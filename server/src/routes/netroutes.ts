import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import type { WriteTransport } from '../routeros/write.js';
import { readTarget, writeTarget, transportFor } from '../transport.js';
import { auditRejected } from '../safeapply.js';
import {
  readRoutes, addRoute, editRoute, removeRoute,
  validateRouteInput, mgmtGuardError, mgmtCriticalPrefixes,
  type RoutesContext,
} from '../netroutes.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
  net_transport?: string | null; tunnel_ip?: string | null;
}

export function netroutesRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });

  async function makeCtx(row: DeviceRow): Promise<RoutesContext> {
    const read = readTarget(box, row);
    const transport: WriteTransport = await transportFor(row, read);
    const write = (row.write_username_enc && row.write_password_enc) ? writeTarget(box, row) : read;
    return { read, write, transport, row };
  }

  // READ — allowed on any device (Home Lab included; reads are safe).
  router.get('/:id/routes', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try {
      const ctx = await makeCtx(row);
      const view = await readRoutes(ctx);
      res.json({ manageable: !!(row.write_username_enc && row.write_password_enc), ...view });
    } catch (err) { res.status(502).json({ error: (err as Error).message }); }
  });

  async function requireManageable(req: Request, res: Response): Promise<{ row: DeviceRow; ctx: RoutesContext; actor: string } | null> {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    if (!row.write_username_enc || !row.write_password_enc) {
      res.status(403).json({ error: 'This device is monitor-only. Add a write credential to configure routes.' });
      return null;
    }
    try { return { row, ctx: await makeCtx(row), actor: actorOf(req) }; }
    catch (err) { res.status(502).json({ error: (err as Error).message }); return null; }
  }

  // ADD a static route.
  router.post('/:id/routes', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const dst = typeof b.dst === 'string' ? b.dst.trim() : '';
    const gateway = typeof b.gateway === 'string' ? b.gateway.trim() : '';
    const distance = b.distance == null || b.distance === '' ? 1 : Number(b.distance);
    const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim() : null;

    const errs = validateRouteInput({ dst, gateway, distance });
    if (errs.length) {
      auditRejected(sac(m.row, m.actor, 'route.add', dst), `Add route ${dst}`, `Rejected: ${errs.join(' ')}`);
      res.status(400).json({ error: errs.join(' ') }); return;
    }
    // MGMT-PATH GUARD (transport-aware) — refuse an obvious mgmt-severing route.
    const mgmt = await mgmtCriticalPrefixes(m.ctx);
    const guard = mgmtGuardError(dst, mgmt.prefixes, mgmt.net);
    if (guard) {
      auditRejected(sac(m.row, m.actor, 'route.add', dst), `Add route ${dst}`, `Blocked by management-path guard: ${guard}`);
      res.status(409).json({ error: guard, mgmtPathGuard: true }); return;
    }
    try {
      const outcome = await addRoute(m.ctx, sac(m.row, m.actor, 'route.add', `${dst} via ${gateway}`), { dst, gateway, distance, comment });
      res.status(outcome.result === 'applied' ? 201 : 502).json(outcome);
    } catch (err) { res.status(502).json({ error: (err as Error).message }); }
  });

  // EDIT a static route (gateway/distance/comment). Static-only + extra care for
  // pre-existing (non-RUBYMIK) routes; mgmt-guard on gateway changes.
  router.patch('/:id/routes/:routeId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readRoutes(m.ctx);
    const route = view.routes.find((r) => r.id === req.params.routeId);
    if (!route) { res.status(404).json({ error: 'Route not found.' }); return; }
    if (route.kind !== 'static') { res.status(400).json({ error: `Only static routes can be changed — this is a ${route.kind} route (read-only).` }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!route.managed && b.force !== true) {
      res.status(409).json({ error: 'This is a pre-existing static route (not RubyMIK-managed) — it may be load-bearing. Re-send with force:true to edit it.', preExistingRoute: true });
      return;
    }
    const patch: { gateway?: string; distance?: number; comment?: string | null } = {};
    if (typeof b.gateway === 'string' && b.gateway.trim()) patch.gateway = b.gateway.trim();
    if (b.distance != null && b.distance !== '') patch.distance = Number(b.distance);
    if (b.comment !== undefined) patch.comment = typeof b.comment === 'string' ? b.comment.trim() : null;
    if (patch.gateway !== undefined && !/^[A-Za-z0-9 _.\-]+$/.test(patch.gateway)) { res.status(400).json({ error: 'Invalid gateway.' }); return; }
    if (patch.distance !== undefined && (!Number.isInteger(patch.distance) || patch.distance < 0 || patch.distance > 255)) { res.status(400).json({ error: 'Distance must be 0–255.' }); return; }
    // Guard: editing a route whose dst overlaps mgmt would be dangerous.
    const guard = route.dst ? mgmtGuardError(route.dst, view.mgmtPrefixes, view.mgmtNet) : null;
    if (guard) { res.status(409).json({ error: guard, mgmtPathGuard: true }); return; }
    try {
      const outcome = await editRoute(m.ctx, sac(m.row, m.actor, 'route.edit', route.dst), req.params.routeId, patch);
      res.status(outcome.result === 'applied' ? 200 : 502).json(outcome);
    } catch (err) { res.status(502).json({ error: (err as Error).message }); }
  });

  // REMOVE a static route (static-only; extra care for non-RUBYMIK routes).
  router.delete('/:id/routes/:routeId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readRoutes(m.ctx);
    const route = view.routes.find((r) => r.id === req.params.routeId);
    if (!route) { res.status(404).json({ error: 'Route not found.' }); return; }
    if (route.kind !== 'static') { res.status(400).json({ error: `Only static routes can be removed — this is a ${route.kind} route (read-only).` }); return; }
    if (!route.managed && (req.body ?? {}).force !== true) {
      res.status(409).json({ error: 'This is a pre-existing static route (not RubyMIK-managed). Re-send with force:true to remove it.', preExistingRoute: true });
      return;
    }
    try {
      const outcome = await removeRoute(m.ctx, sac(m.row, m.actor, 'route.remove', route.dst), req.params.routeId);
      res.status(outcome.result === 'applied' ? 200 : 502).json(outcome);
    } catch (err) { res.status(502).json({ error: (err as Error).message }); }
  });

  return router;
}
