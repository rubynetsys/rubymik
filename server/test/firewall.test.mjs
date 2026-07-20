// Firewall generator unit tests: the mgmt-accept-first structural invariant
// (acceptance D) + custom-rule validation (F).
//   node --test test/firewall.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateFirewall, validateCustomRule, isValidPortSpec, isValidIpOrCidr, TAG,
} from '../dist/firewall.js';

const CFG = { wanInterface: 'ether1', trustedInterface: 'rmik-test', mgmtSources: ['192.0.2.10', '10.0.0.0/24'] };

function firstDropIndex(rules) {
  return rules.findIndex((r) => r.action === 'drop' || r.action === 'reject');
}
function mgmtAcceptCount(rules) {
  // leading accepts that form the guard (established + each mgmt source + trusted iface)
  let n = 0;
  for (const r of rules) { if (r.action === 'accept') n++; else break; }
  return n;
}

test('D: mgmt-accept rules are ALWAYS first, before any drop (basic)', () => {
  const rules = generateFirewall('basic', CFG);
  const firstDrop = firstDropIndex(rules);
  const guard = mgmtAcceptCount(rules);
  assert.ok(firstDrop > 0, 'there is a drop somewhere');
  assert.ok(guard >= 1 + CFG.mgmtSources.length, 'guard has established + every mgmt source');
  assert.ok(guard <= firstDrop, 'every guard accept precedes the first drop');
  // rule 1 is established/related; rules 2..k are the mgmt sources
  assert.match(rules[0].comment, /established/i);
  assert.equal(rules[0]['connection-state'], 'established,related');
  assert.ok(rules.slice(1, 1 + CFG.mgmtSources.length).every((r) => r.action === 'accept' && r['src-address']));
});

test('D: mgmt-accept still first under Standard (more drops present)', () => {
  const rules = generateFirewall('standard', CFG);
  const firstDrop = firstDropIndex(rules);
  const guard = mgmtAcceptCount(rules);
  assert.ok(guard <= firstDrop, 'guard precedes the first drop even in standard');
  // the very last rule is the WAN catch-all drop
  assert.equal(rules.at(-1).action, 'drop');
  assert.equal(rules.at(-1)['in-interface'], 'ether1');
});

test('D: a custom DROP rule cannot be placed above the mgmt guard', () => {
  const custom = [{ chain: 'input', action: 'drop', srcAddress: '0.0.0.0/0', comment: 'evil drop-all' }];
  const rules = generateFirewall('basic', CFG, custom);
  const guard = mgmtAcceptCount(rules);
  const customIdx = rules.findIndex((r) => (r.comment || '').includes('evil drop-all'));
  assert.ok(customIdx >= guard, 'custom drop lands AFTER the mgmt guard, never above it');
  // and the guard accepts are untouched at the top
  assert.equal(rules[0]['connection-state'], 'established,related');
});

test('every generated rule is RUBYMIK-tagged (identifiable / removable)', () => {
  for (const preset of ['basic', 'standard']) {
    for (const r of generateFirewall(preset, CFG)) {
      assert.ok((r.comment || '').startsWith(TAG), `rule tagged: ${r.comment}`);
    }
  }
});

test('preset "off" generates no rules (removal path)', () => {
  assert.deepEqual(generateFirewall('off', CFG), []);
});

test('generator is deterministic / idempotent (same input -> identical output)', () => {
  assert.deepEqual(generateFirewall('standard', CFG), generateFirewall('standard', CFG));
});

test('F: custom-rule validation', () => {
  assert.deepEqual(validateCustomRule({ chain: 'input', action: 'accept', protocol: 'tcp', dstPort: '22', srcAddress: '10.0.0.0/24' }), []);
  assert.ok(validateCustomRule({ chain: 'input', action: 'accept', protocol: 'tcp', dstPort: '99999' }).length > 0, 'port out of range');
  assert.ok(validateCustomRule({ chain: 'input', action: 'accept', protocol: 'tcp', dstPort: 'ssh' }).length > 0, 'non-numeric port');
  assert.ok(validateCustomRule({ chain: 'input', action: 'accept', dstPort: '80' }).length > 0, 'port without tcp/udp');
  assert.ok(validateCustomRule({ chain: 'input', action: 'nuke' }).length > 0, 'bad action');
  assert.ok(validateCustomRule({ chain: 'mangle', action: 'accept' }).length > 0, 'bad chain');
  assert.ok(validateCustomRule({ chain: 'input', action: 'accept', srcAddress: '999.1.1.1' }).length > 0, 'bad src');
});

test('port + CIDR validators', () => {
  assert.ok(isValidPortSpec('80'));
  assert.ok(isValidPortSpec('80,443'));
  assert.ok(isValidPortSpec('1000-2000'));
  assert.ok(!isValidPortSpec('0'));
  assert.ok(!isValidPortSpec('80-'));
  assert.ok(!isValidPortSpec('2000-1000'));
  assert.ok(isValidIpOrCidr('192.0.2.10'));
  assert.ok(isValidIpOrCidr('10.0.0.0/24'));
  assert.ok(!isValidIpOrCidr('10.0.0.0/33'));
  assert.ok(!isValidIpOrCidr('256.0.0.1'));
});
