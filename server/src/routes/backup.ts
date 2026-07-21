import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import { restConnect, restGet } from '../routeros/rest.js';
import type { DeviceTarget } from '../routeros/types.js';
import type { WriteTransport } from '../routeros/write.js';
import { auditRejected, writeAudit } from '../safeapply.js';
import { listBackups, getBackupRow, diffExports } from '../backup.js';
import { restoreBackup, type RestoreContext } from '../restore.js';
import type { BackupScheduler } from '../backupscheduler.js';
import { log } from '../log.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
}

export function backupRoutes(db: DatabaseSync, box: SecretBox, scheduler: BackupScheduler): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as Request & { user: SessionUser }).user.username;

  const readTarget = (row: DeviceRow): DeviceTarget => ({
    host: row.host, port: row.port ?? undefined,
    useTls: row.use_tls === null ? undefined : row.use_tls === 1,
    verifyTls: row.verify_tls === 1,
    username: box.decrypt(row.username_enc), password: box.decrypt(row.password_enc),
  });

  async function transportFor(row: DeviceRow, read: DeviceTarget): Promise<WriteTransport> {
    if (row.use_tls !== null) return { scheme: row.use_tls === 1 ? 'https' : 'http', port: row.port ?? (row.use_tls === 1 ? 443 : 80) };
    const probed = await restConnect(read);
    return { scheme: probed.scheme, port: probed.port };
  }

  // List backups + manageability (backups are reads → allowed on any device).
  router.get('/:id/backups', (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    res.json({
      manageable: !!(row.write_username_enc && row.write_password_enc),
      backups: listBackups(db, row.id),
    });
  });

  // Manual "back up now" — a read, allowed on any device.
  router.post('/:id/backups', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try {
      const backup = await scheduler.manualBackup(row.id);
      writeAudit({ db, actor: actorOf(req), deviceId: row.id, deviceName: row.name, action: 'backup.create', targetLabel: `#${backup.id}` },
        'applied', `Manual backup (${backup.rawBytes}B, RouterOS ${backup.version ?? '?'})`, null, { backupId: backup.id }, 'Config exported and stored.');
      res.status(201).json(backup);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Back up ALL devices now (scheduled-job trigger, for the fleet).
  router.post('/backups/run-all', async (req, res) => {
    const result = await scheduler.runAll('manual');
    log.info(`Backup run-all by ${actorOf(req)}: ${result.ok} ok, ${result.failed} failed`);
    res.json(result);
  });

  // Download a backup's raw export text.
  router.get('/backups/:backupId/download', (req, res) => {
    const b = getBackupRow(db, Number(req.params.backupId));
    if (!b) { res.status(404).json({ error: 'Backup not found.' }); return; }
    if (b.deviceId !== null && !loadDevice(b.deviceId)) { res.status(404).json({ error: 'Backup not found.' }); return; }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${b.deviceName.replace(/[^\w.-]/g, '_')}-${b.id}.rsc"`);
    res.send(b.text);
  });

  // Diff two backups (a = older, b = newer).
  router.get('/:id/backups/diff', (req, res) => {
    const a = getBackupRow(db, Number(req.query.a));
    const b = getBackupRow(db, Number(req.query.b));
    if (!a || !b) { res.status(404).json({ error: 'Backup(s) not found.' }); return; }
    const d = diffExports(a.text, b.text);
    res.json({ from: { id: a.id, createdAt: a.createdAt }, to: { id: b.id, createdAt: b.createdAt }, ...d });
  });

  // RESTORE — write, bench-manageable only, full pipeline + mismatch guard.
  router.post('/:id/backups/:backupId/restore', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    const actor = actorOf(req);
    const sacBase = { db, actor, deviceId: row.id, deviceName: row.name, action: 'backup.restore' as const };

    if (!row.write_username_enc || !row.write_password_enc) {
      res.status(403).json({ error: 'This device is monitor-only. Restore is a write and is blocked; add a write credential to enable it.' });
      return;
    }
    const backup = getBackupRow(db, Number(req.params.backupId));
    if (!backup) { res.status(404).json({ error: 'Backup not found.' }); return; }
    if (backup.format !== 'export') {
      res.status(400).json({ error: 'This backup is a read-only snapshot (not a canonical export) and cannot be restored. Only export-format backups are restorable.' });
      return;
    }

    const read = readTarget(row);
    let transport: WriteTransport;
    try { transport = await transportFor(row, read); }
    catch (err) { res.status(502).json({ error: (err as Error).message }); return; }

    // Device-mismatch guard: the backup must belong to THIS device.
    try {
      const rb = await restGet(read, transport.scheme, transport.port, '/system/routerboard') as { 'serial-number'?: string; model?: string };
      const curSerial = rb['serial-number'] ?? null;
      if (backup.serial && curSerial && backup.serial !== curSerial) {
        const msg = `Backup is for ${backup.model ?? '?'} serial ${backup.serial}, but this device is serial ${curSerial}. Refusing to restore another device's config.`;
        auditRejected({ ...sacBase, targetLabel: `#${backup.id}` }, `Restore backup #${backup.id}`, `Rejected: ${msg}`);
        res.status(409).json({ error: msg });
        return;
      }
    } catch { /* if routerboard unreadable, fall through — export-header serial still stored */ }

    const write: DeviceTarget = {
      host: row.host, port: row.port ?? undefined,
      useTls: row.use_tls === null ? undefined : row.use_tls === 1,
      verifyTls: row.verify_tls === 1,
      username: box.decrypt(row.write_username_enc), password: box.decrypt(row.write_password_enc),
    };
    const ctx: RestoreContext = { read, write, transport };
    const forceRollback = (req.body?._forceRollback === true);

    try {
      const outcome = await restoreBackup(ctx,
        { ...sacBase, targetLabel: `Restore backup #${backup.id} (${backup.createdAt})` },
        backup.text, forceRollback);
      res.status(outcome.result === 'applied' ? 200 : 502).json(outcome);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  return router;
}
