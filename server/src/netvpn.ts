import { restGet } from './routeros/rest.js';
import { restAdd, restSet, restRemove, restCommand, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import type { AddressableRow } from './transport.js';
import { runSafeApply, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import { readL2, type L2Context } from './netl2.js';

/**
 * VPN breadth (P32) — the PPP-family remote-access tunnels (L2TP/IPsec, SSTP,
 * OVPN) on top of P18's WireGuard, plus the shared PPP-secret account store and
 * a read-only view of the router certificate store. All three client protocols
 * share one shape (/interface/<proto>-client with connect-to/user/password), so
 * one parameterised module covers them rather than three near-identical clones.
 *
 * Two invariants, inherited from P24 (PPPoE) and P18 (WireGuard):
 *  1. The MANAGEMENT PATH is protected. If RubyMIK currently reaches the router
 *     THROUGH a tunnel (the mgmt IP rides an l2tp/sstp/ovpn interface), deleting,
 *     disabling, or re-crediting that tunnel would drop RubyMIK's own session —
 *     vpnMgmtGuard REFUSES it (a provable cut), mirroring pppoeMgmtGuard class 2/3.
 *  2. SECRETS are write-only. The PPP password and the L2TP/IPsec pre-shared key
 *     go to the ROUTER only — never returned to the browser (presence flag only),
 *     never logged, never in the audit before/after (kept transiently in a
 *     rollback closure). Same model as the PPPoE password and Wi-Fi passphrase.
 */

export const TAG = 'RUBYMIK-VPN';   // shared with P18 comment convention (RUBYMIK-VPN:)

type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const b = (v: unknown): boolean => v === 'true' || v === 'yes';

export type VpnContext = L2Context; // { read, write, transport, row }
const g = (ctx: VpnContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

export class VpnProtected extends Error {}

// ---------------- protocol table ----------------

export type TunnelProto = 'l2tp' | 'sstp' | 'ovpn';
export const TUNNEL_PROTOS: TunnelProto[] = ['l2tp', 'sstp', 'ovpn'];
const CLIENT_RES: Record<TunnelProto, string> = {
  l2tp: '/interface/l2tp-client',
  sstp: '/interface/sstp-client',
  ovpn: '/interface/ovpn-client',
};
const SERVER_RES: Record<TunnelProto, string> = {
  l2tp: '/interface/l2tp-server/server',
  sstp: '/interface/sstp-server/server',
  ovpn: '/interface/ovpn-server/server',
};
export const PROTO_LABEL: Record<TunnelProto, string> = { l2tp: 'L2TP/IPsec', sstp: 'SSTP', ovpn: 'OpenVPN' };

const isManaged = (comment: string | null): boolean => !!comment && comment.startsWith(TAG);

// ---------------- views ----------------

export interface TunnelClient {
  proto: TunnelProto; id: string; name: string; connectTo: string | null; user: string | null; hasPassword: boolean;
  profile: string | null; disabled: boolean; running: boolean; status: string; uptime: string | null;
  comment: string | null; managed: boolean; isMgmtPath: boolean; dynamic: boolean;
  // l2tp/ipsec
  useIpsec: boolean; hasIpsecSecret: boolean;
  // sstp / ovpn
  certificate: string | null; verifyServerCert: boolean;
}
export interface PppSecret {
  id: string; name: string; service: string | null; profile: string | null; hasPassword: boolean;
  localAddress: string | null; remoteAddress: string | null; disabled: boolean; comment: string | null; managed: boolean;
}
export interface CertInfo {
  id: string; name: string; commonName: string | null; keyType: string | null; hasPrivateKey: boolean;
  invalidBefore: string | null; invalidAfter: string | null; fingerprint: string | null; ca: boolean; trusted: boolean; expired: boolean;
}
export interface TunnelServer { proto: TunnelProto; enabled: boolean; defaultProfile: string | null; certificate: string | null; supported: boolean }
export interface VpnMgmtInfo { mgmtIp: string; mgmtInterface: string | null; mgmtPort: number; mgmtScheme: string }
export interface VpnView {
  clients: TunnelClient[]; supported: Record<TunnelProto, boolean>;
  servers: TunnelServer[]; secrets: PppSecret[]; certs: CertInfo[]; mgmt: VpnMgmtInfo;
}

export async function mgmtInfo(ctx: VpnContext): Promise<VpnMgmtInfo> {
  const l2 = await readL2(ctx);
  return { mgmtIp: l2.path.mgmtIp, mgmtInterface: l2.path.mgmtInterface, mgmtPort: ctx.transport.port, mgmtScheme: ctx.transport.scheme };
}

function toClient(proto: TunnelProto, r: Dict, ifaceRunning: boolean, mgmt: VpnMgmtInfo): TunnelClient {
  const name = s(r['name']) ?? '?';
  const disabled = b(r['disabled']);
  const running = b(r['running']) || ifaceRunning;
  const comment = s(r['comment']);
  const status = disabled ? 'disabled' : running ? 'running' : s(r['status']) ?? 'connecting';
  return {
    proto, id: s(r['.id']) ?? name, name, connectTo: s(r['connect-to']), user: s(r['user']), hasPassword: !!s(r['password']),
    profile: s(r['profile']), disabled, running, status, uptime: s(r['uptime']),
    comment, managed: isManaged(comment), isMgmtPath: mgmt.mgmtInterface === name, dynamic: b(r['dynamic']),
    useIpsec: b(r['use-ipsec']) || s(r['use-ipsec']) === 'required', hasIpsecSecret: !!s(r['ipsec-secret']),
    certificate: s(r['certificate']), verifyServerCert: b(r['verify-server-certificate']),
  };
}

export async function readVpn(ctx: VpnContext): Promise<VpnView> {
  const mgmt = await mgmtInfo(ctx);
  const ifaces = (await g(ctx, '/interface').catch(() => [])) as Dict[];
  const runningOf = (name: string) => b(ifaces.find((i) => s(i['name']) === name)?.['running']);

  const clients: TunnelClient[] = [];
  const supported = { l2tp: true, sstp: true, ovpn: true } as Record<TunnelProto, boolean>;
  for (const proto of TUNNEL_PROTOS) {
    try {
      const rows = (await g(ctx, CLIENT_RES[proto])) as Dict[];
      if (!Array.isArray(rows)) { supported[proto] = false; continue; }
      for (const r of rows) clients.push(toClient(proto, r, runningOf(s(r['name']) ?? ''), mgmt));
    } catch { supported[proto] = false; }
  }

  const servers: TunnelServer[] = [];
  for (const proto of TUNNEL_PROTOS) {
    try {
      const raw = await g(ctx, SERVER_RES[proto]);
      const o = (Array.isArray(raw) ? raw[0] : raw) as Dict | undefined;
      servers.push({ proto, enabled: b(o?.['enabled']), defaultProfile: s(o?.['default-profile']), certificate: s(o?.['certificate']), supported: !!o });
    } catch { servers.push({ proto, enabled: false, defaultProfile: null, certificate: null, supported: false }); }
  }

  const secretRows = (await g(ctx, '/ppp/secret').catch(() => [])) as Dict[];
  const secrets: PppSecret[] = secretRows.map((r) => {
    const comment = s(r['comment']);
    return {
      id: s(r['.id']) ?? '', name: s(r['name']) ?? '?', service: s(r['service']), profile: s(r['profile']),
      hasPassword: !!s(r['password']), localAddress: s(r['local-address']), remoteAddress: s(r['remote-address']),
      disabled: b(r['disabled']), comment, managed: isManaged(comment),
    };
  });

  const certRows = (await g(ctx, '/certificate').catch(() => [])) as Dict[];
  const now = Date.now();
  const certs: CertInfo[] = certRows.map((r) => {
    const after = s(r['invalid-after']);
    const parsed = after ? Date.parse(after.replace(/(\d{4})-(\d{2})-(\d{2})\s/, '$1-$2-$3T')) : NaN;
    return {
      id: s(r['.id']) ?? '', name: s(r['name']) ?? '?', commonName: s(r['common-name']), keyType: s(r['key-type']),
      hasPrivateKey: b(r['private-key']), invalidBefore: s(r['invalid-before']), invalidAfter: after,
      fingerprint: s(r['fingerprint']), ca: b(r['ca']) || (s(r['key-usage']) ?? '').includes('key-cert-sign'),
      trusted: b(r['trusted']), expired: Number.isFinite(parsed) ? parsed < now : false,
    };
  });

  return { clients, supported, servers, secrets, certs, mgmt };
}

// ---------------- validation (pure, unit-tested) ----------------

const isName = (v: string) => /^[A-Za-z][\w.\-]{0,63}$/.test(v);
export function isValidHost(h: string): boolean {
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h)) return h.split('.').every((o) => Number(o) <= 255);
  return /^[A-Za-z0-9]([A-Za-z0-9\-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9\-]*[A-Za-z0-9])?)*$/.test(h) && h.length <= 253;
}

export interface TunnelSpec {
  proto: TunnelProto; name: string; connectTo?: string | null; user?: string | null; password?: string | null;
  profile?: string | null; ipsecSecret?: string | null; useIpsec?: boolean;
  certificate?: string | null; verifyServerCert?: boolean; disabled?: boolean; comment?: string | null;
}
export function validateTunnelInput(spec: TunnelSpec, opts: { create: boolean }): string[] {
  const e: string[] = [];
  if (!TUNNEL_PROTOS.includes(spec.proto)) e.push('Unknown tunnel protocol.');
  if (!spec.name || !isName(spec.name.trim())) e.push('A valid tunnel name is required (letter first; letters/digits/-/_/., max 64).');
  if (opts.create && (!spec.connectTo || !spec.connectTo.trim())) e.push('A server address (connect-to) is required.');
  if (spec.connectTo && spec.connectTo.trim() && !isValidHost(spec.connectTo.trim())) e.push(`"${spec.connectTo}" is not a valid host or IP.`);
  if (opts.create && (!spec.user || !spec.user.trim())) e.push('A user name is required.');
  if (opts.create && !spec.password) e.push('A password is required.');
  if (spec.proto === 'l2tp' && spec.useIpsec && opts.create && !spec.ipsecSecret) e.push('IPsec is enabled but no pre-shared key was given.');
  return e;
}

export interface PppSecretSpec {
  name: string; password?: string | null; service?: string | null; profile?: string | null;
  localAddress?: string | null; remoteAddress?: string | null; disabled?: boolean; comment?: string | null;
}
const PPP_SERVICES = new Set(['any', 'l2tp', 'sstp', 'ovpn', 'pptp', 'pppoe', 'ppp']);
export function validatePppSecretInput(spec: PppSecretSpec, opts: { create: boolean }): string[] {
  const e: string[] = [];
  if (!spec.name || !isName(spec.name.trim())) e.push('A valid account name is required.');
  if (opts.create && !spec.password) e.push('A password is required.');
  if (spec.service && !PPP_SERVICES.has(spec.service)) e.push('service must be any/l2tp/sstp/ovpn/pptp/pppoe/ppp.');
  const ip = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (spec.localAddress && !ip.test(spec.localAddress)) e.push('local-address must be an IPv4 address.');
  if (spec.remoteAddress && !ip.test(spec.remoteAddress)) e.push('remote-address must be an IPv4 address.');
  return e;
}

// ---------------- the VPN management guard ----------------

export type VpnOp = 'create' | 'edit' | 'delete' | 'disable' | 'enable';

/** Refuse a provable management cut: the mgmt IP rides this tunnel and the op
 *  would drop it (delete / disable / re-credit). Create is always additive for a
 *  client tunnel (it dials OUT, seizing no local port). Returns a reason or null. */
export function vpnMgmtGuard(op: VpnOp, existing?: TunnelClient | null): string | null {
  if (!existing?.isMgmtPath) return null;
  if (op === 'delete' || op === 'disable') {
    return `"${existing.name}" is the tunnel RubyMIK's management path currently rides — ${op === 'delete' ? 'deleting' : 'disabling'} it would sever RubyMIK's own access to this router. Refused.`;
  }
  if (op === 'edit') {
    return `"${existing.name}" carries the management path — changing its server/credentials drops and reconnects the tunnel, cutting management mid-flight. Refused.`;
  }
  return null;
}

// ---------------- pure helper: generate a .ovpn client profile ----------------

/** A ready-to-import OpenVPN client profile for connecting TO this router's
 *  ovpn-server. Carries no secret — the user supplies their own client cert/key.
 *  Pure (unit-tested), the P32 analog of WireGuard's genSiteToSite. */
export function genOvpnClientConfig(opts: { server: string; port?: number; proto?: 'tcp' | 'udp'; caCertName?: string; cipher?: string; auth?: string }): string {
  const port = opts.port ?? 1194;
  const proto = opts.proto ?? 'tcp';
  return [
    'client',
    'dev tun',
    `proto ${proto}`,
    `remote ${opts.server} ${port}`,
    'nobind',
    'persist-key',
    'persist-tun',
    'remote-cert-tls server',
    `cipher ${opts.cipher ?? 'AES-256-CBC'}`,
    `auth ${opts.auth ?? 'SHA256'}`,
    'auth-user-pass',
    `# ca / cert / key blocks: paste the CA cert exported from this router's` ,
    `#   certificate store (${opts.caCertName ?? 'your-ca'}) plus your own client cert+key.`,
    '# <ca>...</ca> <cert>...</cert> <key>...</key>',
    'verb 3',
  ].join('\n');
}

// ---------------- writes via runSafeApply (secrets redacted from audit) ----------------

type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: VpnContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });

export function taggedComment(c: string | null | undefined): string {
  const u = (c ?? '').replace(/^RUBYMIK-VPN:?\s*/i, '').trim();
  return u ? `${TAG}: ${u}` : TAG;
}
/** A copy with the tunnel/PPP secrets stripped — for anything audited/logged. */
export function redactTunnel(row: Dict): Dict {
  const c: Dict = { ...row };
  for (const k of ['password', 'ipsec-secret']) if (k in c) c[k] = '(set)';
  return c;
}
function redactSecret(row: Dict): Dict { const c: Dict = { ...row }; if ('password' in c) c.password = '(set)'; return c; }

function tunnelBody(spec: TunnelSpec, opts: { includeSecrets: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name.trim() };
  if (spec.connectTo) body['connect-to'] = spec.connectTo.trim();
  if (spec.user) body.user = spec.user.trim();
  if (opts.includeSecrets && spec.password) body.password = spec.password;
  if (spec.profile) body.profile = spec.profile;
  if (spec.disabled !== undefined) body.disabled = spec.disabled ? 'yes' : 'no';
  if (spec.proto === 'l2tp') {
    if (spec.useIpsec !== undefined) body['use-ipsec'] = spec.useIpsec ? 'yes' : 'no';
    if (opts.includeSecrets && spec.ipsecSecret) body['ipsec-secret'] = spec.ipsecSecret;
  }
  if (spec.proto === 'sstp' || spec.proto === 'ovpn') {
    if (spec.certificate !== undefined) body.certificate = spec.certificate ?? '';
    if (spec.verifyServerCert !== undefined) body['verify-server-certificate'] = spec.verifyServerCert ? 'yes' : 'no';
  }
  body.comment = taggedComment(spec.comment);
  return body;
}

const readIds = async (ctx: VpnContext, res: string): Promise<string[]> => ((await g(ctx, res)) as Dict[]).map((r) => s(r['.id']) ?? '');
const findRow = async (ctx: VpnContext, res: string, id: string): Promise<Dict | undefined> => ((await g(ctx, res)) as Dict[]).find((r) => s(r['.id']) === id);
const CLEAN = ['.id', '.nextid', 'dynamic', 'running', 'uptime', 'invalid', 'encoding'];
const stripReadOnly = (row: Dict): Record<string, unknown> => { const c: Dict = { ...row }; for (const k of CLEAN) delete c[k]; return c as Record<string, unknown>; };

export async function createTunnel(ctx: VpnContext, sac: Sac, spec: TunnelSpec): Promise<SafeApplyOutcome> {
  const res = CLIENT_RES[spec.proto];
  let beforeIds: string[] = [];
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => { beforeIds = await readIds(ctx, res); return { ids: beforeIds }; },
    summary: () => `Create ${PROTO_LABEL[spec.proto]} client "${spec.name}" → ${spec.connectTo} (password set — redacted${spec.proto === 'l2tp' && spec.ipsecSecret ? ', IPsec PSK set — redacted' : ''})`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, res, tunnelBody(spec, { includeSecrets: true })); },
    verifyTook: async () => ({ ok: (await readIds(ctx, res)).some((id) => !beforeIds.includes(id)), after: { name: spec.name } }),
    rollback: async (bb) => { for (const id of (await readIds(ctx, res)).filter((x) => !bb.ids.includes(x))) await restRemove(ctx.write, ctx.transport, res, id); },
  });
}

export async function editTunnel(ctx: VpnContext, sac: Sac, proto: TunnelProto, id: string, spec: TunnelSpec): Promise<SafeApplyOutcome> {
  const res = CLIENT_RES[proto];
  let realBefore: Dict | undefined; // holds the real secrets for rollback; NEVER audited
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => { realBefore = await findRow(ctx, res, id); return realBefore ? redactTunnel(realBefore) : undefined; },
    summary: () => `Edit ${PROTO_LABEL[proto]} client "${spec.name}"${spec.password ? ' (password changed — redacted)' : ''}${spec.ipsecSecret ? ' (IPsec PSK changed — redacted)' : ''}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, res, id, tunnelBody(spec, { includeSecrets: !!(spec.password || spec.ipsecSecret) })); },
    verifyTook: async () => ({ ok: !!(await findRow(ctx, res, id)) }),
    rollback: async () => { if (realBefore) await restSet(ctx.write, ctx.transport, res, id, stripReadOnly(realBefore)); },
  });
}

export async function setTunnelEnabled(ctx: VpnContext, sac: Sac, proto: TunnelProto, id: string, disabled: boolean): Promise<SafeApplyOutcome> {
  const res = CLIENT_RES[proto];
  return runSafeApply<{ was: boolean }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ was: b((await findRow(ctx, res, id))?.['disabled']) }),
    summary: () => `${disabled ? 'Disable' : 'Enable'} ${PROTO_LABEL[proto]} client ${id}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, res, id, { disabled: disabled ? 'yes' : 'no' }); },
    verifyTook: async () => ({ ok: b((await findRow(ctx, res, id))?.['disabled']) === disabled }),
    rollback: async (bb) => { await restSet(ctx.write, ctx.transport, res, id, { disabled: bb.was ? 'yes' : 'no' }); },
  });
}

export async function removeTunnel(ctx: VpnContext, sac: Sac, proto: TunnelProto, id: string): Promise<SafeApplyOutcome> {
  const res = CLIENT_RES[proto];
  let realBefore: Dict | undefined; // holds the real secrets for re-add on rollback; NEVER audited
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => { realBefore = await findRow(ctx, res, id); return realBefore ? redactTunnel(realBefore) : undefined; },
    summary: () => `Remove ${PROTO_LABEL[proto]} client ${id}`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, res, id); },
    verifyTook: async () => ({ ok: !(await findRow(ctx, res, id)) }),
    rollback: async () => { if (realBefore) await restAdd(ctx.write, ctx.transport, res, stripReadOnly(realBefore)); },
  });
}

export async function takeOwnershipTunnel(ctx: VpnContext, sac: Sac, proto: TunnelProto, id: string): Promise<SafeApplyOutcome> {
  const res = CLIENT_RES[proto];
  return runSafeApply<{ comment: string | null }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ comment: s((await findRow(ctx, res, id))?.['comment']) }),
    summary: () => `Take ownership of ${PROTO_LABEL[proto]} client ${id}`,
    apply: async () => { const r = await findRow(ctx, res, id); await restSet(ctx.write, ctx.transport, res, id, { comment: taggedComment(s(r?.['comment'])) }); },
    verifyTook: async () => ({ ok: isManaged(s((await findRow(ctx, res, id))?.['comment'])) }),
    rollback: async (bb) => { await restSet(ctx.write, ctx.transport, res, id, { comment: bb.comment ?? '' }); },
  });
}

// ---------------- PPP secret accounts (server-side users) ----------------

const PS = '/ppp/secret';
function secretBody(spec: PppSecretSpec, opts: { includePassword: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name.trim() };
  if (opts.includePassword && spec.password) body.password = spec.password;
  if (spec.service) body.service = spec.service;
  if (spec.profile) body.profile = spec.profile;
  if (spec.localAddress) body['local-address'] = spec.localAddress;
  if (spec.remoteAddress) body['remote-address'] = spec.remoteAddress;
  if (spec.disabled !== undefined) body.disabled = spec.disabled ? 'yes' : 'no';
  body.comment = taggedComment(spec.comment);
  return body;
}

export async function createSecret(ctx: VpnContext, sac: Sac, spec: PppSecretSpec): Promise<SafeApplyOutcome> {
  let beforeIds: string[] = [];
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => { beforeIds = await readIds(ctx, PS); return { ids: beforeIds }; },
    summary: () => `Create PPP account "${spec.name}"${spec.service ? ` (${spec.service})` : ''} (password set — redacted)`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, PS, secretBody(spec, { includePassword: true })); },
    verifyTook: async () => ({ ok: (await readIds(ctx, PS)).some((id) => !beforeIds.includes(id)), after: { name: spec.name } }),
    rollback: async (bb) => { for (const id of (await readIds(ctx, PS)).filter((x) => !bb.ids.includes(x))) await restRemove(ctx.write, ctx.transport, PS, id); },
  });
}

export async function editSecret(ctx: VpnContext, sac: Sac, id: string, spec: PppSecretSpec): Promise<SafeApplyOutcome> {
  let realBefore: Dict | undefined;
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => { realBefore = await findRow(ctx, PS, id); return realBefore ? redactSecret(realBefore) : undefined; },
    summary: () => `Edit PPP account "${spec.name}"${spec.password ? ' (password changed — redacted)' : ''}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, PS, id, secretBody(spec, { includePassword: !!spec.password })); },
    verifyTook: async () => ({ ok: !!(await findRow(ctx, PS, id)) }),
    rollback: async () => { if (realBefore) await restSet(ctx.write, ctx.transport, PS, id, stripReadOnly(realBefore)); },
  });
}

export async function setSecretEnabled(ctx: VpnContext, sac: Sac, id: string, disabled: boolean): Promise<SafeApplyOutcome> {
  return runSafeApply<{ was: boolean }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ was: b((await findRow(ctx, PS, id))?.['disabled']) }),
    summary: () => `${disabled ? 'Disable' : 'Enable'} PPP account ${id}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, PS, id, { disabled: disabled ? 'yes' : 'no' }); },
    verifyTook: async () => ({ ok: b((await findRow(ctx, PS, id))?.['disabled']) === disabled }),
    rollback: async (bb) => { await restSet(ctx.write, ctx.transport, PS, id, { disabled: bb.was ? 'yes' : 'no' }); },
  });
}

export async function removeSecret(ctx: VpnContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  let realBefore: Dict | undefined;
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => { realBefore = await findRow(ctx, PS, id); return realBefore ? redactSecret(realBefore) : undefined; },
    summary: () => `Remove PPP account ${id}`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, PS, id); },
    verifyTook: async () => ({ ok: !(await findRow(ctx, PS, id)) }),
    rollback: async () => { if (realBefore) await restAdd(ctx.write, ctx.transport, PS, stripReadOnly(realBefore)); },
  });
}

export async function takeOwnershipSecret(ctx: VpnContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  return runSafeApply<{ comment: string | null }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ comment: s((await findRow(ctx, PS, id))?.['comment']) }),
    summary: () => `Take ownership of PPP account ${id}`,
    apply: async () => { const r = await findRow(ctx, PS, id); await restSet(ctx.write, ctx.transport, PS, id, { comment: taggedComment(s(r?.['comment'])) }); },
    verifyTook: async () => ({ ok: isManaged(s((await findRow(ctx, PS, id))?.['comment'])) }),
    rollback: async (bb) => { await restSet(ctx.write, ctx.transport, PS, id, { comment: bb.comment ?? '' }); },
  });
}

// ---------------- server enable/disable (settings singleton) ----------------

export async function setServerEnabled(ctx: VpnContext, sac: Sac, proto: TunnelProto, enabled: boolean): Promise<SafeApplyOutcome> {
  const res = SERVER_RES[proto];
  const readEnabled = async (): Promise<boolean> => { const raw = await g(ctx, res); const o = (Array.isArray(raw) ? raw[0] : raw) as Dict | undefined; return b(o?.['enabled']); };
  return runSafeApply<{ was: boolean }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ was: await readEnabled() }),
    summary: () => `${enabled ? 'Enable' : 'Disable'} the ${PROTO_LABEL[proto]} server`,
    // settings singletons are not id-addressable — set via POST .../set
    apply: async () => { await restCommand(ctx.write, ctx.transport, `${res}/set`, { enabled: enabled ? 'yes' : 'no' }); },
    verifyTook: async () => ({ ok: (await readEnabled()) === enabled }),
    rollback: async (bb) => { await restCommand(ctx.write, ctx.transport, `${res}/set`, { enabled: bb.was ? 'yes' : 'no' }); },
  });
}

// ---------------- certificate generation (private key stays on the router) ----------------

export type CertKind = 'ca' | 'server' | 'client';
export interface CertSpec { name: string; commonName: string; kind: CertKind; daysValid?: number; keySize?: number; ca?: string | null }

export function validateCertInput(spec: CertSpec): string[] {
  const e: string[] = [];
  if (!spec.name || !/^[A-Za-z][\w.\-]{0,63}$/.test(spec.name.trim())) e.push('A valid certificate name is required (letter first; letters/digits/-/_/., max 64).');
  if (!spec.commonName || !spec.commonName.trim()) e.push('A common name (CN) is required.');
  if (!(['ca', 'server', 'client'] as string[]).includes(spec.kind)) e.push('Certificate kind must be ca / server / client.');
  if (spec.daysValid !== undefined && (!Number.isInteger(spec.daysValid) || spec.daysValid < 1 || spec.daysValid > 7300)) e.push('Days-valid must be 1–7300.');
  if (spec.keySize !== undefined && ![2048, 4096].includes(spec.keySize)) e.push('Key size must be 2048 or 4096.');
  return e;
}

export function keyUsageFor(kind: CertKind): string {
  return kind === 'ca' ? 'key-cert-sign,crl-sign' : kind === 'server' ? 'tls-server' : 'tls-client';
}

/** Generate a self-signed CA (or a cert signed by an on-router CA). The private key
 *  is generated ON the router and never leaves it — RubyMIK only reads back the
 *  cert (CN / fingerprint / validity). Add the template, then sign it. */
export async function generateCert(ctx: VpnContext, sac: Sac, spec: CertSpec): Promise<SafeApplyOutcome> {
  const name = spec.name.trim();
  let beforeIds: string[] = [];
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => { beforeIds = await readIds(ctx, '/certificate'); return { ids: beforeIds }; },
    summary: () => `Generate ${spec.kind} certificate "${name}" (CN ${spec.commonName}) — private key generated on the router, never leaves it`,
    apply: async () => {
      await restAdd(ctx.write, ctx.transport, '/certificate', {
        name, 'common-name': spec.commonName.trim(), 'key-size': String(spec.keySize ?? 2048),
        'days-valid': String(spec.daysValid ?? 3650), 'key-usage': keyUsageFor(spec.kind),
      });
      // sign it (self-signed CA, or signed by the chosen CA). RouterOS `sign` takes
      // the cert by name; RSA keygen may still be finishing when this returns.
      await restCommand(ctx.write, ctx.transport, '/certificate/sign', {
        number: name, ...(spec.kind !== 'ca' && spec.ca ? { ca: spec.ca } : {}),
      });
    },
    verifyTook: async () => {
      const found = ((await g(ctx, '/certificate')) as Dict[]).find((r) => s(r['name']) === name);
      return found ? { ok: true, after: { name, fingerprint: s(found['fingerprint']) } } : { ok: false, detail: 'Certificate not present after generate.' };
    },
    rollback: async (bb) => { for (const id of (await readIds(ctx, '/certificate')).filter((x) => !bb.ids.includes(x))) await restRemove(ctx.write, ctx.transport, '/certificate', id); },
  });
}

export async function removeCert(ctx: VpnContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  let before: Dict | undefined;
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => { before = ((await g(ctx, '/certificate')) as Dict[]).find((r) => s(r['.id']) === id); return before; },
    summary: () => `Remove certificate ${s(before?.['name']) ?? id}`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, '/certificate', id); },
    verifyTook: async () => ({ ok: !((await g(ctx, '/certificate')) as Dict[]).some((r) => s(r['.id']) === id) }),
    rollback: async () => { /* a removed cert's private key can't be regenerated — no rollback */ },
  });
}

// test hooks
export { redactTunnel as _redactTunnelForTest, redactSecret as _redactSecretForTest };
export type { DeviceTarget, AddressableRow };
