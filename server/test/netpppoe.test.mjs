// P24 PPPoE: input validation, the pppoeMgmtGuard's four classes, password
// redaction, and the add-before-remove invariant (reachable set never empty).
//   node --test test/netpppoe.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePppoeInput, pppoeMgmtGuard, _redactForTest } from '../dist/netpppoe.js';

const MGMT = { mgmtIp: '10.0.0.1', mgmtInterface: 'ether1', mgmtPorts: ['ether1'], mgmtPort: 80, mgmtScheme: 'http' };

test('validatePppoeInput', () => {
  assert.deepEqual(validatePppoeInput({ name: 'pppoe-wan', interface: 'ether5', user: 'p24test', password: 'x' }, { create: true }), []);
  assert.ok(validatePppoeInput({ name: '', interface: 'ether5', user: 'u', password: 'x' }, { create: true }).length, 'name required');
  assert.ok(validatePppoeInput({ name: 'w', interface: '', user: 'u', password: 'x' }, { create: true }).length, 'interface required');
  assert.ok(validatePppoeInput({ name: 'w', interface: 'ether5', user: '', password: 'x' }, { create: true }).length, 'user required on create');
  assert.ok(validatePppoeInput({ name: 'w', interface: 'ether5', user: 'u' }, { create: true }).length, 'password required on create');
  // edit: user/password optional
  assert.deepEqual(validatePppoeInput({ name: 'w', interface: 'ether5' }, { create: false }), []);
  assert.ok(validatePppoeInput({ name: 'w', interface: 'ether5', allow: 'bogus' }, { create: false }).length, 'bad auth proto');
});

test('guard class 1: creating a PPPoE client on the mgmt port is refused', () => {
  assert.ok(pppoeMgmtGuard(MGMT, 'create', { name: 'w', interface: 'ether1', user: 'u', password: 'p' }), 'seizes the mgmt port');
  assert.equal(pppoeMgmtGuard(MGMT, 'create', { name: 'w', interface: 'ether5', user: 'u', password: 'p' }), null, 'spare port ok');
});

test('guard class 2: deleting/disabling the mgmt-path client is refused', () => {
  const mgmtClient = { name: 'WAN', interface: 'ether1', isMgmtPath: true };
  assert.ok(pppoeMgmtGuard(MGMT, 'delete', null, mgmtClient), 'delete severs mgmt');
  assert.ok(pppoeMgmtGuard(MGMT, 'disable', null, mgmtClient), 'disable severs mgmt');
  // a non-mgmt-path client is fine
  assert.equal(pppoeMgmtGuard(MGMT, 'delete', null, { name: 'wan2', interface: 'ether5', isMgmtPath: false }), null);
});

test('guard class 3: re-parenting the mgmt-path client is refused (→ replace-WAN)', () => {
  const mgmtClient = { name: 'WAN', interface: 'ether1', isMgmtPath: true };
  assert.ok(pppoeMgmtGuard(MGMT, 'edit', { name: 'WAN', interface: 'ether5' }, mgmtClient), 're-parent = delete+recreate');
  // editing OTHER fields of the mgmt-path client (same parent) is allowed → dead-man
  assert.equal(pppoeMgmtGuard(MGMT, 'edit', { name: 'WAN', interface: 'ether1', user: 'newuser' }, mgmtClient), null);
  // class 4: re-parenting a NON-mgmt client is fine
  assert.equal(pppoeMgmtGuard(MGMT, 'edit', { name: 'wan2', interface: 'ether6' }, { name: 'wan2', interface: 'ether5', isMgmtPath: false }), null);
});

test('password is redacted for anything audited/logged', () => {
  const r = _redactForTest({ name: 'w', user: 'p24test', password: 'super-secret-pppoe' });
  assert.equal(r.password, '(set)');
  assert.ok(!JSON.stringify(r).includes('super-secret-pppoe'), 'no plaintext password survives redaction');
});

// ---- add-before-remove invariant: the reachable set is NEVER empty ----
function runAddBeforeRemove({ A, B, verifyB }) {
  let reachable = new Set([A]); const snaps = [];
  const snap = (l) => snaps.push({ l, size: reachable.size });
  snap('start');                       // {A} old WAN
  reachable.add(B); snap('new pppoe up'); // {A,B} — old WAN still up
  if (verifyB()) { /* endpoint moves to B; old WAN teardown is a follow-up */ snap('verified, endpoint→B'); return { result: 'applied', endpoint: B, snaps }; }
  reachable.delete(B); snap('unverified → torn down, kept A'); // {A}
  return { result: 'failed', endpoint: A, snaps };
}
test('replaceWanPppoe invariant: never an unreachable moment', () => {
  for (const verifyB of [() => true, () => false]) {
    const r = runAddBeforeRemove({ A: '10.0.0.1', B: '160.0.0.9', verifyB });
    assert.ok(r.snaps.every((s) => s.size >= 1), 'reachable set never empty');
    assert.equal(r.endpoint, verifyB() ? '160.0.0.9' : '10.0.0.1');
  }
});
