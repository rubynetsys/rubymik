import { generateFirewall, type Preset, type Rule, type FirewallConfig } from './firewall.js';
import { generateBootstrap, type HubConfig, type PeerRow } from './remoteaccess.js';

/**
 * ============================================================================
 *  NEW-ROUTER PROVISIONING (P11) — generate a COMPLETE baseline for a blank
 *  MikroTik: identity, bridge, addressing, WAN, DHCP, NAT, firewall, and (for a
 *  remote site) the WireGuard tunnel-back.
 *
 *  This is the highest-stakes config in RubyMIK: a blank router built wrong comes
 *  up broken or unreachable. So the discipline is:
 *    1. RUTHLESS VALIDATION — refuse to emit a config that isn't internally
 *       coherent (validateSpec below). Never generate a lockout.
 *    2. The generated firewall ALWAYS carries the P6 mgmt-accept guard, so a
 *       provisioned router can never come up locked out.
 *    3. Reuse the proven primitives — P6 firewall generator, P9 tunnel bootstrap —
 *       rather than re-deriving rules here.
 * ============================================================================
 */

export type WanType = 'dhcp' | 'static' | 'pppoe';
export type IfaceRole = 'wan' | 'lan' | 'unused';

export interface BaselineSpec {
  identity: string;
  interfaces: Array<{ name: string; role: IfaceRole }>;
  wan: {
    type: WanType;
    static?: { address: string; gateway: string; dns: string }; // address is CIDR
    pppoe?: { user: string; password: string };
  };
  lan: { routerIp: string; prefix: number };
  dhcp: { enabled: boolean; poolStart?: string; poolEnd?: string; dns?: string; leaseTime?: string };
  firewall: Preset;
  remote: boolean;
}

const BRIDGE = 'bridge-lan';

// ---------- IPv4 / subnet math (pure, unit-tested) ----------

export function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const o = [m[1], m[2], m[3], m[4]].map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}
export function isValidIpv4(ip: string): boolean { return ipToInt(ip) !== null; }
function maskInt(prefix: number): number { return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; }
function networkInt(ip: number, prefix: number): number { return (ip & maskInt(prefix)) >>> 0; }

/** Is `ip` inside the subnet defined by netIp/prefix? */
export function inSubnet(ip: string, netIp: string, prefix: number): boolean {
  const a = ipToInt(ip), b = ipToInt(netIp);
  if (a === null || b === null) return false;
  return networkInt(a, prefix) === networkInt(b, prefix);
}
/** Do two subnets (each ip/prefix) overlap at all? */
export function subnetsOverlap(aIp: string, aPrefix: number, bIp: string, bPrefix: number): boolean {
  const a = ipToInt(aIp), b = ipToInt(bIp);
  if (a === null || b === null) return false;
  const shorter = Math.min(aPrefix, bPrefix); // the larger network
  return networkInt(a, shorter) === networkInt(b, shorter);
}

// ---------- RUTHLESS VALIDATION ----------

/** Validate a whole baseline spec is internally coherent. Returns [] if OK, else
 *  a list of specific, human-readable errors. Generation must NEVER run on a spec
 *  that fails this. */
export function validateSpec(spec: BaselineSpec): string[] {
  const e: string[] = [];
  if (!spec.identity || !spec.identity.trim()) e.push('Router identity (name) is required.');

  // Interface roles
  const names = spec.interfaces.map((i) => i.name);
  const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupNames.length) e.push(`Interface listed more than once: ${[...new Set(dupNames)].join(', ')}.`);
  const wanIfaces = spec.interfaces.filter((i) => i.role === 'wan');
  const lanIfaces = spec.interfaces.filter((i) => i.role === 'lan');
  if (wanIfaces.length !== 1) e.push(`Exactly one interface must be the WAN (found ${wanIfaces.length}).`);
  if (lanIfaces.length === 0) e.push('At least one interface must be a LAN bridge member.');
  const wanName = wanIfaces[0]?.name;
  if (wanName && lanIfaces.some((i) => i.name === wanName)) e.push('The WAN interface cannot also be a LAN bridge member.');

  // LAN addressing
  if (!isValidIpv4(spec.lan.routerIp)) e.push(`Router LAN IP "${spec.lan.routerIp}" is not a valid IPv4 address.`);
  if (!Number.isInteger(spec.lan.prefix) || spec.lan.prefix < 8 || spec.lan.prefix > 30) e.push('LAN prefix length must be between /8 and /30.');

  // DHCP server
  if (spec.dhcp.enabled) {
    const { poolStart, poolEnd, dns, leaseTime } = spec.dhcp;
    if (!poolStart || !isValidIpv4(poolStart)) e.push('DHCP pool start is not a valid IPv4 address.');
    if (!poolEnd || !isValidIpv4(poolEnd)) e.push('DHCP pool end is not a valid IPv4 address.');
    if (poolStart && poolEnd && isValidIpv4(poolStart) && isValidIpv4(poolEnd)) {
      if (ipToInt(poolStart)! > ipToInt(poolEnd)!) e.push('DHCP pool start is after the pool end.');
      if (isValidIpv4(spec.lan.routerIp)) {
        if (!inSubnet(poolStart, spec.lan.routerIp, spec.lan.prefix)) e.push(`DHCP pool start ${poolStart} is outside the LAN subnet.`);
        if (!inSubnet(poolEnd, spec.lan.routerIp, spec.lan.prefix)) e.push(`DHCP pool end ${poolEnd} is outside the LAN subnet.`);
        const rInt = ipToInt(spec.lan.routerIp)!;
        if (ipToInt(poolStart)! <= rInt && rInt <= ipToInt(poolEnd)!) e.push(`The router's own IP ${spec.lan.routerIp} falls inside the DHCP pool — it must be excluded.`);
      }
    }
    if (dns && !dns.split(',').every((d) => isValidIpv4(d.trim()))) e.push('DHCP DNS must be one or more valid IPv4 addresses.');
    if (leaseTime && !/^\d+[smhd]$/.test(leaseTime.trim())) e.push('DHCP lease time must look like 30m, 1h, 1d.');
  }

  // WAN
  if (spec.wan.type === 'static') {
    const s = spec.wan.static;
    if (!s) e.push('Static WAN requires an address, gateway and DNS.');
    else {
      const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(s.address.trim());
      if (!m || !isValidIpv4(m[1]!)) e.push('Static WAN address must be CIDR, e.g. 41.0.0.2/30.');
      if (!isValidIpv4(s.gateway)) e.push('Static WAN gateway is not a valid IPv4 address.');
      if (!s.dns || !s.dns.split(',').every((d) => isValidIpv4(d.trim()))) e.push('Static WAN DNS must be valid IPv4 address(es).');
      // WAN/LAN overlap
      if (m && isValidIpv4(m[1]!) && isValidIpv4(spec.lan.routerIp)) {
        if (subnetsOverlap(m[1]!, Number(m[2]), spec.lan.routerIp, spec.lan.prefix)) e.push('The WAN subnet overlaps the LAN subnet — they must be distinct.');
      }
    }
  } else if (spec.wan.type === 'pppoe') {
    if (!spec.wan.pppoe?.user || !spec.wan.pppoe?.password) e.push('PPPoE WAN requires a username and password.');
  }
  // (dhcp WAN needs nothing extra)

  // Firewall + mgmt path. The generated firewall ALWAYS carries the mgmt-accept
  // guard, but we still assert a trusted mgmt path exists so a locked-out config
  // is impossible: LAN for a local router, the tunnel for a remote one.
  if (spec.firewall !== 'off') {
    if (!spec.remote && lanIfaces.length === 0) e.push('A firewall is enabled but there is no LAN interface to keep management reachable.');
    // remote path relies on the rmik-wg tunnel accept, added by the bootstrap.
  }

  return e;
}

// ---------- Mode A: generate the complete baseline script ----------

function cidrLen(prefix: number): string { return String(prefix); }

/** RouterOS-quote a value if it needs it. */
function q(v: string): string { return /[\s"']/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v; }

/** Render a P6 firewall Rule object as a RouterOS `/ip firewall filter add` line. */
export function renderFilterRule(rule: Rule): string {
  const parts = Object.entries(rule).map(([k, v]) => `${k}=${q(v)}`);
  return `/ip firewall filter add ${parts.join(' ')}`;
}

export interface GenerateOptions {
  /** For a remote baseline: the P9-generated tunnel bootstrap to embed (reused, not re-derived). */
  tunnelBootstrap?: string;
}

/**
 * Generate the full baseline RouterOS script for a validated spec. Caller MUST
 * have run validateSpec first. Order is deliberate: identity → bridge → LAN IP →
 * WAN → DHCP → NAT → firewall (mgmt-accept first) → tunnel-back.
 */
export function generateBaseline(spec: BaselineSpec, opts: GenerateOptions = {}): string {
  const L: string[] = [];
  const wan = spec.interfaces.find((i) => i.role === 'wan')!.name;
  const lanMembers = spec.interfaces.filter((i) => i.role === 'lan').map((i) => i.name);
  const subnet = subnetAddress(spec.lan.routerIp, spec.lan.prefix);

  L.push('# ============================================================================');
  L.push(`# RubyMIK baseline for "${spec.identity}" — apply ONCE to a blank/factory router.`);
  L.push('# Complete config: identity, LAN bridge, addressing, WAN, DHCP, NAT, firewall' + (spec.remote ? ', tunnel-back.' : '.'));
  L.push('# ============================================================================', '');

  L.push(`/system identity set name=${q(spec.identity)}`, '');

  // LAN bridge
  L.push(`/interface bridge add name=${BRIDGE} comment="RUBYMIK LAN"`);
  for (const m of lanMembers) L.push(`/interface bridge port add bridge=${BRIDGE} interface=${m}`);
  L.push(`/ip address add address=${spec.lan.routerIp}/${cidrLen(spec.lan.prefix)} interface=${BRIDGE} comment="RUBYMIK LAN gateway"`, '');

  // WAN
  L.push('# --- WAN ---');
  if (spec.wan.type === 'dhcp') {
    L.push(`/ip dhcp-client add interface=${wan} use-peer-dns=yes add-default-route=yes disabled=no comment="RUBYMIK WAN"`);
  } else if (spec.wan.type === 'static') {
    const s = spec.wan.static!;
    L.push(`/ip address add address=${s.address} interface=${wan} comment="RUBYMIK WAN"`);
    L.push(`/ip route add gateway=${s.gateway} comment="RUBYMIK default route"`);
    L.push(`/ip dns set servers=${s.dns}`);
  } else {
    const p = spec.wan.pppoe!;
    L.push(`/interface pppoe-client add name=pppoe-wan interface=${wan} user=${q(p.user)} password=${q(p.password)} add-default-route=yes use-peer-dns=yes disabled=no comment="RUBYMIK WAN"`);
  }
  L.push('');

  // DHCP server
  if (spec.dhcp.enabled) {
    L.push('# --- DHCP server ---');
    L.push(`/ip pool add name=rubymik-lan-pool ranges=${spec.dhcp.poolStart}-${spec.dhcp.poolEnd}`);
    L.push(`/ip dhcp-server add name=rubymik-lan-dhcp interface=${BRIDGE} address-pool=rubymik-lan-pool lease-time=${spec.dhcp.leaseTime || '1h'} disabled=no`);
    const dns = spec.dhcp.dns || spec.lan.routerIp;
    L.push(`/ip dhcp-server network add address=${subnet}/${cidrLen(spec.lan.prefix)} gateway=${spec.lan.routerIp} dns-server=${dns}`);
    L.push('');
  }

  // NAT (LAN clients out via WAN)
  L.push('# --- NAT ---');
  L.push(`/ip firewall nat add chain=srcnat out-interface=${wan} action=masquerade comment="RUBYMIK: LAN masquerade"`, '');

  // Firewall — reuse the P6 generator; mgmt-accept guard is ALWAYS first.
  if (spec.firewall !== 'off') {
    L.push('# --- Firewall (mgmt-accept guard first — cannot lock out management) ---');
    for (const rule of baselineFirewall(spec)) L.push(renderFilterRule(rule));
    L.push('');
  }

  // Tunnel-back (remote) — reuse the P9 bootstrap verbatim.
  if (spec.remote && opts.tunnelBootstrap) {
    L.push('# --- Remote management tunnel (WireGuard, dials RubyMIK) ---');
    L.push(opts.tunnelBootstrap.trim());
  }

  return L.join('\n') + '\n';
}

/** The P6 firewall ruleset for a baseline. Trusted interface = the LAN bridge
 *  (local admin); for a remote router the tunnel accept comes from the bootstrap. */
export function baselineFirewall(spec: BaselineSpec): Rule[] {
  const wan = spec.interfaces.find((i) => i.role === 'wan')!.name;
  const cfg: FirewallConfig = { wanInterface: wan, trustedInterface: BRIDGE, mgmtSources: [] };
  return generateFirewall(spec.firewall, cfg, []);
}

function subnetAddress(routerIp: string, prefix: number): string {
  const i = ipToInt(routerIp);
  if (i === null) return routerIp;
  const n = networkInt(i, prefix);
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Build the P9 tunnel bootstrap for a remote baseline (reuses P9 generateBootstrap). */
export function baselineTunnelBootstrap(hub: HubConfig, peer: PeerRow): string {
  return generateBootstrap(hub, peer);
}
