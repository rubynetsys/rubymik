import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import type { Poller } from '../poller.js';
import { allSites, scopeFilter } from '../scope.js';
import { connectDevice, type DeviceTarget } from '../routeros/index.js';
import { readTarget, resolveEndpoint, writeTarget, transportFor } from '../transport.js';
import { restCommand } from '../routeros/write.js';
import { captureForDevice } from '../snapshots.js';
import { beginReboot, abortReboot, parseUptimeSec } from '../reboot.js';
import { writeAudit } from '../safeapply.js';
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
  write_username_enc: string | null;
  write_password_enc: string | null;
  net_transport?: string | null;
  tunnel_ip?: string | null;
  backups_enabled?: number;
  category?: string | null;
  created_at: string;
  site_name?: string | null;
  status_state?: string | null;
  status_model?: string | null;
}

/** Public shape — credentials never leave the server. */
function toPublic(row: DeviceRow) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    transport: row.transport,
    netTransport: row.net_transport === 'tunnel' ? 'tunnel' : 'direct',
    tunnelIp: row.tunnel_ip ?? null,
    backupsEnabled: row.backups_enabled === undefined ? true : row.backups_enabled === 1,
    useTls: row.use_tls === null ? null : row.use_tls === 1,
    siteId: row.site_id,
    siteName: row.site_name ?? null,
    notes: row.notes,
    status: row.status_state ?? null,
    // Stored category override (nullable) + the last polled model, so the client
    // can show an effective category (override ?? derive-from-model) and filter.
    category: row.category ?? null,
    model: row.status_model ?? null,
    // A device is "manageable" only when it has an explicit write credential.
    manageable: row.write_username_enc !== null && row.write_password_enc !== null,
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
  /** undefined = leave write cred as-is; '' = explicitly clear; string = set. */
  writeUsername: string | undefined;
  writePassword: string | undefined;
  /** undefined = leave as-is (edit); null = clear override (derive from model). */
  category: string | null | undefined;
}

const CATEGORIES = ['router', 'switch', 'ap', 'other'];

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
  // Write credential is optional and explicit — a device is manageable ONLY
  // when both write fields are present. `null` clears it; undefined leaves it.
  const writeUsername = b.writeUsername === null ? '' : typeof b.writeUsername === 'string' ? b.writeUsername : undefined;
  const writePassword = b.writePassword === null ? '' : typeof b.writePassword === 'string' ? b.writePassword : undefined;
  // Category override: null/'' clears it (derive from model); a valid enum sets it.
  let category: string | null | undefined;
  if (b.category === null || b.category === '') category = null;
  else if (typeof b.category === 'string') {
    if (!CATEGORIES.includes(b.category)) return 'Invalid category.';
    category = b.category;
  }
  return { name, host, port, useTls, siteId, notes, username, password, writeUsername, writePassword, category };
}

export function deviceRoutes(db: DatabaseSync, box: SecretBox, poller: Poller): Router {
  const router = Router();
  router.use(requireAuth(db));

  const selectDevice = `
    SELECT d.*, s.name AS site_name, st.state AS status_state, st.model AS status_model
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
    // A write credential is set only when BOTH fields are non-empty — never
    // silently escalate; monitoring stays on the read credential regardless.
    const hasWrite = !!input.writeUsername && !!input.writePassword;
    // Scheduled-backup opt-in. Defaults to true (unchanged for the plain add
    // form and any client that omits it); onboarding passes false by default.
    const backupsEnabled = (req.body ?? {}).backupsEnabled === false ? 0 : 1;
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO devices (name, host, port, transport, use_tls, verify_tls, site_id, notes, username_enc, password_enc, write_username_enc, write_password_enc, backups_enabled, category, created_at, updated_at)
      VALUES (?, ?, ?, 'rest', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name, input.host, input.port,
      input.useTls === null ? null : input.useTls ? 1 : 0,
      input.siteId, input.notes,
      box.encrypt(input.username), box.encrypt(input.password),
      hasWrite ? box.encrypt(input.writeUsername!) : null,
      hasWrite ? box.encrypt(input.writePassword!) : null,
      backupsEnabled, input.category ?? null, now, now,
    );
    const id = result.lastInsertRowid as number;
    const row = db.prepare(`${selectDevice} WHERE d.id = ?`).get(id) as unknown as DeviceRow;
    log.info(`Device "${row.name}" (${row.host}) added`);
    // Attach is an onboarding event worth an audit trail entry — it writes
    // nothing to the router (pure monitoring attach), so before/after are null.
    const actor = (req as Request & { user: SessionUser }).user.username;
    writeAudit(
      { db, actor, deviceId: id, deviceName: row.name, action: 'device.attach', targetLabel: row.host },
      'applied', `Attached "${row.name}" (${row.host}) as a ${hasWrite ? 'manageable' : 'monitor-only'} DIRECT device`,
      null, null, 'Monitoring attach only — no configuration written to the router.',
    );
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
    // Write cred: undefined = leave as-is; '' = clear (revert to monitor-only);
    // set both = manageable. Partial (only one field) also clears, to avoid a
    // half-configured write credential.
    let writeUserEnc = existing.write_username_enc;
    let writePassEnc = existing.write_password_enc;
    if (input.writeUsername !== undefined || input.writePassword !== undefined) {
      const wu = input.writeUsername ?? '';
      const wp = input.writePassword ?? '';
      if (wu && wp) {
        writeUserEnc = box.encrypt(wu);
        writePassEnc = box.encrypt(wp);
      } else if (input.writeUsername === '' || input.writePassword === '') {
        writeUserEnc = null;
        writePassEnc = null;
      }
    }
    // undefined = leave the stored override as-is; null clears it; value sets it.
    const categoryVal = input.category === undefined ? (existing.category ?? null) : input.category;
    db.prepare(`
      UPDATE devices SET name = ?, host = ?, port = ?, use_tls = ?, site_id = ?, notes = ?,
        username_enc = ?, password_enc = ?, write_username_enc = ?, write_password_enc = ?, category = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name, input.host, input.port,
      input.useTls === null ? null : input.useTls ? 1 : 0,
      input.siteId, input.notes, usernameEnc, passwordEnc, writeUserEnc, writePassEnc, categoryVal,
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

  // --- POST /:id/reboot — reboot the router behind an expected-outage dead-man.
  // Monitor-only → 403. Requires a typed-name confirm. Pre-snapshot fail-closed.
  // There is NO rollback for a reboot; the snapshot is a record, not a revert.
  const REBOOT_WINDOW_SEC = 300;
  router.post('/:id/reboot', async (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as unknown as DeviceRow | undefined;
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    if (!row.write_username_enc || !row.write_password_enc) {
      res.status(403).json({ error: 'This device is monitor-only. Add a write credential to reboot it.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const confirm = typeof body.confirm === 'string' ? body.confirm.trim() : '';
    if (confirm !== row.name) {
      res.status(400).json({ error: `Type the device name exactly ("${row.name}") to confirm the reboot.` });
      return;
    }
    const windowSec = Math.min(Math.max(Number(body.windowSec) || REBOOT_WINDOW_SEC, 60), 1800);
    const actor = (req as unknown as { user: SessionUser }).user.username;

    // 1) Baseline (serial + uptime) + reachability — a reboot of an already-down box is meaningless.
    const readT = readTarget(box, row);
    let baseline: { serial: string | null; uptimeSec: number | null; at: string };
    try {
      const r = await connectDevice('rest', readT);
      baseline = { serial: r.info.serialNumber, uptimeSec: parseUptimeSec(r.info.uptime), at: new Date().toISOString() };
    } catch (err) {
      res.status(502).json({ error: `Cannot reach the device to reboot it: ${(err as Error).message}` });
      return;
    }

    // 2) Pre-reboot snapshot, fail-closed (a record of the config before the reboot).
    try {
      await captureForDevice(db, box, id, { trigger: 'pre_write', operation: 'system.reboot' });
    } catch (err) {
      res.status(409).json({ error: `Refusing to reboot without a pre-reboot snapshot: ${(err as Error).message}`, snapshotRequired: true });
      return;
    }

    // 3) Arm the dead-man BEFORE issuing, so a poll landing during the outage sees 'rebooting'.
    const until = new Date(Date.now() + windowSec * 1000).toISOString();
    beginReboot(db, id, baseline, until);

    // 4) Issue the reboot. A reboot legitimately drops the connection mid-response;
    //    only a clear auth/permission error means it did NOT run — then we disarm.
    try {
      const write = writeTarget(box, row);
      const transport = await transportFor(row, readT);
      await restCommand(write, transport, '/system/reboot', {});
    } catch (err) {
      const msg = (err as Error).message.toLowerCase();
      if (/\b(401|403)\b|forbidden|permission|not permitted|no permission|login/.test(msg)) {
        abortReboot(db, id);
        res.status(502).json({ error: `Reboot refused by the router: ${(err as Error).message}` });
        return;
      }
      // connection reset / timeout → the box is going down as expected
    }

    writeAudit(
      { db, actor, deviceId: id, deviceName: row.name, action: 'system.reboot', targetLabel: 'reboot' },
      'applied', `Reboot issued (return window ${windowSec}s)`, null, { until, baseline },
      'Reboot command sent. Expected-outage dead-man armed — the device shows "rebooting" (no down-alert) until it returns (serial + uptime verified) or the window expires.',
    );
    // Do NOT nudge a poll here: the box may still be reachable for a moment, and a
    // success before it actually goes down would prematurely clear the dead-man.
    res.status(202).json({ rebooting: true, until, windowSec });
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
    const ok = await runTest(res, resolveEndpoint(row).host, readTarget(box, row));
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
