import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, siteScope, scopeFilter, type AccessScope } from '../scope.js';
import { restGet } from '../routeros/rest.js';
import type { DeviceTarget } from '../routeros/types.js';
import type { WriteTransport } from '../routeros/write.js';
import { readTarget, writeTarget, transportFor } from '../transport.js';
import {
  addReservation, editReservation, removeReservation, readReservations,
  validateReservation, isValidMac, isValidIpv4, type DhcpContext,
  readDhcpFull, dhcpMgmtInfo, dhcpMgmtGuard,
  validateServerInput, validatePoolInput, validateNetworkInput,
  createServer, setServerEnabled, removeServer, takeOwnershipServer,
  createPool, removePool, createNetwork, removeNetwork,
  type DhcpFullContext,
} from '../dhcp.js';
import { auditRejected, type SafeApplyOutcome } from '../safeapply.js';
import { log } from '../log.js';
import { writeErr } from '../snapshothook.js';

interface DeviceRow {
  id: number;
  name: string;
  host: string;
  port: number | null;
  use_tls: number | null;
  verify_tls: number;
  site_id: number | null;
  username_enc: string;
  password_enc: string;
  write_username_enc: string | null;
  write_password_enc: string | null;
  net_transport?: string | null;
  tunnel_ip?: string | null;
}

export function dhcpRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  function loadDevice(id: number): DeviceRow | undefined {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`)
      .get(id, ...filter.params) as unknown as DeviceRow | undefined;
  }

  /** Build a DhcpContext, or return null if the device is monitor-only. */
  function dhcpContext(row: DeviceRow, read: DeviceTarget, transport: WriteTransport): DhcpContext | null {
    if (!row.write_username_enc || !row.write_password_enc) return null;
    return { read, write: writeTarget(box, row), transport };
  }

  // ---- Read reservations + leases (works for monitor-only too, read-only) ----
  router.get('/:id/dhcp', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    const read = readTarget(box, row);
    let transport: WriteTransport;
    try {
      transport = await transportFor(row, read);
    } catch (err) {
      writeErr(res, err);
      return;
    }
    const ctx: DhcpContext = { read, write: read, transport };
    try {
      const { reservations, dynamic } = await readReservations(ctx);
      const servers = await restConnectServers(ctx);
      res.json({
        manageable: !!(row.write_username_enc && row.write_password_enc),
        servers,
        reservations,
        dynamic,
      });
    } catch (err) {
      writeErr(res, err);
    }
  });

  async function restConnectServers(ctx: DhcpContext) {
    const servers = await restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, '/ip/dhcp-server') as Array<Record<string, unknown>>;
    return servers.map((s) => ({ name: s.name, interface: s.interface, disabled: s.disabled === 'true' }));
  }

  // Guard: resolve a manageable context or send the right error.
  async function requireManageable(req: import('express').Request, res: import('express').Response): Promise<{ row: DeviceRow; ctx: DhcpContext; actor: string } | null> {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    const read = readTarget(box, row);
    let transport: WriteTransport;
    try {
      transport = await transportFor(row, read);
    } catch (err) {
      writeErr(res, err);
      return null;
    }
    const ctx = dhcpContext(row, read, transport);
    if (!ctx) {
      res.status(403).json({ error: 'This device is monitor-only. Add a write credential to manage it.' });
      return null;
    }
    const actor = (req as import('express').Request & { user: SessionUser }).user.username;
    return { row, ctx, actor };
  }

  function sac(row: DeviceRow, actor: string, action: string, target: string | null) {
    return { db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target };
  }

  // ---- Add reservation ----
  router.post('/:id/dhcp/reservations', async (req, res) => {
    const m = await requireManageable(req, res);
    if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const server = typeof b.server === 'string' ? b.server : '';
    const mac = typeof b.mac === 'string' ? b.mac.trim() : '';
    const address = typeof b.address === 'string' ? b.address.trim() : '';
    const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim() : null;
    const forceRollback = b._forceRollback === true; // TEST hook (applies then reverts)

    if (!server) { res.status(400).json({ error: 'A DHCP server must be selected.' }); return; }
    const errors = await validateReservation(m.ctx, server, { mac, address, comment });
    if (errors.length > 0) {
      const msg = errors.map((e) => e.message).join(' ');
      auditRejected(sac(m.row, m.actor, 'dhcp.reservation.add', `${address} / ${mac}`),
        `Add reservation ${address} → ${mac}`, `Rejected: ${msg}`);
      res.status(400).json({ error: msg, fields: errors });
      return;
    }
    try {
      const outcome = await addReservation(m.ctx, sac(m.row, m.actor, 'dhcp.reservation.add', `${address} / ${mac}`),
        server, { mac, address, comment }, forceRollback);
      res.status(outcome.result === 'applied' ? 201 : 200).json(outcome);
    } catch (err) {
      writeErr(res, err);
    }
  });

  // ---- Edit reservation ----
  router.patch('/:id/dhcp/reservations/:leaseId', async (req, res) => {
    const m = await requireManageable(req, res);
    if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: { address?: string; comment?: string | null } = {};
    if (typeof b.address === 'string' && b.address.trim()) patch.address = b.address.trim();
    if (b.comment !== undefined) patch.comment = typeof b.comment === 'string' ? b.comment.trim() : null;
    const forceRollback = b._forceRollback === true;

    if (patch.address !== undefined && !isValidIpv4(patch.address)) {
      res.status(400).json({ error: 'IP address is not a valid IPv4 address.' });
      return;
    }
    try {
      const outcome = await editReservation(m.ctx, sac(m.row, m.actor, 'dhcp.reservation.edit', req.params.leaseId),
        req.params.leaseId, patch, forceRollback);
      res.json(outcome);
    } catch (err) {
      writeErr(res, err);
    }
  });

  // ---- Remove reservation ----
  router.delete('/:id/dhcp/reservations/:leaseId', async (req, res) => {
    const m = await requireManageable(req, res);
    if (!m) return;
    const forceRollback = (req.query.forceRollback as string) === '1';
    try {
      // Own-lease guard: refuse to remove a lease that IS the management address.
      const { reservations, dynamic } = await readReservations(m.ctx);
      const lease = [...reservations, ...dynamic].find((l) => l['.id'] === req.params.leaseId);
      const mgmt = await dhcpMgmtInfo(fullCtx(m));
      const guard = dhcpMgmtGuard(mgmt, 'delete', 'lease', null, { leaseAddress: lease?.address ?? null });
      if (guard) { auditRejected(sac(m.row, m.actor, 'dhcp.reservation.remove', req.params.leaseId), 'Remove reservation', `Blocked by DHCP mgmt guard: ${guard}`); res.status(409).json({ error: guard, dhcpMgmtGuard: true }); return; }
      const outcome = await removeReservation(m.ctx, sac(m.row, m.actor, 'dhcp.reservation.remove', req.params.leaseId),
        req.params.leaseId, forceRollback);
      res.json(outcome);
    } catch (err) {
      writeErr(res, err);
    }
  });

  // ---- Make a dynamic lease static (same pipeline as add) ----
  router.post('/:id/dhcp/make-static', async (req, res) => {
    const m = await requireManageable(req, res);
    if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const leaseId = typeof b.leaseId === 'string' ? b.leaseId : '';
    const { dynamic } = await readReservations(m.ctx);
    const lease = dynamic.find((l) => l['.id'] === leaseId);
    if (!lease) { res.status(404).json({ error: 'Dynamic lease not found.' }); return; }
    const mac = lease['mac-address'] ?? '';
    const address = lease.address ?? '';
    const server = lease.server ?? '';
    if (!isValidMac(mac) || !isValidIpv4(address)) {
      res.status(400).json({ error: 'The dynamic lease is missing a valid MAC/IP.' });
      return;
    }
    const errors = await validateReservation(m.ctx, server, { mac, address });
    if (errors.length > 0) {
      const msg = errors.map((e) => e.message).join(' ');
      auditRejected(sac(m.row, m.actor, 'dhcp.reservation.make-static', `${address} / ${mac}`),
        `Pin ${address} → ${mac}`, `Rejected: ${msg}`);
      res.status(400).json({ error: msg });
      return;
    }
    try {
      const outcome = await addReservation(m.ctx, sac(m.row, m.actor, 'dhcp.reservation.make-static', `${address} / ${mac}`),
        server, { mac, address, comment: lease['host-name'] ?? null });
      res.status(outcome.result === 'applied' ? 201 : 200).json(outcome);
    } catch (err) {
      writeErr(res, err);
    }
  });

  // ============ P29 (DHCP): server / pool / network CRUD + dhcpMgmtGuard ============

  const fullCtx = (m: { row: DeviceRow; ctx: DhcpContext }): DhcpFullContext => ({ ...m.ctx, row: m.row as unknown as DhcpFullContext['row'] });
  const send = (res: import('express').Response, ok: number, o: SafeApplyOutcome) =>
    res.status(o.result === 'applied' ? ok : o.result === 'rolled_back' ? 409 : 502).json(o);
  const refuse = (res: import('express').Response, m: { row: DeviceRow; actor: string }, action: string, label: string, msg: string) => {
    auditRejected(sac(m.row, m.actor, action, label), `DHCP ${action}`, `Blocked by DHCP mgmt guard: ${msg}`);
    res.status(409).json({ error: msg, dhcpMgmtGuard: true });
  };

  // Full read (servers with mgmt annotations, pools, networks, leases). Any device.
  router.get('/:id/dhcp/full', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    const read = readTarget(box, row);
    try {
      const transport = await transportFor(row, read);
      const ctx: DhcpFullContext = { read, write: read, transport, row: row as unknown as DhcpFullContext['row'] };
      res.json({ manageable: !!(row.write_username_enc && row.write_password_enc), ...(await readDhcpFull(ctx)) });
    } catch (err) { writeErr(res, err); }
  });

  // ---- servers ----
  router.post('/:id/dhcp/servers', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const spec = { name: String(b.name ?? '').trim(), interface: String(b.interface ?? '').trim(), addressPool: typeof b.addressPool === 'string' ? b.addressPool : null, leaseTime: typeof b.leaseTime === 'string' ? b.leaseTime : null, comment: typeof b.comment === 'string' ? b.comment : null, disabled: b.disabled === true };
    const errs = validateServerInput(spec);
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'dhcp.server.create', spec.name), 'Add DHCP server', `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const guard = dhcpMgmtGuard(await dhcpMgmtInfo(fullCtx(m)), 'create', 'server', { interface: spec.interface }, null);
      if (guard) return void refuse(res, m, 'dhcp.server.create', spec.name, guard);
      send(res, 201, await createServer(fullCtx(m), sac(m.row, m.actor, 'dhcp.server.create', spec.name), spec));
    } catch (err) { writeErr(res, err); }
  });

  router.post('/:id/dhcp/servers/:sid/enabled', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const disabled = (req.body ?? {}).disabled === true;
    const view = await readDhcpFull(fullCtx(m));
    const srv = view.servers.find((x) => x.id === req.params.sid);
    if (!srv) { res.status(404).json({ error: 'DHCP server not found.' }); return; }
    if (!srv.managed) { res.status(409).json({ error: 'This DHCP server was created outside RubyMIK. Take ownership first.', ownershipRequired: true }); return; }
    try {
      if (disabled) { const guard = dhcpMgmtGuard(view.mgmt, 'disable', 'server', null, { interface: srv.interface }); if (guard) return void refuse(res, m, 'dhcp.server.disable', req.params.sid, guard); }
      send(res, 200, await setServerEnabled(fullCtx(m), sac(m.row, m.actor, disabled ? 'dhcp.server.disable' : 'dhcp.server.enable', req.params.sid), req.params.sid, disabled));
    } catch (err) { writeErr(res, err); }
  });

  router.delete('/:id/dhcp/servers/:sid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readDhcpFull(fullCtx(m));
    const srv = view.servers.find((x) => x.id === req.params.sid);
    if (!srv) { res.status(404).json({ error: 'DHCP server not found.' }); return; }
    if (!srv.managed) { res.status(409).json({ error: 'This DHCP server was created outside RubyMIK. Take ownership first.', ownershipRequired: true }); return; }
    try {
      const guard = dhcpMgmtGuard(view.mgmt, 'delete', 'server', null, { interface: srv.interface });
      if (guard) return void refuse(res, m, 'dhcp.server.remove', req.params.sid, guard);
      send(res, 200, await removeServer(fullCtx(m), sac(m.row, m.actor, 'dhcp.server.remove', req.params.sid), req.params.sid));
    } catch (err) { writeErr(res, err); }
  });

  router.post('/:id/dhcp/servers/:sid/take-ownership', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    try { send(res, 200, await takeOwnershipServer(fullCtx(m), sac(m.row, m.actor, 'dhcp.server.take-ownership', req.params.sid), req.params.sid)); }
    catch (err) { writeErr(res, err); }
  });

  // ---- pools ----
  router.post('/:id/dhcp/pools', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const spec = { name: String(b.name ?? '').trim(), ranges: String(b.ranges ?? '').trim(), comment: typeof b.comment === 'string' ? b.comment : null };
    const errs = validatePoolInput(spec);
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'dhcp.pool.create', spec.name), 'Add IP pool', `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try { send(res, 201, await createPool(fullCtx(m), sac(m.row, m.actor, 'dhcp.pool.create', spec.name), spec)); }
    catch (err) { writeErr(res, err); }
  });

  router.delete('/:id/dhcp/pools/:pid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readDhcpFull(fullCtx(m));
    const pool = view.pools.find((x) => x.id === req.params.pid);
    if (!pool) { res.status(404).json({ error: 'Pool not found.' }); return; }
    try {
      const guard = dhcpMgmtGuard(view.mgmt, 'delete', 'pool', null, { ranges: pool.ranges });
      if (guard) return void refuse(res, m, 'dhcp.pool.remove', req.params.pid, guard);
      send(res, 200, await removePool(fullCtx(m), sac(m.row, m.actor, 'dhcp.pool.remove', req.params.pid), req.params.pid));
    } catch (err) { writeErr(res, err); }
  });

  // ---- networks ----
  router.post('/:id/dhcp/networks', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const spec = { address: String(b.address ?? '').trim(), gateway: typeof b.gateway === 'string' ? b.gateway.trim() : null, dnsServer: typeof b.dnsServer === 'string' ? b.dnsServer.trim() : null, domain: typeof b.domain === 'string' ? b.domain.trim() : null, comment: typeof b.comment === 'string' ? b.comment : null };
    const errs = validateNetworkInput(spec);
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'dhcp.network.create', spec.address), 'Add DHCP network', `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try { send(res, 201, await createNetwork(fullCtx(m), sac(m.row, m.actor, 'dhcp.network.create', spec.address), spec)); }
    catch (err) { writeErr(res, err); }
  });

  router.delete('/:id/dhcp/networks/:nid', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const view = await readDhcpFull(fullCtx(m));
    const net = view.networks.find((x) => x.id === req.params.nid);
    if (!net) { res.status(404).json({ error: 'Network not found.' }); return; }
    try {
      const guard = dhcpMgmtGuard(view.mgmt, 'delete', 'network', null, { address: net.address });
      if (guard) return void refuse(res, m, 'dhcp.network.remove', req.params.nid, guard);
      send(res, 200, await removeNetwork(fullCtx(m), sac(m.row, m.actor, 'dhcp.network.remove', req.params.nid), req.params.nid));
    } catch (err) { writeErr(res, err); }
  });

  return router;
}

// ---- Audit log (separate small router) ----
export function auditRoutes(db: DatabaseSync): Router {
  const router = Router();
  router.use(requireAuth(db));

  function scopeFromQuery(siteParam: unknown): AccessScope | { error: string } {
    if (typeof siteParam === 'string' && siteParam !== '' && siteParam !== 'all') {
      const siteId = Number(siteParam);
      if (!Number.isInteger(siteId)) return { error: 'Invalid siteId.' };
      return siteScope([siteId]);
    }
    return allSites();
  }

  router.get('/', (req, res) => {
    const scope = scopeFromQuery(req.query.siteId);
    if ('error' in scope) { res.status(400).json({ error: scope.error }); return; }
    // Prune >180d on read — cheap, keeps SQLite light without a timer.
    db.prepare(`DELETE FROM config_audit WHERE created_at < datetime('now', '-180 days')`).run();
    // Audit rows keep device_name even if the device is later deleted; scope by
    // the device's current site when it still exists.
    const filter = scopeFilter(scope, 'd.site_id');
    const deviceId = req.query.deviceId ? Number(req.query.deviceId) : null;
    const rows = db.prepare(`
      SELECT a.* FROM config_audit a
      LEFT JOIN devices d ON d.id = a.device_id
      WHERE 1 = 1${filter.sql}${deviceId ? ' AND a.device_id = ?' : ''}
      ORDER BY a.created_at DESC LIMIT 200
    `).all(...filter.params, ...(deviceId ? [deviceId] : [])) as unknown as Array<Record<string, unknown>>;
    res.json(rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      deviceName: r.device_name,
      actor: r.actor,
      action: r.action,
      target: r.target,
      summary: r.summary,
      before: r.before_json ? JSON.parse(r.before_json as string) : null,
      after: r.after_json ? JSON.parse(r.after_json as string) : null,
      result: r.result,
      detail: r.detail,
      createdAt: r.created_at,
    })));
  });

  return router;
}
