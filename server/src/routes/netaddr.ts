import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import type { WriteTransport } from '../routeros/write.js';
import { readTarget, writeTarget, transportFor } from '../transport.js';
import { auditRejected } from '../safeapply.js';
import {
  readInterfaces, addAddress, removeAddress, setInterface, changeMgmtIp, validateAddress,
  type AddrContext,
} from '../netaddr.js';
import { writeErr } from '../snapshothook.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
  net_transport?: string | null; tunnel_ip?: string | null;
}

export function netaddrRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });

  async function makeCtx(row: DeviceRow): Promise<AddrContext> {
    const read = readTarget(box, row);
    const transport: WriteTransport = await transportFor(row, read);
    const write = (row.write_username_enc && row.write_password_enc) ? writeTarget(box, row) : read;
    return { read, write, transport, row };
  }

  // READ (any device).
  router.get('/:id/addresses', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try {
      const view = await readInterfaces(await makeCtx(row));
      res.json({ manageable: !!(row.write_username_enc && row.write_password_enc), ...view });
    } catch (err) { writeErr(res, err); }
  });

  async function requireManageable(req: Request, res: Response): Promise<{ row: DeviceRow; ctx: AddrContext; actor: string } | null> {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    if (!row.write_username_enc || !row.write_password_enc) {
      res.status(403).json({ error: 'This device is monitor-only. Add a write credential to configure addresses.' });
      return null;
    }
    try { return { row, ctx: await makeCtx(row), actor: actorOf(req) }; }
    catch (err) { writeErr(res, err); return null; }
  }

  // Add an address to an interface (additive — safe on any interface).
  router.post('/:id/addresses', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const iface = typeof b.interface === 'string' ? b.interface.trim() : '';
    const cidr = typeof b.cidr === 'string' ? b.cidr.trim() : '';
    if (!iface) { res.status(400).json({ error: 'An interface is required.' }); return; }
    const view = await readInterfaces(m.ctx);
    const errs = validateAddress(cidr, view.interfaces.flatMap((f) => f.addresses).map((a) => a.address ?? ''));
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'addr.add', `${iface} ${cidr}`), `Add address ${cidr}`, `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const o = await addAddress(m.ctx, sac(m.row, m.actor, 'addr.add', `${iface} ${cidr}`), iface, cidr);
      res.status(o.result === 'applied' ? 201 : 502).json(o);
    } catch (err) { writeErr(res, err); }
  });

  // Remove an address — REFUSED if it is the (only) management address.
  router.delete('/:id/addresses/:addrId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readInterfaces(m.ctx);
    const addr = view.interfaces.flatMap((f) => f.addresses).find((a) => a.id === req.params.addrId);
    if (!addr) { res.status(404).json({ error: 'Address not found.' }); return; }
    if (addr.isMgmt) {
      auditRejected(sac(m.row, m.actor, 'addr.remove', addr.address), `Remove ${addr.address}`, 'Blocked: this is the management address.');
      res.status(409).json({ error: `${addr.address} is the address RubyMIK reaches this router on. Removing it would instantly and unrecoverably cut management. To change it, use "Change management IP" (add-before-remove).`, mgmtAddressProtected: true });
      return;
    }
    try {
      const o = await removeAddress(m.ctx, sac(m.row, m.actor, 'addr.remove', addr.address), req.params.addrId);
      res.status(o.result === 'applied' ? 200 : 502).json(o);
    } catch (err) { writeErr(res, err); }
  });

  // Interface enable/disable/mtu/comment — REFUSE disabling the mgmt interface.
  router.patch('/:id/interfaces/:ifaceId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readInterfaces(m.ctx);
    const iface = view.interfaces.find((f) => f.id === req.params.ifaceId);
    if (!iface) { res.status(404).json({ error: 'Interface not found.' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: { disabled?: boolean; mtu?: string; comment?: string } = {};
    if (b.disabled !== undefined) patch.disabled = b.disabled === true;
    if (typeof b.mtu === 'string' && b.mtu) patch.mtu = b.mtu;
    if (typeof b.comment === 'string') patch.comment = b.comment;
    if (patch.disabled === true && iface.isMgmtInterface) {
      auditRejected(sac(m.row, m.actor, 'iface.set', iface.name), `Disable ${iface.name}`, 'Blocked: mgmt interface.');
      res.status(409).json({ error: `"${iface.name}" is the interface RubyMIK reaches this router through. Disabling it would instantly and unrecoverably cut management — refused.`, mgmtInterfaceProtected: true });
      return;
    }
    try {
      const o = await setInterface(m.ctx, sac(m.row, m.actor, 'iface.set', iface.name), req.params.ifaceId, patch);
      res.status(o.result === 'applied' ? 200 : 502).json(o);
    } catch (err) { writeErr(res, err); }
  });

  // Change the MANAGEMENT IP — always add-before-remove.
  router.post('/:id/mgmt-ip', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const mb = (req.body ?? {}) as Record<string, unknown>;
    const cidr = typeof mb.cidr === 'string' ? mb.cidr.trim() : '';
    try {
      const r = await changeMgmtIp(db, box, m.row, m.ctx.transport, sac(m.row, m.actor, 'addr.mgmt-ip', cidr), cidr);
      const code = r.result === 'applied' ? 200 : r.result === 'rejected' ? 400 : 502;
      res.status(code).json(r);
    } catch (err) { writeErr(res, err); }
  });

  return router;
}
