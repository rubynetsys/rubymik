import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import type { WriteTransport } from '../routeros/write.js';
import { readTarget, writeTarget, transportFor } from '../transport.js';
import { auditRejected } from '../safeapply.js';
import {
  readDns, readNtp, applyDns, applyNtp, addStatic, editStatic, removeStatic,
  validateDnsServers, validateNtpServers, validateStaticEntry, isValidIpv4,
  type NetConfigContext,
} from '../netconfig.js';
import { writeErr } from '../snapshothook.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
  net_transport?: string | null; tunnel_ip?: string | null;
}

export function netconfigRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as Request & { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });

  // Read DNS + NTP (allowed on any device — reads are safe).
  router.get('/:id/netconfig', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    const read = readTarget(box, row);
    let transport: WriteTransport;
    try { transport = await transportFor(row, read); }
    catch (err) { writeErr(res, err); return; }
    const ctx: NetConfigContext = { read, write: read, transport };
    try {
      res.json({
        manageable: !!(row.write_username_enc && row.write_password_enc),
        dns: await readDns(ctx),
        ntp: await readNtp(ctx),
      });
    } catch (err) {
      writeErr(res, err);
    }
  });

  // Poll just NTP (for watching sync after enabling).
  router.get('/:id/netconfig/ntp', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    const read = readTarget(box, row);
    try {
      const transport = await transportFor(row, read);
      res.json(await readNtp({ read, write: read, transport }));
    } catch (err) { writeErr(res, err); }
  });

  async function requireManageable(req: Request, res: Response): Promise<{ row: DeviceRow; ctx: NetConfigContext; actor: string } | null> {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    if (!row.write_username_enc || !row.write_password_enc) {
      res.status(403).json({ error: 'This device is monitor-only. Add a write credential to manage DNS/NTP.' });
      return null;
    }
    const read = readTarget(box, row);
    let transport: WriteTransport;
    try { transport = await transportFor(row, read); }
    catch (err) { writeErr(res, err); return null; }
    const write = writeTarget(box, row);
    return { row, ctx: { read, write, transport }, actor: actorOf(req) };
  }

  // Set DNS.
  router.put('/:id/dns', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const servers = Array.isArray(b.servers) ? (b.servers as unknown[]).map(String).map((s) => s.trim()).filter(Boolean) : [];
    const allowRemoteRequests = b.allowRemoteRequests === true;
    const cacheSize = Number(b.cacheSize);
    const errs = validateDnsServers(servers);
    if (!Number.isInteger(cacheSize) || cacheSize < 128 || cacheSize > 200000) errs.push('Cache size must be 128–200000 KiB.');
    if (errs.length > 0) {
      auditRejected(sac(m.row, m.actor, 'dns.set', servers.join(',')), 'Set DNS', `Rejected: ${errs.join(' ')}`);
      res.status(400).json({ error: errs.join(' ') }); return;
    }
    try {
      const outcome = await applyDns(m.ctx, sac(m.row, m.actor, 'dns.set', servers.join(',')), { servers, allowRemoteRequests, cacheSize });
      res.status(outcome.result === 'applied' ? 200 : 502).json(outcome);
    } catch (err) { writeErr(res, err); }
  });

  // Set NTP.
  router.put('/:id/ntp', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const enabled = b.enabled === true;
    const servers = Array.isArray(b.servers) ? (b.servers as unknown[]).map(String).map((s) => s.trim()).filter(Boolean) : [];
    const errs = validateNtpServers(servers);
    if (enabled && servers.length === 0) errs.push('At least one NTP server is required to enable the client.');
    if (errs.length > 0) {
      auditRejected(sac(m.row, m.actor, 'ntp.set', servers.join(',')), 'Set NTP', `Rejected: ${errs.join(' ')}`);
      res.status(400).json({ error: errs.join(' ') }); return;
    }
    try {
      const outcome = await applyNtp(m.ctx, sac(m.row, m.actor, 'ntp.set', servers.join(',')), { enabled, servers });
      res.status(outcome.result === 'applied' ? 200 : 502).json(outcome);
    } catch (err) { writeErr(res, err); }
  });

  // Static DNS entries.
  router.post('/:id/dns/static', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const address = typeof b.address === 'string' ? b.address.trim() : '';
    const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim() : null;
    const errs = validateStaticEntry(name, address);
    if (errs.length > 0) {
      auditRejected(sac(m.row, m.actor, 'dns.static.add', `${name}/${address}`), `Add static DNS ${name}`, `Rejected: ${errs.join(' ')}`);
      res.status(400).json({ error: errs.join(' ') }); return;
    }
    try {
      const outcome = await addStatic(m.ctx, sac(m.row, m.actor, 'dns.static.add', `${name} → ${address}`), name, address, comment);
      res.status(outcome.result === 'applied' ? 201 : 502).json(outcome);
    } catch (err) { writeErr(res, err); }
  });

  router.patch('/:id/dns/static/:entryId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: { address?: string; comment?: string | null } = {};
    if (typeof b.address === 'string' && b.address.trim()) patch.address = b.address.trim();
    if (b.comment !== undefined) patch.comment = typeof b.comment === 'string' ? b.comment.trim() : null;
    if (patch.address !== undefined && !isValidIpv4(patch.address)) { res.status(400).json({ error: 'Address is not a valid IPv4 address.' }); return; }
    try {
      const outcome = await editStatic(m.ctx, sac(m.row, m.actor, 'dns.static.edit', req.params.entryId), req.params.entryId, patch);
      res.json(outcome);
    } catch (err) { writeErr(res, err); }
  });

  router.delete('/:id/dns/static/:entryId', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    try {
      const outcome = await removeStatic(m.ctx, sac(m.row, m.actor, 'dns.static.remove', req.params.entryId), req.params.entryId);
      res.json(outcome);
    } catch (err) { writeErr(res, err); }
  });

  return router;
}
