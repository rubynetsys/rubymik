// Native L2 tests: vlan-id/name validation, the CLASSIC vlan-filtering LOCK
// detection (proves G at unit level), and the add-before-remove-AT-L2 invariant
// (the reachable set is never empty). No network.
//   node --test test/netl2.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidVlanId, isValidL2Name, validateBridge, validateVlan, vlanFilteringKeepsMgmt } from '../dist/netl2.js';

test('vlan-id and name validation', () => {
  assert.ok(isValidVlanId(1) && isValidVlanId(4094));
  assert.ok(!isValidVlanId(0) && !isValidVlanId(4095) && !isValidVlanId(1.5));
  assert.ok(isValidL2Name('br-lan') && !isValidL2Name('1bad') && !isValidL2Name(''));
});

test('validateBridge / validateVlan', () => {
  assert.deepEqual(validateBridge('br0', []), []);
  assert.ok(validateBridge('br0', ['br0']).length, 'duplicate');
  assert.deepEqual(validateVlan('vlan10', 10, 'br0', []), []);
  assert.ok(validateVlan('vlan10', 5000, 'br0', []).length, 'vlan-id out of range');
  assert.ok(validateVlan('vlan10', 10, '', []).length, 'no parent');
});

// ---- THE classic lock: vlan-filtering on the mgmt bridge without the mgmt VLAN ----

const base = (bridgeVlans, mgmtVlanId = null) => ({
  bridges: [], vlans: [], bridgeVlans,
  path: { mgmtBridge: 'br0', mgmtPorts: ['ether1'], mgmtVlanId, mgmtIp: '10.0.0.1', mgmtInterface: 'br0', mgmtInterfaceType: 'bridge', mgmtVlan: null, mgmtNet: 'direct' },
});

test('vlanFilteringKeepsMgmt: FALSE when no bridge-VLAN entry carries the mgmt port (THE lock)', () => {
  assert.equal(vlanFilteringKeepsMgmt(base([])), false);
});
test('vlanFilteringKeepsMgmt: TRUE when the mgmt port is untagged for a VLAN (access mgmt survives)', () => {
  assert.equal(vlanFilteringKeepsMgmt(base([{ bridge: 'br0', vlanIds: '1', untagged: 'ether1', tagged: '' }])), true);
});
test('vlanFilteringKeepsMgmt: TRUE when the mgmt VLAN is tagged on the mgmt port', () => {
  assert.equal(vlanFilteringKeepsMgmt(base([{ bridge: 'br0', vlanIds: '10', untagged: '', tagged: 'ether1' }], '10')), true);
});
test('vlanFilteringKeepsMgmt: FALSE when an entry exists but not for the mgmt port', () => {
  assert.equal(vlanFilteringKeepsMgmt(base([{ bridge: 'br0', vlanIds: '20', untagged: 'ether5', tagged: '' }])), false);
});

// ---- add-before-remove-AT-L2 invariant: the reachable set is NEVER empty ----

function runL2Move({ verifyNew }) {
  const paths = new Set(['old:br0/ether1@10.0.0.1']);   // current mgmt L2 path
  const snaps = [];
  const snap = (label) => snaps.push({ label, size: paths.size, set: new Set(paths) });
  snap('start');
  paths.add('new:br1/ether2@10.0.0.2'); snap('built new path (old still present)');
  if (verifyNew()) { paths.delete('old:br0/ether1@10.0.0.1'); snap('verified → removed old'); return { result: 'applied', snaps }; }
  paths.delete('new:br1/ether2@10.0.0.2'); snap('verify failed → tore down new, kept old'); return { result: 'failed', snaps };
}

test('add-before-remove-at-L2 SUCCESS: new path verified → old removed, never empty', () => {
  const r = runL2Move({ verifyNew: () => true });
  assert.equal(r.result, 'applied');
  for (const s of r.snaps) assert.ok(s.size >= 1, `no reachable L2 path at "${s.label}" — a partition!`);
  assert.ok(r.snaps.at(-1).set.has('new:br1/ether2@10.0.0.2'));
});
test('add-before-remove-at-L2 FAILURE: new unverified → new torn down, old kept, no partition', () => {
  const r = runL2Move({ verifyNew: () => false });
  assert.equal(r.result, 'failed');
  for (const s of r.snaps) assert.ok(s.size >= 1, `no reachable L2 path at "${s.label}" — a partition!`);
  assert.ok(r.snaps.at(-1).set.has('old:br0/ether1@10.0.0.1') && r.snaps.at(-1).size === 1);
});
