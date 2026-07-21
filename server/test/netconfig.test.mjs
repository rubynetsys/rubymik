// DNS/NTP validation unit tests.
//   node --test test/netconfig.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidIpv4, isValidIp, isValidHostname,
  validateDnsServers, validateNtpServers, validateStaticEntry,
} from '../dist/netconfig.js';

test('IPv4 / IP validators', () => {
  assert.ok(isValidIpv4('8.8.8.8'));
  assert.ok(isValidIpv4('192.168.90.1'));
  assert.ok(!isValidIpv4('8.8.8.256'));
  assert.ok(!isValidIpv4('google.com'));
  assert.ok(isValidIp('2606:4700:4700::1111'), 'IPv6 accepted');
  assert.ok(!isValidIp('not-an-ip'));
});

test('hostname validator', () => {
  assert.ok(isValidHostname('pool.ntp.org'));
  assert.ok(isValidHostname('nas'));
  assert.ok(isValidHostname('printer.lan'));
  assert.ok(!isValidHostname(''));
  assert.ok(!isValidHostname('bad host'));
  assert.ok(!isValidHostname('-leading.dash'));
});

test('DNS servers must be IPs, not hostnames', () => {
  assert.deepEqual(validateDnsServers(['1.1.1.1', '8.8.8.8']), []);
  assert.equal(validateDnsServers(['1.1.1.1', 'notanip']).length, 1);
  assert.equal(validateDnsServers(['dns.google']).length, 1, 'hostname rejected for DNS server');
});

test('NTP servers accept IP OR hostname', () => {
  assert.deepEqual(validateNtpServers(['162.159.200.1', 'pool.ntp.org']), []);
  assert.equal(validateNtpServers(['bad server']).length, 1);
});

test('static entry needs valid hostname + IPv4', () => {
  assert.deepEqual(validateStaticEntry('nas', '192.168.90.10'), []);
  assert.ok(validateStaticEntry('nas', 'nope').length > 0, 'bad address');
  assert.ok(validateStaticEntry('bad host', '192.168.90.10').length > 0, 'bad hostname');
});
