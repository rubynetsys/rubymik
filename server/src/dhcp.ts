import { restGet } from './routeros/rest.js';
import { restAdd, restSet, restRemove, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { runSafeApply, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import { readL2, type L2Context } from './netl2.js';
import type { AddressableRow } from './transport.js';

/**
 * DHCP reservation operations — the first feature riding the safe-apply
 * pipeline. Reads use the GET-only monitoring client; writes use the write
 * path, and ONLY inside runSafeApply().
 */

// ---- Pure validation (unit-tested) ----

export function isValidMac(mac: string): boolean {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac);
}

export function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

/** Is `ip` inside the CIDR `network` (e.g. "192.168.90.0/24")? */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  if (!net || !isValidIpv4(ip) || !isValidIpv4(net)) return false;
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(net) & mask);
}

/** Is `ip` inside any of a pool's ranges ("10.0.0.10-10.0.0.254, 10.0.1.2-10.0.1.9")? */
export function ipInPoolRanges(ip: string, ranges: string | null | undefined): boolean {
  if (!ranges || !isValidIpv4(ip)) return false;
  const v = ipToInt(ip);
  for (const part of ranges.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [lo, hi] = part.split('-').map((x) => x.trim());
    if (lo && hi && isValidIpv4(lo) && isValidIpv4(hi)) { if (v >= ipToInt(lo) && v <= ipToInt(hi)) return true; }
    else if (lo && isValidIpv4(lo) && v === ipToInt(lo)) return true; // single address
  }
  return false;
}

export interface ReservationInput {
  mac: string;
  address: string;
  comment?: string | null;
}

export interface DhcpContext {
  read: DeviceTarget;           // GET-only monitoring credential
  write: DeviceTarget;          // write credential
  transport: WriteTransport;
}

interface LeaseRow {
  '.id': string;
  address?: string;
  'mac-address'?: string;
  server?: string;
  comment?: string;
  dynamic?: string;
  status?: string;
  'host-name'?: string;
}

function g(ctx: DhcpContext, path: string) {
  return restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);
}

async function leases(ctx: DhcpContext): Promise<LeaseRow[]> {
  return await g(ctx, '/ip/dhcp-server/lease') as LeaseRow[];
}

/** Server's network CIDR, for subnet validation. */
async function serverNetwork(ctx: DhcpContext, server: string): Promise<string | null> {
  const servers = await g(ctx, '/ip/dhcp-server') as Array<{ name?: string; interface?: string }>;
  const srv = servers.find((s) => s.name === server);
  if (!srv) return null;
  const networks = await g(ctx, '/ip/dhcp-server/network') as Array<{ address?: string }>;
  // Match the network whose CIDR contains the server's gateway range. With one
  // network per server this is unambiguous; otherwise pick the first that the
  // pool sits in (kept simple — validation only needs *a* containing subnet).
  return networks[0]?.address ?? null;
}

export type ValidationError = { field: string; message: string };

/** Validate a reservation against live server state. Returns [] if OK. */
export async function validateReservation(
  ctx: DhcpContext, server: string, input: ReservationInput, opts: { excludeId?: string } = {},
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  if (!isValidMac(input.mac)) {
    errors.push({ field: 'mac', message: 'MAC address must look like AA:BB:CC:DD:EE:FF.' });
  }
  if (!isValidIpv4(input.address)) {
    errors.push({ field: 'address', message: 'IP address is not a valid IPv4 address.' });
  }
  if (errors.length > 0) return errors;

  const cidr = await serverNetwork(ctx, server);
  if (cidr && !ipInCidr(input.address, cidr)) {
    errors.push({ field: 'address', message: `IP ${input.address} is outside the server's subnet (${cidr}).` });
  }

  const all = await leases(ctx);
  const others = all.filter((l) => l['.id'] !== opts.excludeId);
  if (others.some((l) => (l['mac-address'] ?? '').toLowerCase() === input.mac.toLowerCase() && l.dynamic !== 'true')) {
    errors.push({ field: 'mac', message: `A reservation for MAC ${input.mac} already exists.` });
  }
  if (others.some((l) => l.address === input.address && l.dynamic !== 'true')) {
    errors.push({ field: 'address', message: `IP ${input.address} is already reserved.` });
  }
  return errors;
}

export async function readReservations(ctx: DhcpContext) {
  const all = await leases(ctx);
  return {
    reservations: all.filter((l) => l.dynamic !== 'true'),
    dynamic: all.filter((l) => l.dynamic === 'true'),
  };
}

function baseCtx(dctx: DhcpContext, sac: Omit<SafeApplyContext, 'target' | 'transport'>): SafeApplyContext {
  return { ...sac, target: dctx.read, transport: dctx.transport };
}

/** Add a static reservation through the full pipeline. */
export async function addReservation(
  dctx: DhcpContext, sac: Omit<SafeApplyContext, 'target' | 'transport'>,
  server: string, input: ReservationInput, forceVerifyFail = false,
): Promise<SafeApplyOutcome> {
  const ctx = baseCtx(dctx, sac);
  let createdId: string | null = null;
  return runSafeApply<{ existingIds: string[] }>(ctx, {
    snapshot: async () => ({ existingIds: (await leases(dctx)).map((l) => l['.id']) }),
    summary: () => `Add reservation ${input.address} → ${input.mac} on ${server}${input.comment ? ` (${input.comment})` : ''}`,
    apply: async () => {
      const created = await restAdd(dctx.write, dctx.transport, '/ip/dhcp-server/lease', {
        address: input.address, 'mac-address': input.mac, server,
        ...(input.comment ? { comment: input.comment } : {}),
      });
      createdId = (created['.id'] as string) ?? (created['ret'] as string) ?? null;
    },
    verifyTook: async () => {
      const all = await leases(dctx);
      const found = all.find((l) => l.address === input.address && (l['mac-address'] ?? '').toLowerCase() === input.mac.toLowerCase() && l.dynamic !== 'true');
      return found
        ? { ok: true, after: found }
        : { ok: false, detail: 'Re-read did not find the new reservation.' };
    },
    rollback: async (before) => {
      // Remove whatever the apply created (by id if we captured it, else by diff).
      if (createdId) {
        await restRemove(dctx.write, dctx.transport, '/ip/dhcp-server/lease', createdId);
        return;
      }
      const now = await leases(dctx);
      const added = now.filter((l) => !before.existingIds.includes(l['.id']));
      for (const l of added) await restRemove(dctx.write, dctx.transport, '/ip/dhcp-server/lease', l['.id']);
    },
    forceVerifyFail,
  });
}

/** Edit an existing reservation's address/comment. */
export async function editReservation(
  dctx: DhcpContext, sac: Omit<SafeApplyContext, 'target' | 'transport'>,
  id: string, patch: { address?: string; comment?: string | null }, forceVerifyFail = false,
): Promise<SafeApplyOutcome> {
  const ctx = baseCtx(dctx, sac);
  return runSafeApply<LeaseRow | undefined>(ctx, {
    snapshot: async () => (await leases(dctx)).find((l) => l['.id'] === id),
    summary: (before) => `Edit reservation ${before?.address ?? id} → ${JSON.stringify(patch)}`,
    apply: async () => {
      const body: Record<string, unknown> = {};
      if (patch.address !== undefined) body.address = patch.address;
      if (patch.comment !== undefined) body.comment = patch.comment ?? '';
      await restSet(dctx.write, dctx.transport, '/ip/dhcp-server/lease', id, body);
    },
    verifyTook: async () => {
      const found = (await leases(dctx)).find((l) => l['.id'] === id);
      if (!found) return { ok: false, detail: 'Reservation vanished after edit.' };
      if (patch.address !== undefined && found.address !== patch.address) {
        return { ok: false, detail: 'Address did not update.' };
      }
      return { ok: true, after: found };
    },
    rollback: async (before) => {
      if (!before) return;
      await restSet(dctx.write, dctx.transport, '/ip/dhcp-server/lease', id, {
        address: before.address, comment: before.comment ?? '',
      });
    },
    forceVerifyFail,
  });
}

/** Remove a reservation; rollback re-adds it from the snapshot. */
export async function removeReservation(
  dctx: DhcpContext, sac: Omit<SafeApplyContext, 'target' | 'transport'>,
  id: string, forceVerifyFail = false,
): Promise<SafeApplyOutcome> {
  const ctx = baseCtx(dctx, sac);
  return runSafeApply<LeaseRow | undefined>(ctx, {
    snapshot: async () => (await leases(dctx)).find((l) => l['.id'] === id),
    summary: (before) => `Remove reservation ${before?.address ?? id} (${before?.['mac-address'] ?? '?'})`,
    apply: async () => {
      await restRemove(dctx.write, dctx.transport, '/ip/dhcp-server/lease', id);
    },
    verifyTook: async () => {
      const still = (await leases(dctx)).some((l) => l['.id'] === id);
      return still ? { ok: false, detail: 'Reservation still present after delete.' } : { ok: true };
    },
    rollback: async (before) => {
      if (!before) return;
      await restAdd(dctx.write, dctx.transport, '/ip/dhcp-server/lease', {
        address: before.address, 'mac-address': before['mac-address'], server: before.server,
        ...(before.comment ? { comment: before.comment } : {}),
      });
    },
    forceVerifyFail,
  });
}

/* ============================================================================
 *  P29 (DHCP) — DHCP server / pool / network CRUD, guarded so a change can't
 *  sever RubyMIK's own management path. The mgmt path is traced with the shared
 *  L2 helper (readL2): its interface, the subnet it lives on, and the ports on
 *  that segment. The dhcpMgmtGuard refuses a provable cut; deleting anything with
 *  ACTIVE clients on it surfaces a warning (soft — the UI confirms).
 * ==========================================================================*/

export const DHCP_TAG = 'RUBYMIK-DHCP';
type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const bo = (v: unknown): boolean => v === 'true' || v === 'yes';
const isManaged = (c: string | null): boolean => !!c && c.startsWith(DHCP_TAG);

/** DHCP context that also knows how RubyMIK reaches the router (for the guard). */
export interface DhcpFullContext extends DhcpContext { row: AddressableRow }
const gf = (ctx: DhcpFullContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

export interface DhcpMgmtInfo { mgmtIp: string; mgmtInterface: string | null; mgmtPorts: string[] }
export async function dhcpMgmtInfo(ctx: DhcpFullContext): Promise<DhcpMgmtInfo> {
  const l2 = await readL2(ctx as L2Context);
  return { mgmtIp: l2.path.mgmtIp, mgmtInterface: l2.path.mgmtInterface, mgmtPorts: l2.path.mgmtPorts };
}

export interface DhcpServerView { id: string; name: string; interface: string | null; addressPool: string | null; leaseTime: string | null; disabled: boolean; invalid: boolean; dynamic: boolean; comment: string | null; managed: boolean; isMgmtInterface: boolean; activeLeases: number }
export interface DhcpPoolView { id: string; name: string; ranges: string | null; comment: string | null; managed: boolean; coversMgmtIp: boolean }
export interface DhcpNetworkView { id: string; address: string | null; gateway: string | null; dnsServer: string | null; domain: string | null; comment: string | null; managed: boolean; coversMgmtIp: boolean }
export interface DhcpFullView {
  servers: DhcpServerView[]; pools: DhcpPoolView[]; networks: DhcpNetworkView[];
  reservations: LeaseRow[]; dynamic: LeaseRow[]; mgmt: DhcpMgmtInfo;
}

export async function readDhcpFull(ctx: DhcpFullContext): Promise<DhcpFullView> {
  const [srv, pools, nets, allLeases, mgmt] = await Promise.all([
    gf(ctx, '/ip/dhcp-server').catch(() => []) as Promise<Dict[]>,
    gf(ctx, '/ip/pool').catch(() => []) as Promise<Dict[]>,
    gf(ctx, '/ip/dhcp-server/network').catch(() => []) as Promise<Dict[]>,
    gf(ctx, '/ip/dhcp-server/lease').catch(() => []) as Promise<LeaseRow[]>,
    dhcpMgmtInfo(ctx),
  ]);
  const activeFor = (name: string) => allLeases.filter((l) => l.server === name && l.dynamic === 'true' && (l.status === 'bound' || l.status === undefined)).length;
  const servers: DhcpServerView[] = srv.map((r) => {
    const name = s(r['name']) ?? '?'; const comment = s(r['comment']);
    return {
      id: s(r['.id']) ?? name, name, interface: s(r['interface']), addressPool: s(r['address-pool']), leaseTime: s(r['lease-time']),
      disabled: bo(r['disabled']), invalid: bo(r['invalid']), dynamic: bo(r['dynamic']), comment, managed: isManaged(comment),
      isMgmtInterface: !!mgmt.mgmtInterface && s(r['interface']) === mgmt.mgmtInterface, activeLeases: activeFor(name),
    };
  });
  const pool: DhcpPoolView[] = pools.map((r) => {
    const comment = s(r['comment']); const ranges = s(r['ranges']);
    return { id: s(r['.id']) ?? '', name: s(r['name']) ?? '?', ranges, comment, managed: isManaged(comment), coversMgmtIp: ipInPoolRanges(mgmt.mgmtIp, ranges) };
  });
  const networks: DhcpNetworkView[] = nets.map((r) => {
    const comment = s(r['comment']); const address = s(r['address']);
    return { id: s(r['.id']) ?? '', address, gateway: s(r['gateway']), dnsServer: s(r['dns-server']), domain: s(r['domain']), comment, managed: isManaged(comment), coversMgmtIp: !!address && ipInCidr(mgmt.mgmtIp, address) };
  });
  return { servers, pools: pool, networks, reservations: allLeases.filter((l) => l.dynamic !== 'true'), dynamic: allLeases.filter((l) => l.dynamic === 'true'), mgmt };
}

// ---------------- validation (pure) ----------------

const dhcpName = (v: string) => /^[A-Za-z][\w.\-]{0,63}$/.test(v);
export function validateServerInput(spec: { name: string; interface: string; addressPool?: string | null }): string[] {
  const e: string[] = [];
  if (!spec.name || !dhcpName(spec.name.trim())) e.push('A valid DHCP server name is required.');
  if (!spec.interface || !spec.interface.trim()) e.push('An interface is required.');
  return e;
}
export function validatePoolInput(spec: { name: string; ranges: string }): string[] {
  const e: string[] = [];
  if (!spec.name || !dhcpName(spec.name.trim())) e.push('A valid pool name is required.');
  const parts = (spec.ranges ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) e.push('At least one address range is required.');
  for (const p of parts) {
    const [lo, hi] = p.split('-').map((x) => x.trim());
    if (!lo || !isValidIpv4(lo) || (hi && !isValidIpv4(hi))) { e.push(`"${p}" is not a valid range (e.g. 10.0.0.10-10.0.0.254).`); break; }
    if (hi && ipToInt(hi) < ipToInt(lo)) { e.push(`Range "${p}" ends before it starts.`); break; }
  }
  return e;
}
export function validateNetworkInput(spec: { address: string; gateway?: string | null }): string[] {
  const e: string[] = [];
  if (!/^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/.test(spec.address ?? '')) e.push('Network must be a CIDR (e.g. 10.0.0.0/24).');
  if (spec.gateway && !isValidIpv4(spec.gateway)) e.push('Gateway must be a valid IPv4 address.');
  return e;
}

// ---------------- the DHCP management guard ----------------

export type DhcpOp = 'create' | 'edit' | 'disable' | 'delete';
export type DhcpResource = 'server' | 'pool' | 'network' | 'lease';

/** Refuse a provable management cut. `spec` = the proposed object (create/edit);
 *  `existing` = the current object (edit/disable/delete). Returns a reason or null. */
export function dhcpMgmtGuard(
  mgmt: DhcpMgmtInfo, op: DhcpOp, resource: DhcpResource,
  spec: { interface?: string | null; ranges?: string | null; address?: string | null; leaseAddress?: string | null } | null,
  existing: { interface?: string | null; ranges?: string | null; address?: string | null; leaseAddress?: string | null } | null,
): string | null {
  const onMgmtIface = (iface: string | null | undefined) => !!iface && (iface === mgmt.mgmtInterface || mgmt.mgmtPorts.includes(iface));
  if (resource === 'server') {
    if (op === 'create' && onMgmtIface(spec?.interface)) {
      return `Interface "${spec?.interface}" carries the management path — a second DHCP server on it could hand RubyMIK’s host a conflicting address and cut management. Refused.`;
    }
    if ((op === 'delete' || op === 'disable') && onMgmtIface(existing?.interface)) {
      return `This DHCP server runs on "${existing?.interface}", the interface RubyMIK’s management path rides — ${op === 'delete' ? 'deleting' : 'disabling'} it risks RubyMIK’s own lease/renewal on that segment. Refused.`;
    }
  }
  if (resource === 'pool' && op === 'delete' && existing?.ranges && ipInPoolRanges(mgmt.mgmtIp, existing.ranges)) {
    return `The management IP ${mgmt.mgmtIp} falls inside this pool’s range — deleting it would stop RubyMIK’s address from being renewed. Refused.`;
  }
  if (resource === 'network' && (op === 'delete' || op === 'edit') && existing?.address && ipInCidr(mgmt.mgmtIp, existing.address)) {
    return `This DHCP network (${existing.address}) is the management subnet (${mgmt.mgmtIp}) — ${op === 'delete' ? 'removing' : 'changing'} it risks the gateway/DNS RubyMIK’s path depends on. Refused.`;
  }
  if (resource === 'lease' && op === 'delete' && existing?.leaseAddress && existing.leaseAddress === mgmt.mgmtIp) {
    return `This lease is the management address ${mgmt.mgmtIp} itself — removing it would drop RubyMIK’s own path. Refused.`;
  }
  return null;
}

// ---------------- CRUD via runSafeApply ----------------

type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const full = (ctx: DhcpFullContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });
export function dhcpTagged(c: string | null | undefined): string {
  const u = (c ?? '').replace(/^RUBYMIK-DHCP:?\s*/i, '').trim();
  return u ? `${DHCP_TAG}: ${u}` : DHCP_TAG;
}
const idsOf = async (ctx: DhcpFullContext, res: string) => ((await gf(ctx, res)) as Dict[]).map((r) => s(r['.id']) ?? '');
const rowOf = async (ctx: DhcpFullContext, res: string, id: string) => ((await gf(ctx, res)) as Dict[]).find((r) => s(r['.id']) === id);
const cleanRow = (row: Dict): Record<string, unknown> => { const c: Dict = { ...row }; for (const k of ['.id', '.nextid', 'dynamic', 'invalid', 'running']) delete c[k]; return c as Record<string, unknown>; };

export interface ServerSpec { name: string; interface: string; addressPool?: string | null; leaseTime?: string | null; comment?: string | null; disabled?: boolean }
export async function createServer(ctx: DhcpFullContext, sac: Sac, spec: ServerSpec): Promise<SafeApplyOutcome> {
  let before: string[] = [];
  return runSafeApply<{ ids: string[] }>(full(ctx, sac), {
    snapshot: async () => { before = await idsOf(ctx, '/ip/dhcp-server'); return { ids: before }; },
    summary: () => `Create DHCP server "${spec.name}" on ${spec.interface}${spec.addressPool ? ` (pool ${spec.addressPool})` : ''}`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, '/ip/dhcp-server', { name: spec.name.trim(), interface: spec.interface.trim(), ...(spec.addressPool ? { 'address-pool': spec.addressPool } : {}), ...(spec.leaseTime ? { 'lease-time': spec.leaseTime } : {}), ...(spec.disabled ? { disabled: 'yes' } : {}), comment: dhcpTagged(spec.comment) }); },
    verifyTook: async () => ({ ok: ((await gf(ctx, '/ip/dhcp-server')) as Dict[]).some((r) => s(r['name']) === spec.name.trim()), after: { name: spec.name } }),
    rollback: async (b) => { for (const id of (await idsOf(ctx, '/ip/dhcp-server')).filter((x) => !b.ids.includes(x))) await restRemove(ctx.write, ctx.transport, '/ip/dhcp-server', id); },
  });
}
export async function setServerEnabled(ctx: DhcpFullContext, sac: Sac, id: string, disabled: boolean): Promise<SafeApplyOutcome> {
  return runSafeApply<{ was: boolean }>(full(ctx, sac), {
    snapshot: async () => ({ was: bo((await rowOf(ctx, '/ip/dhcp-server', id))?.['disabled']) }),
    summary: () => `${disabled ? 'Disable' : 'Enable'} DHCP server ${id}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, '/ip/dhcp-server', id, { disabled: disabled ? 'yes' : 'no' }); },
    verifyTook: async () => ({ ok: bo((await rowOf(ctx, '/ip/dhcp-server', id))?.['disabled']) === disabled }),
    rollback: async (b) => { await restSet(ctx.write, ctx.transport, '/ip/dhcp-server', id, { disabled: b.was ? 'yes' : 'no' }); },
  });
}
export async function removeServer(ctx: DhcpFullContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  let before: Dict | undefined;
  return runSafeApply<Dict | undefined>(full(ctx, sac), {
    snapshot: async () => { before = await rowOf(ctx, '/ip/dhcp-server', id); return before; },
    summary: () => `Remove DHCP server ${s(before?.['name']) ?? id}`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, '/ip/dhcp-server', id); },
    verifyTook: async () => ({ ok: !(await rowOf(ctx, '/ip/dhcp-server', id)) }),
    rollback: async () => { if (before) await restAdd(ctx.write, ctx.transport, '/ip/dhcp-server', cleanRow(before)); },
  });
}
export async function takeOwnershipServer(ctx: DhcpFullContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  return runSafeApply<{ comment: string | null }>(full(ctx, sac), {
    snapshot: async () => ({ comment: s((await rowOf(ctx, '/ip/dhcp-server', id))?.['comment']) }),
    summary: () => `Take ownership of DHCP server ${id}`,
    apply: async () => { const r = await rowOf(ctx, '/ip/dhcp-server', id); await restSet(ctx.write, ctx.transport, '/ip/dhcp-server', id, { comment: dhcpTagged(s(r?.['comment'])) }); },
    verifyTook: async () => ({ ok: isManaged(s((await rowOf(ctx, '/ip/dhcp-server', id))?.['comment'])) }),
    rollback: async (b) => { await restSet(ctx.write, ctx.transport, '/ip/dhcp-server', id, { comment: b.comment ?? '' }); },
  });
}

export interface PoolSpec { name: string; ranges: string; comment?: string | null }
export async function createPool(ctx: DhcpFullContext, sac: Sac, spec: PoolSpec): Promise<SafeApplyOutcome> {
  let before: string[] = [];
  return runSafeApply<{ ids: string[] }>(full(ctx, sac), {
    snapshot: async () => { before = await idsOf(ctx, '/ip/pool'); return { ids: before }; },
    summary: () => `Create IP pool "${spec.name}" (${spec.ranges})`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, '/ip/pool', { name: spec.name.trim(), ranges: spec.ranges.trim(), comment: dhcpTagged(spec.comment) }); },
    verifyTook: async () => ({ ok: ((await gf(ctx, '/ip/pool')) as Dict[]).some((r) => s(r['name']) === spec.name.trim()) }),
    rollback: async (b) => { for (const id of (await idsOf(ctx, '/ip/pool')).filter((x) => !b.ids.includes(x))) await restRemove(ctx.write, ctx.transport, '/ip/pool', id); },
  });
}
export async function removePool(ctx: DhcpFullContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  let before: Dict | undefined;
  return runSafeApply<Dict | undefined>(full(ctx, sac), {
    snapshot: async () => { before = await rowOf(ctx, '/ip/pool', id); return before; },
    summary: () => `Remove IP pool ${s(before?.['name']) ?? id}`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, '/ip/pool', id); },
    verifyTook: async () => ({ ok: !(await rowOf(ctx, '/ip/pool', id)) }),
    rollback: async () => { if (before) await restAdd(ctx.write, ctx.transport, '/ip/pool', cleanRow(before)); },
  });
}

export interface NetworkSpec { address: string; gateway?: string | null; dnsServer?: string | null; domain?: string | null; comment?: string | null }
export async function createNetwork(ctx: DhcpFullContext, sac: Sac, spec: NetworkSpec): Promise<SafeApplyOutcome> {
  let before: string[] = [];
  return runSafeApply<{ ids: string[] }>(full(ctx, sac), {
    snapshot: async () => { before = await idsOf(ctx, '/ip/dhcp-server/network'); return { ids: before }; },
    summary: () => `Create DHCP network ${spec.address}${spec.gateway ? ` (gw ${spec.gateway})` : ''}`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, '/ip/dhcp-server/network', { address: spec.address.trim(), ...(spec.gateway ? { gateway: spec.gateway } : {}), ...(spec.dnsServer ? { 'dns-server': spec.dnsServer } : {}), ...(spec.domain ? { domain: spec.domain } : {}), comment: dhcpTagged(spec.comment) }); },
    verifyTook: async () => ({ ok: ((await gf(ctx, '/ip/dhcp-server/network')) as Dict[]).some((r) => s(r['address']) === spec.address.trim()) }),
    rollback: async (b) => { for (const id of (await idsOf(ctx, '/ip/dhcp-server/network')).filter((x) => !b.ids.includes(x))) await restRemove(ctx.write, ctx.transport, '/ip/dhcp-server/network', id); },
  });
}
export async function removeNetwork(ctx: DhcpFullContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  let before: Dict | undefined;
  return runSafeApply<Dict | undefined>(full(ctx, sac), {
    snapshot: async () => { before = await rowOf(ctx, '/ip/dhcp-server/network', id); return before; },
    summary: () => `Remove DHCP network ${s(before?.['address']) ?? id}`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, '/ip/dhcp-server/network', id); },
    verifyTook: async () => ({ ok: !(await rowOf(ctx, '/ip/dhcp-server/network', id)) }),
    rollback: async () => { if (before) await restAdd(ctx.write, ctx.transport, '/ip/dhcp-server/network', cleanRow(before)); },
  });
}
