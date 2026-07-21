import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import { listSnapshots, getSnapshotContent, lastSnapshotFailure } from '../snapshots.js';
import { diffExports } from '../backup.js';
import type { SnapshotScheduler } from '../snapshotscheduler.js';
import { log } from '../log.js';

/**
 * Snapshot API (P21) — CAPTURE + VIEW + DIFF only. There is deliberately NO
 * restore/apply endpoint: nothing here sends snapshot content back to a router.
 * Content responses are secret-bearing (show-sensitive exports) and marked
 * no-store. Mounted under /api/devices (a router IS a device in this codebase).
 */
export function snapshotRoutes(db: DatabaseSync, box: SecretBox, scheduler: SnapshotScheduler): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): { id: number; name: string } | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.id, d.name FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as { id: number; name: string } | undefined;
  };
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store');
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;

  // List (metadata only — never content) + the most recent capture failure (badge).
  router.get('/:id/snapshots', (req, res) => {
    const d = loadDevice(Number(req.params.id));
    if (!d) { res.status(404).json({ error: 'Device not found.' }); return; }
    res.json({ snapshots: listSnapshots(db, d.id), lastFailure: lastSnapshotFailure(db, d.id) });
  });

  // Unified diff of two snapshots — declared BEFORE :sid so "diff" isn't an id.
  router.get('/:id/snapshots/diff', (req, res) => {
    const d = loadDevice(Number(req.params.id));
    if (!d) { res.status(404).json({ error: 'Device not found.' }); return; }
    const a = getSnapshotContent(db, box, Number(req.query.a));
    const b = getSnapshotContent(db, box, Number(req.query.b));
    if (!a || !b || a.meta.routerId !== d.id || b.meta.routerId !== d.id) { res.status(404).json({ error: 'Snapshot(s) not found for this device.' }); return; }
    noStore(res);
    res.json({ a: a.meta, b: b.meta, diff: diffExports(a.text, b.text) });
  });

  // Download as .rsc.
  router.get('/:id/snapshots/:sid/download', (req, res) => {
    const d = loadDevice(Number(req.params.id));
    if (!d) { res.status(404).json({ error: 'Device not found.' }); return; }
    const got = getSnapshotContent(db, box, Number(req.params.sid));
    if (!got || got.meta.routerId !== d.id) { res.status(404).json({ error: 'Snapshot not found.' }); return; }
    noStore(res);
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="snapshot-${got.meta.id}-${(got.meta.identity ?? 'router').replace(/[^\w.-]/g, '_')}.rsc"`);
    res.send(got.text);
  });

  // Decrypted content (secret-bearing — no-store).
  router.get('/:id/snapshots/:sid', (req, res) => {
    const d = loadDevice(Number(req.params.id));
    if (!d) { res.status(404).json({ error: 'Device not found.' }); return; }
    const got = getSnapshotContent(db, box, Number(req.params.sid));
    if (!got || got.meta.routerId !== d.id) { res.status(404).json({ error: 'Snapshot not found.' }); return; }
    noStore(res);
    res.json({ meta: got.meta, content: got.text });
  });

  // Manual capture — READ-ONLY on the router, so allowed on monitor-only devices
  // (Home Lab) too. Never a write path.
  router.post('/:id/snapshots', async (req, res) => {
    const d = loadDevice(Number(req.params.id));
    if (!d) { res.status(404).json({ error: 'Device not found.' }); return; }
    const r = await scheduler.manual(d.id);
    if (r.ok) { log.info(`Manual snapshot #${r.id} of "${d.name}" by ${actorOf(req)}`); res.status(201).json({ ok: true, id: r.id }); }
    else res.status(502).json({ ok: false, error: r.error });
  });

  return router;
}
