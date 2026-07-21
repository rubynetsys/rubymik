// Native routes tests: CIDR math, validation, the TRANSPORT-AWARE management-path
// guard (proves C at unit level + G both transports), and the dead-man auto-revert
// for a routing lockout (proves D at the framework level) — all with NO network.
//   node --test test/netroutes.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ipToInt, isValidIpv4, isValidCidr, cidrsOverlap, isValidGateway,
  validateRouteInput, mgmtGuardError,
} from '../dist/netroutes.js';
import { runSafeApply } from '../dist/safeapply.js';

// ---------------- CIDR math ----------------

test('ipToInt / isValidIpv4', () => {
  assert.equal(ipToInt('0.0.0.0'), 0);
  assert.equal(ipToInt('255.255.255.255'), 0xffffffff);
  assert.ok(isValidIpv4('172.16.111.117'));
  assert.ok(!isValidIpv4('172.16.111.256'));
  assert.equal(ipToInt('1.2.3'), null);
});

test('isValidCidr', () => {
  assert.ok(isValidCidr('10.20.0.0/24'));
  assert.ok(isValidCidr('0.0.0.0/0'));
  assert.ok(!isValidCidr('10.20.0.0/33'));
  assert.ok(!isValidCidr('10.20.0.0'));
});

test('cidrsOverlap', () => {
  assert.ok(cidrsOverlap('172.16.111.0/24', '172.16.111.128/25'), 'super/sub overlap');
  assert.ok(cidrsOverlap('172.16.111.105/32', '172.16.111.0/24'), 'host inside subnet');
  assert.ok(cidrsOverlap('10.0.0.0/8', '10.9.0.0/24'));
  assert.ok(!cidrsOverlap('10.99.99.0/24', '172.16.111.0/24'), 'disjoint');
  assert.ok(!cidrsOverlap('192.168.90.0/24', '172.16.111.0/24'));
});

test('isValidGateway', () => {
  assert.ok(isValidGateway('172.16.111.1'));
  assert.ok(isValidGateway('ether1'));
  assert.ok(isValidGateway('bridge-lan'));
  assert.ok(!isValidGateway(''));
  assert.ok(!isValidGateway('1.2.3'.repeat(30)));
});

test('validateRouteInput', () => {
  assert.deepEqual(validateRouteInput({ dst: '10.20.0.0/24', gateway: '172.16.111.1', distance: 1 }), []);
  assert.ok(validateRouteInput({ dst: 'nope', gateway: '172.16.111.1', distance: 1 }).length);
  assert.ok(validateRouteInput({ dst: '10.20.0.0/24', gateway: '', distance: 1 }).length);
  assert.ok(validateRouteInput({ dst: '10.20.0.0/24', gateway: '172.16.111.1', distance: 999 }).length);
});

// ---------------- MGMT-PATH GUARD (transport-aware → proves C + G) ----------------

test('mgmt-path guard refuses the default route', () => {
  assert.ok(mgmtGuardError('0.0.0.0/0', ['172.16.111.0/24'], 'direct'));
});

test('mgmt-path guard refuses a route overlapping the DIRECT management subnet', () => {
  const e = mgmtGuardError('172.16.111.0/25', ['172.16.111.0/24'], 'direct');
  assert.ok(e && /management subnet/i.test(e), e);
  // a host route to RubyMIK-side source is also caught
  assert.ok(mgmtGuardError('172.16.111.105/32', ['172.16.111.0/24'], 'direct'));
});

test('mgmt-path guard is TRANSPORT-AWARE: a tunnel device protects its OVERLAY subnet (G)', () => {
  const e = mgmtGuardError('10.9.0.0/24', ['10.9.0.0/24'], 'tunnel');
  assert.ok(e && /overlay/i.test(e), 'tunnel guard message names the WireGuard overlay: ' + e);
  // and a benign route on a tunnel device is allowed
  assert.equal(mgmtGuardError('10.50.0.0/24', ['10.9.0.0/24'], 'tunnel'), null);
});

test('mgmt-path guard ALLOWS a benign route that does not touch mgmt', () => {
  assert.equal(mgmtGuardError('10.99.99.0/24', ['172.16.111.0/24'], 'direct'), null);
  assert.equal(mgmtGuardError('192.168.50.0/24', ['172.16.111.0/24'], 'direct'), null);
});

// ---------------- dead-man on a routing lockout (proves D, framework level) ----------------

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE config_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER, device_name TEXT, actor TEXT,
    action TEXT, target TEXT, summary TEXT, before_json TEXT, after_json TEXT, result TEXT,
    detail TEXT, created_at TEXT)`);
  return db;
}

test('routing lockout: apply severs mgmt → dead-man auto-reverts, route removed, rolled_back', async () => {
  const db = freshDb();
  // fake device routing table; adding the "bad" route severs management.
  let routes = [{ id: '*1', dst: '0.0.0.0/0' }];
  let mgmtOk = true;
  const ctx = {
    db, target: {}, transport: { scheme: 'http', port: 80 }, actor: 'tester',
    deviceId: 3, deviceName: 'sim', action: 'route.add', targetLabel: '10.0.0.0/8',
    probe: async () => mgmtOk,          // the dead-man's reachability check
  };
  const out = await runSafeApply(ctx, {
    snapshot: async () => ({ ids: routes.map((r) => r.id) }),
    summary: () => 'Add static route 10.0.0.0/8 via blackhole',
    apply: async () => { routes.push({ id: '*bad', dst: '10.0.0.0/8' }); mgmtOk = false; }, // severs mgmt
    verifyTook: async () => ({ ok: true }),
    rollback: async (before) => { routes = routes.filter((r) => before.ids.includes(r.id)); mgmtOk = true; }, // remove bad route → recovered
  });
  assert.equal(out.result, 'rolled_back');
  assert.match(out.detail, /unreachable/i);
  assert.deepEqual(routes.map((r) => r.id), ['*1'], 'the mgmt-severing route was auto-removed');
  assert.equal(mgmtOk, true, 'management reachable again after revert');
});
