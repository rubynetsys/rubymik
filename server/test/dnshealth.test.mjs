// P43.2 addition — resolver health state machine. Silence is the failure mode: a persistently
// dead resolver MUST alert (even from cold start), but a single-check reload blip must NOT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepResolverHealth, INITIAL_HEALTH, DEFAULT_HEALTH_TIMERS } from '../dist/dnshealth.js';

const T = DEFAULT_HEALTH_TIMERS; // downConfirmChecks: 2
const run = (states, start = INITIAL_HEALTH) => {
  let s = start; const events = [];
  for (const raw of states) { const r = stepResolverHealth(s, raw, T); s = r.persisted; events.push(...r.events.map((e) => e.type)); }
  return { state: s, events };
};

test('cold start UP → adopt baseline silently', () => {
  const { state, events } = run(['up']);
  assert.equal(state.stable, 'up');
  assert.deepEqual(events, []);
});

test('persistent DOWN → alerts after downConfirmChecks (even from cold start)', () => {
  const { state, events } = run(['down', 'down']);
  assert.equal(state.stable, 'down');
  assert.deepEqual(events, ['dnsfilter.resolver.down']);
});

test('single-check reload blip (up → down → up) does NOT alert', () => {
  const { state, events } = run(['up', 'down', 'up']);
  assert.equal(state.stable, 'up');
  assert.deepEqual(events, [], 'one missed check is debounced — no false down/restored pair');
});

test('down then restored → paired events, one each', () => {
  const { events } = run(['up', 'down', 'down', 'up']);
  assert.deepEqual(events, ['dnsfilter.resolver.down', 'dnsfilter.resolver.restored']);
});

test('stays down → the down event fires once, not every check', () => {
  const { events } = run(['down', 'down', 'down', 'down']);
  assert.deepEqual(events, ['dnsfilter.resolver.down']);
});
