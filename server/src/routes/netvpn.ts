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
  readVpn, mgmtInfo, vpnMgmtGuard, genOvpnClientConfig,
  validateTunnelInput, validatePppSecretInput,
  createTunnel, editTunnel, setTunnelEnabled, removeTunnel, takeOwnershipTunnel,
  createSecret, editSecret, setSecretEnabled, removeSecret, takeOwnershipSecret, setServerEnabled,
  TUNNEL_PROTOS,
  type VpnContext, type TunnelProto, type TunnelSpec, type PppSecretSpec, type TunnelClient, type PppSecret,
} from '../netvpn.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
  net_transport?: string | null; tunnel_ip?: string | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const secret = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

function bodyToTunnelSpec(bd: Record<string, unknown>): TunnelSpec {
  return {
    proto: bd.proto as TunnelProto, name: str(bd.name) ?? '', connectTo: str(bd.connectTo), user: str(bd.user),
    password: secret(bd.password), profile: str(bd.profile), ipsecSecret: secret(bd.ipsecSecret), useIpsec: bool(bd.useIpsec),
    certificate: typeof bd.certificate === 'string' ? bd.certificate.trim() : undefined, verifyServerCert: bool(bd.verifyServerCert),
    disabled: bd.disabled === true, comment: str(bd.comment),
  };
}
function bodyToSecretSpec(bd: Record<string, unknown>): PppSecretSpec {
  return {
    name: str(bd.name) ?? '', password: secret(bd.password), service: str(bd.service), profile: str(bd.profile),
    localAddress: str(bd.localAddress), remoteAddress: str(bd.remoteAddress), disabled: bd.disabled === true, comment: str(bd.comment),
  };
}

export function netvpnRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });
  async function makeCtx(row: DeviceRow): Promise<VpnContext> {
    const read = readTarget(box, row);
    const transport: WriteTransport = await transportFor(row, read);
    const write = (row.write_username_enc && row.write_password_enc) ? writeTarget(box, row) : read;
    return { read, write, transport, row };
  }
  const send = (res: Response, ok: number, o: SafeApplyOutcome) => res.status(o.result === 'applied' ? ok : o.result === 'rolled_back' ? 409 : 502).json(o);
  const refuse = (res: Response, row: DeviceRow, actor: string, action: string, label: string, msg: string) => {
    auditRejected(sac(row, actor, action, label), `VPN ${action}`, `Blocked by VPN mgmt guard: ${msg}`);
    res.status(409).json({ error: msg, vpnMgmtGuard: true });
  };

  // READ (any device; Home Lab included).
  router.get('/:id/vpn', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try { res.json({ manageable: !!(row.write_username_enc && row.write_password_enc), ...(await readVpn(await makeCtx(row))) }); }
    catch (err) { writeErr(res, err); }
  });

  async function requireManageable(req: Request, res: Response) {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    if (!row.write_username_enc || !row.write_password_enc) { res.status(403).json({ error: 'This device is monitor-only. Add a write credential to configure VPNs.' }); return null; }
    try { return { row, ctx: await makeCtx(row), actor: actorOf(req) }; }
    catch (err) { writeErr(res, err); return null; }
  }
  function requireOwned<T extends { managed: boolean }>(res: Response, c: T | undefined, kind: string): c is T {
    if (!c) { res.status(404).json({ error: `${kind} not found.` }); return false; }
    if (!c.managed) { res.status(409).json({ error: `This ${kind.toLowerCase()} was created outside RubyMIK. Take ownership of it first to edit/disable/remove it.`, ownershipRequired: true }); return false; }
    return true;
  }
  const validProto = (p: string): p is TunnelProto => (TUNNEL_PROTOS as string[]).includes(p);

  // ---------------- tunnel clients ----------------

  router.post('/:id/vpn/tunnels', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const spec = bodyToTunnelSpec((req.body ?? {}) as Record<string, unknown>);
    const errs = validateTunnelInput(spec, { create: true });
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'vpn.tunnel.create', spec.name), 'Add VPN tunnel', `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try { send(res, 201, await createTunnel(m.ctx, sac(m.row, m.actor, 'vpn.tunnel.create', spec.name), spec)); }
    catch (err) { writeErr(res, err); }
  });

  router.patch('/:id/vpn/tunnels/:proto/:tid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const proto = req.params.proto; if (!validProto(proto)) { res.status(400).json({ error: 'Unknown protocol.' }); return; }
    const view = await readVpn(m.ctx);
    const c = view.clients.find((x) => x.proto === proto && x.id === req.params.tid);
    if (!requireOwned<TunnelClient>(res, c, 'Tunnel')) return;
    const spec = bodyToTunnelSpec({ ...(req.body ?? {}), proto });
    const errs = validateTunnelInput(spec, { create: false });
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'vpn.tunnel.edit', spec.name), 'Edit VPN tunnel', `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const guard = vpnMgmtGuard('edit', c);
      if (guard) return void refuse(res, m.row, m.actor, 'vpn.tunnel.edit', req.params.tid, guard);
      send(res, 200, await editTunnel(m.ctx, sac(m.row, m.actor, 'vpn.tunnel.edit', req.params.tid), proto, req.params.tid, spec));
    } catch (err) { writeErr(res, err); }
  });

  router.post('/:id/vpn/tunnels/:proto/:tid/enabled', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const proto = req.params.proto; if (!validProto(proto)) { res.status(400).json({ error: 'Unknown protocol.' }); return; }
    const view = await readVpn(m.ctx);
    const c = view.clients.find((x) => x.proto === proto && x.id === req.params.tid);
    if (!requireOwned<TunnelClient>(res, c, 'Tunnel')) return;
    const disabled = (req.body ?? {}).disabled === true;
    try {
      if (disabled) { const guard = vpnMgmtGuard('disable', c); if (guard) return void refuse(res, m.row, m.actor, 'vpn.tunnel.disable', req.params.tid, guard); }
      send(res, 200, await setTunnelEnabled(m.ctx, sac(m.row, m.actor, disabled ? 'vpn.tunnel.disable' : 'vpn.tunnel.enable', req.params.tid), proto, req.params.tid, disabled));
    } catch (err) { writeErr(res, err); }
  });

  router.delete('/:id/vpn/tunnels/:proto/:tid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const proto = req.params.proto; if (!validProto(proto)) { res.status(400).json({ error: 'Unknown protocol.' }); return; }
    const view = await readVpn(m.ctx);
    const c = view.clients.find((x) => x.proto === proto && x.id === req.params.tid);
    if (!requireOwned<TunnelClient>(res, c, 'Tunnel')) return;
    try {
      const guard = vpnMgmtGuard('delete', c);
      if (guard) return void refuse(res, m.row, m.actor, 'vpn.tunnel.remove', req.params.tid, guard);
      send(res, 200, await removeTunnel(m.ctx, sac(m.row, m.actor, 'vpn.tunnel.remove', req.params.tid), proto, req.params.tid));
    } catch (err) { writeErr(res, err); }
  });

  router.post('/:id/vpn/tunnels/:proto/:tid/take-ownership', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const proto = req.params.proto; if (!validProto(proto)) { res.status(400).json({ error: 'Unknown protocol.' }); return; }
    const c = (await readVpn(m.ctx)).clients.find((x) => x.proto === proto && x.id === req.params.tid);
    if (!c) { res.status(404).json({ error: 'Tunnel not found.' }); return; }
    try { send(res, 200, await takeOwnershipTunnel(m.ctx, sac(m.row, m.actor, 'vpn.tunnel.take-ownership', req.params.tid), proto, req.params.tid)); }
    catch (err) { writeErr(res, err); }
  });

  // ---------------- PPP secret accounts ----------------

  router.post('/:id/vpn/secrets', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const spec = bodyToSecretSpec((req.body ?? {}) as Record<string, unknown>);
    const errs = validatePppSecretInput(spec, { create: true });
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'vpn.secret.create', spec.name), 'Add PPP account', `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try { send(res, 201, await createSecret(m.ctx, sac(m.row, m.actor, 'vpn.secret.create', spec.name), spec)); }
    catch (err) { writeErr(res, err); }
  });

  router.patch('/:id/vpn/secrets/:sid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const c = (await readVpn(m.ctx)).secrets.find((x) => x.id === req.params.sid);
    if (!requireOwned<PppSecret>(res, c, 'PPP account')) return;
    const spec = bodyToSecretSpec((req.body ?? {}) as Record<string, unknown>);
    const errs = validatePppSecretInput(spec, { create: false });
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'vpn.secret.edit', spec.name), 'Edit PPP account', `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try { send(res, 200, await editSecret(m.ctx, sac(m.row, m.actor, 'vpn.secret.edit', req.params.sid), req.params.sid, spec)); }
    catch (err) { writeErr(res, err); }
  });

  router.post('/:id/vpn/secrets/:sid/enabled', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const c = (await readVpn(m.ctx)).secrets.find((x) => x.id === req.params.sid);
    if (!requireOwned<PppSecret>(res, c, 'PPP account')) return;
    const disabled = (req.body ?? {}).disabled === true;
    try { send(res, 200, await setSecretEnabled(m.ctx, sac(m.row, m.actor, disabled ? 'vpn.secret.disable' : 'vpn.secret.enable', req.params.sid), req.params.sid, disabled)); }
    catch (err) { writeErr(res, err); }
  });

  router.delete('/:id/vpn/secrets/:sid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const c = (await readVpn(m.ctx)).secrets.find((x) => x.id === req.params.sid);
    if (!requireOwned<PppSecret>(res, c, 'PPP account')) return;
    try { send(res, 200, await removeSecret(m.ctx, sac(m.row, m.actor, 'vpn.secret.remove', req.params.sid), req.params.sid)); }
    catch (err) { writeErr(res, err); }
  });

  router.post('/:id/vpn/secrets/:sid/take-ownership', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const c = (await readVpn(m.ctx)).secrets.find((x) => x.id === req.params.sid);
    if (!c) { res.status(404).json({ error: 'PPP account not found.' }); return; }
    try { send(res, 200, await takeOwnershipSecret(m.ctx, sac(m.row, m.actor, 'vpn.secret.take-ownership', req.params.sid), req.params.sid)); }
    catch (err) { writeErr(res, err); }
  });

  // ---------------- server enable/disable ----------------

  router.post('/:id/vpn/servers/:proto/enabled', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const proto = req.params.proto; if (!validProto(proto)) { res.status(400).json({ error: 'Unknown protocol.' }); return; }
    const enabled = (req.body ?? {}).enabled === true;
    try { send(res, 200, await setServerEnabled(m.ctx, sac(m.row, m.actor, enabled ? 'vpn.server.enable' : 'vpn.server.disable', proto), proto, enabled)); }
    catch (err) { writeErr(res, err); }
  });

  // ---------------- pure helper: .ovpn client profile (no secret) ----------------

  router.post('/:id/vpn/ovpn-config', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const bd = (req.body ?? {}) as Record<string, unknown>;
    try {
      const server = str(bd.server) ?? (await mgmtInfo(m.ctx)).mgmtIp;
      const config = genOvpnClientConfig({
        server, port: typeof bd.port === 'number' ? bd.port : undefined,
        proto: bd.proto === 'udp' ? 'udp' : 'tcp', caCertName: str(bd.caCertName), cipher: str(bd.cipher), auth: str(bd.auth),
      });
      res.json({ config });
    } catch (err) { writeErr(res, err); }
  });

  return router;
}
