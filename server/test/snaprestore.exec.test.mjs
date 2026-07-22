// P37.2 — the executor, driven by STUB section adapters (no network). Proves the
// orchestration the acceptance asks for: (a) a clean multi-section restore lands
// exactly the plan in dependency order; (b) a guard refusal mid-restore HALTS with
// accurate applied/remaining; (c) a dead-man rollback mid-section halts + reports;
// (d) additive vs exact modes; (e) secrets masked in the plan. The dead-man's
// actual rollback + the guards live in the write modules (safeapply/net* tests) —
// here we prove the executor inherits and reports them, never re-implements them.
//   node --test test/snaprestore.exec.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRestore, planRestore, planSection } from '../dist/snaprestore.js';

const outcome = (result, detail = '') => ({ result, auditId: 1, detail, before: null, after: null });
const rec = (key, fields, extra = {}) => ({ key, fields, ...extra });

// A stub adapter: fixed snapshot + current records, and a scripted apply().
function stub(id, order, snap, cur, apply, { canEdit = false, singleton = false } = {}) {
  return { id, label: id.toUpperCase(), paths: [`/x/${id}`], order, singleton, canEdit,
    fromSnapshot: () => snap, readCurrent: async () => cur, apply: async (_ctx, _sac, op) => apply(op) };
}
const run = (registry, ids, mode) => executeRestore({}, (a, t) => ({ action: a, target: t }), '', ids, mode, registry);

// ---------------- (a) clean multi-section, dependency order ----------------

test('(a) clean multi-section restore lands exactly the plan, in order', async () => {
  const applied = [];
  const A = stub('addr', 10, [rec('a1', { address: '10.0.0.1/24' })], [], (op) => { applied.push(`addr:${op.kind}:${op.key}`); return outcome('applied', 'ok'); });
  const B = stub('nat', 90, [rec('r1', { chain: 'srcnat' })], [], (op) => { applied.push(`nat:${op.kind}:${op.key}`); return outcome('applied', 'ok'); });
  const rep = await run([B, A], ['nat', 'addr'], 'additive'); // pass out of order — executor sorts by dep order
  assert.equal(rep.halted, false);
  assert.equal(rep.applied, 2);
  assert.deepEqual(applied, ['addr:create:a1', 'nat:create:r1']); // addr (order 10) BEFORE nat (order 90)
  assert.deepEqual(rep.results.map((r) => r.result), ['applied', 'applied']);
});

// ---------------- (b) guard refusal mid-restore halts ----------------

test('(b) a guard refusal (rolled_back 409) HALTS with accurate applied/remaining', async () => {
  const S = stub('nat', 90, [rec('r1', { chain: 'a' }), rec('r2', { chain: 'b' }), rec('r3', { chain: 'c' })], [],
    (op) => op.key === 'r2' ? outcome('rolled_back', 'natMgmtGuard: would steal the management socket') : outcome('applied', 'ok'));
  const rep = await run([S], ['nat'], 'additive');
  assert.equal(rep.halted, true);
  assert.equal(rep.applied, 1);                                  // only r1 applied
  assert.match(rep.haltReason, /rolled_back|management socket/i);
  assert.deepEqual(rep.remaining, [{ section: 'nat', kind: 'create', key: 'r3' }]); // r3 never attempted
  assert.deepEqual(rep.results.map((r) => `${r.key}:${r.result}`), ['r1:applied', 'r2:rolled_back']);
});

test('a halt in an EARLY section leaves all LATER sections entirely in remaining', async () => {
  const A = stub('addr', 10, [rec('a1', {})], [], () => outcome('rolled_back', 'unreachable'));
  const B = stub('nat', 90, [rec('r1', {}), rec('r2', {})], [], () => outcome('applied', 'ok'));
  const rep = await run([A, B], ['addr', 'nat'], 'additive');
  assert.equal(rep.halted, true);
  assert.equal(rep.applied, 0);
  assert.deepEqual(rep.remaining.map((r) => `${r.section}:${r.key}`), ['nat:r1', 'nat:r2']);
});

// ---------------- (c) dead-man rollback mid-section halts ----------------

test('(c) a dead-man rollback (unreachable → section auto-rolled-back) halts + is reported', async () => {
  const S = stub('queue', 60, [rec('q1', { name: 'q1' }), rec('q2', { name: 'q2' })], [],
    (op) => op.key === 'q2' ? outcome('rolled_back', 'device unreachable after change — rolled back (dead-man)') : outcome('applied', 'ok'),
    { canEdit: true });
  const rep = await run([S], ['queue'], 'additive');
  assert.equal(rep.halted, true);
  assert.equal(rep.applied, 1);
  assert.match(rep.results.find((r) => r.key === 'q2').detail, /dead-man|unreachable/i);
});

test('a guard THROW (e.g. MgmtTunnelProtected) is caught → refused + halt', async () => {
  const S = stub('vpn', 70, [rec('t1', {})], [], () => { throw new Error('This is the RubyMIK management tunnel — it cannot be modified.'); });
  const rep = await run([S], ['vpn'], 'additive');
  assert.equal(rep.halted, true);
  assert.equal(rep.results[0].result, 'refused');
  assert.match(rep.haltReason, /management tunnel/i);
});

// ---------------- (d) additive vs exact ----------------

test('(d) additive leaves extras; exact deletes them (and skips unmanaged)', async () => {
  const snap = [rec('q1', { name: 'q1', 'max-limit': '1M/1M' })];
  const cur = [rec('q1', { name: 'q1', 'max-limit': '1M/1M' }, { id: '*1', managed: true }),
    rec('q2', { name: 'q2' }, { id: '*2', managed: true }),
    rec('q3', { name: 'q3' }, { id: '*3', managed: false })];
  const seen = [];
  const S = stub('queue', 60, snap, cur, (op) => { seen.push(`${op.kind}:${op.key}`); return outcome('applied'); }, { canEdit: true });
  seen.length = 0; await run([S], ['queue'], 'additive');
  assert.deepEqual(seen, []); // q1 identical → nothing; extras untouched in additive
  seen.length = 0; await run([S], ['queue'], 'exact');
  assert.deepEqual(seen, ['delete:q2']); // q2 deleted; q3 unmanaged → blocked (never issued)
});

// ---------------- (e) secret masking in the plan ----------------

test('(e) the PLAN masks secret values (real values never leave the planner)', async () => {
  const S = stub('vpn', 70, [rec('t1', { 'connect-to': 'a.b', 'ipsec-secret': 'RealPSK123' })], [], () => outcome('applied'));
  const plan = await planRestore({}, '', ['vpn'], 'additive', [S]);
  const op = plan[0].ops[0];
  assert.equal(op.kind, 'create');
  assert.equal(op.after.fields['ipsec-secret'], '••••••');
  assert.equal(op.after.fields['connect-to'], 'a.b');
  assert.equal(op.after.raw, undefined);
  const blob = JSON.stringify(plan);
  assert.ok(!blob.includes('RealPSK123'), 'the real PSK never appears anywhere in the plan payload');
});

test('planSection integration: a full section plan matches per-op expectations', () => {
  const snap = [rec('a', { x: '1' }), rec('b', { x: '2' })];
  const cur = [rec('a', { x: '9' }, { id: '1', managed: true }), rec('c', { x: '3' }, { id: '2', managed: true })];
  const exact = planSection(snap, cur, 'exact', { canEdit: true });
  assert.deepEqual(exact.map((o) => `${o.kind}:${o.key}`).sort(), ['create:b', 'delete:c', 'edit:a']);
});
