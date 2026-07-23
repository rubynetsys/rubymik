// P43.2 — router-side DNS-filtering enforcement (pure rule-set core). Mirrors netnat/netwan:
// this module produces the exact RouterOS object set for forcing LAN clients through the
// filtering resolver, so it's fixture-diffable. All I/O (apply/teardown) is elsewhere.
//
// Design note (redirect target): we redirect client :53 to the ROUTER's own DNS (action=redirect)
// and point /ip/dns at the resolver — NOT a dst-nat straight to the resolver IP. That's the only
// way fail-OPEN works with static rules: /ip/dns keeps a fallback upstream (resolver dead →
// router still answers, unfiltered → internet stays up); fail-CLOSED lists only the resolver
// (resolver dead → no DNS). The resolver IP is the /ip/dns upstream (same-LAN or over the WG
// tunnel-back). Everything is RUBYMIK-DNS-tagged; teardown restores the prior /ip/dns verbatim.

import type { NatMgmtInfo } from './netnat.js';

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
  lists: PlanObject[];     // address-list entries: exemptions + DoH endpoints
  all: PlanObject[];       // every tagged firewall/list object (NOT the /ip/dns patch)
}

const isIpv4 = (v: string) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v);

export function validateEnforceInput(spec: DnsEnforceSpec): string[] {
  const e: string[] = [];
  if (!isIpv4(spec.resolverIp)) e.push('Resolver IP must be a valid IPv4 address.');
  if (!spec.lanInterfaces.length) e.push('At least one LAN interface is required.');
  for (const i of spec.lanInterfaces) if (!i || /\s/.test(i)) e.push(`Invalid LAN interface "${i}".`);
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
  for (const ip of spec.exemptions) lists.push({ menu: '/ip/firewall/address-list', body: { list: EXEMPT_LIST, address: ip, comment: tag('exempt') } });
  if (spec.blockDoh) for (const ip of DOH_ENDPOINTS) lists.push({ menu: '/ip/firewall/address-list', body: { list: DOH_LIST, address: ip, comment: tag('doh-endpoint') } });

  const servers = spec.failMode === 'open' ? `${spec.resolverIp},${spec.fallbackUpstream}` : spec.resolverIp;
  return {
    dns: { servers, 'allow-remote-requests': 'yes' },
    redirects, filters, lists,
    all: [...redirects, ...filters, ...lists],
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
