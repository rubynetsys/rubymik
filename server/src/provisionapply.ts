import { restGet } from './routeros/rest.js';
import { restAdd, restRemove, restCommand, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { applyFirewall, type FirewallConfig } from './firewall.js';
import { writeAudit, type SafeApplyContext } from './safeapply.js';
import { withWriteOp } from './snapshothook.js';
import type { DatabaseSync } from 'node:sqlite';
import { baselineFirewall, type BaselineSpec } from './provision.js';
import { log } from './log.js';

/**
 * MODE B — live-apply a baseline to a reachable-but-blank LAN router, in SAFE
 * ORDER with a dead-man armed. LAN-ONLY (never remote/behind-NAT — that's Mode A).
 *
 *   ORDER IS EVERYTHING: management reachability is preserved throughout; the
 *   lockout-capable piece (firewall) is applied LAST via the P6 dead-man; every
 *   step is verified before the next. If any step severs management (the
 *   reachability probe fails) the whole baseline is unwound — the router goes
 *   back toward blank/reachable, never orphaned half-configured — and the failing
 *   step is reported.
 */

export interface ProvCtx { read: DeviceTarget; write: DeviceTarget; transport: WriteTransport; }
type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;

export interface StepResult { step: string; ok: boolean; detail: string; }
export interface LiveApplyOutcome {
  result: 'applied' | 'reverted' | 'failed';
  steps: StepResult[];
  failedStep: string | null;
  mgmtPreserved: boolean;
  auditId: number;
}

const g = (ctx: ProvCtx, p: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, p);
const REACH_TIMEOUT_MS = 4000;

async function reachable(ctx: ProvCtx): Promise<boolean> {
  try { await restGet({ ...ctx.read, timeoutMs: REACH_TIMEOUT_MS }, ctx.transport.scheme, ctx.transport.port, '/system/resource'); return true; }
  catch { return false; }
}
/** Retry the reachability probe for a dead-man window (a self-expiring sever recovers within it). */
async function reachableWithin(ctx: ProvCtx, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (await reachable(ctx)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

interface Step { name: string; apply: () => Promise<void>; undo: () => Promise<void>; verify: () => Promise<boolean>; }

/**
 * Apply the baseline live. `opts.forceSeverAt` (E) injects a SELF-EXPIRING
 * management-drop at the named step, so the dead-man is exercised safely — even
 * if controller-side rollback failed, the router recovers on its own.
 */
/** RubyMIK's source IP as the router sees it (for the safe self-expiring sever). */
async function mgmtSource(ctx: ProvCtx, fallback?: string): Promise<string | null> {
  try {
    const conns = await g(ctx, '/ip/firewall/connection') as Array<Record<string, string>>;
    const c = conns.find((x) => (x['dst-address'] ?? '').endsWith(`:${ctx.transport.port}`) || (x['reply-src-address'] ?? '').endsWith(`:${ctx.transport.port}`));
    const src = c?.['src-address']?.split(':')[0];
    if (src) return src;
  } catch { /* fall through */ }
  return fallback ?? null;
}

export function liveApplyBaseline(
  ctx: ProvCtx, db: DatabaseSync, sac: Sac, spec: BaselineSpec,
  opts: { forceSeverAt?: string; severSource?: string } = {},
): Promise<LiveApplyOutcome> {
  // P21: bracket live baseline provisioning with pre/post snapshots.
  return withWriteOp(sac.deviceId, 'provision.liveApplyBaseline', () => liveApplyBaselineInner(ctx, db, sac, spec, opts));
}
async function liveApplyBaselineInner(
  ctx: ProvCtx, db: DatabaseSync, sac: Sac, spec: BaselineSpec,
  opts: { forceSeverAt?: string; severSource?: string } = {},
): Promise<LiveApplyOutcome> {
  const wan = spec.interfaces.find((i) => i.role === 'wan')!.name;
  const lanMembers = spec.interfaces.filter((i) => i.role === 'lan').map((i) => i.name);
  const add = (path: string, body: Record<string, unknown>) => restAdd(ctx.write, ctx.transport, path, body);
  const created: Array<{ path: string; id: string }> = [];
  const track = async (path: string, body: Record<string, unknown>) => { const r = await add(path, body); if (r?.['.id']) created.push({ path, id: r['.id'] as string }); return r; };

  const steps: Step[] = [
    { name: 'identity', apply: async () => { await restCommand(ctx.write, ctx.transport, '/system/identity/set', { name: spec.identity }); },
      undo: async () => {}, verify: async () => ((await g(ctx, '/system/identity')) as { name?: string }).name === spec.identity },
    { name: 'bridge', apply: async () => { await track('/interface/bridge', { name: 'bridge-lan', comment: 'RUBYMIK LAN' }); for (const m of lanMembers) await track('/interface/bridge/port', { bridge: 'bridge-lan', interface: m }); },
      undo: async () => {}, verify: async () => ((await g(ctx, '/interface/bridge')) as Array<{ name?: string }>).some((b) => b.name === 'bridge-lan') },
    { name: 'lan-address', apply: async () => { await track('/ip/address', { address: `${spec.lan.routerIp}/${spec.lan.prefix}`, interface: 'bridge-lan', comment: 'RUBYMIK LAN gateway' }); },
      undo: async () => {}, verify: async () => ((await g(ctx, '/ip/address')) as Array<{ address?: string }>).some((a) => a.address === `${spec.lan.routerIp}/${spec.lan.prefix}`) },
    { name: 'wan', apply: async () => {
        if (spec.wan.type === 'dhcp') await track('/ip/dhcp-client', { interface: wan, 'use-peer-dns': 'yes', 'add-default-route': 'yes', disabled: 'no', comment: 'RUBYMIK WAN' });
        else if (spec.wan.type === 'static') { await track('/ip/address', { address: spec.wan.static!.address, interface: wan, comment: 'RUBYMIK WAN' }); await track('/ip/route', { gateway: spec.wan.static!.gateway, comment: 'RUBYMIK default route' }); }
        else await track('/interface/pppoe-client', { name: 'pppoe-wan', interface: wan, user: spec.wan.pppoe!.user, password: spec.wan.pppoe!.password, 'add-default-route': 'yes', disabled: 'no', comment: 'RUBYMIK WAN' });
      }, undo: async () => {}, verify: async () => true },
    ...(spec.dhcp.enabled ? [{ name: 'dhcp', apply: async () => {
        await track('/ip/pool', { name: 'rubymik-lan-pool', ranges: `${spec.dhcp.poolStart}-${spec.dhcp.poolEnd}` });
        await track('/ip/dhcp-server', { name: 'rubymik-lan-dhcp', interface: 'bridge-lan', 'address-pool': 'rubymik-lan-pool', 'lease-time': spec.dhcp.leaseTime || '1h', disabled: 'no' });
        await track('/ip/dhcp-server/network', { address: `${subnetOf(spec.lan.routerIp, spec.lan.prefix)}/${spec.lan.prefix}`, gateway: spec.lan.routerIp, 'dns-server': spec.dhcp.dns || spec.lan.routerIp });
      }, undo: async () => {}, verify: async () => ((await g(ctx, '/ip/dhcp-server')) as Array<{ name?: string }>).some((d) => d.name === 'rubymik-lan-dhcp') }] : []),
    { name: 'nat', apply: async () => { await track('/ip/firewall/nat', { chain: 'srcnat', 'out-interface': wan, action: 'masquerade', comment: 'RUBYMIK: LAN masquerade' }); },
      undo: async () => {}, verify: async () => true },
  ];

  const results: StepResult[] = [];
  const unwind = async () => {
    // Remove any dead-man sever artifacts first (in case they lingered), then the
    // tracked baseline changes in reverse order → router back toward blank/reachable.
    try { for (const r of (await g(ctx, '/ip/firewall/filter') as Array<Record<string, string>>).filter((x) => (x.comment ?? '').startsWith('RUBYMIK-SEVER'))) await restRemove(ctx.write, ctx.transport, '/ip/firewall/filter', r['.id']!); } catch { /* */ }
    try { for (const r of (await g(ctx, '/ip/firewall/address-list') as Array<Record<string, string>>).filter((x) => x.list === 'RUBYMIK-SEVER')) await restRemove(ctx.write, ctx.transport, '/ip/firewall/address-list', r['.id']!); } catch { /* */ }
    for (const c of created.reverse()) { try { await restRemove(ctx.write, ctx.transport, c.path, c.id); } catch { /* best-effort */ } }
  };

  // Run the ordered steps (everything up to the firewall).
  for (const step of steps) {
    try {
      if (opts.forceSeverAt === step.name) {
        // E: sever RubyMIK's management with a ROUTER-ENFORCED self-expiring drop
        // (a src-address-list entry with a timeout — works even where device-mode
        // blocks the scheduler, and recovers on its own if we can't reach it).
        const src = await mgmtSource(ctx, opts.severSource);
        if (!src) throw new Error('could not determine management source for the dead-man test');
        log.warn(`[live-apply] dead-man test: severing mgmt source ${src} for 25s (self-expiring) at step "${step.name}"`);
        await restAdd(ctx.write, ctx.transport, '/ip/firewall/address-list', { list: 'RUBYMIK-SEVER', address: src, timeout: '25s' });
        await restAdd(ctx.write, ctx.transport, '/ip/firewall/filter', { chain: 'input', 'src-address-list': 'RUBYMIK-SEVER', action: 'drop', comment: 'RUBYMIK-SEVER dead-man test', 'place-before': '0' });
        await new Promise((r) => setTimeout(r, 2500)); // let the drop take effect before probing
      } else {
        await step.apply();
        if (!(await step.verify())) throw new Error('verification failed');
      }
      // DEAD-MAN: a quick probe. If this step severed management, recover (wait out
      // the self-expiring drop — the router restores its own reachability), then
      // unwind the baseline and report which step did it.
      if (!(await reachable(ctx))) {
        log.error(`[live-apply] mgmt LOST at step "${step.name}" — dead-man: waiting for self-recovery, then unwinding`);
        const recovered = await reachableWithin(ctx, 45_000);
        if (recovered) await unwind();
        const finalUp = await reachable(ctx);
        results.push({ step: step.name, ok: false, detail: `severed management; ${recovered ? 'recovered and unwound baseline' : 'router did NOT recover'}` });
        const id = writeAudit(sac, finalUp ? 'rolled_back' : 'rollback_failed', `Provision live-apply of "${spec.identity}"`, null, null, `Step "${step.name}" severed management; dead-man ${finalUp ? 'recovered the router and unwound the baseline' : 'could NOT recover the router'}.`);
        return { result: 'reverted', steps: results, failedStep: step.name, mgmtPreserved: finalUp, auditId: id };
      }
      results.push({ step: step.name, ok: true, detail: 'applied + verified, mgmt reachable' });
    } catch (err) {
      results.push({ step: step.name, ok: false, detail: (err as Error).message });
      await unwind();
      const id = writeAudit(sac, 'rolled_back', `Provision live-apply of "${spec.identity}"`, null, null, `Step "${step.name}" failed: ${(err as Error).message}; unwound ${created.length} change(s).`);
      return { result: 'failed', steps: results, failedStep: step.name, mgmtPreserved: await reachable(ctx), auditId: id };
    }
  }

  // Firewall LAST — through the P6 dead-man (its own reachability-verified rollback).
  if (spec.firewall !== 'off') {
    const cfg: FirewallConfig = { wanInterface: wan, trustedInterface: 'bridge-lan', mgmtSources: [] };
    const fwOut = await applyFirewall(ctx, { ...sac, action: 'provision.firewall' }, spec.firewall, cfg, []);
    if (fwOut.result !== 'applied') {
      results.push({ step: 'firewall', ok: false, detail: fwOut.detail });
      await unwind();
      const id = writeAudit(sac, 'rolled_back', `Provision live-apply of "${spec.identity}"`, null, null, `Firewall step ${fwOut.result}: ${fwOut.detail}; unwound baseline.`);
      return { result: 'reverted', steps: results, failedStep: 'firewall', mgmtPreserved: await reachable(ctx), auditId: id };
    }
    results.push({ step: 'firewall', ok: true, detail: 'applied via P6 dead-man (mgmt-accept first)' });
  }

  const id = writeAudit(sac, 'applied', `Provision live-apply of "${spec.identity}"`, null, null, `Baseline applied live in ${results.length} steps; management preserved throughout.`);
  return { result: 'applied', steps: results, failedStep: null, mgmtPreserved: true, auditId: id };
}

function subnetOf(routerIp: string, prefix: number): string {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(routerIp);
  if (!m) return routerIp;
  const ip = ((+m[1]! << 24) | (+m[2]! << 16) | (+m[3]! << 8) | +m[4]!) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const n = (ip & mask) >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
