// P42.1 — dual-WAN failover core (sim, fixture-diffed). Proves the exact RouterOS object
// set, the state machine, the dual-WAN route guard, and the 5 approved amendments:
// (1) DHCP-gw-change route rewrite, (2) probe/DNS collision + probe pinning, (3) mangle
// never marks the mgmt flow, (5) adopt-vs-replace collision policy + pppoe add-default-route.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFailoverPlan, validateFailoverInput, computeWanState, wanRouteGuard,
  dnsCollisions, analyzeCollisions, planDhcpReconcile, mangleIsMgmtSafe,
  buildApplyOps, restoreRouteBody,
  DEFAULT_PROBE_WAN1, DEFAULT_PROBE_WAN2,
} from '../dist/netwan.js';

const STATIC = {
  wan1: { interface: 'ether1', sourceType: 'static', gateway: '192.168.88.1', probeTarget: '1.0.0.1' },
  wan2: { interface: 'ether2', sourceType: 'static', gateway: '192.168.89.1', probeTarget: '8.8.4.4' },
};

test('buildFailoverPlan — exact static/static object set (fixture diff)', () => {
  const plan = buildFailoverPlan(STATIC);
  // RouterOS 7: the routing tables must exist (and be applied) before any routing-mark refs them.
  assert.deepEqual(plan.tables.map((o) => o.body), [
    { name: 'RUBYMIK-to-wan1', fib: 'yes', comment: 'RUBYMIK-WAN table-wan1' },
    { name: 'RUBYMIK-to-wan2', fib: 'yes', comment: 'RUBYMIK-WAN table-wan2' },
  ]);
  // …and they come first in the applied order, ahead of the markroute routes and mangle.
  assert.equal(plan.all[0].menu, '/routing/table');
  assert.ok(plan.all.findIndex((o) => o.menu === '/routing/table') < plan.all.findIndex((o) => o.body['routing-mark']));
  assert.deepEqual(plan.routes.map((o) => o.body), [
    { 'dst-address': '1.0.0.1/32', gateway: '192.168.88.1', scope: '10', comment: 'RUBYMIK-WAN wan1-probe' },
    { 'dst-address': '8.8.4.4/32', gateway: '192.168.89.1', scope: '10', comment: 'RUBYMIK-WAN wan2-probe' },
    { 'dst-address': '0.0.0.0/0', gateway: '1.0.0.1', 'check-gateway': 'ping', distance: '1', comment: 'RUBYMIK-WAN default-primary' },
    { 'dst-address': '0.0.0.0/0', gateway: '8.8.4.4', 'check-gateway': 'ping', distance: '2', comment: 'RUBYMIK-WAN default-backup' },
    { 'dst-address': '0.0.0.0/0', gateway: '192.168.88.1', 'routing-mark': 'RUBYMIK-to-wan1', comment: 'RUBYMIK-WAN markroute-wan1' },
    { 'dst-address': '0.0.0.0/0', gateway: '192.168.89.1', 'routing-mark': 'RUBYMIK-to-wan2', comment: 'RUBYMIK-WAN markroute-wan2' },
  ]);
  assert.deepEqual(plan.nat.map((o) => o.body), [
    { chain: 'srcnat', action: 'masquerade', 'out-interface': 'ether1', comment: 'RUBYMIK-WAN nat-wan1' },
    { chain: 'srcnat', action: 'masquerade', 'out-interface': 'ether2', comment: 'RUBYMIK-WAN nat-wan2' },
  ]);
  assert.deepEqual(plan.mangle.map((o) => o.body), [
    { chain: 'prerouting', 'in-interface': 'ether1', 'connection-state': 'new', 'dst-address-type': '!local', action: 'mark-connection', 'new-connection-mark': 'RUBYMIK-wan1-conn', passthrough: 'yes', comment: 'RUBYMIK-WAN conn-wan1' },
    { chain: 'prerouting', 'in-interface': 'ether2', 'connection-state': 'new', 'dst-address-type': '!local', action: 'mark-connection', 'new-connection-mark': 'RUBYMIK-wan2-conn', passthrough: 'yes', comment: 'RUBYMIK-WAN conn-wan2' },
    { chain: 'prerouting', 'connection-mark': 'RUBYMIK-wan1-conn', action: 'mark-routing', 'new-routing-mark': 'RUBYMIK-to-wan1', passthrough: 'yes', comment: 'RUBYMIK-WAN route-wan1' },
    { chain: 'prerouting', 'connection-mark': 'RUBYMIK-wan2-conn', action: 'mark-routing', 'new-routing-mark': 'RUBYMIK-to-wan2', passthrough: 'yes', comment: 'RUBYMIK-WAN route-wan2' },
  ]);
  assert.equal(plan.patches.length, 0, 'no pppoe patch for static/static');
});

test('validation rejects same interface / same probe / bad IPs', () => {
  assert.equal(validateFailoverInput(STATIC).length, 0);
  assert.ok(validateFailoverInput({ ...STATIC, wan2: { ...STATIC.wan2, interface: 'ether1' } }).some((e) => /different interfaces/.test(e)));
  assert.ok(validateFailoverInput({ ...STATIC, wan2: { ...STATIC.wan2, probeTarget: '1.0.0.1' } }).some((e) => /different probe/.test(e)));
  assert.ok(validateFailoverInput({ ...STATIC, wan1: { ...STATIC.wan1, gateway: 'nope' } }).some((e) => /gateway must be an IPv4/.test(e)));
});

test('state machine: primary / failover / both-down / none', () => {
  assert.equal(computeWanState([{ distance: '1', active: true }, { distance: '2', active: false }]), 'primary');
  assert.equal(computeWanState([{ distance: '1', active: false }, { distance: '2', active: true }]), 'failover');
  assert.equal(computeWanState([{ distance: '1', active: false }, { distance: '2', active: false }]), 'both-down');
  assert.equal(computeWanState([]), 'none');
});

test('dual-WAN route guard: refuse cutting the active mgmt default w/o a verified alternate', () => {
  const del = (t, all) => wanRouteGuard('delete', t, all);
  // active primary, backup NOT active → refuse
  assert.match(del({ dst: '0.0.0.0/0', distance: '1', active: true }, [{ distance: '1', active: true }, { distance: '2', active: false }]) ?? '', /Refused/);
  // active primary, backup ALSO active (verified reachable) → allow
  assert.equal(del({ dst: '0.0.0.0/0', distance: '1', active: true }, [{ distance: '1', active: true }, { distance: '2', active: true }]), null);
  // cutting a standby (inactive) default → allow
  assert.equal(del({ dst: '0.0.0.0/0', distance: '2', active: false }, [{ distance: '1', active: true }, { distance: '2', active: false }]), null);
  // a non-default route is not this guard's business
  assert.equal(del({ dst: '10.0.0.0/24', distance: '1', active: true }, []), null);
});

// ── Amendment 1: DHCP-learned gateway change → probe/markroute routes rewritten ──
test('DHCP reconcile rewrites stale gateways for the DHCP WAN only', () => {
  const managed = [
    { id: '*1', comment: 'RUBYMIK-WAN wan1-probe', gateway: '192.168.88.1' },
    { id: '*5', comment: 'RUBYMIK-WAN markroute-wan1', gateway: '192.168.88.1' },
    { id: '*2', comment: 'RUBYMIK-WAN wan2-probe', gateway: '8.8.4.4' },
    { id: '*3', comment: 'RUBYMIK-WAN default-primary', gateway: '1.0.0.1' }, // default uses probe target, never rewritten
  ];
  const rw = planDhcpReconcile(managed, [{ wanIndex: 1, learnedGw: '192.168.88.55' }]); // lease renewed
  assert.deepEqual(rw.map((r) => r.id).sort(), ['*1', '*5'], 'both WAN1 gw-bearing routes rewritten');
  assert.ok(rw.every((r) => r.newGateway === '192.168.88.55'));
  assert.equal(planDhcpReconcile(managed, [{ wanIndex: 1, learnedGw: '192.168.88.1' }]).length, 0, 'no change when gw unchanged');
});

// ── Amendment 2: probe/DNS collision warning + probe pinned to its WAN ──
test('DNS-collision warning + P1 host-route pins the probe to its WAN (no WAN2 leak)', () => {
  assert.deepEqual(DEFAULT_PROBE_WAN1, '1.0.0.1'); // deliberately NOT the common client primary 1.1.1.1
  assert.deepEqual(DEFAULT_PROBE_WAN2, '8.8.4.4');
  assert.deepEqual(dnsCollisions(STATIC, ['1.0.0.1', '9.9.9.9']), [{ wan: 'wan1', probe: '1.0.0.1' }]);
  assert.deepEqual(dnsCollisions(STATIC, ['10.0.0.1']), []);
  // pinning: exactly one /32 host route for P1, via WAN1's gw, scope 10 — and NONE via WAN2.
  const p1 = buildFailoverPlan(STATIC).routes.filter((r) => r.body['dst-address'] === '1.0.0.1/32');
  assert.equal(p1.length, 1);
  assert.equal(p1[0].body.gateway, '192.168.88.1'); // WAN1 gw
  assert.equal(p1[0].body.scope, '10');
  assert.ok(!buildFailoverPlan(STATIC).routes.some((r) => r.body['dst-address'] === '1.0.0.1/32' && r.body.gateway === '192.168.89.1'), 'P1 never routed via WAN2');
});

// ── Amendment 3: mangle can never route-mark the management flow ──
test('mangle is mgmt-safe: every mark-connection is dst-address-type=!local + WAN-scoped', () => {
  const plan = buildFailoverPlan(STATIC);
  const res = mangleIsMgmtSafe(plan, ['ether1', 'ether2']);
  assert.ok(res.safe, `expected safe, got: ${res.problems.join('; ')}`);
  assert.ok(plan.mangle.filter((m) => m.body.action === 'mark-connection').every((m) => m.body['dst-address-type'] === '!local'));
  // negative control: a plan whose mark-connection lost the !local guard is flagged
  const unsafe = { ...plan, mangle: [{ kind: 'mangle', menu: '/ip/firewall/mangle', body: { chain: 'prerouting', 'in-interface': 'ether1', action: 'mark-connection', 'new-connection-mark': 'RUBYMIK-wan1-conn', comment: 'x' } }] };
  assert.equal(mangleIsMgmtSafe(unsafe, ['ether1', 'ether2']).safe, false);
});

// ── Amendment 5: collision policy (adopt vs replace) + pppoe add-default-route=no ──
test('collision policy: existing default forces adopt|replace; mark clash + masq-only-WAN1 flagged', () => {
  const existing = {
    routes: [{ id: '*1', dst: '0.0.0.0/0', distance: '1', comment: '', dynamic: false }],
    nat: [{ id: '*9', outInterface: 'ether1', action: 'masquerade', chain: 'srcnat', comment: '' }],
    mangleMarks: [],
  };
  assert.equal(analyzeCollisions({ ...STATIC, mode: 'fresh' }, existing).ok, false, 'fresh refuses to stack a 3rd default');
  assert.equal(analyzeCollisions({ ...STATIC, mode: 'fresh' }, existing).requiresModeChoice, true);
  assert.equal(analyzeCollisions({ ...STATIC, mode: 'adopt' }, existing).ok, true, 'adopt path allowed');
  assert.equal(analyzeCollisions({ ...STATIC, mode: 'replace' }, existing).ok, true, 'replace path allowed');
  assert.equal(analyzeCollisions({ ...STATIC, mode: 'adopt' }, existing).masqueradeOnlyWan1, true, 'masquerade covers WAN1 not WAN2');
  // mark-name clash → hard refuse
  const clash = analyzeCollisions({ ...STATIC, mode: 'replace' }, { routes: [], nat: [], mangleMarks: ['RUBYMIK-to-wan1'] });
  assert.equal(clash.ok, false);
  assert.deepEqual(clash.markNameCollisions, ['RUBYMIK-to-wan1']);
});

test('PPPoE leg adds an add-default-route=no patch for its pppoe-client (wizard owns defaults)', () => {
  const spec = { ...STATIC, wan2: { interface: 'pppoe-out2', sourceType: 'pppoe', gateway: 'pppoe-out2', probeTarget: '8.8.4.4' } };
  const plan = buildFailoverPlan(spec);
  assert.deepEqual(plan.patches, [{ menu: '/interface/pppoe-client', where: { name: 'pppoe-out2' }, body: { 'add-default-route': 'no' }, note: 'pppoe-client pppoe-out2: add-default-route=no (wizard owns defaults)' }]);
  // pppoe probe/markroute use the interface name as gateway (recursive via pppoe peer)
  assert.equal(plan.routes.find((r) => r.body.comment === 'RUBYMIK-WAN wan2-probe').body.gateway, 'pppoe-out2');
});

// ── P19 add-before-remove SEQUENCE (the live-danger concern) ──────────────────────────────
test('buildApplyOps — replace mode: new primary is verified active BEFORE the old default is removed', () => {
  const plan = buildFailoverPlan(STATIC);
  const ops = buildApplyOps(plan, ['*7'], 'replace');
  const verifyIdx = ops.findIndex((o) => o.kind === 'verify-primary-active');
  const removeIdx = ops.findIndex((o) => o.kind === 'remove-old-default');
  const lastAddIdx = ops.map((o) => o.kind).lastIndexOf('add');
  assert.ok(verifyIdx >= 0, 'the apply gates on the new primary becoming active');
  assert.ok(removeIdx >= 0, 'replace mode retires the existing default');
  assert.ok(lastAddIdx < verifyIdx, 'every RUBYMIK add happens before the verify gate');
  assert.ok(verifyIdx < removeIdx, 'the old default is removed strictly AFTER the verify gate (P19: no partition)');
  assert.equal(ops[removeIdx].id, '*7', 'the removed default is the captured pre-existing one, by id');
});

test('buildApplyOps — fresh mode never removes a default (nothing to retire)', () => {
  const ops = buildApplyOps(buildFailoverPlan(STATIC), [], 'fresh');
  assert.equal(ops.filter((o) => o.kind === 'remove-old-default').length, 0);
  assert.ok(ops.some((o) => o.kind === 'verify-primary-active'));
});

test('restoreRouteBody — hands back the ORIGINAL default verbatim (dst/gateway/distance/flags), drops runtime fields', () => {
  // a captured pre-wizard default route as RouterOS returns it
  const captured = {
    '.id': '*A', 'dst-address': '0.0.0.0/0', gateway: '192.168.88.1', distance: '1',
    'check-gateway': 'ping', scope: '30', 'target-scope': '10', active: 'true', dynamic: 'false', comment: '',
  };
  const body = restoreRouteBody(captured);
  // the identifying line is reproduced exactly …
  assert.deepEqual(body, { 'dst-address': '0.0.0.0/0', gateway: '192.168.88.1', distance: '1', 'check-gateway': 'ping', scope: '30', 'target-scope': '10' });
  // … and NO runtime/read-only field leaks into the re-add (a subtly-different route would pass a lazy check)
  for (const k of ['.id', 'active', 'dynamic']) assert.equal(body[k], undefined, `${k} is not replayed`);
});
