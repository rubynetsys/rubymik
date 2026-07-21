import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import { writeErr } from '../snapshothook.js';
import { auditRejected, type SafeApplyOutcome } from '../safeapply.js';
import { readTarget, writeTarget, transportFor } from '../transport.js';
import type { WriteTransport } from '../routeros/write.js';
import {
  readPppoe, mgmtInfo, validatePppoeInput, pppoeMgmtGuard, replaceWanPppoe,
  createPppoe, editPppoe, setPppoeEnabled, removePppoe, takeOwnershipPppoe,
  type PppoeContext, type PppoeClient, type PppoeSpec,
} from '../netpppoe.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
  net_transport?: string | null; tunnel_ip?: string | null;
}

function bodyToSpec(b: Record<string, unknown>): PppoeSpec {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
  return {
    name: str(b.name) ?? '', interface: str(b.interface), user: str(b.user), password: typeof b.password === 'string' && b.password !== '' ? b.password : undefined,
    serviceName: str(b.serviceName), acName: str(b.acName),
    addDefaultRoute: bool(b.addDefaultRoute), defaultRouteDistance: str(b.defaultRouteDistance), usePeerDns: bool(b.usePeerDns), allow: str(b.allow),
    comment: str(b.comment), disabled: b.disabled === true,
  };
}

export function netpppoeRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });
  async function makeCtx(row: DeviceRow): Promise<PppoeContext> {
    const read = readTarget(box, row);
    const transport: WriteTransport = await transportFor(row, read);
    const write = (row.write_username_enc && row.write_password_enc) ? writeTarget(box, row) : read;
    return { read, write, transport, row };
  }
  const send = (res: Response, ok: number, o: SafeApplyOutcome) => res.status(o.result === 'applied' ? ok : o.result === 'rolled_back' ? 409 : 502).json(o);
  const refuse = (res: Response, row: DeviceRow, actor: string, action: string, label: string, msg: string) => {
    auditRejected(sac(row, actor, action, label), `PPPoE ${action}`, `Blocked by PPPoE mgmt guard: ${msg}`);
    res.status(409).json({ error: msg, pppoeMgmtGuard: true });
  };

  router.get('/:id/pppoe', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try { res.json({ manageable: !!(row.write_username_enc && row.write_password_enc), ...(await readPppoe(await makeCtx(row))) }); }
    catch (err) { writeErr(res, err); }
  });

  async function requireManageable(req: Request, res: Response) {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    if (!row.write_username_enc || !row.write_password_enc) { res.status(403).json({ error: 'This device is monitor-only. Add a write credential to configure PPPoE.' }); return null; }
    try { return { row, ctx: await makeCtx(row), actor: actorOf(req) }; }
    catch (err) { writeErr(res, err); return null; }
  }
  function requireOwned(res: Response, c: PppoeClient | undefined): c is PppoeClient {
    if (!c) { res.status(404).json({ error: 'PPPoE client not found.' }); return false; }
    if (!c.managed) { res.status(409).json({ error: 'This PPPoE client was created outside RubyMIK. Take ownership of it first to edit/disable/remove it.', ownershipRequired: true }); return false; }
    return true;
  }

  router.post('/:id/pppoe', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const spec = bodyToSpec((req.body ?? {}) as Record<string, unknown>);
    const errs = validatePppoeInput(spec, { create: true });
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'pppoe.create', spec.name), `Add PPPoE`, `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const guard = pppoeMgmtGuard(await mgmtInfo(m.ctx), 'create', spec);
      if (guard) return void refuse(res, m.row, m.actor, 'pppoe.create', spec.name, guard);
      send(res, 201, await createPppoe(m.ctx, sac(m.row, m.actor, 'pppoe.create', spec.name), spec));
    } catch (err) { writeErr(res, err); }
  });

  router.patch('/:id/pppoe/:pid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readPppoe(m.ctx);
    const c = view.clients.find((x) => x.id === req.params.pid);
    if (!requireOwned(res, c)) return;
    const spec = bodyToSpec((req.body ?? {}) as Record<string, unknown>);
    const errs = validatePppoeInput(spec, { create: false });
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'pppoe.edit', spec.name), `Edit PPPoE`, `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const guard = pppoeMgmtGuard(view.mgmt, 'edit', spec, c);
      if (guard) return void refuse(res, m.row, m.actor, 'pppoe.edit', req.params.pid, guard);
      send(res, 200, await editPppoe(m.ctx, sac(m.row, m.actor, 'pppoe.edit', req.params.pid), req.params.pid, spec));
    } catch (err) { writeErr(res, err); }
  });

  router.post('/:id/pppoe/:pid/enabled', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readPppoe(m.ctx);
    const c = view.clients.find((x) => x.id === req.params.pid);
    if (!requireOwned(res, c)) return;
    const disabled = (req.body ?? {}).disabled === true;
    try {
      if (disabled) { const guard = pppoeMgmtGuard(view.mgmt, 'disable', null, c); if (guard) return void refuse(res, m.row, m.actor, 'pppoe.disable', req.params.pid, guard); }
      send(res, 200, await setPppoeEnabled(m.ctx, sac(m.row, m.actor, disabled ? 'pppoe.disable' : 'pppoe.enable', req.params.pid), req.params.pid, disabled));
    } catch (err) { writeErr(res, err); }
  });

  router.delete('/:id/pppoe/:pid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readPppoe(m.ctx);
    const c = view.clients.find((x) => x.id === req.params.pid);
    if (!requireOwned(res, c)) return;
    try {
      const guard = pppoeMgmtGuard(view.mgmt, 'delete', null, c);
      if (guard) return void refuse(res, m.row, m.actor, 'pppoe.remove', req.params.pid, guard);
      send(res, 200, await removePppoe(m.ctx, sac(m.row, m.actor, 'pppoe.remove', req.params.pid), req.params.pid));
    } catch (err) { writeErr(res, err); }
  });

  router.post('/:id/pppoe/:pid/take-ownership', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const c = (await readPppoe(m.ctx)).clients.find((x) => x.id === req.params.pid);
    if (!c) { res.status(404).json({ error: 'PPPoE client not found.' }); return; }
    try { send(res, 200, await takeOwnershipPppoe(m.ctx, sac(m.row, m.actor, 'pppoe.take-ownership', req.params.pid), req.params.pid)); }
    catch (err) { writeErr(res, err); }
  });

  // ADD-BEFORE-REMOVE: replace the mgmt-path WAN with a new PPPoE session.
  router.post('/:id/pppoe/replace-wan', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const newInterface = typeof b.newInterface === 'string' ? b.newInterface.trim() : '';
    const user = typeof b.user === 'string' ? b.user.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!newInterface || !user || !password) { res.status(400).json({ error: 'newInterface, user and password are required.' }); return; }
    try {
      const r = await replaceWanPppoe(db, box, m.row, m.ctx.transport, sac(m.row, m.actor, 'pppoe.replace-wan', newInterface), { newInterface, user, password, serviceName: typeof b.serviceName === 'string' ? b.serviceName : undefined });
      res.status(r.result === 'applied' ? 200 : r.result === 'rejected' ? 400 : 502).json(r);
    } catch (err) { writeErr(res, err); }
  });

  return router;
}
