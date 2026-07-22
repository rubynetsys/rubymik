// Device-catalogue unit tests. Runs on Node's built-in test runner with native TS
// (`node --experimental-strip-types --test`), no extra deps. Guards the RB5009 port-count
// fix (v1.0.1) and the SFP28/QSFP28 rebuild, plus structural invariants over the catalogue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, MODEL_COUNT, categoryForModel } from '../src/catalog.ts';

const byModel = (re: RegExp) => CATALOG.filter((x) => re.test(x.model));

test('RB5009* variants have 8 Ethernet (ether1 2.5G + ether2-8 1G) + 1 SFP+', () => {
  const rb5009 = byModel(/^RB5009/);
  assert.ok(rb5009.length >= 2, `expected >=2 RB5009 variants, got ${rb5009.length}`);
  const expected = ['ether1', 'ether2', 'ether3', 'ether4', 'ether5', 'ether6', 'ether7', 'ether8', 'sfp-sfpplus1'];
  for (const d of rb5009) {
    assert.deepEqual(d.ports, expected, `${d.model} port list`);
    assert.equal(d.ports.length, 9, `${d.model} has 9 ports`);
    assert.ok(d.ports.includes('ether8'), `${d.model} must include ether8 (the 7-port bug)`);
    assert.ok(!d.ports.includes('ether9'), `${d.model} must not over-count ether ports`);
    assert.equal(d.ports[0], 'ether1', `${d.model} WAN candidate is ether1`);
    assert.equal(d.category, 'router');
    assert.equal(d.wireless, false);
  }
});

test('CCR2216 is 25G SFP28 + 100G QSFP28 (not SFP+/QSFP+)', () => {
  const [d] = byModel(/^CCR2216/);
  assert.ok(d, 'CCR2216 present');
  assert.ok(d.ports.includes('sfp28-12'), 'has 12× sfp28');
  assert.ok(d.ports.includes('qsfp28-2'), 'has 2× qsfp28');
  assert.ok(!d.ports.some((p) => p.startsWith('sfp-sfpplus')), 'no SFP+ ports');
  assert.ok(!d.ports.some((p) => p.startsWith('qsfpplus')), 'no QSFP+ ports');
});

test('CCR2004-1G-12S+2XS keeps 12× SFP+ AND adds the 2× SFP28', () => {
  const [d] = byModel(/^CCR2004-1G-12S\+2XS/);
  assert.ok(d, 'present');
  assert.ok(d.ports.includes('sfp-sfpplus12'), '12× SFP+');
  assert.ok(d.ports.includes('sfp28-1') && d.ports.includes('sfp28-2'), '2× SFP28');
});

test('hAP ac³ / ax³ have NO SFP (5 ether, wireless)', () => {
  for (const re of [/^hAP ac³/, /^hAP ax³/]) {
    const [d] = byModel(re);
    assert.ok(d, `${re} present`);
    assert.ok(d.ports.includes('ether5'), '5 ether ports');
    assert.ok(!d.ports.some((p) => p.startsWith('sfp')), `${d.model} has no SFP`);
    assert.equal(d.wireless, true);
  }
});

test('catalogue expanded and structurally sound', () => {
  assert.ok(MODEL_COUNT >= 80, `expected >=80 models after the rebuild, got ${MODEL_COUNT}`);
  const seen = new Set<string>();
  const validPort = /^(ether\d+|sfp\d+|sfp-sfpplus\d+|sfp28-\d+|qsfpplus\d+|qsfp28-\d+|wlan\d+)$/;
  for (const d of CATALOG) {
    assert.ok(d.model && d.model.trim() === d.model, `clean model name: ${d.model}`);
    assert.ok(!seen.has(d.model), `no duplicate model: ${d.model}`); seen.add(d.model);
    assert.ok(['router', 'switch', 'ap', 'other'].includes(d.category), `valid category: ${d.model}`);
    assert.ok(d.ports.length >= 1, `${d.model} has at least one port`);
    for (const p of d.ports) assert.match(p, validPort, `${d.model} port name "${p}"`);
    assert.equal(d.wireless, !!d.bands?.length, `${d.model} wireless flag matches bands`);
  }
});

test('classifier still routes model strings to the right category', () => {
  assert.equal(categoryForModel('RB5009UG+S+IN'), 'router');
  assert.equal(categoryForModel('CRS354-48G-4S+2Q+'), 'switch');
  assert.equal(categoryForModel('cAP ax'), 'ap');
  assert.equal(categoryForModel('OmniTIK 5 PoE ac'), 'ap');
  assert.equal(categoryForModel(null), 'other');
});
