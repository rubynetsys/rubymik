// Provisioning: ruthless validation + baseline generation (mgmt-guard always).
//   node --test test/provision.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSpec, generateBaseline, baselineFirewall, inSubnet, subnetsOverlap, ipToInt,
} from '../dist/provision.js';

function baseSpec(over = {}) {
  return {
    identity: 'branch-rtr',
    interfaces: [
      { name: 'ether1', role: 'wan' },
      { name: 'ether2', role: 'lan' },
      { name: 'ether3', role: 'lan' },
    ],
    wan: { type: 'dhcp' },
    lan: { routerIp: '192.168.88.1', prefix: 24 },
    dhcp: { enabled: true, poolStart: '192.168.88.10', poolEnd: '192.168.88.254', dns: '1.1.1.1', leaseTime: '1h' },
    firewall: 'standard',
    remote: false,
    ...over,
  };
}

test('subnet math', () => {
  assert.ok(ipToInt('192.168.88.1') !== null);
  assert.equal(ipToInt('192.168.88.256'), null);
  assert.ok(inSubnet('192.168.88.10', '192.168.88.1', 24));
  assert.ok(!inSubnet('192.168.89.10', '192.168.88.1', 24));
  assert.ok(subnetsOverlap('192.168.88.0', 24, '192.168.88.128', 25));
  assert.ok(!subnetsOverlap('192.168.88.0', 24, '10.0.0.0', 24));
});

test('a coherent spec validates clean', () => {
  assert.deepEqual(validateSpec(baseSpec()), []);
});

test('A: DHCP pool outside the LAN subnet is rejected', () => {
  const e = validateSpec(baseSpec({ dhcp: { enabled: true, poolStart: '10.0.0.10', poolEnd: '10.0.0.20' } }));
  assert.ok(e.some((x) => /outside the LAN subnet/.test(x)), e.join('|'));
});

test('A: router IP inside the DHCP pool is rejected', () => {
  const e = validateSpec(baseSpec({ lan: { routerIp: '192.168.88.50', prefix: 24 } }));
  assert.ok(e.some((x) => /falls inside the DHCP pool/.test(x)), e.join('|'));
});

test('A: overlapping WAN and LAN subnets are rejected', () => {
  const e = validateSpec(baseSpec({ wan: { type: 'static', static: { address: '192.168.88.2/24', gateway: '192.168.88.254', dns: '1.1.1.1' } } }));
  assert.ok(e.some((x) => /WAN subnet overlaps the LAN subnet/.test(x)), e.join('|'));
});

test('A: a double-assigned / double-WAN interface set is rejected', () => {
  const e = validateSpec(baseSpec({ interfaces: [{ name: 'ether1', role: 'wan' }, { name: 'ether2', role: 'wan' }, { name: 'ether3', role: 'lan' }] }));
  assert.ok(e.some((x) => /Exactly one interface must be the WAN/.test(x)), e.join('|'));
});

test('A: WAN interface cannot also be a LAN member', () => {
  const e = validateSpec(baseSpec({ interfaces: [{ name: 'ether1', role: 'wan' }, { name: 'ether1', role: 'lan' }] }));
  assert.ok(e.some((x) => /listed more than once|cannot also be a LAN/.test(x)), e.join('|'));
});

test('A: static WAN missing fields, and PPPoE missing creds, are rejected', () => {
  assert.ok(validateSpec(baseSpec({ wan: { type: 'static' } })).some((x) => /Static WAN requires/.test(x)));
  assert.ok(validateSpec(baseSpec({ wan: { type: 'pppoe', pppoe: { user: '', password: '' } } })).some((x) => /PPPoE WAN requires/.test(x)));
});

test('A: no LAN interface, and bad prefix, are rejected', () => {
  assert.ok(validateSpec(baseSpec({ interfaces: [{ name: 'ether1', role: 'wan' }] })).some((x) => /At least one interface must be a LAN/.test(x)));
  assert.ok(validateSpec(baseSpec({ lan: { routerIp: '192.168.88.1', prefix: 33 } })).some((x) => /prefix length/.test(x)));
});

test('F: EVERY firewall baseline leads with the mgmt-accept guard', () => {
  for (const preset of ['basic', 'standard']) {
    const rules = baselineFirewall(baseSpec({ firewall: preset }));
    assert.ok(rules.length > 0);
    assert.equal(rules[0].chain, 'input');
    assert.equal(rules[0].action, 'accept', `${preset}: first rule must be an accept (mgmt guard)`);
    // the generated script contains the guard as the first filter line
    const script = generateBaseline(baseSpec({ firewall: preset }));
    const firstFilter = script.split('\n').find((l) => l.startsWith('/ip firewall filter add'));
    assert.match(firstFilter, /action=accept/, `${preset}: first firewall line must be an accept`);
  }
  // firewall 'off' → no filter rules at all
  assert.equal(baselineFirewall(baseSpec({ firewall: 'off' })).length, 0);
});

test('B: a local baseline script is complete', () => {
  const s = generateBaseline(baseSpec());
  for (const frag of ['/system identity set name=branch-rtr', '/interface bridge add name=bridge-lan', '/ip address add address=192.168.88.1/24', '/ip dhcp-client add interface=ether1', '/ip pool add', 'action=masquerade', '/ip firewall filter add']) {
    assert.ok(s.includes(frag), `missing: ${frag}`);
  }
  assert.ok(!s.includes('rmik-wg'), 'a local baseline must NOT include a tunnel');
});

test('C: a remote baseline embeds the provided tunnel bootstrap', () => {
  const s = generateBaseline(baseSpec({ remote: true }), { tunnelBootstrap: '/interface wireguard add name=rmik-wg\n' });
  assert.ok(s.includes('rmik-wg'), 'remote baseline must embed the tunnel-back');
});
