// P43 — DNS filtering API. Two routers: dnsFilterRoutes (the single global resolver — settings +
// Save&apply reload-verify + health) mounted at /api/dns-filter, and dnsEnforceRoutes (per-device
// router enforcement — preview/apply/teardown) mounted at /api/devices.
import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import { readTarget, writeTarget, transportFor } from '../transport.js';
import type { WriteTransport } from '../routeros/write.js';
import { auditRejected, type SafeApplyOutcome } from '../safeapply.js';
import { writeErr } from '../snapshothook.js';
import { mgmtInfo } from '../netnat.js';
import {
  readEnforcement, buildEnforcementPlan, validateEnforceInput, dnsMgmtGuard, enforcementIsMgmtSafe,
  applyEnforcement, teardownEnforcement, type DnsContext, type DnsEnforceSpec,
} from '../netdns.js';
import { reloadAndVerify, dnsQuery } from '../resolver.js';
import { validateResolverSettings, type ResolverSettings } from '../dnsfilter.js';
import { loadResolverSettings, saveResolverSettings, loadEnforcement, saveEnforcement, clearEnforcement } from '../dnsfilterstore.js';
import type { Config } from '../config.js';

// ── global resolver (settings + apply + health) ──
export function dnsFilterRoutes(db: DatabaseSync, config: Config): Router {
  const router = Router();
  router.use(requireAuth(db));
  const df = config.dnsFilter;

  router.get('/settings', async (_req, res) => {
    let resolverUp: boolean | null = null;
    if (df.enabled) { try { await dnsQuery(df.dnsHost, df.dnsPort, 'cloudflare.com'); resolverUp = true; } catch { resolverUp = false; } }
    res.json({ enabled: df.enabled, settings: loadResolverSettings(db), resolverUp });
  });

  router.put('/settings', (req, res) => {
    const s = (req.body ?? {}) as ResolverSettings;
    const errs = validateResolverSettings(s);
    if (errs.length) { res.status(400).json({ error: errs.join(' ') }); return; }
    saveResolverSettings(db, s);
    res.json({ ok: true, settings: loadResolverSettings(db) });
  });

  // Save & apply: regenerate the Blocky config, restart the resolver, verify it blocks a probe.
  router.post('/apply', async (_req, res) => {
    if (!df.enabled) { res.status(409).json({ error: 'Filtering is not deployed — apply the docker-compose.filtering.yml override first.', notDeployed: true }); return; }
    const settings = loadResolverSettings(db);
    try {
      const r = await reloadAndVerify({ configPath: df.configPath, dockerSock: df.dockerSock, container: df.blockyContainer, probeHost: df.dnsHost, probePort: df.dnsPort, settings });
      res.status(r.ok ? 200 : 502).json(r);
    } catch (err) { writeErr(res, err); }
  });

  return router;
}

// ── per-device enforcement ──
interface DeviceRow {
  id: number; name: string; host: string; site_id: number | null; port: number | null;
  use_tls: number | null; verify_tls: number; net_transport: string | null; tunnel_ip: string | null;
  username_enc: string; password_enc: string; write_username_enc: string | null; write_password_enc: string | null;
}

export function dnsEnforceRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const f = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${f.sql}`).get(id, ...f.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });
  async function makeCtx(row: DeviceRow): Promise<DnsContext> {
    const read = readTarget(box, row);
    const transport: WriteTransport = await transportFor(row, read);
    const write = (row.write_username_enc && row.write_password_enc) ? writeTarget(box, row) : read;
    return { read, write, transport, row };
  }
  const send = (res: Response, ok: number, o: SafeApplyOutcome) =>
    res.status(o.result === 'applied' ? ok : o.result === 'rolled_back' ? 409 : 502).json(o);
  async function requireManageable(req: Request, res: Response) {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    if (!row.write_username_enc || !row.write_password_enc) { res.status(403).json({ error: 'This device is monitor-only. Add a write credential to enforce DNS filtering.' }); return null; }
    return { row, ctx: await makeCtx(row), actor: actorOf(req) };
  }

  router.get('/:id/dns-enforcement', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try { res.json(await readEnforcement(await makeCtx(row))); } catch (err) { writeErr(res, err); }
  });

  router.post('/:id/dns-enforcement/preview', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const spec = ((req.body ?? {}).spec ?? req.body) as DnsEnforceSpec;
    const errs = validateEnforceInput(spec);
    if (errs.length) { res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const mgmt = await mgmtInfo(m.ctx);
      const plan = buildEnforcementPlan(spec);
      res.json({ plan, guard: dnsMgmtGuard(mgmt, spec), mgmtSafe: enforcementIsMgmtSafe(plan, mgmt), current: await readEnforcement(m.ctx) });
    } catch (err) { writeErr(res, err); }
  });

  router.post('/:id/dns-enforcement', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const spec = ((req.body ?? {}).spec ?? req.body) as DnsEnforceSpec;
    const errs = validateEnforceInput(spec);
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'dns.enforce', null), 'Enforce DNS filtering', `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const guard = dnsMgmtGuard(await mgmtInfo(m.ctx), spec);
      if (guard) { auditRejected(sac(m.row, m.actor, 'dns.enforce', null), 'Enforce DNS filtering', `Blocked by DNS mgmt guard: ${guard}`); res.status(409).json({ error: guard, dnsMgmtGuard: true }); return; }
      const outcome = await applyEnforcement(m.ctx, sac(m.row, m.actor, 'dns.enforce', spec.resolverIp), spec);
      if (outcome.result === 'applied') {
        const prior = (outcome.after as { priorDns?: { servers: string; 'allow-remote-requests': string } } | undefined)?.priorDns ?? { servers: '', 'allow-remote-requests': 'no' };
        saveEnforcement(db, m.row.id, spec, prior);
      }
      send(res, 201, outcome);
    } catch (err) { writeErr(res, err); }
  });

  router.post('/:id/dns-enforcement/teardown', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    try {
      const stored = loadEnforcement(db, m.row.id);
      const prior = stored.priorDns ?? { servers: '', 'allow-remote-requests': 'no' };
      const outcome = await teardownEnforcement(m.ctx, sac(m.row, m.actor, 'dns.teardown', 'dns-filter'), prior);
      if (outcome.result === 'applied') clearEnforcement(db, m.row.id);
      send(res, 200, outcome);
    } catch (err) { writeErr(res, err); }
  });

  return router;
}
