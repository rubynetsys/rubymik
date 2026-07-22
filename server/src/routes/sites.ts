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
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  device_count?: number;
}

function toPublic(row: SiteRow) {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    clientName: row.client_name,
    latitude: row.latitude,
    longitude: row.longitude,
    deviceCount: row.device_count ?? 0,
    createdAt: row.created_at,
  };
}

interface SiteInput { name: string; location: string | null; clientName: string | null; latitude: number | null; longitude: number | null }

/** Parse an optional coordinate; empty/absent → null, out-of-range → error sentinel. */
function coord(v: unknown, lo: number, hi: number): number | null | 'ERR' {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return 'ERR';
  return n;
}

export function parseSiteInput(body: unknown): SiteInput | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return 'Site name is required.';
  const location = typeof b.location === 'string' && b.location.trim() ? b.location.trim() : null;
  const clientName = typeof b.clientName === 'string' && b.clientName.trim() ? b.clientName.trim() : null;
  const latitude = coord(b.latitude, -90, 90);
  const longitude = coord(b.longitude, -180, 180);
  if (latitude === 'ERR') return 'Latitude must be between −90 and 90.';
  if (longitude === 'ERR') return 'Longitude must be between −180 and 180.';
  if ((latitude === null) !== (longitude === null)) return 'Provide both latitude and longitude, or neither.';
  return { name, location, clientName, latitude, longitude };
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
      SELECT s.id, s.name, s.location, s.client_name, s.latitude, s.longitude, s.created_at, COUNT(d.id) AS device_count
      FROM sites s LEFT JOIN devices d ON d.site_id = s.id
      WHERE 1 = 1${filter.sql}
      GROUP BY s.id ORDER BY s.name
    `).all(...filter.params) as unknown as SiteRow[];
    res.json(rows.map(toPublic));
  });

  // Geocode an address string → coordinates, via a server-side Nominatim proxy.
  // Server-side so the required User-Agent is always sent and the browser avoids
  // a CORS round-trip. Best-effort: needs outbound internet; returns 502 if not.
  router.get('/geocode', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 3) { res.status(400).json({ error: 'Enter at least 3 characters to search.' }); return; }
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'RubyMIK/1.0 (self-hosted MikroTik dashboard)', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`Nominatim returned HTTP ${r.status}`);
      const raw = (await r.json()) as Array<Record<string, unknown>>;
      const results = raw.map((x) => ({ lat: Number(x.lat), lng: Number(x.lon), displayName: String(x.display_name ?? '') }))
        .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng));
      res.json({ results });
    } catch (err) {
      log.warn(`geocode failed: ${(err as Error).message}`);
      res.status(502).json({ error: 'Address lookup is unavailable (no internet, or the map service is down). Enter coordinates manually.' });
    }
  });

  router.post('/', (req, res) => {
    const input = parseSiteInput(req.body);
    if (typeof input === 'string') {
      res.status(400).json({ error: input });
      return;
    }
    const now = new Date().toISOString();
    try {
      const result = db.prepare('INSERT INTO sites (name, location, client_name, latitude, longitude, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.name, input.location, input.clientName, input.latitude, input.longitude, now, now);
      const row = db.prepare('SELECT id, name, location, client_name, latitude, longitude, created_at FROM sites WHERE id = ?')
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
      db.prepare('UPDATE sites SET name = ?, location = ?, client_name = ?, latitude = ?, longitude = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.location, input.clientName, input.latitude, input.longitude, new Date().toISOString(), id);
    } catch (err) {
      if ((err as Error).message.includes('UNIQUE')) {
        res.status(409).json({ error: 'A site with that name already exists.' });
        return;
      }
      throw err;
    }
    const row = db.prepare(`
      SELECT s.id, s.name, s.location, s.client_name, s.latitude, s.longitude, s.created_at, COUNT(d.id) AS device_count
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
