// P42.2 — WAN failover NOTIFICATION state machine (sim). Proves Ray's timers: confirm-delay
// before "engaged", hold-down before "restored", and flap-suppression (max 1 engage/window
// → summary). These gate ALERTS only; failover itself is RouterOS check-gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepWanState, INITIAL, DEFAULT_TIMERS } from '../dist/wanstate.js';

const T = DEFAULT_TIMERS; // confirm 30s · hold-down 120s · flap window 600s · max 1 engage
/** Run a sequence of [rawState, nowSec] steps; return the ordered event types + final state. */
function run(steps, timers = T) {
  let p = INITIAL; const events = [];
  for (const [raw, sec] of steps) {
    const r = stepWanState(p, raw, sec * 1000, timers);
    p = r.persisted;
    for (const e of r.events) events.push(e.type);
  }
  return { events, stable: p.stable };
}

test('baseline: first observation of primary adopts silently (no alert on configure)', () => {
  const { events, stable } = run([['primary', 0], ['primary', 30]]);
  assert.deepEqual(events, []);
  assert.equal(stable, 'primary');
});

test('confirm-delay: failover must persist ≥30s before wan.failover.engaged', () => {
  // established primary, then failover — held only 20s ⇒ no alert yet
  assert.deepEqual(run([['primary', 0], ['failover', 5], ['failover', 20]]).events, []);
  // held ≥30s ⇒ engaged fires once
  assert.deepEqual(run([['primary', 0], ['failover', 5], ['failover', 40]]).events, ['wan.failover.engaged']);
  // a blip that clears before the delay never alerts
  assert.deepEqual(run([['primary', 0], ['failover', 5], ['primary', 15]]).events, []);
});

test('restore hold-down: primary must hold ≥120s before wan.primary.restored', () => {
  const engaged = [['primary', 0], ['failover', 5], ['failover', 40]]; // now on backup (stable=failover)
  assert.deepEqual(run([...engaged, ['primary', 45], ['primary', 120]]).events, ['wan.failover.engaged'], 'held <120s → no restore yet');
  assert.deepEqual(run([...engaged, ['primary', 45], ['primary', 170]]).events, ['wan.failover.engaged', 'wan.primary.restored'], 'held ≥120s → restored');
});

test('both WANs down → wan.both.down (critical), confirm-delayed', () => {
  assert.deepEqual(run([['primary', 0], ['both-down', 5], ['both-down', 40]]).events, ['wan.both.down']);
  assert.deepEqual(run([['primary', 0], ['both-down', 5], ['both-down', 20]]).events, [], 'below confirm delay → silent');
});

test('flap suppression: >1 engage per window → summarise once, suppress the rest', () => {
  // engage#1 (alert) → restore#1 (alert) → engage#2 (flap summary, suppress) → restore#2 (silent) → engage#3 (silent)
  const steps = [
    ['primary', 0],
    ['failover', 5], ['failover', 40],      // engage #1  → engaged
    ['primary', 45], ['primary', 170],       // restore #1 → restored (held 125s)
    ['failover', 175], ['failover', 210],    // engage #2  → flapping (suppress)
    ['primary', 215], ['primary', 340],      // restore #2 → suppressed
    ['failover', 345], ['failover', 380],    // engage #3  → suppressed
  ];
  assert.deepEqual(run(steps).events, ['wan.failover.engaged', 'wan.primary.restored', 'wan.flapping']);
});

test('flap window resets: after the window elapses, alerts resume', () => {
  const steps = [
    ['primary', 0],
    ['failover', 5], ['failover', 40],       // engage #1 → engaged
    ['primary', 45], ['primary', 170],        // restore #1 → restored
    ['failover', 175], ['failover', 210],     // engage #2 → flapping (window started at t=40)
    // jump past the 600s window from the first engage, then engage again → fresh window, alerts resume
    ['primary', 215], ['primary', 340],       // restore (suppressed)
    ['failover', 900], ['failover', 935],     // engage after window reset → engaged again
  ];
  const ev = run(steps).events;
  assert.deepEqual(ev, ['wan.failover.engaged', 'wan.primary.restored', 'wan.flapping', 'wan.failover.engaged']);
});

test('teardown (state→none) resets the machine without alerting', () => {
  assert.deepEqual(run([['primary', 0], ['failover', 5], ['failover', 40], ['none', 60]]).events, ['wan.failover.engaged']);
  assert.equal(run([['primary', 0], ['none', 10]]).stable, 'none');
});
