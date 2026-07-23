import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, verifyPassword, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import type { SelfBackupScheduler } from '../selfbackupscheduler.js';
import type { BackupKeyStore } from '../backupkey.js';
import {
  listSelfBackups, recentSelfBackupLog, backupHealth, restoreDrill,
  readOffhostConfig, writeOffhostConfig,
} from '../selfbackup.js';

/**
 * P36/P44 — the RubyMIK self-backup control surface. Admin-only. The backup key is managed here,
 * fully in-UI (one-click enable, download, strict off-server mode) — no compose editing. `/status`
 * is polled by the app to drive the banner.
 */
export function selfbackupRoutes(
  db: DatabaseSync, keyStore: BackupKeyStore, dataDir: string, box: SecretBox,
  scheduler: SelfBackupScheduler, gapHours: number,
): Router {
  const router = Router();
  router.use(requireAuth(db));

  function requireAdmin(req: Request, res: Response): boolean {
    const role = (req as unknown as { user: SessionUser & { role?: string } }).user.role;
    if (role !== 'admin') { res.status(403).json({ error: 'Admin only.' }); return false; }
    return true;
  }
  const guarded = (req: Request, res: Response, fn: () => void) => {
    if (!requireAdmin(req, res)) return;
    try { fn(); } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  };

  // Health + key state for the banner + the page. Any authenticated user can read it.
  router.get('/status', (_req, res) => {
    const st = keyStore.status();
    res.json({ ...backupHealth(db, { configured: st.enabled, gapHours }), keyConfigured: st.enabled, gapHours, key: st });
  });

  router.get('/list', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const backups = listSelfBackups(dataDir).map((b) => ({ name: b.name, createdAt: b.createdAt, sizeBytes: b.sizeBytes, manifest: b.manifest }));
    res.json({ backups, log: recentSelfBackupLog(db, 50), keyConfigured: keyStore.configured() });
  });

  router.post('/watchdog-check', (req, res) => {
    if (!requireAdmin(req, res)) return;
    scheduler.checkWatchdog();
    res.json(backupHealth(db, { configured: keyStore.configured(), gapHours }));
  });

  router.post('/run', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!keyStore.configured()) { res.status(409).json({ error: 'Backups are not enabled — enable them first.', keyMissing: true }); return; }
    const out = await scheduler.run('manual');
    res.status(out.ok ? 200 : 502).json(out);
  });

  // ── P44 key management (all admin) ──

  // One-click enable: generate + persist to /data, back up immediately.
  router.post('/enable', (req, res) => guarded(req, res, () => {
    keyStore.enable();
    scheduler.kick();
    res.json({ ok: true, key: keyStore.status() });
  }));

  // Download the recovery key (for off-server safekeeping / strict mode).
  router.get('/recovery-key', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const hex = keyStore.recoveryHex();
    if (!hex) { res.status(409).json({ error: 'No backup key to download — enable backups first.' }); return; }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rubymik-recovery-key.txt"');
    res.send([
      'RubyMIK — backup recovery key', '',
      'Keep this OFF the server, in a password manager. Without it, your backups cannot be',
      'restored. Together with a backup file it is plaintext-equivalent, so store them apart.', '',
      hex, '',
    ].join('\n'));
  });

  // Toggle strict off-server mode: strict=true removes the key from /data (memory only, re-prompt
  // on restart); strict=false stores it back on the server (convenience).
  router.post('/strict', (req, res) => guarded(req, res, () => {
    const strict = ((req.body ?? {}) as { strict?: boolean }).strict === true;
    if (strict) keyStore.goStrict(); else keyStore.goConvenience();
    res.json({ ok: true, key: keyStore.status() });
  }));

  // Provide the key at runtime (strict restart, or a migrated host). Paste or uploaded-file text.
  router.post('/provide-key', (req, res) => guarded(req, res, () => {
    const key = ((req.body ?? {}) as { key?: string }).key ?? '';
    keyStore.provide(key);
    scheduler.kick();
    res.json({ ok: true, key: keyStore.status() });
  }));

  // Turn backups off entirely (remove the key).
  router.post('/disable', (req, res) => guarded(req, res, () => {
    keyStore.disable();
    res.json({ ok: true, key: keyStore.status() });
  }));

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

  // Restore DRILL against the latest backup (admin). Scratch dir; live instance untouched. In
  // strict/migrated cases the key can be supplied for this drill via { key } (hex).
  router.post('/restore-drill', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const provided = ((req.body ?? {}) as { key?: string }).key?.trim();
    let backupKey = keyStore.get();
    if (provided) { if (!/^[0-9a-fA-F]{64}$/.test(provided)) { res.status(400).json({ error: 'The key must be 64 hex characters.' }); return; } backupKey = Buffer.from(provided, 'hex'); }
    if (!backupKey) { res.status(409).json({ error: 'No backup key available — enable backups or provide a recovery key.' }); return; }
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
