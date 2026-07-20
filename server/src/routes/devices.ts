import { Router, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import type { Poller } from '../poller.js';
import { allSites, scopeFilter } from '../scope.js';
import { connectDevice, type DeviceTarget } from '../routeros/index.js';
import { log } from '../log.js';

interface DeviceRow {
  id: number;
  name: string;
  host: string;
  port: number | null;
  transport: string;
  use_tls: number | null;
  verify_tls: number;
  site_id: number | null;
  notes: string | null;
  username_enc: string;
  password_enc: string;
  created_at: string;
  site_name?: string | null;
  status_state?: string | null;
}

/** Public shape — credentials never leave the server. */
function toPublic(row: DeviceRow) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    transport: row.transport,
    useTls: row.use_tls === null ? null : row.use_tls === 1,
    siteId: row.site_id,
    siteName: row.site_name ?? null,
    notes: row.notes,
    status: row.status_state ?? null,
    createdAt: row.created_at,
  };
}

interface DeviceInput {
  name: string;
  host: string;
  port: number | null;
  useTls: boolean | null;
  siteId: number | null;
  notes: string | null;
  /** Empty string on edit means "keep the stored username". */
  username: string;
  /** Empty string on edit means "keep the stored password". */
  password: string;
}

function parseDeviceInput(body: unknown, db: DatabaseSync, opts: { requireName: boolean; requireCreds: boolean }): DeviceInput | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (opts.requireName && !name) return 'Device name is required.';
  const host = typeof b.host === 'string' ? b.host.trim() : '';
  if (!host || /\s/.test(host)) return 'A valid host (IP address or hostname) is required.';
  const username = typeof b.username === 'string' ? b.username : '';
  if (opts.requireCreds && username.length === 0) return 'RouterOS username is required.';
  const password = typeof b.password === 'string' ? b.password : '';
  let port: number | null = null;
  if (b.port !== undefined && b.port !== null && b.port !== '') {
    port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be 1–65535.';
  }
  const useTls = typeof b.useTls === 'boolean' ? b.useTls : null;
  let siteId: number | null = null;
  if (b.siteId !== undefined && b.siteId !== null && b.siteId !== '') {
    siteId = Number(b.siteId);
    if (!Number.isInteger(siteId)) return 'Invalid site.';
    if (!db.prepare('SELECT id FROM sites WHERE id = ?').get(siteId)) return 'Site not found.';
  }
  const notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : null;
  return { name, host, port, useTls, siteId, notes, username, password };
}

export function deviceRoutes(db: DatabaseSync, box: SecretBox, poller: Poller): Router {
  const router = Router();
  router.use(requireAuth(db));

  const selectDevice = `
    SELECT d.*, s.name AS site_name, st.state AS status_state
    FROM devices d
    LEFT JOIN sites s ON s.id = d.site_id
    LEFT JOIN device_status st ON st.device_id = d.id
  `;

  router.get('/', (_req, res) => {
    // P1: single admin → unrestricted scope (see scope.ts for the tenancy plan).
    const filter = scopeFilter(allSites(), 'd.site_id');
    const rows = db.prepare(`${selectDevice} WHERE 1 = 1${filter.sql} ORDER BY d.name`)
      .all(...filter.params) as unknown as DeviceRow[];
    res.json(rows.map(toPublic));
  });

  router.post('/', (req, res) => {
    const input = parseDeviceInput(req.body, db, { requireName: true, requireCreds: true });
    if (typeof input === 'string') {
      res.status(400).json({ error: input });
      return;
    }
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO devices (name, host, port, transport, use_tls, verify_tls, site_id, notes, username_enc, password_enc, created_at, updated_at)
      VALUES (?, ?, ?, 'rest', ?, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name, input.host, input.port,
      input.useTls === null ? null : input.useTls ? 1 : 0,
      input.siteId, input.notes,
      box.encrypt(input.username), box.encrypt(input.password),
      now, now,
    );
    const id = result.lastInsertRowid as number;
    const row = db.prepare(`${selectDevice} WHERE d.id = ?`).get(id) as unknown as DeviceRow;
    log.info(`Device "${row.name}" (${row.host}) added`);
    poller.pollDeviceById(id);
    res.status(201).json(toPublic(row));
  });

  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as unknown as DeviceRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }
    const input = parseDeviceInput(req.body, db, { requireName: true, requireCreds: false });
    if (typeof input === 'string') {
      res.status(400).json({ error: input });
      return;
    }
    const usernameEnc = input.username.length > 0 ? box.encrypt(input.username) : existing.username_enc;
    const passwordEnc = input.password.length > 0 ? box.encrypt(input.password) : existing.password_enc;
    db.prepare(`
      UPDATE devices SET name = ?, host = ?, port = ?, use_tls = ?, site_id = ?, notes = ?,
        username_enc = ?, password_enc = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name, input.host, input.port,
      input.useTls === null ? null : input.useTls ? 1 : 0,
      input.siteId, input.notes, usernameEnc, passwordEnc,
      new Date().toISOString(), id,
    );
    const row = db.prepare(`${selectDevice} WHERE d.id = ?`).get(id) as unknown as DeviceRow;
    log.info(`Device "${row.name}" (${row.host}) updated`);
    poller.pollDeviceById(id);
    res.json(toPublic(row));
  });

  router.delete('/:id', (req, res) => {
    const result = db.prepare('DELETE FROM devices WHERE id = ?').run(Number(req.params.id));
    if (result.changes === 0) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }
    res.json({ ok: true });
  });

  // Live connection test for an UNSAVED device (form values from the add dialog).
  router.post('/test', async (req, res) => {
    const input = parseDeviceInput(req.body, db, { requireName: false, requireCreds: true });
    if (typeof input === 'string') {
      res.status(400).json({ error: input });
      return;
    }
    await runTest(res, input.host, {
      host: input.host,
      port: input.port ?? undefined,
      useTls: input.useTls ?? undefined,
      username: input.username,
      password: input.password,
    });
  });

  // Live connection test for a saved device, using its stored (encrypted) credentials.
  router.post('/:id/test', async (req, res) => {
    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(req.params.id)) as unknown as DeviceRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }
    const ok = await runTest(res, row.host, {
      host: row.host,
      port: row.port ?? undefined,
      useTls: row.use_tls === null ? undefined : row.use_tls === 1,
      verifyTls: row.verify_tls === 1,
      username: box.decrypt(row.username_enc),
      password: box.decrypt(row.password_enc),
    });
    // Persist what auto-probe discovered so future connections skip the probe.
    if (ok && row.use_tls === null) {
      db.prepare('UPDATE devices SET use_tls = ?, port = ?, updated_at = ? WHERE id = ?')
        .run(ok.scheme === 'https' ? 1 : 0, ok.port, new Date().toISOString(), row.id);
    }
  });

  async function runTest(res: Response, host: string, target: DeviceTarget) {
    try {
      const result = await connectDevice('rest', target);
      log.info(`Connection test OK: ${host} → ${result.info.identity ?? 'unknown'} (RouterOS ${result.info.version})`);
      res.json({ ok: true, ...result });
      return result;
    } catch (err) {
      const message = (err as Error).message;
      log.warn(`Connection test failed for ${host}: ${message}`);
      res.status(502).json({ ok: false, error: message });
      return null;
    }
  }

  return router;
}
