// Native interface/address tests: same-subnet + address validation, and the
// ADD-BEFORE-REMOVE INVARIANT — at no step is the router without a reachable
// management address (proves the design; the real flow is proven live/simulator).
//   node --test test/netaddr.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { sameSubnet, validateAddress } from '../dist/netaddr.js';

test('sameSubnet: B must share the current mgmt subnet', () => {
  assert.ok(sameSubnet('172.16.111.222/24', '172.16.111.117/24'));
  assert.ok(sameSubnet('10.9.0.50/24', '10.9.0.9/24'));
  assert.ok(!sameSubnet('192.168.5.10/24', '172.16.111.117/24'), 'different subnet rejected');
  assert.ok(!sameSubnet('172.16.112.10/24', '172.16.111.117/24'), 'adjacent /24 rejected');
});

test('validateAddress', () => {
  assert.deepEqual(validateAddress('10.20.0.5/24', []), []);
  assert.ok(validateAddress('nope', []).length, 'bad CIDR');
  assert.ok(validateAddress('10.20.0.5/32', []).length, '/32 rejected');
  assert.ok(validateAddress('10.20.0.5/24', ['10.20.0.5/24']).length, 'exact duplicate');
  assert.ok(validateAddress('10.20.0.5/24', ['10.20.0.5/16']).length, 'same host different mask');
});

// ---- the ADD-BEFORE-REMOVE invariant: the reachable set is NEVER empty ----

/** Model of the add-before-remove sequence over an in-memory device. `verifyB`
 *  decides whether B is reachable as the same router. Records the reachable-
 *  address set after every step and asserts it is never empty. */
function runAddBeforeRemove({ A, B, verifyB }) {
  let addresses = new Set([A]);          // A = current mgmt address
  const snapshots = [];
  const snap = (label) => snapshots.push({ label, set: new Set(addresses), size: addresses.size });

  snap('start');                          // {A}
  addresses.add(B); snap('added B');      // {A,B} — A still present, router reachable
  const ok = verifyB();
  if (ok) {
    addresses.delete(A); snap('removed A (B verified)');   // {B}
    return { result: 'applied', endpoint: B, snapshots };
  }
  addresses.delete(B); snap('removed B (verify failed)');  // {A}
  return { result: 'failed', endpoint: A, snapshots };
}

test('ADD-BEFORE-REMOVE success: A→B, reachable at every step, endpoint = B', () => {
  const r = runAddBeforeRemove({ A: '172.16.111.117/24', B: '172.16.111.222/24', verifyB: () => true });
  assert.equal(r.result, 'applied');
  assert.equal(r.endpoint, '172.16.111.222/24');
  for (const s of r.snapshots) assert.ok(s.size >= 1, `reachable set empty at "${s.label}" — a partition!`);
  // the old address is only removed AFTER B is present
  const addedB = r.snapshots.find((s) => s.label === 'added B');
  assert.ok(addedB.set.has('172.16.111.117/24') && addedB.set.has('172.16.111.222/24'), 'both present before removing A');
});

test('ADD-BEFORE-REMOVE failure: B not verified → B removed, A kept, no partition', () => {
  const r = runAddBeforeRemove({ A: '172.16.111.117/24', B: '172.16.111.9/24', verifyB: () => false });
  assert.equal(r.result, 'failed');
  assert.equal(r.endpoint, '172.16.111.117/24', 'endpoint unchanged — still A');
  for (const s of r.snapshots) assert.ok(s.size >= 1, `reachable set empty at "${s.label}" — a partition!`);
  const end = r.snapshots.at(-1);
  assert.ok(end.set.has('172.16.111.117/24') && !end.set.has('172.16.111.9/24'), 'ends exactly as it began: only A');
});
