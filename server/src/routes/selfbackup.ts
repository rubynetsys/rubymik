import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, verifyPassword, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import type { SelfBackupScheduler } from '../selfbackupscheduler.js';
import {
  listSelfBackups, recentSelfBackupLog, backupHealth, restoreDrill,
  readOffhostConfig, writeOffhostConfig,
} from '../selfbackup.js';

/**
 * P36 — the RubyMIK self-backup control surface. Admin-only. `/api/backup` is a
 * free mount path (router-config backups live under `/api/devices`), so no
 * collision. `/status` is polled by the app to drive the red banner.
 */
export function selfbackupRoutes(
  db: DatabaseSync, backupKey: Buffer | null, dataDir: string, box: SecretBox,
  scheduler: SelfBackupScheduler, gapHours: number,
): Router {
  const router = Router();
  router.use(requireAuth(db));

  const configured = backupKey !== null;
  function requireAdmin(req: Request, res: Response): boolean {
    const role = (req as unknown as { user: SessionUser & { role?: string } }).user.role;
    if (role !== 'admin') { res.status(403).json({ error: 'Admin only.' }); return false; }
    return true;
  }

  // Health for the banner + the page header. Any authenticated user can read it.
  router.get('/status', (_req, res) => {
    res.json({ ...backupHealth(db, { configured, gapHours }), keyConfigured: configured, gapHours });
  });

  // Full list + recent run log (admin).
  router.get('/list', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const backups = listSelfBackups(dataDir).map((b) => ({ name: b.name, createdAt: b.createdAt, sizeBytes: b.sizeBytes, manifest: b.manifest }));
    res.json({ backups, log: recentSelfBackupLog(db, 50), keyConfigured: configured });
  });

  // Force a watchdog re-evaluation now (admin) — fires the gap alert if we're past
  // the no-successful-backup window. Also useful operationally to re-check health.
  router.post('/watchdog-check', (req, res) => {
    if (!requireAdmin(req, res)) return;
    scheduler.checkWatchdog();
    res.json(backupHealth(db, { configured, gapHours }));
  });

  // On-demand backup (admin).
  router.post('/run', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!configured) { res.status(409).json({ error: 'No backup key configured — set RUBYMIK_BACKUP_KEY first.', keyMissing: true }); return; }
    const out = await scheduler.run('manual');
    res.status(out.ok ? 200 : 502).json(out);
  });

  // Shown-once key generation for setup. The app NEVER persists this — the operator
  // stores it OFF this machine and puts it in .env (then restarts). Returned once.
  router.post('/genkey', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const key = crypto.randomBytes(32).toString('hex');
    res.json({
      key,
      instructions: [
        'Store this key somewhere safe and OFF this machine (a password manager) — a backup is unreadable without it.',
        'Add it to the app\'s .env as:  RUBYMIK_BACKUP_KEY=' + key,
        'Restart RubyMIK. Keep the key and your backups apart — together they are plaintext-equivalent.',
      ],
      warning: 'This key is shown ONCE and is not stored by the app. If you lose it, existing backups cannot be restored.',
    });
  });

  // Off-host config (admin).
  router.get('/config', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ ...readOffhostConfig(db), pendingRay: true });
  });
  router.put('/config', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: { enabled?: boolean; kind?: string; path?: string | null } = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (typeof b.kind === 'string') { if (b.kind !== 'path') { res.status(400).json({ error: 'Only kind="path" is implemented in v1 (SFTP/rclone are PENDING-RAY).' }); return; } patch.kind = b.kind; }
    if (b.path === null || typeof b.path === 'string') patch.path = (b.path as string | null) || null;
    res.json({ ...writeOffhostConfig(db, patch), pendingRay: true });
  });

  // Test the off-host destination without a full backup (admin).
  router.post('/config/test', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const cfg = readOffhostConfig(db);
    if (!cfg.enabled || !cfg.path) { res.status(400).json({ error: 'Off-host is not enabled / no path set.' }); return; }
    try {
      const probe = `.rubymik-offhost-probe-${Date.now()}`;
      fs.mkdirSync(cfg.path, { recursive: true });
      fs.writeFileSync(path.join(cfg.path, probe), 'ok');
      fs.rmSync(path.join(cfg.path, probe));
      res.json({ ok: true, detail: `Wrote + removed a probe file in ${cfg.path}.` });
    } catch (err) { res.status(502).json({ ok: false, error: `Off-host target unwritable: ${(err as Error).message}` }); }
  });

  // Restore DRILL against the latest backup (admin). Runs in a scratch dir; the
  // live instance is never touched. No password is verified here (no known pw) —
  // the login check confirms user rows + hashes restored; the full password-verify
  // drill runs in tests + the scripted live drill.
  router.post('/restore-drill', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!backupKey) { res.status(409).json({ error: 'No backup key configured.' }); return; }
    const list = listSelfBackups(dataDir);
    const target = list[0];
    if (!target) { res.status(409).json({ error: 'No backup to drill — run a backup first.' }); return; }
    try {
      const drill = await restoreDrill({ backupFile: target.file, manifestFile: target.manifestFile, backupKey, mainBox: box, verifyPassword });
      res.status(drill.ok ? 200 : 502).json({ backup: target.name, ...drill });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  return router;
}
