import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, requireRole } from '../auth.js';
import { APP_VERSION } from '../version.js';
import { getMeta, TARGET_SCHEMA } from '../db.js';
import { readUpdateConfig, writeUpdateConfig, performUpdateCheck, DEFAULT_UPDATE_URL } from '../appupdate.js';

/**
 * P38 — /api/update. Read the cached update status (any signed-in user), trigger a
 * manual re-check, or toggle the daily check / URL (admin only). There is NO
 * endpoint that applies an update — updating is always an operator action.
 */
export function appUpdateRoutes(db: DatabaseSync, defaultUrl?: string): Router {
  const router = Router();
  router.use(requireAuth(db));

  // The banner reads this — instant, from cache, offline-safe. Never triggers a
  // network call itself (the daily scheduler / manual check own that).
  router.get('/status', (_req, res) => {
    const cfg = readUpdateConfig(db);
    res.json({
      current: APP_VERSION,
      schemaVersion: TARGET_SCHEMA,
      bootedAt: getMeta(db, 'booted_at'),
      enabled: cfg.enabled,
      url: cfg.url || defaultUrl || DEFAULT_UPDATE_URL,
      lastCheckAt: cfg.lastCheckAt,
      lastStatus: cfg.lastStatus,
      report: cfg.lastResult,
    });
  });

  // Manual "check now" (admin) — hits the network once and returns the fresh result.
  router.post('/check', requireRole('admin'), async (_req, res) => {
    const outcome = await performUpdateCheck(db, { currentVersion: APP_VERSION, defaultUrl });
    res.json({ current: APP_VERSION, ...outcome });
  });

  // Opt-out toggle + optional URL override (admin). null/empty url ⇒ use default.
  router.put('/config', requireRole('admin'), (req, res) => {
    const b = (req.body ?? {}) as { enabled?: unknown; url?: unknown };
    const patch: { enabled?: boolean; url?: string | null } = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (b.url === null || b.url === '') patch.url = null;
    else if (typeof b.url === 'string') {
      if (!/^https?:\/\//i.test(b.url.trim())) { res.status(400).json({ error: 'Update URL must be an http(s) URL.' }); return; }
      patch.url = b.url.trim();
    }
    const cfg = writeUpdateConfig(db, patch);
    res.json({ enabled: cfg.enabled, url: cfg.url || DEFAULT_UPDATE_URL });
  });

  return router;
}
