import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import type { WriteTransport } from '../routeros/write.js';
import { readTarget, writeTarget, transportFor } from '../transport.js';
import { auditRejected, type SafeApplyOutcome } from '../safeapply.js';
import {
  readL2, createBridge, addPort, createVlan, removeL2, setBridge, moveMgmtToBridge,
  validateBridge, validateVlan, vlanFilteringKeepsMgmt, type L2Context,
} from '../netl2.js';
import { writeErr } from '../snapshothook.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
  net_transport?: string | null; tunnel_ip?: string | null;
}

export function netl2Routes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });

  async function makeCtx(row: DeviceRow): Promise<L2Context> {
    const read = readTarget(box, row);
    const transport: WriteTransport = await transportFor(row, read);
    const write = (row.write_username_enc && row.write_password_enc) ? writeTarget(box, row) : read;
    return { read, write, transport, row };
  }
  const send = (res: Response, ok: number, o: SafeApplyOutcome) => res.status(o.result === 'applied' ? ok : 502).json(o);
  const l2Refuse = (res: Response, row: DeviceRow, actor: string, action: string, label: string, msg: string) => {
    auditRejected(sac(row, actor, action, label), `L2 ${action}`, `Blocked by L2 mgmt-path guard: ${msg}`);
    res.status(409).json({ error: msg, l2MgmtPathGuard: true });
  };

  // READ (any device).
  router.get('/:id/l2', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try { res.json({ manageable: !!(row.write_username_enc && row.write_password_enc), ...(await readL2(await makeCtx(row))) }); }
    catch (err) { writeErr(res, err); }
  });

  async function requireManageable(req: Request, res: Response) {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    if (!row.write_username_enc || !row.write_password_enc) { res.status(403).json({ error: 'This device is monitor-only. Add a write credential to configure L2.' }); return null; }
    try { return { row, ctx: await makeCtx(row), actor: actorOf(req) }; }
    catch (err) { writeErr(res, err); return null; }
  }

  // ---- bridges ----
  router.post('/:id/l2/bridges', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const view = await readL2(m.ctx);
    const errs = validateBridge(name, [...view.bridges.map((x) => x.name), ...view.vlans.map((x) => x.name)]);
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'l2.bridge.add', name), `Add bridge ${name}`, `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try { send(res, 201, await createBridge(m.ctx, sac(m.row, m.actor, 'l2.bridge.add', name), name, b.vlanFiltering === true)); }
    catch (err) { writeErr(res, err); }
  });

  router.patch('/:id/l2/bridges/:bridgeId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readL2(m.ctx);
    const br = view.bridges.find((x) => x.id === req.params.bridgeId);
    if (!br) { res.status(404).json({ error: 'Bridge not found.' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: { vlanFiltering?: boolean; disabled?: boolean; comment?: string } = {};
    if (b.vlanFiltering !== undefined) patch.vlanFiltering = b.vlanFiltering === true;
    if (b.disabled !== undefined) patch.disabled = b.disabled === true;
    if (typeof b.comment === 'string') patch.comment = b.comment;
    if (br.isMgmt && patch.disabled === true) return void l2Refuse(res, m.row, m.actor, 'l2.bridge.set', br.name, `"${br.name}" is the bridge the management IP lives on — disabling it would instantly sever management. Refused.`);
    // THE classic lock: enabling vlan-filtering on the mgmt bridge without the mgmt VLAN carried on the mgmt port.
    if (br.isMgmt && patch.vlanFiltering === true && !vlanFilteringKeepsMgmt(view)) {
      return void l2Refuse(res, m.row, m.actor, 'l2.bridge.set', br.name, `Enabling vlan-filtering on the management bridge "${br.name}" would cut management: the management port isn't carried by a bridge-VLAN entry (untagged for its PVID, or tagged for the mgmt VLAN). Configure the management VLAN in the bridge-VLAN table first. Refused — this is the classic MikroTik L2 self-lock.`);
    }
    try { send(res, 200, await setBridge(m.ctx, sac(m.row, m.actor, 'l2.bridge.set', br.name), req.params.bridgeId, patch)); }
    catch (err) { writeErr(res, err); }
  });

  router.delete('/:id/l2/bridges/:bridgeId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readL2(m.ctx);
    const br = view.bridges.find((x) => x.id === req.params.bridgeId);
    if (!br) { res.status(404).json({ error: 'Bridge not found.' }); return; }
    if (br.isMgmt) return void l2Refuse(res, m.row, m.actor, 'l2.bridge.remove', br.name, `"${br.name}" carries the management IP — deleting it would strand management with no recovery. Refused (use "Move management onto a new bridge" for a safe add-before-remove restructure).`);
    try { send(res, 200, await removeL2(m.ctx, sac(m.row, m.actor, 'l2.bridge.remove', br.name), '/interface/bridge', req.params.bridgeId, `bridge "${br.name}"`)); }
    catch (err) { writeErr(res, err); }
  });

  // ---- bridge ports ----
  router.post('/:id/l2/ports', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const bridge = typeof b.bridge === 'string' ? b.bridge.trim() : '';
    const iface = typeof b.interface === 'string' ? b.interface.trim() : '';
    const pvid = b.pvid == null || b.pvid === '' ? undefined : Number(b.pvid);
    if (!bridge || !iface) { res.status(400).json({ error: 'bridge and interface are required.' }); return; }
    if (pvid !== undefined && (!Number.isInteger(pvid) || pvid < 1 || pvid > 4094)) { res.status(400).json({ error: 'PVID must be 1–4094.' }); return; }
    // Guard: don't enslave the mgmt interface/port into a bridge (strands its IP).
    const view = await readL2(m.ctx);
    if (view.path.mgmtPorts.includes(iface) || iface === view.path.mgmtInterface) {
      return void l2Refuse(res, m.row, m.actor, 'l2.port.add', iface, `"${iface}" carries the management path. Moving it into a bridge would strand the management IP. Refused (use "Move management onto a new bridge" for a safe restructure).`);
    }
    try { send(res, 201, await addPort(m.ctx, sac(m.row, m.actor, 'l2.port.add', `${iface}→${bridge}`), bridge, iface, pvid)); }
    catch (err) { writeErr(res, err); }
  });

  router.delete('/:id/l2/ports/:portId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readL2(m.ctx);
    const port = view.bridges.flatMap((x) => x.ports).find((p) => p.id === req.params.portId);
    if (!port) { res.status(404).json({ error: 'Port not found.' }); return; }
    const pIface = port.interface ?? '?';
    if (port.isMgmtPort) return void l2Refuse(res, m.row, m.actor, 'l2.port.remove', pIface, `Removing "${pIface}" from the management bridge would strand management. Refused.`);
    try { send(res, 200, await removeL2(m.ctx, sac(m.row, m.actor, 'l2.port.remove', pIface), '/interface/bridge/port', req.params.portId, `port ${pIface}`)); }
    catch (err) { writeErr(res, err); }
  });

  // ---- VLAN interfaces ----
  router.post('/:id/l2/vlans', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const vlanId = Number(b.vlanId);
    const iface = typeof b.interface === 'string' ? b.interface.trim() : '';
    const view = await readL2(m.ctx);
    const errs = validateVlan(name, vlanId, iface, [...view.bridges.map((x) => x.name), ...view.vlans.map((x) => x.name)]);
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'l2.vlan.add', name), `Add VLAN ${name}`, `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try { send(res, 201, await createVlan(m.ctx, sac(m.row, m.actor, 'l2.vlan.add', name), name, vlanId, iface)); }
    catch (err) { writeErr(res, err); }
  });

  router.delete('/:id/l2/vlans/:vlanId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readL2(m.ctx);
    const v = view.vlans.find((x) => x.id === req.params.vlanId);
    if (!v) { res.status(404).json({ error: 'VLAN not found.' }); return; }
    if (v.isMgmt) return void l2Refuse(res, m.row, m.actor, 'l2.vlan.remove', v.name, `"${v.name}" is the VLAN the management IP lives on — deleting it would sever management. Refused.`);
    try { send(res, 200, await removeL2(m.ctx, sac(m.row, m.actor, 'l2.vlan.remove', v.name), '/interface/vlan', req.params.vlanId, `VLAN "${v.name}"`)); }
    catch (err) { writeErr(res, err); }
  });

  // ---- ADD-BEFORE-REMOVE at L2: move mgmt onto a new bridge ----
  router.post('/:id/l2/move-mgmt', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const newBridge = typeof b.newBridge === 'string' ? b.newBridge.trim() : '';
    const port = typeof b.port === 'string' ? b.port.trim() : '';
    const newCidr = typeof b.newCidr === 'string' ? b.newCidr.trim() : '';
    if (!newBridge || !port || !newCidr) { res.status(400).json({ error: 'newBridge, port and newCidr are required.' }); return; }
    try {
      const r = await moveMgmtToBridge(db, box, m.row, m.ctx.transport, sac(m.row, m.actor, 'l2.move-mgmt', newBridge), { newBridge, port, newCidr });
      res.status(r.result === 'applied' ? 200 : r.result === 'rejected' ? 400 : 502).json(r);
    } catch (err) { writeErr(res, err); }
  });

  return router;
}
