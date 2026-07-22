import type { DatabaseSync } from 'node:sqlite';
import { writeAudit } from './safeapply.js';

/**
 * P29 — expected-outage reboot dead-man.
 *
 * A reboot is DELIBERATE unreachability: no down-alert, no false "down". The
 * reboot endpoint calls beginReboot() (sets a deadline + a baseline of the
 * pre-reboot serial/uptime and flips state to 'rebooting'); the poller then:
 *   - on a FAILED poll while within the window → handleRebootFailure() keeps it
 *     'rebooting' (absorbed, no alert). Past the deadline → clears the flag,
 *     audits "not-returned", and lets the caller mark it normally 'down' (which
 *     is where the ordinary device_down alert finally fires).
 *   - on a SUCCESSFUL poll → handleRebootReturn() verifies the serial matches and
 *     the uptime reset (proving it actually rebooted), audits the outcome, clears.
 *
 * There is NO rollback for a reboot — the pre-snapshot is a record, not a revert.
 */

export interface RebootBaseline { serial: string | null; uptimeSec: number | null; at: string }

/** RouterOS uptime string ("1w2d3h4m5s") → seconds. Null if unparseable. */
export function parseUptimeSec(u: string | null | undefined): number | null {
  if (!u) return null;
  const units: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  let matched = false;
  for (const mm of u.matchAll(/(\d+)([wdhms])/g)) { total += Number(mm[1]) * units[mm[2]!]!; matched = true; }
  return matched ? total : null;
}

function deviceName(db: DatabaseSync, deviceId: number): string {
  const r = db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId) as { name: string } | undefined;
  return r?.name ?? `device ${deviceId}`;
}

function pending(db: DatabaseSync, deviceId: number): { until: string; baseline: RebootBaseline } | null {
  const r = db.prepare('SELECT reboot_expected_until AS until, reboot_baseline AS baseline FROM device_status WHERE device_id = ?')
    .get(deviceId) as { until: string | null; baseline: string | null } | undefined;
  if (!r?.until) return null;
  let baseline: RebootBaseline = { serial: null, uptimeSec: null, at: '' };
  try { if (r.baseline) baseline = JSON.parse(r.baseline) as RebootBaseline; } catch { /* keep default */ }
  return { until: r.until, baseline };
}

/** Arm the dead-man: mark the device 'rebooting' until `until`, remembering the baseline. */
export function beginReboot(db: DatabaseSync, deviceId: number, baseline: RebootBaseline, until: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO device_status (device_id, state, consecutive_failures, last_attempt_at, last_error, reboot_expected_until, reboot_baseline, updated_at)
    VALUES (?, 'rebooting', 0, ?, 'Rebooting…', ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      state = 'rebooting', last_attempt_at = excluded.last_attempt_at, last_error = 'Rebooting…',
      reboot_expected_until = excluded.reboot_expected_until, reboot_baseline = excluded.reboot_baseline,
      updated_at = excluded.updated_at
  `).run(deviceId, now, until, JSON.stringify(baseline), now);
}

/** Undo an armed reboot (e.g. the reboot command was refused before it ran). */
export function abortReboot(db: DatabaseSync, deviceId: number): void {
  db.prepare("UPDATE device_status SET reboot_expected_until = NULL, reboot_baseline = NULL, state = 'up', last_error = NULL WHERE device_id = ?")
    .run(deviceId);
}

/**
 * On a FAILED poll. Returns true if the failure was absorbed as an expected reboot
 * outage (caller must NOT mark the device down). Returns false to let the caller
 * proceed to a normal 'down' (either no reboot pending, or the window expired).
 */
export function handleRebootFailure(db: DatabaseSync, deviceId: number, nowMs: number): boolean {
  const p = pending(db, deviceId);
  if (!p) return false;
  if (nowMs < Date.parse(p.until)) {
    const iso = new Date(nowMs).toISOString();
    db.prepare("UPDATE device_status SET state = 'rebooting', last_attempt_at = ?, last_error = 'Rebooting…', updated_at = ? WHERE device_id = ?")
      .run(iso, iso, deviceId);
    return true; // absorbed — no alert
  }
  // Deadline passed and still unreachable → not-returned.
  db.prepare('UPDATE device_status SET reboot_expected_until = NULL, reboot_baseline = NULL WHERE device_id = ?').run(deviceId);
  writeAudit(
    { db, actor: 'system', deviceId, deviceName: deviceName(db, deviceId), action: 'system.reboot', targetLabel: 'reboot' },
    'rejected', 'Reboot return verification', p.baseline, null,
    `Device did not come back within the reboot window (deadline ${p.until}). Marking it down — the down-alert will now fire.`,
  );
  return false; // caller marks it normally 'down'
}

/**
 * On a SUCCESSFUL poll (call AFTER the normal up-state write). If a reboot was
 * pending, verify serial match + uptime reset, audit the outcome, and clear the flag.
 */
export function handleRebootReturn(db: DatabaseSync, deviceId: number, serial: string | null, uptime: string | null): void {
  const p = pending(db, deviceId);
  if (!p) return;
  const upNew = parseUptimeSec(uptime);
  const serialOk = !p.baseline.serial || !serial || serial === p.baseline.serial;
  const canCheckUptime = p.baseline.uptimeSec != null && upNew != null;
  const rebooted = canCheckUptime ? upNew! < p.baseline.uptimeSec! : true; // can't verify uptime → trust serial
  const expired = Date.now() > Date.parse(p.until);

  const clear = () => db.prepare('UPDATE device_status SET reboot_expected_until = NULL, reboot_baseline = NULL WHERE device_id = ?').run(deviceId);
  const audit = (result: 'applied' | 'rejected', detail: string) => writeAudit(
    { db, actor: 'system', deviceId, deviceName: deviceName(db, deviceId), action: 'system.reboot', targetLabel: 'reboot' },
    result, 'Reboot return verification', p.baseline, { serial, uptime }, detail,
  );

  if (!serialOk) {
    clear();
    audit('rejected', `Returned with a DIFFERENT serial (${serial ?? '?'} vs expected ${p.baseline.serial}) — possible hardware swap; NOT the same box.`);
    return;
  }
  if (rebooted) {
    clear();
    audit('applied', `Returned after reboot — serial matches and uptime reset to ${uptime ?? '?'}.`);
    return;
  }
  // Same box, but uptime did NOT reset — a poll landed before it actually went
  // down. Keep the dead-man armed (do NOT clear) and wait for the real reboot;
  // give up only once the window has expired.
  if (expired) {
    clear();
    audit('rejected', `Window expired and the device never rebooted (uptime never reset — still ${uptime ?? '?'}). The reboot may not have taken.`);
  }
}
