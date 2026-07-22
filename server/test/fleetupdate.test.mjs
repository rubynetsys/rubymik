// P35 fleet update orchestrator tests: the pure planner (exclusions + canary-first
// + batching) and the run state-machine (canary gate, halt-on-failure skips the
// rest, abort stops before the next stage) driven by an injected processor. No
// network — the real per-device install is P34's attended path.
//   node --test test/fleetupdate.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { planFleetUpdate, FleetUpdater } from '../dist/fleetupdate.js';

const T = (id, over = {}) => ({ id, name: `r${id}`, manageable: true, reachable: true, updateAvailable: true, installed: '7.15', latest: '7.16', ...over });
let seq = 0;
const now = () => `t${seq++}`; // deterministic, monotonic timestamps (no ambient clock)
const settle = () => new Promise((r) => setTimeout(r, 20));

// ---------------- planner ----------------

test('planFleetUpdate excludes monitor-only, unreachable, and up-to-date', () => {
  const p = planFleetUpdate([
    T(1),
    T(2, { manageable: false }),
    T(3, { reachable: false }),
    T(4, { updateAvailable: false }),
    T(5, { updateAvailable: null, latest: null }),
  ], { canaryCount: 1, batchSize: 5 });
  // only id 1 is eligible; 2 monitor-only, 3 unreachable, 4 up-to-date, 5 unchecked → excluded
  assert.equal(p.total, 1);
  assert.deepEqual(p.canary.map((x) => x.id), [1]);
  assert.equal(p.excluded.length, 4);
  assert.match(p.excluded.find((e) => e.id === 2).reason, /Monitor-only/);
  assert.match(p.excluded.find((e) => e.id === 3).reason, /reachable/);
  assert.match(p.excluded.find((e) => e.id === 4).reason, /up to date/i);
  assert.match(p.excluded.find((e) => e.id === 5).reason, /unknown/i);
});

test('planFleetUpdate: 1 canary then batches of N', () => {
  const p = planFleetUpdate([T(1), T(2), T(3), T(4), T(5), T(6), T(7)], { canaryCount: 1, batchSize: 3 });
  assert.deepEqual(p.canary.map((x) => x.id), [1]);
  assert.deepEqual(p.batches.map((b) => b.map((x) => x.id)), [[2, 3, 4], [5, 6, 7]]);
  assert.equal(p.total, 7);
});

// ---------------- run state machine ----------------

test('a clean run: canary then every batch → done', async () => {
  const u = new FleetUpdater();
  const plan = planFleetUpdate([T(1), T(2), T(3), T(4)], { canaryCount: 1, batchSize: 2 });
  const id = u.start(plan, { canaryCount: 1, batchSize: 2, haltOnFailure: true }, true, async () => 'done', now);
  for (let i = 0; i < 50 && u.status(id).phase === 'running'; i++) await settle();
  const st = u.status(id);
  assert.equal(st.phase, 'done');
  assert.ok(st.targets.every((t) => t.status === 'done'));
});

test('canary that fails HALTS: the batches are skipped, never touched', async () => {
  const u = new FleetUpdater();
  const plan = planFleetUpdate([T(1), T(2), T(3), T(4)], { canaryCount: 1, batchSize: 2 });
  const cfg = { canaryCount: 1, batchSize: 2, haltOnFailure: true };
  const id = u.start(plan, cfg, true, async (it) => (it.id === 1 ? 'failed' : 'done'), now);
  for (let i = 0; i < 50 && u.status(id).phase === 'running'; i++) await settle();
  const st = u.status(id);
  assert.equal(st.phase, 'halted');
  assert.equal(st.targets.find((t) => t.id === 1).status, 'failed');
  assert.ok(st.targets.filter((t) => t.id !== 1).every((t) => t.status === 'skipped'), 'batch devices never updated after a canary failure');
});

test('a mid-fleet failure halts the remaining batches', async () => {
  const u = new FleetUpdater();
  const plan = planFleetUpdate([T(1), T(2), T(3), T(4), T(5)], { canaryCount: 1, batchSize: 2 });
  const cfg = { canaryCount: 1, batchSize: 2, haltOnFailure: true };
  // canary ok; batch1 = [2,3]; batch2 = [4,5]; fail 3 → halt before batch2
  const id = u.start(plan, cfg, true, async (it) => (it.id === 3 ? 'failed' : 'done'), now);
  for (let i = 0; i < 50 && u.status(id).phase === 'running'; i++) await settle();
  const st = u.status(id);
  assert.equal(st.phase, 'halted');
  assert.equal(st.targets.find((t) => t.id === 1).status, 'done'); // canary done
  assert.equal(st.targets.find((t) => t.id === 3).status, 'failed');
  assert.equal(st.targets.find((t) => t.id === 4).status, 'skipped'); // batch2 never ran
  assert.equal(st.targets.find((t) => t.id === 5).status, 'skipped');
});

test('haltOnFailure=false keeps going past a failure', async () => {
  const u = new FleetUpdater();
  const plan = planFleetUpdate([T(1), T(2), T(3)], { canaryCount: 1, batchSize: 5 });
  const cfg = { canaryCount: 1, batchSize: 5, haltOnFailure: false };
  const id = u.start(plan, cfg, true, async (it) => (it.id === 2 ? 'failed' : 'done'), now);
  for (let i = 0; i < 50 && u.status(id).phase === 'running'; i++) await settle();
  const st = u.status(id);
  assert.equal(st.phase, 'done');
  assert.equal(st.targets.find((t) => t.id === 2).status, 'failed');
  assert.equal(st.targets.find((t) => t.id === 3).status, 'done'); // continued despite the failure
});

test('abort stops before the next stage; in-flight canary still completes', async () => {
  const u = new FleetUpdater();
  const plan = planFleetUpdate([T(1), T(2), T(3), T(4)], { canaryCount: 1, batchSize: 1 });
  const cfg = { canaryCount: 1, batchSize: 1, haltOnFailure: true };
  let started = 0;
  const id = u.start(plan, cfg, true, async () => { started++; await new Promise((r) => setTimeout(r, 15)); return 'done'; }, now);
  // abort while the canary is in flight
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(u.abort(id), true);
  for (let i = 0; i < 60 && u.status(id).phase === 'running'; i++) await settle();
  const st = u.status(id);
  assert.equal(st.phase, 'aborted');
  const skipped = st.targets.filter((t) => t.status === 'skipped').length;
  assert.ok(skipped >= 1, 'at least one later stage was skipped by the abort');
});
