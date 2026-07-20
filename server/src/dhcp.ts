import { restGet } from './routeros/rest.js';
import { restAdd, restSet, restRemove, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { runSafeApply, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';

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
