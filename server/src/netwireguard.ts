import { restGet } from './routeros/rest.js';
import { restAdd, restRemove, restSet, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { resolveEndpoint, type AddressableRow } from './transport.js';
import { runSafeApply, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import { isValidWgKey } from './remoteaccess.js';

/**
 * Native WireGuard VPN configuration (P18) — the USER's own site-to-site / client
 * tunnels, distinct from P9's management tunnel. Composes P9 (WG primitives, the
 * router generates its OWN private key), P17 (VPN routing rides the route
 * safe-apply + mgmt-path guard + dead-man), and P5 (safe-apply).
 *
 * TWO invariants:
 *  1. The P9 MANAGEMENT TUNNEL is PROTECTED. A user-VPN change that touches the
 *     `rmik-wg` interface (or the interface carrying a tunnel device's overlay
 *     address) is REFUSED — it must never be clobbered/rerouted via this UI.
 *  2. PRIVATE KEYS never leave the router. Interfaces are created with just a
 *     name/comment; RouterOS generates the keypair. RubyMIK reads back only the
 *     PUBLIC key — the private-key (and any preshared-key) are redacted on read,
 *     never logged, never audited.
 */

export const VPN_TAG = 'RUBYMIK-VPN:';   // distinct from P9 ("RubyMIK remote-access") and P17 routes ("RUBYMIK:")

type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export interface WgContext {
  read: DeviceTarget;
  write: DeviceTarget;
  transport: WriteTransport;
  row: AddressableRow;
}
const g = (ctx: WgContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

// ---------------- classification ----------------

export type WgRole = 'mgmt' | 'user-managed' | 'user';

/** Is this the P9 management tunnel? Name `rmik-wg`, a RubyMIK-management comment,
 *  or (for a tunnel-transport device) the interface carrying the overlay address. */
export function isMgmtTunnel(name: string | null, comment: string | null, addrsOnIface: string[], row: AddressableRow): boolean {
  if (name === 'rmik-wg') return true;
  if (comment && /RubyMIK\s+(remote-access|management|hub|overlay)/i.test(comment)) return true;
  const { host, net } = resolveEndpoint(row);
  if (net === 'tunnel' && addrsOnIface.some((a) => a.split('/')[0] === host)) return true;
  return false;
}
function roleOf(name: string | null, comment: string | null, addrsOnIface: string[], row: AddressableRow): WgRole {
  if (isMgmtTunnel(name, comment, addrsOnIface, row)) return 'mgmt';
  if (comment && comment.startsWith(VPN_TAG)) return 'user-managed';
  return 'user';
}

// ---------------- read (private/preshared keys REDACTED) ----------------

export interface WgPeerView {
  id: string; publicKey: string | null; endpoint: string | null; allowedAddress: string | null;
  keepalive: string | null; hasPresharedKey: boolean; lastHandshake: string | null; rx: string | null; tx: string | null;
}
export interface WgInterfaceView {
  id: string; name: string; role: WgRole; comment: string | null;
  publicKey: string | null; listenPort: string | null; running: boolean; disabled: boolean;
  addresses: string[]; peers: WgPeerView[];
}

export async function readWireguard(ctx: WgContext): Promise<{ interfaces: WgInterfaceView[]; supported: boolean }> {
  let ifaces: Dict[];
  try { ifaces = await g(ctx, '/interface/wireguard') as Dict[]; if (!Array.isArray(ifaces)) return { interfaces: [], supported: false }; }
  catch { return { interfaces: [], supported: false }; }
  const peers = await g(ctx, '/interface/wireguard/peers').catch(() => []) as Dict[];
  const addrs = await g(ctx, '/ip/address').catch(() => []) as Dict[];
  const addrByIface = new Map<string, string[]>();
  for (const a of addrs) { const i = s(a['interface']); const ad = s(a['address']); if (i && ad) (addrByIface.get(i) ?? addrByIface.set(i, []).get(i)!).push(ad); }

  const interfaces: WgInterfaceView[] = ifaces.map((f) => {
    const name = s(f['name']) ?? '?';
    const comment = s(f['comment']);
    const addresses = addrByIface.get(name) ?? [];
    return {
      id: s(f['.id']) ?? name, name, comment,
      role: roleOf(name, comment, addresses, ctx.row),
      publicKey: s(f['public-key']),        // public only — private-key intentionally dropped
      listenPort: s(f['listen-port']), running: f['running'] === 'true', disabled: f['disabled'] === 'true',
      addresses,
      peers: peers.filter((p) => s(p['interface']) === name).map((p) => ({
        id: s(p['.id']) ?? '', publicKey: s(p['public-key']),
        endpoint: [s(p['endpoint-address']), s(p['endpoint-port'])].filter(Boolean).join(':') || s(p['current-endpoint-address']),
        allowedAddress: s(p['allowed-address']), keepalive: s(p['persistent-keepalive']),
        hasPresharedKey: !!s(p['preshared-key']),   // presence only — value dropped
        lastHandshake: s(p['last-handshake']), rx: s(p['rx']), tx: s(p['tx']),
      })),
    };
  });
  return { interfaces, supported: true };
}

// ---------------- pure validation (unit-tested) ----------------

export function isValidEndpoint(ep: string): boolean {
  // host:port or bare host/IP (RouterOS splits address/port). Accept both.
  const [host, port] = ep.split(':');
  if (!host) return false;
  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return false;
  return /^[A-Za-z0-9.\-]+$/.test(host);
}
export function isValidAllowedAddresses(list: string): boolean {
  const parts = list.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/.test(p)
    && p.split('/')[0]!.split('.').every((o) => Number(o) <= 255));
}
export function isValidKeepalive(k: string): boolean {
  return k === '' || /^\d{1,5}s?$/.test(k);
}
export function validateInterfaceInput(input: { name: string; listenPort?: number | null }): string[] {
  const errs: string[] = [];
  if (!/^[A-Za-z][A-Za-z0-9_\-]{0,31}$/.test(input.name)) errs.push('Interface name must start with a letter (letters/digits/-/_, max 32).');
  if (input.name === 'rmik-wg') errs.push('"rmik-wg" is reserved for the RubyMIK management tunnel.');
  if (input.listenPort != null && (!Number.isInteger(input.listenPort) || input.listenPort < 1 || input.listenPort > 65535)) errs.push('Listen port must be 1–65535.');
  return errs;
}
export function validatePeerInput(input: { publicKey: string; endpoint?: string; allowedAddress: string; keepalive?: string }): string[] {
  const errs: string[] = [];
  if (!isValidWgKey(input.publicKey)) errs.push('Peer public key is not a valid WireGuard key (44-char base64).');
  if (input.endpoint && !isValidEndpoint(input.endpoint)) errs.push(`"${input.endpoint}" is not a valid endpoint (host or host:port).`);
  if (!isValidAllowedAddresses(input.allowedAddress)) errs.push('Allowed-address must be one or more CIDR subnets (comma-separated).');
  if (input.keepalive && !isValidKeepalive(input.keepalive)) errs.push('Persistent-keepalive must be seconds (e.g. 25 or 25s).');
  return errs;
}

// ---------------- site-to-site helper (pure → proves C) ----------------

export interface WgEnd { publicKey: string; endpoint: string; port: number; tunnelSubnet: string }

/** Matched peer configs for a router↔router tunnel: each side gets a peer that
 *  points at the OTHER side's endpoint + subnet. Plus a ready-to-paste RouterOS
 *  script for an unmanaged far end. */
export function genSiteToSite(local: WgEnd, remote: WgEnd, remoteIface = 'wg-s2s') {
  const localPeer = {
    'public-key': remote.publicKey, 'endpoint-address': remote.endpoint, 'endpoint-port': String(remote.port),
    'allowed-address': remote.tunnelSubnet, 'persistent-keepalive': '25s', comment: `${VPN_TAG} site-to-site`,
  };
  const remotePeer = {
    'public-key': local.publicKey, 'endpoint-address': local.endpoint, 'endpoint-port': String(local.port),
    'allowed-address': local.tunnelSubnet, 'persistent-keepalive': '25s', comment: `${VPN_TAG} site-to-site`,
  };
  const remoteScript = `# Apply on the FAR-END router to complete the site-to-site tunnel.
/interface/wireguard/add name=${remoteIface} listen-port=${remote.port} comment="${VPN_TAG} site-to-site"
/interface/wireguard/peers/add interface=${remoteIface} \\
    public-key="${local.publicKey}" endpoint-address=${local.endpoint} endpoint-port=${local.port} \\
    allowed-address=${local.tunnelSubnet} persistent-keepalive=25s comment="${VPN_TAG} site-to-site"
:put ("Far-end public key = " . [/interface/wireguard get [find name=${remoteIface}] public-key])`;
  return { localPeer, remotePeer, remoteScript };
}

// ---------------- writes via runSafeApply (mgmt-tunnel PROTECTED) ----------------

type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: WgContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });

export class MgmtTunnelProtected extends Error {}

/** Throw if `ifaceName` is the management tunnel — user VPN config must not touch it. */
export async function assertNotMgmt(ctx: WgContext, ifaceName: string): Promise<WgInterfaceView | undefined> {
  const { interfaces } = await readWireguard(ctx);
  const iface = interfaces.find((i) => i.name === ifaceName || i.id === ifaceName);
  if (iface?.role === 'mgmt') {
    throw new MgmtTunnelProtected('This is the RubyMIK management tunnel (rmik-wg) — it cannot be modified through VPN configuration. Doing so could sever RubyMIK’s own access.');
  }
  return iface;
}

export async function addInterface(ctx: WgContext, sac: Sac, input: { name: string; listenPort?: number | null; comment?: string | null }): Promise<SafeApplyOutcome> {
  const comment = `${VPN_TAG}${input.comment ? ' ' + input.comment : ''}`;
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ ids: ((await g(ctx, '/interface/wireguard')) as Dict[]).map((r) => s(r['.id']) ?? '') }),
    summary: () => `Create WireGuard interface "${input.name}"${input.listenPort ? ` (listen ${input.listenPort})` : ''} — router generates its own keypair`,
    apply: async () => {
      await restAdd(ctx.write, ctx.transport, '/interface/wireguard', { name: input.name, comment, ...(input.listenPort ? { 'listen-port': String(input.listenPort) } : {}) });
    },
    verifyTook: async () => {
      const found = ((await g(ctx, '/interface/wireguard')) as Dict[]).find((r) => s(r['name']) === input.name);
      // never return the private-key in `after`
      return found ? { ok: true, after: { name: s(found['name']), 'public-key': s(found['public-key']), 'listen-port': s(found['listen-port']) } }
        : { ok: false, detail: 'Interface not present after add.' };
    },
    rollback: async (before) => {
      for (const r of ((await g(ctx, '/interface/wireguard')) as Dict[]).filter((x) => !before.ids.includes(s(x['.id']) ?? ''))) {
        await restRemove(ctx.write, ctx.transport, '/interface/wireguard', s(r['.id']) ?? '');
      }
    },
  });
}

export async function addAddress(ctx: WgContext, sac: Sac, ifaceName: string, cidr: string): Promise<SafeApplyOutcome> {
  await assertNotMgmt(ctx, ifaceName);
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ ids: ((await g(ctx, '/ip/address')) as Dict[]).map((r) => s(r['.id']) ?? '') }),
    summary: () => `Assign ${cidr} to WireGuard interface "${ifaceName}"`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, '/ip/address', { address: cidr, interface: ifaceName, comment: `${VPN_TAG} tunnel address` }); },
    verifyTook: async () => {
      const found = ((await g(ctx, '/ip/address')) as Dict[]).find((r) => s(r['interface']) === ifaceName && (s(r['address']) ?? '') === cidr);
      return found ? { ok: true, after: { address: cidr } } : { ok: false, detail: 'Address not present after add.' };
    },
    rollback: async (before) => {
      for (const r of ((await g(ctx, '/ip/address')) as Dict[]).filter((x) => !before.ids.includes(s(x['.id']) ?? ''))) {
        await restRemove(ctx.write, ctx.transport, '/ip/address', s(r['.id']) ?? '');
      }
    },
  });
}

export async function addPeer(ctx: WgContext, sac: Sac, ifaceName: string, input: { publicKey: string; endpoint?: string; allowedAddress: string; keepalive?: string; presharedKey?: string }): Promise<SafeApplyOutcome> {
  await assertNotMgmt(ctx, ifaceName);
  const [epAddr, epPort] = (input.endpoint ?? '').split(':');
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ ids: ((await g(ctx, '/interface/wireguard/peers')) as Dict[]).map((r) => s(r['.id']) ?? '') }),
    // NO key material in the summary/audit.
    summary: () => `Add WireGuard peer on "${ifaceName}" (allowed ${input.allowedAddress}${input.endpoint ? `, endpoint ${input.endpoint}` : ''}${input.presharedKey ? ', PSK set (redacted)' : ''})`,
    apply: async () => {
      const body: Record<string, unknown> = {
        interface: ifaceName, 'public-key': input.publicKey, 'allowed-address': input.allowedAddress,
        comment: `${VPN_TAG} peer`,
      };
      if (epAddr) body['endpoint-address'] = epAddr;
      if (epPort) body['endpoint-port'] = epPort;
      if (input.keepalive) body['persistent-keepalive'] = input.keepalive;
      if (input.presharedKey) body['preshared-key'] = input.presharedKey;   // secret → device only
      await restAdd(ctx.write, ctx.transport, '/interface/wireguard/peers', body);
    },
    verifyTook: async () => {
      const found = ((await g(ctx, '/interface/wireguard/peers')) as Dict[]).find((r) => s(r['interface']) === ifaceName && s(r['public-key']) === input.publicKey);
      return found ? { ok: true, after: { publicKey: s(found['public-key']), allowedAddress: s(found['allowed-address']) } } : { ok: false, detail: 'Peer not present after add.' };
    },
    rollback: async (before) => {
      for (const r of ((await g(ctx, '/interface/wireguard/peers')) as Dict[]).filter((x) => !before.ids.includes(s(x['.id']) ?? ''))) {
        await restRemove(ctx.write, ctx.transport, '/interface/wireguard/peers', s(r['.id']) ?? '');
      }
    },
  });
}

export async function removePeer(ctx: WgContext, sac: Sac, peerId: string): Promise<SafeApplyOutcome> {
  const peers = await g(ctx, '/interface/wireguard/peers') as Dict[];
  const peer = peers.find((p) => s(p['.id']) === peerId);
  if (peer) await assertNotMgmt(ctx, s(peer['interface']) ?? '');
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => peer,
    summary: (b) => `Remove WireGuard peer on "${s(b?.['interface']) ?? '?'}" (allowed ${s(b?.['allowed-address']) ?? '?'})`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, '/interface/wireguard/peers', peerId); },
    verifyTook: async () => {
      const still = ((await g(ctx, '/interface/wireguard/peers')) as Dict[]).some((p) => s(p['.id']) === peerId);
      return still ? { ok: false, detail: 'Peer still present after delete.' } : { ok: true };
    },
    rollback: async (b) => {
      if (b) await restAdd(ctx.write, ctx.transport, '/interface/wireguard/peers', {
        interface: s(b['interface']), 'public-key': s(b['public-key']), 'allowed-address': s(b['allowed-address']),
        ...(s(b['endpoint-address']) ? { 'endpoint-address': s(b['endpoint-address']) } : {}),
        ...(s(b['comment']) ? { comment: s(b['comment']) } : {}),
      });
    },
  });
}

export async function removeInterface(ctx: WgContext, sac: Sac, ifaceId: string): Promise<SafeApplyOutcome> {
  const iface = await assertNotMgmt(ctx, ifaceId);
  const name = iface?.name ?? ifaceId;
  return runSafeApply<{ peers: Dict[]; iface: Dict | undefined }>(ctxFull(ctx, sac), {
    snapshot: async () => {
      const ifaces = await g(ctx, '/interface/wireguard') as Dict[];
      const peers = (await g(ctx, '/interface/wireguard/peers') as Dict[]).filter((p) => s(p['interface']) === name);
      return { peers, iface: ifaces.find((i) => s(i['.id']) === ifaceId || s(i['name']) === name) };
    },
    summary: (b) => `Remove WireGuard interface "${s(b.iface?.['name']) ?? name}" and its ${b.peers.length} peer(s)`,
    apply: async () => {
      for (const p of (await g(ctx, '/interface/wireguard/peers') as Dict[]).filter((x) => s(x['interface']) === name)) {
        await restRemove(ctx.write, ctx.transport, '/interface/wireguard/peers', s(p['.id']) ?? '');
      }
      await restRemove(ctx.write, ctx.transport, '/interface/wireguard', iface?.id ?? ifaceId);
    },
    verifyTook: async () => {
      const still = ((await g(ctx, '/interface/wireguard')) as Dict[]).some((i) => s(i['name']) === name);
      return still ? { ok: false, detail: 'Interface still present after delete.' } : { ok: true };
    },
    rollback: async (b) => {
      if (b.iface) await restAdd(ctx.write, ctx.transport, '/interface/wireguard', { name, ...(s(b.iface['comment']) ? { comment: s(b.iface['comment']) } : {}) });
      for (const p of b.peers) await restAdd(ctx.write, ctx.transport, '/interface/wireguard/peers', {
        interface: name, 'public-key': s(p['public-key']), 'allowed-address': s(p['allowed-address']),
        ...(s(p['endpoint-address']) ? { 'endpoint-address': s(p['endpoint-address']) } : {}),
      });
    },
  });
}
