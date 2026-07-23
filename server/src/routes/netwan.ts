// P42 — dual-WAN failover API. Mirrors routes/netnat.ts. Resolves DHCP-learned gateways +
// site DNS server-side (the wizard sends interfaces/types; we resolve the moving parts),
// runs the collision analysis as a gate, and applies via netwan's safe-apply ops.
import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import { readTarget, writeTarget, transportFor } from '../transport.js';
import type { WriteTransport } from '../routeros/write.js';
import { restGet } from '../routeros/rest.js';
import { auditRejected, type SafeApplyOutcome } from '../safeapply.js';
import { writeErr } from '../snapshothook.js';
import {
  readWan, validateFailoverInput, buildFailoverPlan, analyzeCollisions, dnsCollisions,
  applyFailover, teardownFailover, type WanContext, type FailoverSpec, type ExistingSnapshot,
} from '../netwan.js';

interface DeviceRow {
  id: number; name: string; host: string; site_id: number | null; port: number | null;
  use_tls: number | null; verify_tls: number; net_transport: string | null; tunnel_ip: string | null;
  username_enc: string; password_enc: string; write_username_enc: string | null; write_password_enc: string | null;
}
type Dict = Record<string, unknown>;

export function netwanRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const f = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${f.sql}`).get(id, ...f.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });
  async function makeCtx(row: DeviceRow): Promise<WanContext> {
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
    if (!row.write_username_enc || !row.write_password_enc) { res.status(403).json({ error: 'This device is monitor-only. Add a write credential to configure WAN failover.' }); return null; }
    return { row, ctx: await makeCtx(row), actor: actorOf(req) };
  }

  const get = (ctx: WanContext, p: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, p) as Promise<Dict[]>;
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const csv = (v: unknown) => str(v).split(',').map((x) => x.trim()).filter(Boolean);

  /** Resolve the moving parts (DHCP gateways + site DNS + existing config) and build the plan. */
  async function prepare(ctx: WanContext, spec: FailoverSpec) {
    const [dhcp, dnsRow, nets, rt, nat, mangle] = await Promise.all([
      get(ctx, '/ip/dhcp-client'), get(ctx, '/ip/dns'), get(ctx, '/ip/dhcp-server/network'),
      get(ctx, '/ip/route'), get(ctx, '/ip/firewall/nat'), get(ctx, '/ip/firewall/mangle'),
    ]);
    const resolved: FailoverSpec = JSON.parse(JSON.stringify(spec));
    for (const leg of [resolved.wan1, resolved.wan2]) {
      if (leg.sourceType === 'dhcp') { const c = dhcp.find((d) => str(d.interface) === leg.interface); leg.gateway = str(c?.gateway) || leg.gateway; }
    }
    const siteDns = [...csv(dnsRow[0]?.servers), ...nets.flatMap((n) => csv(n['dns-server']))];
    const existing: ExistingSnapshot = {
      routes: rt.map((r) => ({ id: str(r['.id']), dst: str(r['dst-address']), distance: str(r.distance), comment: str(r.comment), dynamic: str(r.dynamic) === 'true' })),
      nat: nat.map((r) => ({ id: str(r['.id']), outInterface: str(r['out-interface']), action: str(r.action), chain: str(r.chain), comment: str(r.comment) })),
      mangleMarks: [...new Set(mangle.flatMap((r) => [r['new-connection-mark'], r['new-routing-mark'], r['connection-mark'], r['routing-mark']].map(str).filter(Boolean)))],
    };
    return { resolved, plan: buildFailoverPlan(resolved), analysis: analyzeCollisions(resolved, existing), dnsCollisions: dnsCollisions(resolved, siteDns) };
  }

  // ── read: current status + managed objects ──
  router.get('/:id/wan-failover', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try { res.json(await readWan(await makeCtx(row))); } catch (err) { writeErr(res, err); }
  });

  // ── preview: the exact plan + collision analysis + DNS collisions (nothing applied) ──
  router.post('/:id/wan-failover/preview', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const spec = ((req.body ?? {}).spec ?? req.body) as FailoverSpec;
    const errs = validateFailoverInput(spec);
    if (errs.length) { res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const { plan, analysis, dnsCollisions: dc } = await prepare(m.ctx, spec);
      res.json({ plan, analysis, dnsCollisions: dc, current: await readWan(m.ctx) });
    } catch (err) { writeErr(res, err); }
  });

  // ── apply: validate → collision gate (409) → safe-apply ──
  router.post('/:id/wan-failover', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    const spec = ((req.body ?? {}).spec ?? req.body) as FailoverSpec;
    const errs = validateFailoverInput(spec);
    if (errs.length) { auditRejected(sac(m.row, m.actor, 'wan.failover.setup', null), 'Set up WAN failover', `Rejected: ${errs.join(' ')}`); res.status(400).json({ error: errs.join(' ') }); return; }
    try {
      const { resolved, analysis } = await prepare(m.ctx, spec);
      if (!analysis.ok) {
        auditRejected(sac(m.row, m.actor, 'wan.failover.setup', null), 'Set up WAN failover', `Refused (collision): ${analysis.messages.join(' ')}`);
        res.status(409).json({ error: analysis.messages.join(' '), wanCollision: true, analysis }); return;
      }
      const outcome = await applyFailover(m.ctx, sac(m.row, m.actor, 'wan.failover.setup', 'dual-WAN'), resolved);
      if (outcome.result === 'applied') {
        // Persist the retired default(s) verbatim so teardown hands back the exact original line.
        const removedDefaults = (outcome.after as { removedDefaults?: Record<string, string>[] } | undefined)?.removedDefaults ?? [];
        const cfg = { wan1: { interface: resolved.wan1.interface, sourceType: resolved.wan1.sourceType }, wan2: { interface: resolved.wan2.interface, sourceType: resolved.wan2.sourceType }, mode: resolved.mode ?? 'fresh', originalDefaults: removedDefaults };
        db.prepare('UPDATE device_status SET wan_config_json = ? WHERE device_id = ?').run(JSON.stringify(cfg), m.row.id);
      }
      send(res, 201, outcome);
    } catch (err) { writeErr(res, err); }
  });

  // ── teardown: remove only RUBYMIK-WAN objects ──
  router.post('/:id/wan-failover/teardown', async (req, res) => {
    const m = await requireManageable(req, res); if (!m) return;
    try {
      const cfgRow = db.prepare('SELECT wan_config_json FROM device_status WHERE device_id = ?').get(m.row.id) as { wan_config_json: string | null } | undefined;
      let originalDefaults: Record<string, string>[] = [];
      if (cfgRow?.wan_config_json) { try { originalDefaults = (JSON.parse(cfgRow.wan_config_json).originalDefaults ?? []) as Record<string, string>[]; } catch { /* corrupt cfg → restore nothing */ } }
      const outcome = await teardownFailover(m.ctx, sac(m.row, m.actor, 'wan.failover.teardown', 'dual-WAN'), originalDefaults);
      if (outcome.result === 'applied') db.prepare('UPDATE device_status SET wan_config_json = NULL, wan_state_json = NULL WHERE device_id = ?').run(m.row.id);
      send(res, 200, outcome);
    } catch (err) { writeErr(res, err); }
  });

  return router;
}
