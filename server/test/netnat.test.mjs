// P22 NAT: port-spec + input validation, and the natMgmtGuard's four classes.
// Refuse only PROVABLE mgmt cuts; ambiguous src-nat falls through to the dead-man.
//   node --test test/netnat.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidPortSpec, portSpecIncludes, validateNatInput, natMgmtGuard } from '../dist/netnat.js';

const MGMT = { mgmtIp: '10.0.0.1', mgmtInterface: 'ether1', mgmtPorts: ['ether1'], mgmtPort: 80, mgmtScheme: 'http' };

test('isValidPortSpec', () => {
  for (const ok of ['80', '80,443', '1-1024', '80,443,1000-2000', '65535']) assert.ok(isValidPortSpec(ok), ok);
  for (const bad of ['', '0', '70000', 'abc', '100-50', '80,']) assert.ok(!isValidPortSpec(bad), bad);
});

test('portSpecIncludes (empty = all ports)', () => {
  assert.ok(portSpecIncludes('80', 80));
  assert.ok(portSpecIncludes('80,443', 443));
  assert.ok(portSpecIncludes('8080-8090', 8085));
  assert.ok(!portSpecIncludes('8080-8090', 80));
  assert.ok(!portSpecIncludes('22', 80));
  assert.ok(portSpecIncludes(null, 80), 'no port constraint matches every port');
});

test('validateNatInput', () => {
  assert.deepEqual(validateNatInput({ chain: 'dstnat', action: 'dst-nat', toAddresses: '1.2.3.4' }), []);
  assert.deepEqual(validateNatInput({ chain: 'srcnat', action: 'masquerade' }), []);
  assert.ok(validateNatInput({ chain: 'srcnat', action: 'dst-nat' }).length, 'dst-nat invalid on srcnat');
  assert.ok(validateNatInput({ chain: 'dstnat', action: 'redirect' }).length, 'redirect needs to-ports');
  assert.deepEqual(validateNatInput({ chain: 'dstnat', action: 'redirect', toPorts: '8080' }), []);
  assert.ok(validateNatInput({ chain: 'dstnat', action: 'dst-nat', toAddresses: '1.2.3.4', dstPort: '99999', protocol: 'tcp' }).length, 'bad port');
  assert.ok(validateNatInput({ chain: 'dstnat', action: 'dst-nat', toAddresses: '1.2.3.4', dstPort: '80' }).length, 'port needs protocol');
});

// ---- the four guard classes ----

test('guard class 1: dst-nat/redirect capturing the mgmt port at the router is refused', () => {
  assert.ok(natMgmtGuard(MGMT, { chain: 'dstnat', action: 'dst-nat', dstPort: '80', protocol: 'tcp', toAddresses: '192.168.1.5' }), 'steals the mgmt socket');
  assert.ok(natMgmtGuard(MGMT, { chain: 'dstnat', action: 'redirect', dstPort: '80', protocol: 'tcp', toPorts: '8080' }), 'redirect of the mgmt port');
  // allowed: a different port
  assert.equal(natMgmtGuard(MGMT, { chain: 'dstnat', action: 'dst-nat', dstPort: '8080', protocol: 'tcp', toAddresses: '192.168.1.5' }), null);
  // allowed: same port but dst-address is a DIFFERENT host (not the router)
  assert.equal(natMgmtGuard(MGMT, { chain: 'dstnat', action: 'dst-nat', dstPort: '80', protocol: 'tcp', dstAddress: '203.0.113.9', toAddresses: '192.168.1.5' }), null);
});

test('guard class 2: all-port redirect on the mgmt in-interface is refused (even non-tcp, where class 1 does not apply)', () => {
  assert.ok(natMgmtGuard(MGMT, { chain: 'dstnat', action: 'redirect', inInterface: 'ether1', protocol: 'udp', toPorts: '8080' }), 'all-port redirect on mgmt iface');
  // allowed on a non-mgmt interface
  assert.equal(natMgmtGuard(MGMT, { chain: 'dstnat', action: 'redirect', inInterface: 'ether2', protocol: 'udp', toPorts: '8080' }), null);
});

test('guard class 3: provable src-nat cut refused; ambiguous falls through (acceptance E)', () => {
  // provable: masquerade ALL traffic out the mgmt interface, no scope
  assert.ok(natMgmtGuard(MGMT, { chain: 'srcnat', action: 'masquerade', outInterface: 'ether1' }), 'rewrites the mgmt return path');
  // ambiguous: scoped by dst-address → NOT refused, goes to dead-man
  assert.equal(natMgmtGuard(MGMT, { chain: 'srcnat', action: 'masquerade', outInterface: 'ether1', dstAddress: '8.8.8.8' }), null, 'scoped src-nat is ambiguous → allowed through safe-apply');
  // masquerade out a non-mgmt interface
  assert.equal(natMgmtGuard(MGMT, { chain: 'srcnat', action: 'masquerade', outInterface: 'ether2' }), null);
});

test('guard class 4: a disabled rule is never refused (removing/disabling NAT cannot steal the socket)', () => {
  assert.equal(natMgmtGuard(MGMT, { chain: 'dstnat', action: 'dst-nat', dstPort: '80', protocol: 'tcp', toAddresses: '192.168.1.5', disabled: true }), null);
});
