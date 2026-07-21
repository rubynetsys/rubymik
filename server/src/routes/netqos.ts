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
  readQos, mgmtInfo, validateQueueInput, queueMgmtGuard, queueToSpec,
  createQueue, editQueue, setQueueEnabled, removeQueue, moveQueue, takeOwnershipQueue,
  type QosContext, type SimpleQueue, type QueueSpec,
} from '../netqos.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
  net_transport?: string | null; tunnel_ip?: string | null;
}

function bodyToSpec(b: Record<string, unknown>): QueueSpec {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  return {
    name: str(b.name) ?? '', target: str(b.target),
    maxLimitUp: str(b.maxLimitUp), maxLimitDown: str(b.maxLimitDown), limitAtUp: str(b.limitAtUp), limitAtDown: str(b.limitAtDown),
    burstLimit: str(b.burstLimit), burstThreshold: str(b.burstThreshold), burstTime: str(b.burstTime),
    priority: str(b.priority), parent: str(b.parent), queueType: str(b.queueType), timeSchedule: str(b.timeSchedule),
    comment: str(b.comment), disabled: b.disabled === true,
  };
}

export function netqosRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });
  async function makeCtx(row: DeviceRow): Promise<QosContext> {
    const read = readTarget(box, row);
    const transport: WriteTransport = await transportFor(row, read);
    const write = (row.write_username_enc && row.write_password_enc) ? writeTarget(box, row) : read;
    return { read, write, transport, row };
  }
  const send = (res: Response, ok: number, o: SafeApplyOutcome) => res.status(o.result === 'applied' ? ok : o.result === 'rolled_back' ? 409 : 502).json(o);
  const qosRefuse = (res: Response, row: DeviceRow, actor: string, action: string, label: string, msg: string) => {
    auditRejected(sac(row, actor, action, label), `QoS ${action}`, `Blocked by QoS mgmt guard: ${msg}`);
    res.status(409).json({ error: msg, queueMgmtGuard: true });
  };

  router.get('/:id/qos', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try { res.json({ manageable: !!(row.write_username_enc && row.write_password_enc), ...(await readQos(await makeCtx(row))) }); }
    catch (err) { writeErr(res, err); }
  });

  async function requireManageable(req: Request, res: Response) {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    if (!row.write_username_enc || !row.write_password_enc) { res.status(403).json({ error: 'This device is monitor-only. Add a write credential to configure QoS.' }); return null; }
    try { return { row, ctx: await makeCtx(row), actor: actorOf(req) }; }
    catch (err) { writeErr(res, err); return null; }
  }
  function requireOwned(res: Response, q: SimpleQueue | undefined): q is SimpleQueue {
    if (!q) { res.status(404).json({ error: 'Queue not found.' }); return false; }
    if (!q.managed) { res.status(409).json({ error: 'This queue was created outside RubyMIK. Take ownership of it first to edit/move/remove it.', ownershipRequired: true }); return false; }
    return true;
  }

  router.post('/:id/qos', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const spec = bodyToSpec((req.body ?? {}) as Record<string, unknown>);
    const errs = validateQueueInput(spec);
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'queue.create', spec.name), `Add queue`, `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const guard = queueMgmtGuard(await mgmtInfo(m.ctx), spec);
      if (guard) return void qosRefuse(res, m.row, m.actor, 'queue.create', spec.name, guard);
      send(res, 201, await createQueue(m.ctx, sac(m.row, m.actor, 'queue.create', spec.name), spec));
    } catch (err) { writeErr(res, err); }
  });

  router.patch('/:id/qos/:qid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readQos(m.ctx);
    const q = view.queues.find((x) => x.id === req.params.qid);
    if (!requireOwned(res, q)) return;
    const spec = bodyToSpec((req.body ?? {}) as Record<string, unknown>);
    const errs = validateQueueInput(spec);
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'queue.edit', spec.name), `Edit queue`, `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const guard = queueMgmtGuard(view.mgmt, spec);
      if (guard) return void qosRefuse(res, m.row, m.actor, 'queue.edit', req.params.qid, guard);
      send(res, 200, await editQueue(m.ctx, sac(m.row, m.actor, 'queue.edit', req.params.qid), req.params.qid, spec));
    } catch (err) { writeErr(res, err); }
  });

  router.post('/:id/qos/:qid/enabled', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readQos(m.ctx);
    const q = view.queues.find((x) => x.id === req.params.qid);
    if (!requireOwned(res, q)) return;
    const disabled = (req.body ?? {}).disabled === true;
    try {
      if (!disabled) { const guard = queueMgmtGuard(view.mgmt, { ...queueToSpec(q!), disabled: false }); if (guard) return void qosRefuse(res, m.row, m.actor, 'queue.enable', req.params.qid, guard); }
      send(res, 200, await setQueueEnabled(m.ctx, sac(m.row, m.actor, disabled ? 'queue.disable' : 'queue.enable', req.params.qid), req.params.qid, disabled));
    } catch (err) { writeErr(res, err); }
  });

  router.delete('/:id/qos/:qid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const q = (await readQos(m.ctx)).queues.find((x) => x.id === req.params.qid);
    if (!requireOwned(res, q)) return;
    try { send(res, 200, await removeQueue(m.ctx, sac(m.row, m.actor, 'queue.remove', req.params.qid), req.params.qid)); }
    catch (err) { writeErr(res, err); }
  });

  router.post('/:id/qos/:qid/move', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const q = (await readQos(m.ctx)).queues.find((x) => x.id === req.params.qid);
    if (!requireOwned(res, q)) return;
    const destId = typeof (req.body ?? {}).destId === 'string' ? (req.body as { destId: string }).destId : null;
    try { send(res, 200, await moveQueue(m.ctx, sac(m.row, m.actor, 'queue.move', req.params.qid), req.params.qid, destId)); }
    catch (err) { writeErr(res, err); }
  });

  router.post('/:id/qos/:qid/take-ownership', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const q = (await readQos(m.ctx)).queues.find((x) => x.id === req.params.qid);
    if (!q) { res.status(404).json({ error: 'Queue not found.' }); return; }
    try { send(res, 200, await takeOwnershipQueue(m.ctx, sac(m.row, m.actor, 'queue.take-ownership', req.params.qid), req.params.qid)); }
    catch (err) { writeErr(res, err); }
  });

  return router;
}
