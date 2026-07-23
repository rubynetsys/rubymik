import { Router, type Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import { restConnect } from '../routeros/rest.js';
import type { DeviceTarget } from '../routeros/types.js';
import { writeAudit } from '../safeapply.js';
import {
  validateSpec, generateBaseline, baselineTunnelBootstrap, baselineFirewall,
  type BaselineSpec,
} from '../provision.js';
import { liveApplyBaseline, type ProvCtx } from '../provisionapply.js';
import { allocateTunnelIp, createPeer, type HubConfig, type PeerRow } from '../remoteaccess.js';
import { log } from '../log.js';
import { writeErr } from '../snapshothook.js';

/**
 * New-router provisioning (P11). Orchestrates the pure generator (provision.ts),
 * the P9 tunnel, the P6 firewall (via the generator), and the Mode B live-apply.
 * Nothing here re-derives rules — it validates, generates, or applies.
 */
export function provisionRoutes(db: DatabaseSync): Router {
  const router = Router();
  router.use(requireAuth(db));
  const actorOf = (req: Request) => (req as Request & { user: SessionUser }).user.username;
  const audit = (actor: string, action: string, target: string | null, detail: string, result = 'applied') =>
    writeAudit({ db, actor, deviceId: null as unknown as number, deviceName: 'provision', action, targetLabel: target }, result as never, detail, null, null, detail);

  function parseSpec(body: unknown): BaselineSpec {
    const b = (body ?? {}) as Record<string, unknown>;
    const s = (b.spec ?? {}) as Record<string, unknown>;
    return s as unknown as BaselineSpec;
  }

  function hubConfig(): HubConfig | null {
    const r = db.prepare('SELECT endpoint, listen_port, overlay_cidr, hub_address, public_key, enabled FROM wg_hub WHERE id = 1').get() as
      | { endpoint: string | null; listen_port: number; overlay_cidr: string; hub_address: string; public_key: string | null; enabled: number } | undefined;
    if (!r || r.enabled !== 1 || !r.endpoint || !r.public_key) return null;
    return { endpoint: r.endpoint, listenPort: r.listen_port, overlayCidr: r.overlay_cidr, hubAddress: r.hub_address, publicKey: r.public_key };
  }

  // Validate a spec. Coherence here means BOTH: (1) the spec is internally
  // consistent (pure validateSpec, never touches a device), AND (2) everything
  // Apply will need actually exists. A remote baseline embeds a tunnel-back, which
  // requires the WireGuard hub — so if the hub isn't set up we report it here as a
  // prerequisite, rather than letting Apply's /generate 400 after Review said "OK".
  router.post('/validate', (req, res) => {
    const spec = parseSpec(req.body);
    const errors = validateSpec(spec);
    const preconditions: string[] = [];
    if (spec.remote && !hubConfig()) {
      preconditions.push('Remote provisioning needs the WireGuard hub. Set up Remote Access first, then return here — or provision this router as local.');
    }
    // Structural safety fact the UI surfaces: a firewall baseline always carries the mgmt guard.
    const fw = spec.firewall && spec.firewall !== 'off' ? baselineFirewall(spec) : [];
    const hasMgmtGuard = fw.length === 0 || fw[0]?.action === 'accept';
    res.json({ ok: errors.length === 0 && preconditions.length === 0, errors, preconditions, firewallRuleCount: fw.length, mgmtGuardFirst: hasMgmtGuard });
  });

  // Mode A: generate the complete baseline script. For a remote baseline, requires
  // the hub enabled and allocates a peer (the tunnel-back is embedded).
  router.post('/generate', (req, res) => {
    const spec = parseSpec(req.body);
    const errors = validateSpec(spec);
    if (errors.length) { res.status(400).json({ ok: false, errors }); return; }

    let peer: { id: number; tunnelIp: string } | undefined;
    let tunnelBootstrap: string | undefined;
    if (spec.remote) {
      const hub = hubConfig();
      if (!hub) { res.status(400).json({ ok: false, errors: ['Remote provisioning needs the WireGuard hub enabled. Turn on Remote Access first (or provision this router as local).'] }); return; }
      const tunnelIp = allocateTunnelIp(db, hub.overlayCidr, hub.hubAddress);
      const p: PeerRow = createPeer(db, spec.identity || 'Provisioned router', tunnelIp);
      peer = { id: p.id, tunnelIp: p.tunnel_ip };
      tunnelBootstrap = baselineTunnelBootstrap(hub, p);
      audit(actorOf(req), 'provision.generate.remote', `${spec.identity} (${tunnelIp})`, `Generated remote baseline for "${spec.identity}" incl. tunnel-back at ${tunnelIp}`);
    } else {
      audit(actorOf(req), 'provision.generate.local', spec.identity, `Generated local baseline for "${spec.identity}"`);
    }
    const script = generateBaseline(spec, { tunnelBootstrap });
    res.json({ ok: true, script, peer });
  });

  // Mode B: live-apply to a reachable-but-blank LAN router. LAN-only (a remote
  // spec is refused — use Mode A). forceSeverAt (E) exercises the dead-man.
  router.post('/apply', async (req, res) => {
    const spec = parseSpec(req.body);
    if (spec.remote) { res.status(400).json({ error: 'Live-apply (Mode B) is LAN-only. A remote/behind-NAT router must use Mode A (generate script).' }); return; }
    const errors = validateSpec(spec);
    if (errors.length) { res.status(400).json({ ok: false, errors }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const host = typeof b.host === 'string' ? b.host.trim() : '';
    const username = typeof b.username === 'string' ? b.username : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const forceSeverAt = typeof b.forceSeverAt === 'string' ? b.forceSeverAt : undefined;
    const severSource = typeof b.severSource === 'string' ? b.severSource : undefined;
    if (!host || !username) { res.status(400).json({ error: 'A reachable host and a write-capable username are required for live-apply.' }); return; }

    const target: DeviceTarget = { host, username, password };
    let transport;
    try { const probed = await restConnect(target); transport = { scheme: probed.scheme, port: probed.port }; }
    catch (err) { res.status(502).json({ error: `Could not reach the router to live-apply: ${(err as Error).message}` }); return; }
    const ctx: ProvCtx = { read: target, write: target, transport };

    try {
      const outcome = await liveApplyBaseline(ctx, db,
        { db, actor: actorOf(req), deviceId: null as unknown as number, deviceName: `provision:${spec.identity}`, action: 'provision.apply', targetLabel: host },
        spec, { forceSeverAt, severSource });
      log.info(`Live-apply of "${spec.identity}" → ${outcome.result} (mgmt ${outcome.mgmtPreserved ? 'preserved' : 'LOST'})`);
      res.status(outcome.result === 'applied' ? 200 : 502).json(outcome);
    } catch (err) { writeErr(res, err); }
  });

  return router;
}
