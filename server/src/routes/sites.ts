import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth } from '../auth.js';
import { allSites, scopeFilter } from '../scope.js';
import { log } from '../log.js';

interface SiteRow {
  id: number;
  name: string;
  location: string | null;
  client_name: string | null;
  created_at: string;
  device_count?: number;
}

function toPublic(row: SiteRow) {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    clientName: row.client_name,
    deviceCount: row.device_count ?? 0,
    createdAt: row.created_at,
  };
}

function parseSiteInput(body: unknown): { name: string; location: string | null; clientName: string | null } | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return 'Site name is required.';
  const location = typeof b.location === 'string' && b.location.trim() ? b.location.trim() : null;
  const clientName = typeof b.clientName === 'string' && b.clientName.trim() ? b.clientName.trim() : null;
  return { name, location, clientName };
}

export function siteRoutes(db: DatabaseSync): Router {
  const router = Router();
  router.use(requireAuth(db));

  router.get('/', (_req, res) => {
    // P1: single admin → unrestricted scope. Per-user tenancy will swap this
    // for the requesting user's scope (see scope.ts).
    const scope = allSites();
    const filter = scopeFilter(scope, 's.id');
    const rows = db.prepare(`
      SELECT s.id, s.name, s.location, s.client_name, s.created_at, COUNT(d.id) AS device_count
      FROM sites s LEFT JOIN devices d ON d.site_id = s.id
      WHERE 1 = 1${filter.sql}
      GROUP BY s.id ORDER BY s.name
    `).all(...filter.params) as unknown as SiteRow[];
    res.json(rows.map(toPublic));
  });

  router.post('/', (req, res) => {
    const input = parseSiteInput(req.body);
    if (typeof input === 'string') {
      res.status(400).json({ error: input });
      return;
    }
    const now = new Date().toISOString();
    try {
      const result = db.prepare('INSERT INTO sites (name, location, client_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(input.name, input.location, input.clientName, now, now);
      const row = db.prepare('SELECT id, name, location, client_name, created_at FROM sites WHERE id = ?')
        .get(result.lastInsertRowid as number) as unknown as SiteRow;
      log.info(`Site "${row.name}" created`);
      res.status(201).json(toPublic(row));
    } catch (err) {
      if ((err as Error).message.includes('UNIQUE')) {
        res.status(409).json({ error: 'A site with that name already exists.' });
        return;
      }
      throw err;
    }
  });

  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id FROM sites WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'Site not found.' });
      return;
    }
    const input = parseSiteInput(req.body);
    if (typeof input === 'string') {
      res.status(400).json({ error: input });
      return;
    }
    try {
      db.prepare('UPDATE sites SET name = ?, location = ?, client_name = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.location, input.clientName, new Date().toISOString(), id);
    } catch (err) {
      if ((err as Error).message.includes('UNIQUE')) {
        res.status(409).json({ error: 'A site with that name already exists.' });
        return;
      }
      throw err;
    }
    const row = db.prepare(`
      SELECT s.id, s.name, s.location, s.client_name, s.created_at, COUNT(d.id) AS device_count
      FROM sites s LEFT JOIN devices d ON d.site_id = s.id WHERE s.id = ? GROUP BY s.id
    `).get(id) as unknown as SiteRow;
    res.json(toPublic(row));
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const inUse = (db.prepare('SELECT COUNT(*) AS n FROM devices WHERE site_id = ?').get(id) as { n: number }).n;
    if (inUse > 0) {
      res.status(409).json({ error: `Site still has ${inUse} device(s) — move or remove them first.` });
      return;
    }
    const result = db.prepare('DELETE FROM sites WHERE id = ?').run(id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Site not found.' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
