// P42 — WAN failover NOTIFICATION state machine. Pure + testable. IMPORTANT: these timers
// gate ALERTS only. The actual failover is done by RouterOS check-gateway (~20-30s, fixed);
// nothing here changes failover speed. Confirm-delay debounces a flap before we alert;
// hold-down makes "restored" honest; flap-suppression caps alert noise + summarises.
//
// The poller feeds computeWanState(...)'s raw state in each cycle; stepWanState decides what
// (if anything) to notify, and returns the new persisted timer state (stored per device in
// device_status, following the reboot_* precedent).

export type RawWanState = 'primary' | 'failover' | 'both-down' | 'none';
export type WanEventType = 'wan.failover.engaged' | 'wan.primary.restored' | 'wan.both.down' | 'wan.flapping';

export interface WanTimers {
  confirmDelaySec: number; // engaged/both-down must persist this long before alerting (default 30)
  holdDownSec: number;     // primary must hold this long before "restored" alerts (default 120)
  flapWindowSec: number;   // window over which flapping is counted (default 600)
  flapMaxEngages: number;  // engages allowed in the window before suppressing + summarising (default 1)
}
export const DEFAULT_TIMERS: WanTimers = { confirmDelaySec: 30, holdDownSec: 120, flapWindowSec: 600, flapMaxEngages: 1 };

export interface WanPersisted {
  stable: RawWanState;             // last CONFIRMED state
  pending: RawWanState | null;     // a candidate transition being debounced
  pendingSinceMs: number | null;
  flapWindowStartMs: number | null;
  flapEngages: number;             // engages (failover/both-down) counted in the current window
  suppressing: boolean;            // currently suppressing per-transition alerts (flapping)
}
export const INITIAL: WanPersisted = { stable: 'none', pending: null, pendingSinceMs: null, flapWindowStartMs: null, flapEngages: 0, suppressing: false };

export interface WanEvent { type: WanEventType; detail: string; severity: 'warning' | 'critical' | 'info' }
export interface StepResult { events: WanEvent[]; persisted: WanPersisted; transitioned: boolean }

const isEngage = (to: RawWanState) => to === 'failover' || to === 'both-down';

/** One poll step. `raw` = current on-device state (computeWanState); `nowMs` = wall clock. */
export function stepWanState(prev: WanPersisted, raw: RawWanState, nowMs: number, timers: WanTimers = DEFAULT_TIMERS): StepResult {
  const events: WanEvent[] = [];
  const p: WanPersisted = { ...prev };

  if (raw === 'none') { // failover not configured (or torn down) — reset, never alert
    return { events, persisted: { ...INITIAL }, transitioned: prev.stable !== 'none' };
  }
  if (p.stable === 'none') { // first observation of a configured failover — adopt baseline, no alert
    return { events, persisted: { ...INITIAL, stable: raw }, transitioned: true };
  }
  if (raw === p.stable) { p.pending = null; p.pendingSinceMs = null; return { events, persisted: p, transitioned: false }; }

  // debounce: a transition must persist before it's confirmed
  if (p.pending !== raw) { p.pending = raw; p.pendingSinceMs = nowMs; return { events, persisted: p, transitioned: false }; }
  const elapsedSec = (nowMs - (p.pendingSinceMs ?? nowMs)) / 1000;
  const isRestore = raw === 'primary' && (p.stable === 'failover' || p.stable === 'both-down');
  const need = isRestore ? timers.holdDownSec : timers.confirmDelaySec;
  if (elapsedSec < need) return { events, persisted: p, transitioned: false };

  // ── CONFIRM the transition ──
  const from = p.stable;
  p.stable = raw; p.pending = null; p.pendingSinceMs = null;

  if (isEngage(raw)) {
    // roll the flap window
    if (p.flapWindowStartMs === null || (nowMs - p.flapWindowStartMs) / 1000 > timers.flapWindowSec) {
      p.flapWindowStartMs = nowMs; p.flapEngages = 0; p.suppressing = false;
    }
    p.flapEngages += 1;
    if (p.flapEngages <= timers.flapMaxEngages) {
      events.push(raw === 'both-down'
        ? { type: 'wan.both.down', detail: `Both WANs down (confirmed after ${Math.round(elapsedSec)}s) — no internet path.`, severity: 'critical' }
        : { type: 'wan.failover.engaged', detail: `Failover engaged: on the backup WAN (confirmed after ${Math.round(elapsedSec)}s).`, severity: 'warning' });
    } else if (!p.suppressing) {
      p.suppressing = true;
      events.push({ type: 'wan.flapping', detail: `WAN is flapping — ${p.flapEngages} failovers within ${Math.round((nowMs - (p.flapWindowStartMs ?? nowMs)) / 1000)}s. Suppressing per-transition alerts for this window (will summarise).`, severity: 'warning' });
    } // else already suppressing → silent
  } else if (isRestore) {
    if (!p.suppressing) events.push({ type: 'wan.primary.restored', detail: `Primary WAN restored (held ${Math.round(elapsedSec)}s) from ${from}.`, severity: 'info' });
    // suppressed restores emit nothing (the flapping summary already covers it)
  }
  return { events, persisted: p, transitioned: true };
}
