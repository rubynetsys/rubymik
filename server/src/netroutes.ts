import { restGet } from './routeros/rest.js';
import { restAdd, restRemove, restSet, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { resolveEndpoint, type AddressableRow } from './transport.js';
import { runSafeApply, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';

/**
 * Native STATIC route configuration — the highest-risk native-config rung so far:
 * a bad route can BLACK-HOLE the very path RubyMIK manages the router through.
 * So this rides runSafeApply() with the dead-man MANDATORY (verify reachability
 * after every change; auto-revert if management was lost) AND a transport-aware
 * MGMT-PATH GUARD that refuses the obvious mgmt-severing changes up front.
 *
 * Static only. Dynamic / connected / protocol routes are read-only. RubyMIK-added
 * routes carry a "RUBYMIK:" comment — idempotent, identifiable, removable.
 */

type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export interface RoutesContext {
  read: DeviceTarget;
  write: DeviceTarget;
  transport: WriteTransport;
  row: AddressableRow;   // for transport-aware mgmt-path resolution
}
const g = (ctx: RoutesContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

// ---------------- CIDR / address helpers (pure, unit-tested) ----------------

export function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = [m[1], m[2], m[3], m[4]].map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
}
export function isValidIpv4(ip: string): boolean { return ipToInt(ip) !== null; }

export interface Cidr { net: number; prefix: number }
export function parseCidr(cidr: string): Cidr | null {
  const [ip, pStr] = cidr.split('/');
  if (ip === undefined || pStr === undefined) return null;
  const prefix = Number(pStr);
  const base = ipToInt(ip);
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { net: (base & mask) >>> 0, prefix };
}
export function isValidCidr(cidr: string): boolean { return parseCidr(cidr) !== null; }

/** Do two CIDRs share any address? (Either contains the other.) */
export function cidrsOverlap(a: string, b: string): boolean {
  const ca = parseCidr(a); const cb = parseCidr(b);
  if (!ca || !cb) return false;
  const p = Math.min(ca.prefix, cb.prefix);
  const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  return ((ca.net & mask) >>> 0) === ((cb.net & mask) >>> 0);
}

/** A gateway is an IPv4 next-hop or an interface name. */
export function isValidGateway(gw: string): boolean {
  if (gw.length === 0) return false;
  if (isValidIpv4(gw)) return true;
  return /^[A-Za-z][A-Za-z0-9 _.\-]{0,63}$/.test(gw);   // interface name
}

export interface RouteInput { dst: string; gateway: string; distance: number; comment?: string | null }

export function validateRouteInput(input: { dst: string; gateway: string; distance: number }): string[] {
  const errs: string[] = [];
  if (!isValidCidr(input.dst)) errs.push(`"${input.dst}" is not a valid destination subnet (expected e.g. 10.20.0.0/24).`);
  if (!isValidGateway(input.gateway)) errs.push(`"${input.gateway}" is not a valid gateway (IPv4 next-hop or interface name).`);
  if (!Number.isInteger(input.distance) || input.distance < 0 || input.distance > 255) errs.push('Distance must be an integer 0–255.');
  return errs;
}

// ---------------- read + classify ----------------

export type RouteKind = 'connected' | 'dynamic' | 'static';
export interface RouteRow {
  id: string; dst: string | null; gateway: string | null; distance: number | null;
  active: boolean; kind: RouteKind; managed: boolean; comment: string | null;
}

function classify(r: Dict): RouteKind {
  if (r['connect'] === 'true') return 'connected';
  if (r['static'] === 'true') return 'static';
  if (r['dynamic'] === 'true') return 'dynamic';
  return 'static';
}

/** The subnet(s) whose route RubyMIK's management traffic to THIS device depends
 *  on — transport-aware: for a DIRECT device the connected LAN subnet carrying
 *  the device's management address; for a TUNNEL device the overlay subnet. Plus
 *  the default route, which is protected separately. */
export async function mgmtCriticalPrefixes(ctx: RoutesContext): Promise<{ prefixes: string[]; host: string; net: string }> {
  const { host, net } = resolveEndpoint(ctx.row);
  const prefixes: string[] = [];
  try {
    const addrs = await g(ctx, '/ip/address') as Dict[];
    // The interface whose address == the address RubyMIK reaches this device on.
    const hit = addrs.find((a) => (s(a['address']) ?? '').split('/')[0] === host);
    if (hit) {
      const cidr = s(hit['address']) ?? '';
      const parsed = parseCidr(cidr);
      if (parsed) {
        const netStr = `${(parsed.net >>> 24) & 255}.${(parsed.net >>> 16) & 255}.${(parsed.net >>> 8) & 255}.${parsed.net & 255}/${parsed.prefix}`;
        prefixes.push(netStr);
      }
    }
  } catch { /* if we can't read addresses, rely on the dead-man */ }
  return { prefixes, host, net };
}

export async function readRoutes(ctx: RoutesContext): Promise<{ routes: RouteRow[]; mgmtPrefixes: string[]; mgmtHost: string; mgmtNet: string }> {
  const raw = await g(ctx, '/ip/route') as Dict[];
  const routes: RouteRow[] = raw.map((r) => {
    const comment = s(r['comment']);
    return {
      id: s(r['.id']) ?? '',
      dst: s(r['dst-address']),
      gateway: s(r['gateway']) ?? s(r['immediate-gw']),
      distance: r['distance'] === undefined ? null : Number(r['distance']),
      active: r['active'] === 'true',
      kind: classify(r),
      managed: !!comment && comment.startsWith('RUBYMIK:'),
      comment,
    };
  });
  const mgmt = await mgmtCriticalPrefixes(ctx);
  return { routes, mgmtPrefixes: mgmt.prefixes, mgmtHost: mgmt.host, mgmtNet: mgmt.net };
}

// ---------------- MGMT-PATH GUARD (transport-aware) ----------------

/** Returns a clear error if a route to `dst` would sever the management path,
 *  else null. Protects the default route and the management subnet(s). */
export function mgmtGuardError(dst: string, mgmtPrefixes: string[], net: string): string | null {
  if (dst === '0.0.0.0/0') {
    return 'This would replace the default route (0.0.0.0/0) that the management path depends on — refused. Remove/replace the default route only from the console.';
  }
  for (const p of mgmtPrefixes) {
    if (cidrsOverlap(dst, p)) {
      return `This route (${dst}) overlaps the ${net === 'tunnel' ? 'WireGuard overlay' : 'management'} subnet ${p} that RubyMIK reaches this device on — it could black-hole the return path and lock RubyMIK out. Refused.`;
    }
  }
  return null;
}

// ---------------- writes (via runSafeApply — dead-man MANDATORY) ----------------

type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: RoutesContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });
const TAG = 'RUBYMIK:';

interface RRow { '.id': string; 'dst-address'?: string; gateway?: string; comment?: string; static?: string; connect?: string }

export async function addRoute(ctx: RoutesContext, sac: Sac, input: RouteInput): Promise<SafeApplyOutcome> {
  const comment = `${TAG}${input.comment ? ' ' + input.comment : ''}`;
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ ids: ((await g(ctx, '/ip/route')) as RRow[]).map((r) => r['.id']) }),
    summary: () => `Add static route ${input.dst} via ${input.gateway} (distance ${input.distance}, RUBYMIK-tagged)`,
    apply: async () => {
      await restAdd(ctx.write, ctx.transport, '/ip/route', {
        'dst-address': input.dst, gateway: input.gateway, distance: String(input.distance), comment,
      });
    },
    verifyTook: async () => {
      const found = ((await g(ctx, '/ip/route')) as RRow[]).find((r) => r['dst-address'] === input.dst && (r.gateway ?? '').startsWith(input.gateway.split('%')[0] ?? input.gateway));
      return found ? { ok: true, after: { dst: found['dst-address'], gateway: found.gateway } } : { ok: false, detail: 'Route not present after add.' };
    },
    rollback: async (before) => {
      const now = (await g(ctx, '/ip/route')) as RRow[];
      for (const r of now.filter((x) => !before.ids.includes(x['.id']) && x.static === 'true')) {
        await restRemove(ctx.write, ctx.transport, '/ip/route', r['.id']);
      }
    },
  });
}

export async function editRoute(ctx: RoutesContext, sac: Sac, id: string, patch: { gateway?: string; distance?: number; comment?: string | null }): Promise<SafeApplyOutcome> {
  return runSafeApply<RRow | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => ((await g(ctx, '/ip/route')) as RRow[]).find((r) => r['.id'] === id),
    summary: (b) => `Edit static route ${b?.['dst-address'] ?? id}: ${JSON.stringify(patch)}`,
    apply: async () => {
      const body: Record<string, unknown> = {};
      if (patch.gateway !== undefined) body.gateway = patch.gateway;
      if (patch.distance !== undefined) body.distance = String(patch.distance);
      if (patch.comment !== undefined) body.comment = patch.comment ?? '';
      await restSet(ctx.write, ctx.transport, '/ip/route', id, body);
    },
    verifyTook: async () => {
      const found = ((await g(ctx, '/ip/route')) as RRow[]).find((r) => r['.id'] === id);
      if (!found) return { ok: false, detail: 'Route vanished after edit.' };
      if (patch.gateway !== undefined && (found.gateway ?? '') !== patch.gateway && !(found.gateway ?? '').startsWith(patch.gateway)) return { ok: false, detail: 'Gateway did not update.' };
      return { ok: true, after: { gateway: found.gateway } };
    },
    rollback: async (before) => {
      if (before) await restSet(ctx.write, ctx.transport, '/ip/route', id, { gateway: before.gateway, comment: before.comment ?? '' });
    },
  });
}

export async function removeRoute(ctx: RoutesContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  return runSafeApply<RRow | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => ((await g(ctx, '/ip/route')) as RRow[]).find((r) => r['.id'] === id),
    summary: (b) => `Remove static route ${b?.['dst-address'] ?? id} via ${b?.gateway ?? '?'}`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, '/ip/route', id); },
    verifyTook: async () => {
      const still = ((await g(ctx, '/ip/route')) as RRow[]).some((r) => r['.id'] === id);
      return still ? { ok: false, detail: 'Route still present after delete.' } : { ok: true };
    },
    rollback: async (before) => {
      if (before) await restAdd(ctx.write, ctx.transport, '/ip/route', {
        'dst-address': before['dst-address'], gateway: before.gateway, ...(before.comment ? { comment: before.comment } : {}),
      });
    },
  });
}
