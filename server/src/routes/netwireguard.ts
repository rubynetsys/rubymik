import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import type { WriteTransport } from '../routeros/write.js';
import { readTarget, writeTarget, transportFor } from '../transport.js';
import { auditRejected, type SafeApplyOutcome } from '../safeapply.js';
import { isValidWgKey } from '../remoteaccess.js';
import {
  readWireguard, addInterface, addAddress, addPeer, removePeer, removeInterface,
  validateInterfaceInput, validatePeerInput, genSiteToSite, isValidEndpoint, isValidAllowedAddresses,
  MgmtTunnelProtected, type WgContext, type WgEnd,
} from '../netwireguard.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
  net_transport?: string | null; tunnel_ip?: string | null;
}

export function netwireguardRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });

  async function makeCtx(row: DeviceRow): Promise<WgContext> {
    const read = readTarget(box, row);
    const transport: WriteTransport = await transportFor(row, read);
    const write = (row.write_username_enc && row.write_password_enc) ? writeTarget(box, row) : read;
    return { read, write, transport, row };
  }

  // READ (any device; Home Lab included).
  router.get('/:id/wireguard', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try {
      const view = await readWireguard(await makeCtx(row));
      res.json({ manageable: !!(row.write_username_enc && row.write_password_enc), ...view });
    } catch (err) { res.status(502).json({ error: (err as Error).message }); }
  });

  async function requireManageable(req: Request, res: Response): Promise<{ row: DeviceRow; ctx: WgContext; actor: string } | null> {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    if (!row.write_username_enc || !row.write_password_enc) {
      res.status(403).json({ error: 'This device is monitor-only. Add a write credential to configure VPNs.' });
      return null;
    }
    try { return { row, ctx: await makeCtx(row), actor: actorOf(req) }; }
    catch (err) { res.status(502).json({ error: (err as Error).message }); return null; }
  }

  // Wrap an apply so MgmtTunnelProtected → 409 (the make-or-break protection).
  async function run(res: Response, okStatus: number, fn: () => Promise<SafeApplyOutcome>) {
    try {
      const outcome = await fn();
      res.status(outcome.result === 'applied' ? okStatus : 502).json(outcome);
    } catch (err) {
      if (err instanceof MgmtTunnelProtected) { res.status(409).json({ error: err.message, mgmtTunnelProtected: true }); return; }
      res.status(502).json({ error: (err as Error).message });
    }
  }

  // Create a user WG interface (router generates its own keypair).
  router.post('/:id/wireguard/interfaces', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const listenPort = b.listenPort == null || b.listenPort === '' ? null : Number(b.listenPort);
    const errs = validateInterfaceInput({ name, listenPort });
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'wg.iface.add', name), `Add WG interface ${name}`, `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    await run(res, 201, () => addInterface(m.ctx, sac(m.row, m.actor, 'wg.iface.add', name), { name, listenPort, comment: typeof b.comment === 'string' ? b.comment : null }));
  });

  router.delete('/:id/wireguard/interfaces/:ifaceId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    await run(res, 200, () => removeInterface(m.ctx, sac(m.row, m.actor, 'wg.iface.remove', req.params.ifaceId), req.params.ifaceId));
  });

  // Assign a tunnel address to a WG interface.
  router.post('/:id/wireguard/interfaces/:ifaceName/address', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cidr = typeof body.cidr === 'string' ? body.cidr.trim() : '';
    if (!/^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/.test(cidr)) { res.status(400).json({ error: 'Address must be a CIDR (e.g. 10.88.0.1/24).' }); return; }
    await run(res, 201, () => addAddress(m.ctx, sac(m.row, m.actor, 'wg.address.add', `${req.params.ifaceName} ${cidr}`), req.params.ifaceName, cidr));
  });

  // Add a peer.
  router.post('/:id/wireguard/interfaces/:ifaceName/peers', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const publicKey = typeof b.publicKey === 'string' ? b.publicKey.trim() : '';
    const endpoint = typeof b.endpoint === 'string' ? b.endpoint.trim() : '';
    const allowedAddress = typeof b.allowedAddress === 'string' ? b.allowedAddress.trim() : '';
    const keepalive = typeof b.keepalive === 'string' ? b.keepalive.trim() : '';
    const presharedKey = typeof b.presharedKey === 'string' && b.presharedKey ? b.presharedKey : undefined; // secret
    const errs = validatePeerInput({ publicKey, endpoint, allowedAddress, keepalive });
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'wg.peer.add', req.params.ifaceName), `Add WG peer on ${req.params.ifaceName}`, `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    await run(res, 201, () => addPeer(m.ctx, sac(m.row, m.actor, 'wg.peer.add', req.params.ifaceName), req.params.ifaceName, { publicKey, endpoint, allowedAddress, keepalive, presharedKey }));
  });

  router.delete('/:id/wireguard/peers/:peerId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    await run(res, 200, () => removePeer(m.ctx, sac(m.row, m.actor, 'wg.peer.remove', req.params.peerId), req.params.peerId));
  });

  // Site-to-site helper: generate matched configs for both ends (no write — the
  // local peer can then be applied via the peers endpoint; the far-end script is
  // for an unmanaged router).
  router.post('/:id/wireguard/site-to-site', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const localIface = typeof b.localIface === 'string' ? b.localIface : '';
    const local = b.local as Partial<WgEnd> | undefined;
    const remote = b.remote as Partial<WgEnd> | undefined;
    // read local iface public key
    const view = await readWireguard(m.ctx);
    const iface = view.interfaces.find((i) => i.name === localIface);
    if (!iface) { res.status(404).json({ error: 'Local WireGuard interface not found.' }); return; }
    if (iface.role === 'mgmt') { res.status(409).json({ error: 'The management tunnel cannot be used for a user site-to-site VPN.', mgmtTunnelProtected: true }); return; }
    if (!iface.publicKey) { res.status(400).json({ error: 'Local interface has no public key yet.' }); return; }
    if (!remote?.publicKey || !isValidWgKey(remote.publicKey)) { res.status(400).json({ error: 'Remote public key is required and must be a valid WireGuard key.' }); return; }
    if (!remote.endpoint || !isValidEndpoint(remote.endpoint)) { res.status(400).json({ error: 'Remote endpoint is required (host or host:port).' }); return; }
    if (!remote.tunnelSubnet || !isValidAllowedAddresses(remote.tunnelSubnet) || !local?.tunnelSubnet || !isValidAllowedAddresses(local.tunnelSubnet)) { res.status(400).json({ error: 'Both tunnel subnets must be valid CIDRs.' }); return; }
    const localEnd: WgEnd = { publicKey: iface.publicKey, endpoint: local?.endpoint ?? '', port: Number(local?.port) || 51820, tunnelSubnet: local.tunnelSubnet };
    const remoteEnd: WgEnd = { publicKey: remote.publicKey, endpoint: remote.endpoint, port: Number(remote.port) || 51820, tunnelSubnet: remote.tunnelSubnet };
    res.json(genSiteToSite(localEnd, remoteEnd, typeof b.remoteIface === 'string' ? b.remoteIface : undefined));
  });

  return router;
}
