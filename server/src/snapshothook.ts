import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import type { Response } from 'express';
import type { SecretBox } from './secretbox.js';
import { setPreWriteGuard } from './routeros/write.js';
import { captureForDevice, recordSnapshotFailure, type SnapshotTrigger } from './snapshots.js';
import { log } from './log.js';

/**
 * The pre/post snapshot bracket for the write chokepoint (P21).
 *
 * Every config-mutating operation runs inside `withWriteOp`, which:
 *   1. captures a PRE snapshot BEFORE any write — FAIL-CLOSED: if the pre-capture
 *      fails, the operation is refused (SnapshotRequiredError → 409) and no write
 *      is attempted. No snapshot, no write. No override.
 *   2. runs the operation;
 *   3. captures a POST snapshot in a finally (success OR failure/rollback), tagged
 *      with the outcome — BEST-EFFORT: a post-capture failure never undoes or fails
 *      the already-completed write; it is logged as a snapshot_failure (warning
 *      badge), nothing more.
 *
 * write.ts additionally consults `preWriteGuard` on every PUT/PATCH/DELETE and
 * refuses if it is somehow reached outside a bracket with a completed pre-snapshot
 * — a structural backstop so no config write can ever bypass the pre-snapshot.
 * (POST is exempt: it carries the read-only `/export` capture itself and restore.)
 */

export class SnapshotRequiredError extends Error {
  readonly snapshotRequired = true;
  readonly httpStatus = 409;
  constructor(message: string) { super(message); this.name = 'SnapshotRequiredError'; }
}

interface OpStore { deviceId: number; operation: string; opGroup: string; preDone: boolean }

const store = new AsyncLocalStorage<OpStore>();
let installed: { db: DatabaseSync; box: SecretBox } | null = null;
let opCounter = 0;

export function installCaptureHook(db: DatabaseSync, box: SecretBox): void {
  installed = { db, box };
  setPreWriteGuard((method) => preWriteGuard(method));
  log.info('Snapshot capture hook installed — writes are bracketed by pre/post config snapshots.');
}
/** TEST-ONLY: reset installed state between hermetic runs. */
export function _uninstallCaptureHook(): void { installed = null; }

function deriveOutcome(result: unknown): string | null {
  if (result && typeof result === 'object' && 'result' in result) return String((result as { result: unknown }).result);
  return 'applied';
}

/**
 * Bracket a write operation for `deviceId` with pre (fail-closed) + post (best-
 * effort) snapshots. Re-entrant: a nested op on the same device reuses the outer
 * bracket (one pre/post per logical operation, not per REST verb).
 */
export async function withWriteOp<T>(deviceId: number, operation: string, run: () => Promise<T>): Promise<T> {
  if (!installed) return run(); // no hook (hermetic unit tests) → run unbracketed
  const existing = store.getStore();
  if (existing && existing.deviceId === deviceId) return run(); // nested → outer owns pre/post

  const opGroup = `op-${deviceId}-${Date.now()}-${++opCounter}`;
  // 1. PRE — fail-closed.
  try {
    await captureForDevice(installed.db, installed.box, deviceId, { trigger: 'pre_write', operation, opGroup });
  } catch (err) {
    throw new SnapshotRequiredError(`Pre-write config snapshot failed — write refused (no snapshot, no write): ${(err as Error).message}`);
  }

  const ctx: OpStore = { deviceId, operation, opGroup, preDone: true };
  let outcome: string | null = 'failed';
  try {
    const result = await store.run(ctx, run);
    outcome = deriveOutcome(result);
    return result;
  } finally {
    // 2. POST — best-effort; a failure here does NOT fail the completed write.
    try {
      await captureForDevice(installed!.db, installed!.box, deviceId, { trigger: 'post_write', operation, opGroup, outcome });
    } catch (err) {
      recordSnapshotFailure(installed!.db, deviceId, 'post_write', operation, (err as Error).message);
      log.warn(`[snapshot] post-write capture failed for device ${deviceId} (${operation}); the write already completed: ${(err as Error).message}`);
    }
  }
}

/** Structural backstop for write.ts: refuse a config-mutating verb reached without
 *  a completed pre-snapshot. No-op until the hook is installed. */
export function preWriteGuard(method: string): void {
  if (!installed) return;
  if (method === 'POST') return; // read-only /export capture + restore ride POST
  const ctx = store.getStore();
  if (!ctx || !ctx.preDone) {
    throw new SnapshotRequiredError('A configuration write was attempted without a pre-write snapshot — refused (no snapshot, no write).');
  }
}

/** Manual/scheduled capture path (best-effort logging on failure). */
export async function captureManualOrScheduled(
  db: DatabaseSync, box: SecretBox, deviceId: number, trigger: Extract<SnapshotTrigger, 'manual' | 'scheduled'>,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  try {
    const m = await captureForDevice(db, box, deviceId, { trigger });
    return { ok: true, id: m.id };
  } catch (err) {
    recordSnapshotFailure(db, deviceId, trigger, null, (err as Error).message);
    log.warn(`[snapshot] ${trigger} capture failed for device ${deviceId}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

/** Uniform write-route error responder: 409 {snapshotRequired} for a refused
 *  fail-closed write, otherwise the pre-existing 502 behaviour, unchanged. */
export function writeErr(res: Response, err: unknown): void {
  const e = err as { snapshotRequired?: boolean; message?: string };
  if (e && e.snapshotRequired) { res.status(409).json({ error: e.message, snapshotRequired: true }); return; }
  res.status(502).json({ error: (err as Error).message });
}
