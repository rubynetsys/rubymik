// P43.2 — router-side DNS-filtering enforcement. Mirrors netnat/netwan: a pure, fixture-diffable
// rule-set builder (buildEnforcementPlan) + the safe-apply I/O (applyEnforcement/teardownEnforcement)
// that forces LAN clients through the filtering resolver.
//
// Design note (redirect target): we redirect client :53 to the ROUTER's own DNS (action=redirect)
// and point /ip/dns at the resolver — NOT a dst-nat straight to the resolver IP. That's the only
// way fail-OPEN works with static rules: /ip/dns keeps a fallback upstream (resolver dead →
// router still answers, unfiltered → internet stays up); fail-CLOSED lists only the resolver
// (resolver dead → no DNS). The resolver IP is the /ip/dns upstream (same-LAN or over the WG
// tunnel-back). Everything is RUBYMIK-DNS-tagged; teardown restores the prior /ip/dns verbatim.

import { restGet } from './routeros/rest.js';
import { restAdd, restRemove, restCommand } from './routeros/write.js';
import { runSafeApply, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import { mgmtInfo, type NatContext, type NatMgmtInfo } from './netnat.js';

export const TAG = 'RUBYMIK-DNS';
export const EXEMPT_LIST = 'RUBYMIK-DNS-exempt';
export const DOH_LIST = 'RUBYMIK-DNS-doh';
/** The remote router's RubyMIK WireGuard interface (remoteaccess.ts) — a tunnel-back we must
 *  never apply client enforcement to. */
export const WG_IFACE = 'rmik-wg';
const tag = (note: string) => `${TAG} ${note}`;

/** Curated well-known DoH provider IPs for the best-effort 443 block. PUBLIC addresses (fine in
 *  a public repo); an admin can extend the list. DoH mitigation is inherently best-effort — a new
 *  endpoint or an ECH-fronted provider can still slip through; the UI states this plainly. */
export const DOH_ENDPOINTS: string[] = [
  '1.1.1.1', '1.0.0.1',          // Cloudflare
  '8.8.8.8', '8.8.4.4',          // Google
  '9.9.9.9', '149.112.112.112',  // Quad9
  '94.140.14.14', '94.140.15.15',// AdGuard
  '208.67.222.222', '208.67.220.220', // OpenDNS
  '45.90.28.0', '45.90.30.0',    // NextDNS anycast
];

export type FailMode = 'open' | 'closed';
export interface DnsEnforceSpec {
  resolverIp: string;         // the filtering resolver (/ip/dns upstream): same-LAN IP or tunnel IP
  resolverNet: 'direct' | 'tunnel';
  lanInterfaces: string[];    // LAN client interfaces to enforce on (NEVER the mgmt/tunnel path)
  wanInterfaces: string[];    // WAN/uplink interfaces — REQUIRED so we can close the open resolver
  exemptions: string[];       // client IPs that skip the redirect + blocks
  failMode: FailMode;         // open (fallback upstream kept) | closed (resolver-only)
  fallbackUpstream: string;   // used only in fail-open
  blockDoh: boolean;          // add the best-effort DoH 443 block
}

export interface PlanObject { menu: string; body: Record<string, string> }
export interface DnsSettingsPatch { servers: string; 'allow-remote-requests': string }
export interface EnforcePlan {
  dns: DnsSettingsPatch;   // PATCH /ip/dns (fail-mode lives here)
  redirects: PlanObject[]; // dst-nat redirect udp+tcp :53 → router DNS, per LAN interface
  filters: PlanObject[];   // DoT (853) drop + optional DoH (443 to DOH_LIST) drop, per LAN interface
  wanDnsDrop: PlanObject[];// OPEN-RESOLVER GUARD: input-chain :53 drop from every WAN (see note)
  lists: PlanObject[];     // address-list entries: exemptions + DoH endpoints
  all: PlanObject[];       // every tagged firewall/list object (NOT the /ip/dns patch)
}

const isIpv4 = (v: string) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v);

export function validateEnforceInput(spec: DnsEnforceSpec): string[] {
  const e: string[] = [];
  if (!isIpv4(spec.resolverIp)) e.push('Resolver IP must be a valid IPv4 address.');
  if (!spec.lanInterfaces.length) e.push('At least one LAN interface is required.');
  for (const i of spec.lanInterfaces) if (!i || /\s/.test(i)) e.push(`Invalid LAN interface "${i}".`);
  if (!spec.wanInterfaces.length) e.push('At least one WAN interface is required — routing DNS via the router needs a WAN 53 drop so the router is not left an open resolver.');
  for (const i of spec.wanInterfaces) if (!i || /\s/.test(i)) e.push(`Invalid WAN interface "${i}".`);
  for (const ip of spec.exemptions) if (!isIpv4(ip)) e.push(`Exemption "${ip}" is not a valid IPv4 address.`);
  if (spec.failMode === 'open' && !isIpv4(spec.fallbackUpstream)) e.push('Fail-open needs a valid fallback upstream IP.');
  if (spec.failMode !== 'open' && spec.failMode !== 'closed') e.push('Fail mode must be open or closed.');
  return e;
}

/**
 * The exact enforcement object set (pure, ordered → fixture-diffable). Redirect + blocks are
 * scoped to `src-address-list=!EXEMPT_LIST` so exempt clients pass through untouched.
 */
export function buildEnforcementPlan(spec: DnsEnforceSpec): EnforcePlan {
  const notExempt: Record<string, string> = spec.exemptions.length ? { 'src-address-list': `!${EXEMPT_LIST}` } : {};
  const redirects: PlanObject[] = [];
  const filters: PlanObject[] = [];
  const lists: PlanObject[] = [];

  for (const iface of spec.lanInterfaces) {
    for (const proto of ['udp', 'tcp'] as const) {
      redirects.push({ menu: '/ip/firewall/nat', body: {
        chain: 'dstnat', 'in-interface': iface, protocol: proto, 'dst-port': '53', ...notExempt,
        action: 'redirect', 'to-ports': '53', comment: tag(`redirect-${proto}-${iface}`),
      } });
    }
    // block DoT (853/tcp) so clients can't bypass the redirect with an encrypted resolver
    filters.push({ menu: '/ip/firewall/filter', body: {
      chain: 'forward', 'in-interface': iface, protocol: 'tcp', 'dst-port': '853', ...notExempt,
      action: 'drop', comment: tag(`block-dot-${iface}`),
    } });
    if (spec.blockDoh) {
      filters.push({ menu: '/ip/firewall/filter', body: {
        chain: 'forward', 'in-interface': iface, protocol: 'tcp', 'dst-port': '443',
        'dst-address-list': DOH_LIST, ...notExempt, action: 'drop', comment: tag(`block-doh-${iface}`),
      } });
    }
  }
  // OPEN-RESOLVER GUARD (security-critical): allow-remote-requests=yes turns the router into a
  // resolver on EVERY interface, including WAN → a DNS-amplification reflector. Drop :53 on input
  // from every WAN so the router only answers LAN clients. Always present when we set /ip/dns.
  const wanDnsDrop: PlanObject[] = [];
  for (const wan of spec.wanInterfaces) {
    for (const proto of ['udp', 'tcp'] as const) {
      wanDnsDrop.push({ menu: '/ip/firewall/filter', body: {
        chain: 'input', 'in-interface': wan, protocol: proto, 'dst-port': '53',
        action: 'drop', comment: tag(`block-wan-dns-${proto}-${wan}`),
      } });
    }
  }
  for (const ip of spec.exemptions) lists.push({ menu: '/ip/firewall/address-list', body: { list: EXEMPT_LIST, address: ip, comment: tag('exempt') } });
  if (spec.blockDoh) for (const ip of DOH_ENDPOINTS) lists.push({ menu: '/ip/firewall/address-list', body: { list: DOH_LIST, address: ip, comment: tag('doh-endpoint') } });

  const servers = spec.failMode === 'open' ? `${spec.resolverIp},${spec.fallbackUpstream}` : spec.resolverIp;
  return {
    dns: { servers, 'allow-remote-requests': 'yes' },
    redirects, filters, wanDnsDrop, lists,
    all: [...redirects, ...filters, ...wanDnsDrop, ...lists],
  };
}

/** Does an interface carry the RubyMIK management path (or the WG tunnel-back)? */
function touchesMgmt(iface: string, mgmt: NatMgmtInfo): boolean {
  return iface === mgmt.mgmtInterface || mgmt.mgmtPorts.includes(iface) || iface === WG_IFACE;
}

/**
 * dnsMgmtGuard — the amendment-3 pattern for DNS: the 53-redirect + 853/443 blocks must match LAN
 * client interfaces ONLY. Refuse an empty interface set (would match everything, incl. the mgmt
 * path + tunnel-back) or any LAN interface that is the mgmt path / rmik-wg. Returns null when safe.
 */
export function dnsMgmtGuard(mgmt: NatMgmtInfo, spec: DnsEnforceSpec): string | null {
  if (!spec.lanInterfaces.length) {
    return 'Refused: no LAN interface selected. An empty in-interface match applies the DNS redirect and blocks to EVERY interface — including the management path and any WireGuard tunnel-back. Select the LAN client interfaces explicitly.';
  }
  const bad = spec.lanInterfaces.filter((i) => touchesMgmt(i, mgmt));
  if (bad.length) {
    return `Refused: ${bad.join(', ')} carries the RubyMIK management path${bad.includes(WG_IFACE) ? ' / WireGuard tunnel-back' : ''}. DNS enforcement must match LAN client interfaces only — never the interface RubyMIK reaches this router on.`;
  }
  return null;
}

/** Sim assertion (like mangleIsMgmtSafe): NO enforcement object matches the mgmt path or has an
 *  empty in-interface. Every redirect/filter must carry an explicit LAN in-interface. */
export function enforcementIsMgmtSafe(plan: EnforcePlan, mgmt: NatMgmtInfo): { safe: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const o of [...plan.redirects, ...plan.filters]) {
    const iface = o.body['in-interface'];
    if (!iface) { problems.push(`${o.body.comment}: no in-interface — would match ALL interfaces incl. mgmt`); continue; }
    if (touchesMgmt(iface, mgmt)) problems.push(`${o.body.comment}: matches the mgmt path (${iface})`);
  }
  return { safe: problems.length === 0, problems };
}

export type TeardownOp =
  | { kind: 'restore-dns'; patch: DnsSettingsPatch }
  | { kind: 'flush-dns' }
  | { kind: 'remove-tagged' };
/**
 * Teardown ORDER (open-resolver safety, same class as P42's add-verify-remove): restore the prior
 * /ip/dns — CLOSING the resolver (allow-remote-requests → prior, usually 'no') — BEFORE removing
 * the RUBYMIK-DNS objects, which include the WAN :53 input-drop. Removing that drop while the
 * resolver is still open (even briefly, and permanently if a later step fails) would leave the
 * router an open DNS reflector — the worst possible teardown residue.
 */
export function buildTeardownOps(priorDns: DnsSettingsPatch): TeardownOp[] {
  return [{ kind: 'restore-dns', patch: priorDns }, { kind: 'flush-dns' }, { kind: 'remove-tagged' }, { kind: 'flush-dns' }];
}

// ── read + write (safe-apply + P21-snapshot-bracketed) ──
export type DnsContext = NatContext;
type Dict = Record<string, unknown>;
type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: DnsContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });
const g = (ctx: DnsContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path) as Promise<Dict[]>;
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const isManaged = (c: unknown) => typeof c === 'string' && c.startsWith(TAG);
const MENUS = ['/ip/firewall/nat', '/ip/firewall/filter', '/ip/firewall/address-list'] as const;
type IdSet = Record<string, string[]>;
const setDns = (ctx: DnsContext, patch: DnsSettingsPatch) => restCommand(ctx.write, ctx.transport, '/ip/dns/set', patch as unknown as Record<string, unknown>);
const flushDns = (ctx: DnsContext) => restCommand(ctx.write, ctx.transport, '/ip/dns/cache/flush', {});

/** The static /ip/dns settings we PATCH — captured before apply so teardown restores them verbatim. */
async function readDnsSettings(ctx: DnsContext): Promise<DnsSettingsPatch> {
  const rows = await g(ctx, '/ip/dns');
  const r = rows[0] ?? {};
  return { servers: s(r.servers), 'allow-remote-requests': s(r['allow-remote-requests']) || 'no' };
}
async function allIds(ctx: DnsContext): Promise<IdSet> {
  const out: IdSet = {};
  for (const m of MENUS) out[m] = (await g(ctx, m)).map((r) => s(r['.id']));
  return out;
}

export interface DnsEnforceView {
  configured: boolean; manageable: boolean;
  redirects: number; dotBlocks: number; dohBlocks: number; wanDrops: number; exemptions: number;
  dnsServers: string; allowRemoteRequests: string; mgmt: NatMgmtInfo;
}
export async function readEnforcement(ctx: DnsContext): Promise<DnsEnforceView> {
  const [nat, filter, alist, dns, mgmt] = await Promise.all([
    g(ctx, '/ip/firewall/nat'), g(ctx, '/ip/firewall/filter'), g(ctx, '/ip/firewall/address-list'), g(ctx, '/ip/dns'), mgmtInfo(ctx),
  ]);
  const has = (rows: Dict[], sub: string) => rows.filter((r) => isManaged(r.comment) && s(r.comment).includes(sub));
  const d = dns[0] ?? {};
  const redirects = has(nat, 'redirect');
  return {
    configured: redirects.length > 0,
    manageable: !!(ctx.row.write_username_enc && ctx.row.write_password_enc),
    redirects: redirects.length,
    dotBlocks: has(filter, 'block-dot').length,
    dohBlocks: has(filter, 'block-doh').length,
    wanDrops: has(filter, 'block-wan-dns').length,
    exemptions: alist.filter((r) => isManaged(r.comment) && s(r.list) === EXEMPT_LIST).length,
    dnsServers: s(d.servers), allowRemoteRequests: s(d['allow-remote-requests']) || 'no', mgmt,
  };
}

/** Apply enforcement as ONE snapshot-bracketed op: add every RUBYMIK-DNS object, point /ip/dns at
 *  the resolver, then FLUSH the router DNS cache (so a rule change doesn't keep serving a stale
 *  0.0.0.0). Rollback removes what we added AND restores the prior /ip/dns (servers +
 *  allow-remote-requests) verbatim. after.priorDns is returned so the API can persist it for teardown. */
export async function applyEnforcement(ctx: DnsContext, sac: Sac, spec: DnsEnforceSpec): Promise<SafeApplyOutcome> {
  const plan = buildEnforcementPlan(spec);
  let before: IdSet = {};
  let priorDns: DnsSettingsPatch = { servers: '', 'allow-remote-requests': 'no' };
  return runSafeApply<{ before: IdSet; priorDns: DnsSettingsPatch }>(ctxFull(ctx, sac), {
    snapshot: async () => { before = await allIds(ctx); priorDns = await readDnsSettings(ctx); return { before, priorDns }; },
    summary: () => `Enforce DNS filtering (${spec.failMode}): +${plan.all.length} RUBYMIK-DNS objects, /ip/dns → ${plan.dns.servers}, flush cache`,
    apply: async () => {
      for (const o of plan.all) await restAdd(ctx.write, ctx.transport, o.menu, o.body);
      await setDns(ctx, plan.dns);
      await flushDns(ctx); // don't serve stale blocked/allowed answers
    },
    verifyTook: async () => {
      const v = await readEnforcement(ctx);
      const ok = v.redirects >= 1 && v.wanDrops >= 1 && v.dnsServers.startsWith(spec.resolverIp) && v.allowRemoteRequests === 'yes';
      return { ok, after: { redirects: v.redirects, wanDrops: v.wanDrops, dnsServers: v.dnsServers, priorDns } };
    },
    rollback: async (b) => {
      await setDns(ctx, b.priorDns); // CLOSE the resolver FIRST (restore allow-remote-requests) …
      await flushDns(ctx);
      const now = await allIds(ctx);
      for (const m of [...MENUS].reverse()) for (const id of (now[m] ?? []).filter((x) => !(b.before[m] ?? []).includes(x))) await restRemove(ctx.write, ctx.transport, m, id); // … THEN drop the WAN-53 rule etc.
      await flushDns(ctx);
    },
  });
}

/** Teardown — remove ONLY RUBYMIK-DNS objects, restore the prior /ip/dns verbatim, flush cache.
 *  Pass the prior /ip/dns captured at apply time (persisted in dns_enforcement.prior_dns_json). */
export async function teardownEnforcement(ctx: DnsContext, sac: Sac, priorDns: DnsSettingsPatch): Promise<SafeApplyOutcome> {
  return runSafeApply<{ count: number }>(ctxFull(ctx, sac), {
    snapshot: async () => {
      let count = 0;
      for (const m of MENUS) count += (await g(ctx, m)).filter((r) => isManaged(r.comment)).length;
      return { count };
    },
    summary: (b) => `Tear down DNS filtering (${b.count} RUBYMIK-DNS objects, restore /ip/dns → ${priorDns.servers || '(none)'})`,
    apply: async () => {
      // Ordered so the resolver is closed BEFORE the WAN-53 drop is removed (buildTeardownOps).
      for (const op of buildTeardownOps(priorDns)) {
        if (op.kind === 'restore-dns') await setDns(ctx, op.patch);
        else if (op.kind === 'flush-dns') await flushDns(ctx);
        else for (const m of [...MENUS].reverse()) {
          const rows = await g(ctx, m);
          for (const r of rows.filter((x) => isManaged(x.comment))) await restRemove(ctx.write, ctx.transport, m, s(r['.id']));
        }
      }
    },
    verifyTook: async () => { const v = await readEnforcement(ctx); return { ok: v.redirects === 0 && v.wanDrops === 0, after: { dnsServers: v.dnsServers } }; },
    rollback: async () => { /* removal+restore; the P21 pre-snapshot is the restore point */ },
  });
}
