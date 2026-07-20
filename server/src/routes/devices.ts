import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { connectDevice, type Transport } from '../routeros/index.js';
import { log } from '../log.js';

interface DeviceRow {
  id: number;
  name: string;
  host: string;
  port: number | null;
  transport: string;
  use_tls: number | null;
  verify_tls: number;
  username_enc: string;
  password_enc: string;
  created_at: string;
  updated_at: string;
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
    createdAt: row.created_at,
  };
}

interface DeviceInput {
  name: string;
  host: string;
  port?: number;
  useTls?: boolean;
  username: string;
  password: string;
}

function parseDeviceInput(body: unknown, requireName: boolean): DeviceInput | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (requireName && !name) return 'Device name is required.';
  const host = typeof b.host === 'string' ? b.host.trim() : '';
  if (!host || /\s/.test(host)) return 'A valid host (IP address or hostname) is required.';
  if (typeof b.username !== 'string' || b.username.length === 0) return 'RouterOS username is required.';
  if (typeof b.password !== 'string') return 'RouterOS password is required.';
  let port: number | undefined;
  if (b.port !== undefined && b.port !== null && b.port !== '') {
    port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be 1–65535.';
  }
  const useTls = typeof b.useTls === 'boolean' ? b.useTls : undefined;
  return { name, host, port, useTls, username: b.username, password: b.password };
}

export function deviceRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  router.get('/', (_req, res) => {
    const rows = db.prepare('SELECT * FROM devices ORDER BY name').all() as unknown as DeviceRow[];
    res.json(rows.map(toPublic));
  });

  router.post('/', (req, res) => {
    const input = parseDeviceInput(req.body, true);
    if (typeof input === 'string') {
      res.status(400).json({ error: input });
      return;
    }
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO devices (name, host, port, transport, use_tls, verify_tls, username_enc, password_enc, created_at, updated_at)
      VALUES (?, ?, ?, 'rest', ?, 0, ?, ?, ?, ?)
    `).run(
      input.name, input.host, input.port ?? null,
      input.useTls === undefined ? null : input.useTls ? 1 : 0,
      box.encrypt(input.username), box.encrypt(input.password),
      now, now,
    );
    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(result.lastInsertRowid as number) as unknown as DeviceRow;
    log.info(`Device "${row.name}" (${row.host}) added`);
    res.status(201).json(toPublic(row));
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
    const input = parseDeviceInput(req.body, false);
    if (typeof input === 'string') {
      res.status(400).json({ error: input });
      return;
    }
    await runTest(res, input.host, {
      host: input.host, port: input.port, useTls: input.useTls,
      username: input.username, password: input.password,
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

  async function runTest(
    res: Parameters<ReturnType<typeof requireAuth>>[1],
    host: string,
    target: Parameters<typeof connectDevice>[1],
    transport: Transport = 'rest',
  ) {
    try {
      const result = await connectDevice(transport, target);
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
