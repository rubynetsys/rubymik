// P29 (DHCP) tests: the pool-range containment helper, server/pool/network
// validation, and the dhcpMgmtGuard proven BOTH ways — it refuses a provable
// management cut (a server on the mgmt interface/port, a pool or network covering
// the mgmt IP, a lease that IS the mgmt IP) and allows everything else. Plus a
// safe-apply state-machine check (applied + auto-rollback). No network.
//   node --test test/dhcp.mgmt.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ipInPoolRanges, ipInCidr, dhcpMgmtGuard,
  validateServerInput, validatePoolInput, validateNetworkInput,
} from '../dist/dhcp.js';
import { runSafeApply } from '../dist/safeapply.js';

// ---------------- range / cidr helpers ----------------

test('ipInPoolRanges: inside, outside, multi-range, single address', () => {
  assert.ok(ipInPoolRanges('10.0.0.50', '10.0.0.10-10.0.0.254'));
  assert.ok(!ipInPoolRanges('10.0.0.5', '10.0.0.10-10.0.0.254'));
  assert.ok(ipInPoolRanges('10.0.1.5', '10.0.0.10-10.0.0.254, 10.0.1.2-10.0.1.9'));
  assert.ok(ipInPoolRanges('10.0.9.9', '10.0.9.9'));
  assert.ok(!ipInPoolRanges('10.0.0.50', null));
});

// ---------------- validation ----------------

test('validateServerInput / Pool / Network', () => {
  assert.deepEqual(validateServerInput({ name: 'zzz-dhcp', interface: 'ether2' }), []);
  assert.ok(validateServerInput({ name: '', interface: 'ether2' }).length);
  assert.ok(validateServerInput({ name: 'zzz', interface: '' }).length);
  assert.deepEqual(validatePoolInput({ name: 'zzz-pool', ranges: '10.9.0.10-10.9.0.250' }), []);
  assert.ok(validatePoolInput({ name: 'zzz', ranges: '10.9.0.250-10.9.0.10' }).length, 'reversed range');
  assert.ok(validatePoolInput({ name: 'zzz', ranges: 'nope' }).length);
  assert.deepEqual(validateNetworkInput({ address: '10.9.0.0/24', gateway: '10.9.0.1' }), []);
  assert.ok(validateNetworkInput({ address: '10.9.0.0' }).length, 'not a CIDR');
  assert.ok(validateNetworkInput({ address: '10.9.0.0/24', gateway: 'x' }).length, 'bad gateway');
});

// ---------------- the guard: REFUSES a provable cut ----------------

const MGMT = { mgmtIp: '192.168.88.10', mgmtInterface: 'ether1', mgmtPorts: ['ether1'] };
const BRIDGE_MGMT = { mgmtIp: '192.168.88.10', mgmtInterface: 'bridge-lan', mgmtPorts: ['ether1', 'ether2'] };

test('guard refuses a DHCP server on the mgmt interface (create/disable/delete)', () => {
  assert.ok(dhcpMgmtGuard(MGMT, 'create', 'server', { interface: 'ether1' }, null), 'create on mgmt iface');
  assert.ok(dhcpMgmtGuard(MGMT, 'disable', 'server', null, { interface: 'ether1' }), 'disable on mgmt iface');
  assert.ok(dhcpMgmtGuard(MGMT, 'delete', 'server', null, { interface: 'ether1' }), 'delete on mgmt iface');
  // a server on a PORT of the mgmt bridge is also on the mgmt path
  assert.ok(dhcpMgmtGuard(BRIDGE_MGMT, 'create', 'server', { interface: 'ether2' }, null), 'create on a mgmt-bridge port');
  assert.match(dhcpMgmtGuard(MGMT, 'delete', 'server', null, { interface: 'ether1' }), /management path|risks/i);
});

test('guard refuses removing a pool/network/lease that covers the mgmt IP', () => {
  assert.ok(dhcpMgmtGuard(MGMT, 'delete', 'pool', null, { ranges: '192.168.88.2-192.168.88.254' }), 'pool contains mgmt IP');
  assert.ok(dhcpMgmtGuard(MGMT, 'delete', 'network', null, { address: '192.168.88.0/24' }), 'network is mgmt subnet');
  assert.ok(dhcpMgmtGuard(MGMT, 'edit', 'network', null, { address: '192.168.88.0/24' }), 'editing mgmt network');
  assert.ok(dhcpMgmtGuard(MGMT, 'delete', 'lease', null, { leaseAddress: '192.168.88.10' }), 'lease IS the mgmt IP');
});

// ---------------- the guard: ALLOWS everything else ----------------

test('guard allows non-mgmt DHCP work', () => {
  assert.equal(dhcpMgmtGuard(MGMT, 'create', 'server', { interface: 'ether5' }, null), null);
  assert.equal(dhcpMgmtGuard(MGMT, 'delete', 'server', null, { interface: 'ether5' }), null);
  assert.equal(dhcpMgmtGuard(MGMT, 'delete', 'pool', null, { ranges: '10.0.0.2-10.0.0.254' }), null);
  assert.equal(dhcpMgmtGuard(MGMT, 'delete', 'network', null, { address: '10.0.0.0/24' }), null);
  assert.equal(dhcpMgmtGuard(MGMT, 'delete', 'lease', null, { leaseAddress: '192.168.88.50' }), null);
  // creating a pool/network never cuts mgmt (additive)
  assert.equal(dhcpMgmtGuard(MGMT, 'create', 'pool', { ranges: '192.168.88.2-192.168.88.254' }, null), null);
});

// ---------------- safe-apply integration (applied + rollback) ----------------

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE config_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER, device_name TEXT, actor TEXT,
    action TEXT, target TEXT, summary TEXT, before_json TEXT, after_json TEXT, result TEXT,
    detail TEXT, created_at TEXT)`);
  return db;
}
const ctxFor = (db, probe) => ({ db, target: {}, transport: { scheme: 'http', port: 80 }, actor: 'tester', deviceId: 1, deviceName: 'bench', action: 'dhcp.server.create', targetLabel: 'zzz-dhcp', probe });

test('a DHCP server create rides safe-apply: applied on success, rolled back on verify-fail', async () => {
  const db = freshDb();
  const table = [];
  const ok = await runSafeApply(ctxFor(db, async () => true), {
    snapshot: async () => ({ ids: table.map((r) => r.id) }),
    summary: () => 'Create DHCP server "zzz-dhcp" on ether2',
    apply: async () => { table.push({ id: '*1', name: 'zzz-dhcp' }); },
    verifyTook: async () => ({ ok: table.some((r) => r.name === 'zzz-dhcp') }),
    rollback: async (b) => { for (let i = table.length - 1; i >= 0; i--) if (!b.ids.includes(table[i].id)) table.splice(i, 1); },
  });
  assert.equal(ok.result, 'applied');
  assert.equal(table.length, 1);

  const bad = await runSafeApply(ctxFor(db, async () => true), {
    snapshot: async () => ({ ids: table.map((r) => r.id) }),
    summary: () => 'Create DHCP server "zzz-dhcp2" on ether3',
    apply: async () => { table.push({ id: '*2', name: 'zzz-dhcp2' }); },
    verifyTook: async () => ({ ok: true }),
    rollback: async (b) => { for (let i = table.length - 1; i >= 0; i--) if (!b.ids.includes(table[i].id)) table.splice(i, 1); },
    forceVerifyFail: true,
  });
  assert.equal(bad.result, 'rolled_back');
  assert.equal(table.length, 1, 'the rolled-back create left no server behind');
});
