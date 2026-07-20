// Anti-flap + interface-semantics unit tests for the alert engine core.
//   node --test test/alerts.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { Debouncer, ifaceCondition } from '../dist/alerts.js';

// Helper: run a value series through a debouncer with threshold=90/clear=85,
// fire after 3, resolve after 3 — returns the sequence of fire/resolve events.
function run(series, { fireN = 3, resolveN = 3, threshold = 90, clear = 85 } = {}) {
  const d = new Debouncer();
  const events = [];
  let active = false;
  for (const v of series) {
    const cond = v >= threshold ? 'breach' : v <= clear ? 'clear' : 'band';
    const r = d.step('k', cond, fireN, resolveN, active);
    if (r === 'fire') { active = true; events.push(`fire@${v}`); }
    if (r === 'resolve') { active = false; events.push(`resolve@${v}`); }
  }
  return events;
}

test('ANTI-FLAP: a value hovering across the threshold never fires', () => {
  // Crosses 90 five separate times but never holds 3 consecutive cycles.
  const events = run([91, 84, 92, 86, 93, 84, 91, 88, 92, 84]);
  assert.deepEqual(events, [], 'hovering must produce ZERO alerts');
});

test('sustained breach fires exactly once, at the Nth consecutive cycle', () => {
  const events = run([91, 92, 93, 94, 95, 96]);
  assert.deepEqual(events, ['fire@93'], 'fires at cycle 3, once — no per-cycle spam');
});

test('HYSTERESIS: firing alert holds through the dead band, resolves only after N clear cycles', () => {
  // Fire on 91,92,93 → then 87/88 are in band (85<v<90): must NOT resolve.
  // Then 84,83,82 are clear → resolves on the 3rd.
  const events = run([91, 92, 93, 87, 88, 86, 89, 84, 83, 82]);
  assert.deepEqual(events, ['fire@93', 'resolve@82']);
});

test('a clear cycle resets the fire streak; a breach resets the resolve streak', () => {
  // 2 breaches, an 84 clear, 2 breaches → still no fire (needs 3 consecutive).
  assert.deepEqual(run([91, 92, 84, 93, 94]), []);
  // While firing: 2 clears then a breach then 2 clears → still firing.
  const events = run([91, 92, 93, 84, 83, 95, 84, 83]);
  assert.deepEqual(events, ['fire@93'], 'resolve streak must restart after the breach');
});

test('binary rule (device down): fires after N failures, resolves after N successes', () => {
  const d = new Debouncer();
  let active = false;
  const events = [];
  for (const up of [false, false, true, true, false, false]) {
    const r = d.step('down', up ? 'clear' : 'breach', 2, 2, active);
    if (r === 'fire') { active = true; events.push('fire'); }
    if (r === 'resolve') { active = false; events.push('resolve'); }
  }
  assert.deepEqual(events, ['fire', 'resolve', 'fire']);
});

test('IFACE: was-running → down fires; admin-disabled never does', () => {
  const up = { name: 'e1', running: true, disabled: false };
  const down = { name: 'e1', running: false, disabled: false };
  const disabled = { name: 'e1', running: false, disabled: true };
  assert.equal(ifaceCondition(up, down), 'breach', 'real link loss alerts');
  assert.equal(ifaceCondition(up, disabled), 'ignore', 'operator disable is NOT a fault');
  assert.equal(ifaceCondition(disabled, down), 'ignore', 're-enable settling is not a fault yet');
  assert.equal(ifaceCondition(down, down), 'ignore', 'down at baseline never alerts');
  assert.equal(ifaceCondition(undefined, down), 'ignore', 'no baseline → no alert on first sight');
  assert.equal(ifaceCondition(down, up), 'clear', 'coming up clears');
});
