// P42 — dual-WAN failover. The correct RouterOS pattern (recursive routes + check-gateway),
// NO scripts/netwatch. Failover itself is done by RouterOS in ~20-30s (fixed check-gateway
// cadence); RubyMIK's timers gate NOTIFICATIONS only, never failover speed.
//
// This module is the pure, fixture-diffable core: buildFailoverPlan (the exact object set),
// validation, DNS-collision + pre-existing-config collision analysis, the DHCP-gateway
// reconcile (amendment 1 — the failover-breaking bug), the mgmt-safe mangle assertion
// (amendment 3), the dual-WAN route guard, and the safe-apply/teardown ops. Mirrors netnat.
import { restGet } from './routeros/rest.js';
import { restAdd, restRemove, restSet } from './routeros/write.js';
import { runSafeApply, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import { mgmtInfo, type NatContext, type NatMgmtInfo } from './netnat.js';
import { setTimeout as sleep } from 'node:timers/promises';

export const TAG = 'RUBYMIK-WAN';
export type WanContext = NatContext; // { read, write, transport, row }

// Amendment 2: default probe targets deliberately avoid the primaries (1.1.1.1 / 8.8.8.8)
// that sites most commonly hand clients as DNS — pinning a client-DNS IP to one WAN would
// blackhole DNS on that WAN's failure. Wizard still warns on any collision with site DNS.
export const DEFAULT_PROBE_WAN1 = '1.0.0.1';
export const DEFAULT_PROBE_WAN2 = '8.8.4.4';

export type WanSourceType = 'static' | 'dhcp' | 'pppoe';
export interface WanLeg {
  interface: string;              // WAN interface (ether1, pppoe-out1, vlan10 …)
  sourceType: WanSourceType;
  gateway: string;                // static: gw IP · dhcp: CURRENT learned gw IP · pppoe: the pppoe-out iface name
  probeTarget: string;            // recursive check target — must differ per WAN
}
/** Fresh install, or reconcile with a pre-existing default at distance 1 (amendment 5). */
export type FailoverMode = 'fresh' | 'adopt' | 'replace';
export interface FailoverSpec {
  wan1: WanLeg;                   // primary → default distance 1
  wan2: WanLeg;                   // backup  → default distance 2
  markRouterTraffic?: boolean;    // v1 optional: also route router-originated replies per WAN
  mode?: FailoverMode;            // default 'fresh'
}

export type PlanKind = 'table' | 'route' | 'nat' | 'mangle';
export interface PlanObject { kind: PlanKind; menu: string; body: Record<string, string>; }
/** A PATCH to a pre-existing object (amendment 5: pppoe add-default-route=no — the wizard
 *  owns the defaults, the pppoe-client must not add its own). Matched by `where`. */
export interface PlanPatch { menu: string; where: Record<string, string>; body: Record<string, string>; note: string; }
export interface FailoverPlan { tables: PlanObject[]; routes: PlanObject[]; nat: PlanObject[]; mangle: PlanObject[]; patches: PlanPatch[]; all: PlanObject[]; }

const tag = (note: string) => `${TAG} ${note}`;
const obj = (kind: PlanKind, menu: string, body: Record<string, string>): PlanObject => ({ kind, menu, body });
const connMark = (n: number) => `RUBYMIK-wan${n}-conn`;
const routeMark = (n: number) => `RUBYMIK-to-wan${n}`;

/**
 * The canonical recursive-route dual-WAN failover object set (pure). Order matters:
 * probe host-routes (scope=10) resolve the recursive defaults (check-gateway=ping, the
 * failover trigger); mangle conn-marks precede route-marks; reply-routing keeps inbound
 * dst-nat working on the backup WAN. Mgmt-safe by construction (amendment 3): the
 * mark-connection rules carry dst-address-type=!local, so router-destined (management)
 * connections are never marked — only forwarded traffic is.
 */
export function buildFailoverPlan(spec: FailoverSpec): FailoverPlan {
  const legs = [spec.wan1, spec.wan2];
  const tables: PlanObject[] = [];
  const routes: PlanObject[] = [];
  const nat: PlanObject[] = [];
  const mangle: PlanObject[] = [];
  const patches: PlanPatch[] = [];

  // 0. routing tables — RouterOS 7 requires a routing table to EXIST before any route or
  //    mangle rule may reference it via routing-mark/new-routing-mark (v6 auto-created them).
  legs.forEach((_leg, i) => {
    tables.push(obj('table', '/routing/table', { name: routeMark(i + 1), fib: 'yes', comment: tag(`table-wan${i + 1}`) }));
  });

  // 1. probe host-routes — recursive resolvers (scope 10 ≤ defaults' target-scope 10)
  legs.forEach((leg, i) => {
    routes.push(obj('route', '/ip/route', { 'dst-address': `${leg.probeTarget}/32`, gateway: leg.gateway, scope: '10', comment: tag(`wan${i + 1}-probe`) }));
  });
  // 2. recursive defaults — check-gateway=ping; distance 1 primary / 2 backup.
  //    target-scope (30) MUST exceed the probe route's scope (10) or RouterOS won't resolve the
  //    recursive next-hop (equal scopes leave the route inactive — verified on RouterOS 7.23).
  routes.push(obj('route', '/ip/route', { 'dst-address': '0.0.0.0/0', gateway: spec.wan1.probeTarget, 'check-gateway': 'ping', distance: '1', 'target-scope': '30', comment: tag('default-primary') }));
  routes.push(obj('route', '/ip/route', { 'dst-address': '0.0.0.0/0', gateway: spec.wan2.probeTarget, 'check-gateway': 'ping', distance: '2', 'target-scope': '30', comment: tag('default-backup') }));
  // 3. per-table default routes — force marked replies out the WAN they arrived on.
  //    RouterOS 7: a route joins a table via `routing-table=` (v6's `routing-mark=` on a
  //    route is rejected as "unknown parameter"; only mangle keeps `new-routing-mark`).
  legs.forEach((leg, i) => {
    routes.push(obj('route', '/ip/route', { 'dst-address': '0.0.0.0/0', gateway: leg.gateway, 'routing-table': routeMark(i + 1), comment: tag(`markroute-wan${i + 1}`) }));
  });

  // 4. NAT — masquerade out BOTH WANs
  legs.forEach((leg, i) => {
    nat.push(obj('nat', '/ip/firewall/nat', { chain: 'srcnat', action: 'masquerade', 'out-interface': leg.interface, comment: tag(`nat-wan${i + 1}`) }));
  });

  // 5. mangle — mark NEW forwarded (NOT router-destined) inbound conns by arrival WAN …
  legs.forEach((leg, i) => {
    mangle.push(obj('mangle', '/ip/firewall/mangle', {
      chain: 'prerouting', 'in-interface': leg.interface, 'connection-state': 'new',
      'dst-address-type': '!local', // amendment 3: never mark the management (router-destined) flow
      action: 'mark-connection', 'new-connection-mark': connMark(i + 1), passthrough: 'yes', comment: tag(`conn-wan${i + 1}`),
    }));
  });
  // … then route their replies back out that WAN
  legs.forEach((_leg, i) => {
    mangle.push(obj('mangle', '/ip/firewall/mangle', { chain: 'prerouting', 'connection-mark': connMark(i + 1), action: 'mark-routing', 'new-routing-mark': routeMark(i + 1), passthrough: 'yes', comment: tag(`route-wan${i + 1}`) }));
  });
  if (spec.markRouterTraffic) {
    legs.forEach((leg, i) => {
      mangle.push(obj('mangle', '/ip/firewall/mangle', { chain: 'input', 'in-interface': leg.interface, 'connection-state': 'new', action: 'mark-connection', 'new-connection-mark': connMark(i + 1), passthrough: 'yes', comment: tag(`conn-in-wan${i + 1}`) }));
    });
    legs.forEach((_leg, i) => {
      mangle.push(obj('mangle', '/ip/firewall/mangle', { chain: 'output', 'connection-mark': connMark(i + 1), action: 'mark-routing', 'new-routing-mark': routeMark(i + 1), passthrough: 'yes', comment: tag(`route-out-wan${i + 1}`) }));
    });
  }

  // 6. amendment 5: PPPoE legs must not add their own default — the wizard owns the defaults.
  legs.forEach((leg) => {
    if (leg.sourceType === 'pppoe') {
      patches.push({ menu: '/interface/pppoe-client', where: { name: leg.interface }, body: { 'add-default-route': 'no' }, note: `pppoe-client ${leg.interface}: add-default-route=no (wizard owns defaults)` });
    }
  });

  // tables FIRST in `all` — they must exist before the markroute routes / mangle reference them.
  return { tables, routes, nat, mangle, patches, all: [...tables, ...routes, ...nat, ...mangle] };
}

// ── validation ──
const isIpv4 = (v: string) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v);
function validateLeg(leg: WanLeg | undefined, label: string): string[] {
  const e: string[] = [];
  if (!leg) return [`${label} is required.`];
  if (!leg.interface || /\s/.test(leg.interface)) e.push(`${label}: a valid interface is required.`);
  if (!['static', 'dhcp', 'pppoe'].includes(leg.sourceType)) e.push(`${label}: source type must be static, dhcp or pppoe.`);
  if (!leg.gateway) e.push(`${label}: a resolved gateway (IP, or the PPPoE interface) is required.`);
  else if (leg.sourceType !== 'pppoe' && !isIpv4(leg.gateway)) e.push(`${label}: gateway must be an IPv4 address.`);
  if (!isIpv4(leg.probeTarget)) e.push(`${label}: probe target must be an IPv4 address.`);
  return e;
}
export function validateFailoverInput(spec: FailoverSpec): string[] {
  const e = [...validateLeg(spec.wan1, 'Primary WAN (WAN1)'), ...validateLeg(spec.wan2, 'Backup WAN (WAN2)')];
  if (spec.wan1 && spec.wan2) {
    if (spec.wan1.interface && spec.wan1.interface === spec.wan2.interface) e.push('WAN1 and WAN2 must be different interfaces.');
    if (spec.wan1.probeTarget && spec.wan1.probeTarget === spec.wan2.probeTarget) e.push('WAN1 and WAN2 must use different probe targets (each recursive route needs its own).');
  }
  return e;
}

/** Amendment 2: a probe target that a site also hands clients as DNS would be blackholed on
 *  that WAN's failure. Returns the colliding probes so the wizard can warn. */
export function dnsCollisions(spec: FailoverSpec, siteDns: string[]): { wan: 'wan1' | 'wan2'; probe: string }[] {
  const dns = new Set(siteDns.filter(Boolean));
  const out: { wan: 'wan1' | 'wan2'; probe: string }[] = [];
  if (dns.has(spec.wan1.probeTarget)) out.push({ wan: 'wan1', probe: spec.wan1.probeTarget });
  if (dns.has(spec.wan2.probeTarget)) out.push({ wan: 'wan2', probe: spec.wan2.probeTarget });
  return out;
}

// ── amendment 5: pre-existing-config collision analysis (pure) ──
export interface ExistingSnapshot {
  routes: { id: string; dst: string; distance: string; comment: string; dynamic: boolean }[];
  nat: { id: string; outInterface: string; action: string; chain: string; comment: string }[];
  mangleMarks: string[]; // every connection/routing-mark name already in use (any comment)
}
export interface CollisionReport {
  ok: boolean;                    // false = must resolve before applying
  requiresModeChoice: boolean;    // an existing distance-1 default is present → adopt|replace
  existingDefaults: { id: string; distance: string; comment: string; managed: boolean }[];
  masqueradeOnlyWan1: boolean;    // an existing masquerade covers WAN1 but not WAN2
  markNameCollisions: string[];   // RUBYMIK-* mark names already used by non-RUBYMIK config
  messages: string[];
}
const isManagedComment = (c: string) => c.startsWith(TAG);
export function analyzeCollisions(spec: FailoverSpec, existing: ExistingSnapshot): CollisionReport {
  const mode = spec.mode ?? 'fresh';
  const existingDefaults = existing.routes
    .filter((r) => r.dst === '0.0.0.0/0' && !r.dynamic)
    .map((r) => ({ id: r.id, distance: r.distance, comment: r.comment, managed: isManagedComment(r.comment) }));
  const unmanagedDefaults = existingDefaults.filter((d) => !d.managed);
  const messages: string[] = [];

  const requiresModeChoice = unmanagedDefaults.length > 0;
  if (requiresModeChoice && mode === 'fresh') {
    messages.push(`An existing default route is present (distance ${unmanagedDefaults.map((d) => d.distance).join(', ')}). Choose "adopt as WAN1" or "replace (tagged)" — RubyMIK will never silently stack a third default.`);
  }

  // masquerade covering WAN1 but not WAN2
  const masq = existing.nat.filter((n) => n.chain === 'srcnat' && n.action === 'masquerade');
  const covers = (iface: string) => masq.some((n) => n.outInterface === iface || n.outInterface === '');
  const masqueradeOnlyWan1 = covers(spec.wan1.interface) && !covers(spec.wan2.interface) && !masq.some((n) => n.outInterface === '');
  if (masqueradeOnlyWan1) messages.push(`An existing masquerade covers ${spec.wan1.interface} but not ${spec.wan2.interface} — traffic out the backup WAN would not be NATed. The wizard adds the missing rule.`);

  // RUBYMIK-* mark names already used by non-RubyMIK mangle
  const wanted = [connMark(1), connMark(2), routeMark(1), routeMark(2)];
  const markNameCollisions = wanted.filter((m) => existing.mangleMarks.includes(m));
  if (markNameCollisions.length) messages.push(`Mark name(s) already in use by non-RubyMIK config: ${markNameCollisions.join(', ')}. Refusing to reuse — rename the existing marks first.`);

  const ok = !(requiresModeChoice && mode === 'fresh') && markNameCollisions.length === 0;
  return { ok, requiresModeChoice, existingDefaults, masqueradeOnlyWan1, markNameCollisions, messages };
}

/** Amendment 1 (the bug): DHCP-learned gateways change on lease renewal, which would leave
 *  the probe/markroute routes pointing at a stale gw and silently kill failover detection.
 *  Pure planner: given the current RUBYMIK-WAN routes and the DHCP-learned gw per DHCP WAN,
 *  return the route rewrites needed. The poller applies these via a guarded safe-apply. */
export function planDhcpReconcile(
  managedRoutes: { id: string; comment: string; gateway: string }[],
  dhcp: { wanIndex: 1 | 2; learnedGw: string }[],
): { id: string; newGateway: string; comment: string }[] {
  const out: { id: string; newGateway: string; comment: string }[] = [];
  for (const { wanIndex, learnedGw } of dhcp) {
    if (!learnedGw) continue;
    for (const r of managedRoutes) {
      const forThisWan = r.comment.includes(`wan${wanIndex}-probe`) || r.comment.includes(`markroute-wan${wanIndex}`);
      if (forThisWan && r.gateway !== learnedGw) out.push({ id: r.id, newGateway: learnedGw, comment: r.comment });
    }
  }
  return out;
}

/** Amendment 3 assertion: prove no RUBYMIK mangle rule can route-mark the management flow.
 *  Every mark-connection must be dst-address-type=!local (router-destined excluded) and
 *  scoped to a WAN in-interface; mark-routing acts only on those connection-marks. */
export function mangleIsMgmtSafe(plan: FailoverPlan, wanInterfaces: string[]): { safe: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const r of plan.mangle) {
    if (r.body.action === 'mark-connection') {
      if (r.body['dst-address-type'] !== '!local') problems.push(`${r.body.comment}: mark-connection without dst-address-type=!local could mark the mgmt flow`);
      const inIf = r.body['in-interface'];
      if (inIf && !wanInterfaces.includes(inIf)) problems.push(`${r.body.comment}: in-interface ${inIf} is not a declared WAN`);
    } else if (r.body.action === 'mark-routing') {
      if (!r.body['connection-mark']?.startsWith('RUBYMIK-')) problems.push(`${r.body.comment}: mark-routing not scoped to a RUBYMIK connection-mark`);
    }
  }
  return { safe: problems.length === 0, problems };
}

// ── read current state + failover state machine input ──
type Dict = Record<string, unknown>;
const g = (ctx: WanContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path) as Promise<Dict[]>;
const isManaged = (c: unknown) => typeof c === 'string' && c.startsWith(TAG);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export type WanState = 'primary' | 'failover' | 'both-down' | 'none';
export interface WanRouteRow { id: string; comment: string; dst: string; gateway: string; distance: string; active: boolean; checkGateway: string; }
export interface WanView {
  configured: boolean;
  state: WanState;
  manageable: boolean;
  routes: WanRouteRow[];
  nat: { comment: string; outInterface: string; action: string }[];
  mangle: { comment: string; chain: string; action: string }[];
  mgmt: NatMgmtInfo;
}

/** Failover state from the two RUBYMIK default routes' `active` flags (active ⇒ check-gateway
 *  passing ⇒ that WAN reachable). Notification-only interpretation; failover itself is RouterOS. */
export function computeWanState(defaults: { distance: string; active: boolean }[]): WanState {
  const primary = defaults.find((r) => r.distance === '1');
  const backup = defaults.find((r) => r.distance === '2');
  if (!primary && !backup) return 'none';
  if (primary?.active) return 'primary';
  if (backup?.active) return 'failover';
  return 'both-down';
}

export async function readWan(ctx: WanContext): Promise<WanView> {
  const [rt, nat, mangle, mgmt] = await Promise.all([g(ctx, '/ip/route'), g(ctx, '/ip/firewall/nat'), g(ctx, '/ip/firewall/mangle'), mgmtInfo(ctx)]);
  const routes: WanRouteRow[] = rt.filter((r) => isManaged(r.comment)).map((r) => ({
    id: s(r['.id']), comment: s(r.comment), dst: s(r['dst-address']), gateway: s(r.gateway),
    distance: s(r.distance), active: s(r.active) === 'true', checkGateway: s(r['check-gateway']),
  }));
  const defaults = routes.filter((r) => r.dst === '0.0.0.0/0' && !r.comment.includes('markroute'));
  return {
    configured: defaults.length > 0,
    state: computeWanState(defaults),
    manageable: !!(ctx.row.write_username_enc && ctx.row.write_password_enc),
    routes,
    nat: nat.filter((r) => isManaged(r.comment)).map((r) => ({ comment: s(r.comment), outInterface: s(r['out-interface']), action: s(r.action) })),
    mangle: mangle.filter((r) => isManaged(r.comment)).map((r) => ({ comment: s(r.comment), chain: s(r.chain), action: s(r.action) })),
    mgmt,
  };
}

/**
 * Dual-WAN mgmt guard for deleting/disabling a DEFAULT route (amendment to routeMgmtGuard).
 * Two defaults at different distances are legitimate. Refuse cutting the default that
 * currently carries the mgmt path UNLESS another default is present AND currently ACTIVE
 * (active ⇒ its check-target resolves ⇒ verified reachable). Ambiguity → caller's dead-man.
 */
export function wanRouteGuard(
  op: 'delete' | 'disable',
  targetRoute: { dst: string; distance: string; active: boolean },
  allDefaults: { distance: string; active: boolean }[],
): string | null {
  if (targetRoute.dst !== '0.0.0.0/0') return null;
  if (!targetRoute.active) return null; // cutting a standby default can't drop the live path
  const verifiedAlternate = allDefaults.filter((r) => r.distance !== targetRoute.distance).some((r) => r.active);
  if (verifiedAlternate) return null;
  return `Refused: this active default route (distance ${targetRoute.distance}) is the only internet path currently verified reachable — no other WAN's default route is active (its check-target does not resolve). ${op === 'delete' ? 'Deleting' : 'Disabling'} it would black-hole egress and strand any management that rides this WAN. Bring the other WAN up first, or use failover teardown.`;
}

// ── write ops (safe-apply + P21-snapshot-bracketed) ──
type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: WanContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });
type IdSet = { route: string[]; nat: string[]; mangle: string[]; table: string[] };
const allIds = async (ctx: WanContext): Promise<IdSet> => {
  const [rt, nat, mg, tb] = await Promise.all([g(ctx, '/ip/route'), g(ctx, '/ip/firewall/nat'), g(ctx, '/ip/firewall/mangle'), g(ctx, '/routing/table')]);
  return { route: rt.map((r) => s(r['.id'])), nat: nat.map((r) => s(r['.id'])), mangle: mg.map((r) => s(r['.id'])), table: tb.map((r) => s(r['.id'])) };
};

/**
 * The ORDERED apply sequence — P19 add-before-remove. Every RUBYMIK object is added and the new
 * recursive PRIMARY default is verified active BEFORE any pre-existing default is removed, so the
 * mgmt path (which rides the default on this box) never loses egress. In 'fresh' mode no default
 * is removed; in 'adopt'/'replace' the old non-RUBYMIK default(s) are retired LAST.
 */
export type ApplyOp =
  | { kind: 'patch'; menu: string; where: Record<string, string>; body: Record<string, string> }
  | { kind: 'add'; menu: string; body: Record<string, string> }
  | { kind: 'verify-primary-active' }
  | { kind: 'remove-old-default'; id: string };
export function buildApplyOps(plan: FailoverPlan, oldDefaultIds: string[], mode: FailoverMode): ApplyOp[] {
  const ops: ApplyOp[] = [];
  for (const p of plan.patches) ops.push({ kind: 'patch', menu: p.menu, where: p.where, body: p.body });
  for (const o of plan.all) ops.push({ kind: 'add', menu: o.menu, body: o.body });
  ops.push({ kind: 'verify-primary-active' });               // ← gate: the new primary must be up …
  if (mode !== 'fresh') for (const id of oldDefaultIds) ops.push({ kind: 'remove-old-default', id }); // … before the old default is retired
  return ops;
}

/** Fields that reconstruct a route verbatim on restore (rollback / teardown). Read-only/runtime
 *  fields (.id, active, dynamic, …) are dropped so the re-add reproduces the exact same line. */
const ROUTE_RESTORE_FIELDS = ['dst-address', 'gateway', 'distance', 'check-gateway', 'scope', 'target-scope', 'routing-table', 'routing-mark', 'pref-src', 'comment', 'disabled'] as const;
export function restoreRouteBody(captured: Record<string, string>): Record<string, string> {
  const body: Record<string, string> = {};
  for (const f of ROUTE_RESTORE_FIELDS) { const v = captured[f]; if (v !== undefined && v !== '') body[f] = v; }
  return body;
}

/** Poll for the RUBYMIK recursive PRIMARY default to show active (check-gateway resolved). Returns
 *  false if it never comes up — the caller then aborts BEFORE removing the old default (no partition). */
async function waitPrimaryActive(ctx: WanContext, attempts = 8, delayMs = 2000): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const rt = await g(ctx, '/ip/route');
    const primary = rt.find((r) => isManaged(r.comment) && s(r.comment).includes('default-primary'));
    if (primary && s(primary.active) === 'true') return true;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}

/** Apply the whole failover set as ONE snapshot-bracketed op with P19 ordering. The rollback both
 *  removes what this op added AND re-adds any pre-existing default it retired — removing the new
 *  default without restoring the old one is itself a partition. outcome.after carries the retired
 *  default(s) verbatim so the API can persist them for a faithful teardown. */
export async function applyFailover(ctx: WanContext, sac: Sac, spec: FailoverSpec): Promise<SafeApplyOutcome> {
  const plan = buildFailoverPlan(spec);
  const mode: FailoverMode = spec.mode ?? 'fresh';
  let before: IdSet = { route: [], nat: [], mangle: [], table: [] };
  let removed: Record<string, string>[] = [];
  // Undo helpers shared by rollback AND the defensive apply-catch. runSafeApply does NOT roll
  // back when apply() throws (it treats a throw as "nothing committed"), but our apply commits
  // objects incrementally — so we clean up our own partial writes before letting the throw out.
  const removeAdded = async () => {
    const now = await allIds(ctx);
    // route/mangle before table — a table can't be removed while a route still references it.
    for (const [k, menu] of [['mangle', '/ip/firewall/mangle'], ['nat', '/ip/firewall/nat'], ['route', '/ip/route'], ['table', '/routing/table']] as const) {
      for (const id of now[k].filter((x) => !before[k].includes(x))) await restRemove(ctx.write, ctx.transport, menu, id);
    }
  };
  const restoreRemoved = async () => { for (const r of removed) await restAdd(ctx.write, ctx.transport, '/ip/route', restoreRouteBody(r)); };
  return runSafeApply<{ before: IdSet; removed: Record<string, string>[] }>(ctxFull(ctx, sac), {
    snapshot: async () => {
      before = await allIds(ctx);
      const rt = await g(ctx, '/ip/route');
      removed = mode === 'fresh' ? [] : rt
        .filter((r) => s(r['dst-address']) === '0.0.0.0/0' && s(r.dynamic) !== 'true' && !isManaged(r.comment))
        .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, s(v)])));
      return { before, removed };
    },
    summary: () => `Set up dual-WAN failover (${mode}): +${plan.all.length} RUBYMIK-WAN objects, ${plan.patches.length} pppoe patch${removed.length ? `, retire ${removed.length} existing default (add-before-remove)` : ''}`,
    apply: async () => {
      try {
        const ops = buildApplyOps(plan, removed.map((r) => s(r['.id'])), mode);
        let primaryUp = true;
        for (const op of ops) {
          if (op.kind === 'patch') {
            const rows = await g(ctx, op.menu);
            const hit = rows.find((r) => Object.entries(op.where).every(([k, v]) => s(r[k]) === v));
            if (hit) await restSet(ctx.write, ctx.transport, op.menu, s(hit['.id']), op.body);
          } else if (op.kind === 'add') {
            await restAdd(ctx.write, ctx.transport, op.menu, op.body);
          } else if (op.kind === 'verify-primary-active') {
            // P19 gate: the new recursive primary must be verified active BEFORE we retire the
            // old default. If it never comes up we do NOT throw — we simply skip the removal and
            // let verifyTook fail, so the framework rolls back the adds with the old default intact.
            primaryUp = await waitPrimaryActive(ctx);
          } else if (op.kind === 'remove-old-default') {
            if (primaryUp) await restRemove(ctx.write, ctx.transport, '/ip/route', op.id);
          }
        }
      } catch (err) {
        // Never orphan a partial apply: undo our own writes, then re-throw for the audit trail.
        try { await removeAdded(); await restoreRemoved(); } catch { /* best-effort */ }
        throw err;
      }
    },
    verifyTook: async () => {
      const view = await readWan(ctx);
      const primaryActive = view.routes.some((r) => r.comment.includes('default-primary') && r.active);
      const ok = view.nat.length >= 2 && primaryActive && view.state !== 'none';
      return { ok, detail: primaryActive ? undefined : 'The recursive primary default did not become active — the WAN1 uplink or its probe target is unreachable. No existing default was removed.', after: { state: view.state, removedDefaults: removed, routes: view.routes.length, nat: view.nat.length, mangle: view.mangle.length } };
    },
    rollback: async () => {
      await removeAdded();
      // CRITICAL: hand back the default(s) we retired — no partition on rollback.
      await restoreRemoved();
    },
  });
}

/** Teardown — remove ONLY RUBYMIK-WAN objects, then restore the exact pre-wizard default(s) the
 *  setup retired (verbatim: dst/gateway/distance/flags). Pass the retired defaults captured at
 *  apply time (persisted in wan_config_json); [] when the setup was 'fresh'. */
export async function teardownFailover(ctx: WanContext, sac: Sac, originalDefaults: Record<string, string>[] = []): Promise<SafeApplyOutcome> {
  return runSafeApply<{ count: number }>(ctxFull(ctx, sac), {
    snapshot: async () => {
      const [rt, nat, mg, tb] = await Promise.all([g(ctx, '/ip/route'), g(ctx, '/ip/firewall/nat'), g(ctx, '/ip/firewall/mangle'), g(ctx, '/routing/table')]);
      return { count: [...rt, ...nat, ...mg, ...tb].filter((r) => isManaged(r.comment)).length };
    },
    summary: (b) => `Tear down dual-WAN failover (${b.count} RUBYMIK-WAN objects${originalDefaults.length ? `, restore ${originalDefaults.length} original default` : ''})`,
    apply: async () => {
      // routes/mangle before /routing/table — a table can't be removed while a route references it.
      for (const menu of ['/ip/firewall/mangle', '/ip/firewall/nat', '/ip/route', '/routing/table']) {
        const rows = await g(ctx, menu);
        for (const r of rows.filter((x) => isManaged(x.comment))) await restRemove(ctx.write, ctx.transport, menu, s(r['.id']));
      }
      // restore the exact original default(s) the wizard retired (verbatim)
      for (const d of originalDefaults) await restAdd(ctx.write, ctx.transport, '/ip/route', restoreRouteBody(d));
    },
    verifyTook: async () => {
      const v = await readWan(ctx);
      return { ok: v.routes.length === 0 && v.nat.length === 0 && v.mangle.length === 0, after: { state: v.state, restoredDefaults: originalDefaults.length } };
    },
    rollback: async () => { /* removal+restore; the pre-snapshot is the restore point */ },
  });
}

/** Amendment 1: reconcile DHCP-learned gateways (poller-driven, guarded). Rewrites stale
 *  probe/markroute route gateways so failover detection survives lease renewals. */
export async function reconcileDhcp(ctx: WanContext, sac: Sac, dhcp: { wanIndex: 1 | 2; learnedGw: string }[]): Promise<SafeApplyOutcome | null> {
  const rt = await g(ctx, '/ip/route');
  const managed = rt.filter((r) => isManaged(r.comment)).map((r) => ({ id: s(r['.id']), comment: s(r.comment), gateway: s(r.gateway) }));
  const rewrites = planDhcpReconcile(managed, dhcp);
  if (rewrites.length === 0) return null;
  return runSafeApply<{ rewrites: number }>(ctxFull(ctx, sac), {
    snapshot: () => Promise.resolve({ rewrites: rewrites.length }),
    summary: () => `Reconcile ${rewrites.length} DHCP-WAN route gateway(s) after lease change`,
    apply: async () => { for (const w of rewrites) await restSet(ctx.write, ctx.transport, '/ip/route', w.id, { gateway: w.newGateway }); },
    verifyTook: async () => {
      const now = (await g(ctx, '/ip/route')).filter((r) => isManaged(r.comment));
      const ok = rewrites.every((w) => now.some((r) => s(r['.id']) === w.id && s(r.gateway) === w.newGateway));
      return { ok, after: { rewritten: rewrites.length } };
    },
    rollback: async () => { /* gateway rewrite: the pre/post snapshots capture both sides */ },
  });
}
