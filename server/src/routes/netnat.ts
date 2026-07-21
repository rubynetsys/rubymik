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
  readNat, mgmtInfo, validateNatInput, natMgmtGuard, createNat, editNat, setNatEnabled, removeNat, moveNat, takeOwnershipNat,
  type NatContext, type NatRule, type NatRuleSpec,
} from '../netnat.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
  net_transport?: string | null; tunnel_ip?: string | null;
}

/** Build a rule SPEC from a client body (only the fields the builder sends). */
function bodyToSpec(b: Record<string, unknown>): NatRuleSpec {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  return {
    chain: str(b.chain) ?? '', action: str(b.action) ?? '',
    inInterface: str(b.inInterface), outInterface: str(b.outInterface), inInterfaceList: str(b.inInterfaceList), outInterfaceList: str(b.outInterfaceList),
    srcAddress: str(b.srcAddress), dstAddress: str(b.dstAddress), srcAddressList: str(b.srcAddressList), dstAddressList: str(b.dstAddressList),
    protocol: str(b.protocol), srcPort: str(b.srcPort), dstPort: str(b.dstPort), toAddresses: str(b.toAddresses), toPorts: str(b.toPorts),
    comment: str(b.comment), disabled: b.disabled === true,
  };
}
function ruleToSpec(r: NatRule): NatRuleSpec {
  return {
    chain: r.chain, action: r.action, inInterface: r.inInterface, outInterface: r.outInterface, inInterfaceList: r.inInterfaceList, outInterfaceList: r.outInterfaceList,
    srcAddress: r.srcAddress, dstAddress: r.dstAddress, srcAddressList: r.srcAddressList, dstAddressList: r.dstAddressList,
    protocol: r.protocol, srcPort: r.srcPort, dstPort: r.dstPort, toAddresses: r.toAddresses, toPorts: r.toPorts, comment: r.comment, disabled: r.disabled,
  };
}

export function netnatRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });

  async function makeCtx(row: DeviceRow): Promise<NatContext> {
    const read = readTarget(box, row);
    const transport: WriteTransport = await transportFor(row, read);
    const write = (row.write_username_enc && row.write_password_enc) ? writeTarget(box, row) : read;
    return { read, write, transport, row };
  }
  const send = (res: Response, ok: number, o: SafeApplyOutcome) => res.status(o.result === 'applied' ? ok : o.result === 'rolled_back' ? 409 : 502).json(o);
  const natRefuse = (res: Response, row: DeviceRow, actor: string, action: string, label: string, msg: string) => {
    auditRejected(sac(row, actor, action, label), `NAT ${action}`, `Blocked by NAT mgmt guard: ${msg}`);
    res.status(409).json({ error: msg, natMgmtGuard: true });
  };

  // READ (any device).
  router.get('/:id/nat', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try { res.json({ manageable: !!(row.write_username_enc && row.write_password_enc), ...(await readNat(await makeCtx(row))) }); }
    catch (err) { writeErr(res, err); }
  });

  async function requireManageable(req: Request, res: Response) {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    if (!row.write_username_enc || !row.write_password_enc) { res.status(403).json({ error: 'This device is monitor-only. Add a write credential to configure NAT.' }); return null; }
    try { return { row, ctx: await makeCtx(row), actor: actorOf(req) }; }
    catch (err) { writeErr(res, err); return null; }
  }
  /** Editing/moving/removing an UNMANAGED rule requires taking ownership first. */
  function requireOwned(res: Response, rule: NatRule | undefined): rule is NatRule {
    if (!rule) { res.status(404).json({ error: 'NAT rule not found.' }); return false; }
    if (!rule.managed) { res.status(409).json({ error: 'This rule was created outside RubyMIK. Take ownership of it first to edit/move/remove it.', ownershipRequired: true }); return false; }
    return true;
  }

  // CREATE.
  router.post('/:id/nat', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const spec = bodyToSpec((req.body ?? {}) as Record<string, unknown>);
    const errs = validateNatInput(spec);
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'nat.create', spec.action), `Add NAT rule`, `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const guard = natMgmtGuard(await mgmtInfo(m.ctx), spec);
      if (guard) return void natRefuse(res, m.row, m.actor, 'nat.create', spec.action, guard);
      send(res, 201, await createNat(m.ctx, sac(m.row, m.actor, 'nat.create', `${spec.chain} ${spec.action}`), spec));
    } catch (err) { writeErr(res, err); }
  });

  // EDIT.
  router.patch('/:id/nat/:rid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readNat(m.ctx);
    const rule = view.rules.find((r) => r.id === req.params.rid);
    if (!requireOwned(res, rule)) return;
    const spec = bodyToSpec((req.body ?? {}) as Record<string, unknown>);
    const errs = validateNatInput(spec);
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'nat.edit', spec.action), `Edit NAT rule`, `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const guard = natMgmtGuard(view.mgmt, spec);
      if (guard) return void natRefuse(res, m.row, m.actor, 'nat.edit', req.params.rid, guard);
      send(res, 200, await editNat(m.ctx, sac(m.row, m.actor, 'nat.edit', req.params.rid), req.params.rid, spec));
    } catch (err) { writeErr(res, err); }
  });

  // ENABLE / DISABLE.
  router.post('/:id/nat/:rid/enabled', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readNat(m.ctx);
    const rule = view.rules.find((r) => r.id === req.params.rid);
    if (!requireOwned(res, rule)) return;
    const disabled = (req.body ?? {}).disabled === true;
    try {
      // Enabling a rule can activate a mgmt-stealing shape → guard it (disable never guarded).
      if (!disabled) { const guard = natMgmtGuard(view.mgmt, { ...ruleToSpec(rule!), disabled: false }); if (guard) return void natRefuse(res, m.row, m.actor, 'nat.enable', req.params.rid, guard); }
      send(res, 200, await setNatEnabled(m.ctx, sac(m.row, m.actor, disabled ? 'nat.disable' : 'nat.enable', req.params.rid), req.params.rid, disabled));
    } catch (err) { writeErr(res, err); }
  });

  // REMOVE (never guard-refused; still safe-apply).
  router.delete('/:id/nat/:rid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const rule = (await readNat(m.ctx)).rules.find((r) => r.id === req.params.rid);
    if (!requireOwned(res, rule)) return;
    try { send(res, 200, await removeNat(m.ctx, sac(m.row, m.actor, 'nat.remove', req.params.rid), req.params.rid)); }
    catch (err) { writeErr(res, err); }
  });

  // MOVE (reorder — single move).
  router.post('/:id/nat/:rid/move', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const rule = (await readNat(m.ctx)).rules.find((r) => r.id === req.params.rid);
    if (!requireOwned(res, rule)) return;
    const destId = typeof (req.body ?? {}).destId === 'string' ? (req.body as { destId: string }).destId : null;
    try { send(res, 200, await moveNat(m.ctx, sac(m.row, m.actor, 'nat.move', req.params.rid), req.params.rid, destId)); }
    catch (err) { writeErr(res, err); }
  });

  // TAKE OWNERSHIP of an unmanaged rule.
  router.post('/:id/nat/:rid/take-ownership', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const rule = (await readNat(m.ctx)).rules.find((r) => r.id === req.params.rid);
    if (!rule) { res.status(404).json({ error: 'NAT rule not found.' }); return; }
    try { send(res, 200, await takeOwnershipNat(m.ctx, sac(m.row, m.actor, 'nat.take-ownership', req.params.rid), req.params.rid)); }
    catch (err) { writeErr(res, err); }
  });

  return router;
}
