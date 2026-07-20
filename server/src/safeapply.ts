import type { DatabaseSync } from 'node:sqlite';
import { restGet } from './routeros/rest.js';
import type { DeviceTarget } from './routeros/types.js';
import type { WriteTransport } from './routeros/write.js';
import { log } from './log.js';

/**
 * The safe-apply pipeline — every config write goes through this, no
 * exceptions. Ported from the RubyBPO dead-man discipline:
 *
 *   snapshot → apply → verify → (auto-rollback on failure) → audit
 *
 * verify() checks BOTH that management survived (device still answers) AND
 * that the change actually took. If either fails, rollback() runs against the
 * (still-reachable) device to restore the snapshot, and the audit row records
 * `rolled_back`. If rollback itself fails, the row records `rollback_failed`
 * — the loudest possible signal.
 *
 * DHCP can't realistically trigger rollback, but the machinery is built now
 * because firewall/VLAN writes will need it — and acceptance D forces a
 * verify failure to prove the net catches a deliberately-broken apply.
 */

export type ApplyResult = 'applied' | 'rolled_back' | 'rollback_failed' | 'failed';

export interface SafeApplyContext {
  db: DatabaseSync;
  target: DeviceTarget;
  transport: WriteTransport;
  actor: string;
  deviceId: number;
  deviceName: string;
  action: string;
  targetLabel: string | null;
  /** Override the reachability probe (tests inject a stub; prod uses GET). */
  probe?: () => Promise<boolean>;
}

export interface SafeApplySteps<B> {
  /** Read current relevant state (GET) so we can revert. */
  snapshot: () => Promise<B>;
  summary: (before: B) => string;
  /** Perform the write(s) via the write path. Returns anything verify needs. */
  apply: () => Promise<void>;
  /** Re-read and confirm the change took. Throw to signal "did not take". */
  verifyTook: () => Promise<{ ok: boolean; detail?: string; after?: unknown }>;
  /** Undo the change, restoring the snapshot. */
  rollback: (before: B) => Promise<void>;
  /** TEST ONLY: force verify to fail, to prove the rollback machinery. */
  forceVerifyFail?: boolean;
}

export interface SafeApplyOutcome {
  result: ApplyResult;
  auditId: number;
  detail: string;
  before: unknown;
  after: unknown;
}

/** Is the device still reachable / management not lost? (GET, read-only.) */
async function reachable(ctx: SafeApplyContext): Promise<boolean> {
  try {
    await restGet({ ...ctx.target, timeoutMs: 6000 }, ctx.transport.scheme, ctx.transport.port, '/system/resource');
    return true;
  } catch {
    return false;
  }
}

function audit(
  ctx: SafeApplyContext, result: ApplyResult, summary: string,
  before: unknown, after: unknown, detail: string,
): number {
  const row = ctx.db.prepare(`
    INSERT INTO config_audit (device_id, device_name, actor, action, target, summary, before_json, after_json, result, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ctx.deviceId, ctx.deviceName, ctx.actor, ctx.action, ctx.targetLabel, summary,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    result, detail, new Date().toISOString(),
  );
  return row.lastInsertRowid as number;
}

export async function runSafeApply<B>(ctx: SafeApplyContext, steps: SafeApplySteps<B>): Promise<SafeApplyOutcome> {
  const before = await steps.snapshot();
  const summary = steps.summary(before);

  // 1. Apply
  try {
    log.info(`[safe-apply] ${ctx.action} on "${ctx.deviceName}" by ${ctx.actor}: applying — ${summary}`);
    await steps.apply();
  } catch (err) {
    const detail = `Apply failed before any change could be verified: ${(err as Error).message}`;
    const id = audit(ctx, 'failed', summary, before, null, detail);
    log.warn(`[safe-apply] ${ctx.action} FAILED on "${ctx.deviceName}": ${detail}`);
    return { result: 'failed', auditId: id, detail, before, after: null };
  }

  // 2. Verify — reachability first (did we lose management?), then change-took.
  let verifyDetail = '';
  let after: unknown = null;
  let ok = true;
  if (!(await (ctx.probe ? ctx.probe() : reachable(ctx)))) {
    ok = false;
    verifyDetail = 'Device became unreachable after the change — management may be lost.';
  } else if (steps.forceVerifyFail) {
    ok = false;
    verifyDetail = 'FORCED TEST FAILURE: simulating a post-apply verification failure to exercise auto-rollback.';
  } else {
    try {
      const v = await steps.verifyTook();
      after = v.after ?? null;
      ok = v.ok;
      if (!ok) verifyDetail = v.detail ?? 'The change did not take effect on the device.';
    } catch (err) {
      ok = false;
      verifyDetail = `Verification error: ${(err as Error).message}`;
    }
  }

  if (ok) {
    const id = audit(ctx, 'applied', summary, before, after, 'Applied and verified.');
    log.info(`[safe-apply] ${ctx.action} APPLIED + verified on "${ctx.deviceName}"`);
    return { result: 'applied', auditId: id, detail: 'Applied and verified.', before, after };
  }

  // 3. Auto-rollback
  log.warn(`[safe-apply] ${ctx.action} verify FAILED on "${ctx.deviceName}": ${verifyDetail} — rolling back`);
  try {
    await steps.rollback(before);
  } catch (err) {
    const detail = `${verifyDetail} Rollback ALSO failed: ${(err as Error).message}`;
    const id = audit(ctx, 'rollback_failed', summary, before, after, detail);
    log.error(`[safe-apply] ${ctx.action} ROLLBACK FAILED on "${ctx.deviceName}": ${detail}`);
    return { result: 'rollback_failed', auditId: id, detail, before, after };
  }
  const detail = `${verifyDetail} Auto-rolled back to the pre-change snapshot.`;
  const id = audit(ctx, 'rolled_back', summary, before, after, detail);
  log.info(`[safe-apply] ${ctx.action} ROLLED BACK on "${ctx.deviceName}"`);
  return { result: 'rolled_back', auditId: id, detail, before, after };
}

/** Record an input-validation rejection (never reached the device). */
export function auditRejected(ctx: Omit<SafeApplyContext, 'target' | 'transport'>, summary: string, detail: string): number {
  const row = ctx.db.prepare(`
    INSERT INTO config_audit (device_id, device_name, actor, action, target, summary, before_json, after_json, result, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'rejected', ?, ?)
  `).run(ctx.deviceId, ctx.deviceName, ctx.actor, ctx.action, ctx.targetLabel, summary, detail, new Date().toISOString());
  return row.lastInsertRowid as number;
}
