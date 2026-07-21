import { restGet } from './routeros/rest.js';
import { restAdd, restRemove, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { runSafeApply, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import { parseDhcpLeases, type ParsedLease } from './backup.js';
import { log } from './log.js';

/**
 * Config restore, wrapped in the full safe-apply dead-man.
 *
 * Scope + honesty: a RouterOS text export is a set of `add` commands and is
 * NOT idempotent — re-running a whole export onto a live device aborts on the
 * first duplicate (e.g. an interface that already exists), and RouterOS has no
 * ftp-free way to extract a binary backup or do a clean wipe-replace over REST.
 * So RubyMIK restores by IDEMPOTENT RECONCILE of the reservation domain it
 * models (DHCP static leases): it removes leases the device has that the
 * backup lacks, and adds leases the backup has that the device lacks, so the
 * device's reservations end up matching the backup. Restore is still gated by
 * the same dead-man: if the management path is lost after applying, it
 * auto-reverts to the pre-restore snapshot. (Full bit-for-bit device restore
 * is a roadmap item — see the README.)
 */

const DEADMAN_WINDOW_MS = 20_000;

export interface RestoreContext {
  read: DeviceTarget;
  write: DeviceTarget;
  transport: WriteTransport;
}

interface LeaseRow { '.id': string; address?: string; 'mac-address'?: string; server?: string; comment?: string; dynamic?: string }

const key = (l: { address: string; mac: string }) => `${l.address}|${l.mac.toLowerCase()}`;

async function currentStaticLeases(ctx: RestoreContext): Promise<LeaseRow[]> {
  const all = await restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, '/ip/dhcp-server/lease') as LeaseRow[];
  return all.filter((l) => l.dynamic !== 'true');
}

/** Bring the device's static leases to exactly `target`. Returns actions taken. */
async function reconcileLeases(ctx: RestoreContext, target: ParsedLease[]): Promise<{ added: number; removed: number }> {
  const current = await currentStaticLeases(ctx);
  const targetKeys = new Set(target.map(key));
  const currentKeys = new Map(current.map((l) => [key({ address: l.address ?? '', mac: l['mac-address'] ?? '' }), l]));
  let added = 0, removed = 0;
  // remove leases not in the target
  for (const [k, l] of currentKeys) {
    if (!targetKeys.has(k)) { await restRemove(ctx.write, ctx.transport, '/ip/dhcp-server/lease', l['.id']); removed++; }
  }
  // add leases the target has that the device lacks
  for (const t of target) {
    if (!currentKeys.has(key(t))) {
      await restAdd(ctx.write, ctx.transport, '/ip/dhcp-server/lease', {
        address: t.address, 'mac-address': t.mac, server: t.server, ...(t.comment ? { comment: t.comment } : {}),
      });
      added++;
    }
  }
  return { added, removed };
}

function reachableProbe(ctx: RestoreContext, windowMs: number): () => Promise<boolean> {
  return async () => {
    const deadline = Date.now() + windowMs;
    for (;;) {
      try {
        await restGet({ ...ctx.read, timeoutMs: 4000 }, ctx.transport.scheme, ctx.transport.port, '/system/resource');
        return true;
      } catch {
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
}

export async function restoreBackup(
  ctx: RestoreContext,
  sac: Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>,
  targetText: string, forceVerifyFail = false,
): Promise<SafeApplyOutcome> {
  const targetLeases = parseDhcpLeases(targetText);
  const full: SafeApplyContext = {
    ...sac, target: ctx.read, transport: ctx.transport, probe: reachableProbe(ctx, DEADMAN_WINDOW_MS),
  };
  return runSafeApply<{ snapshot: ParsedLease[] }>(full, {
    snapshot: async () => ({
      snapshot: (await currentStaticLeases(ctx)).map((l) => ({
        address: l.address ?? '', mac: l['mac-address'] ?? '', server: l.server ?? '', comment: l.comment ?? null,
      })),
    }),
    summary: () => `${sac.targetLabel ?? 'Restore backup'} — reconcile ${targetLeases.length} DHCP reservation(s)`,
    apply: async () => {
      const r = await reconcileLeases(ctx, targetLeases);
      log.warn(`[restore] "${sac.deviceName}" reconciled reservations: +${r.added} -${r.removed}`);
    },
    verifyTook: async () => {
      const now = new Set((await currentStaticLeases(ctx)).map((l) => key({ address: l.address ?? '', mac: l['mac-address'] ?? '' })));
      const want = new Set(targetLeases.map(key));
      const matches = want.size === now.size && [...want].every((k) => now.has(k));
      return matches ? { ok: true, after: { reservations: now.size } } : { ok: false, detail: 'Reservations do not match the backup after restore.' };
    },
    rollback: async (before) => {
      log.warn(`[restore] rolling back "${sac.deviceName}" — restoring pre-restore reservations`);
      await reconcileLeases(ctx, before.snapshot);
    },
    forceVerifyFail,
  });
}
