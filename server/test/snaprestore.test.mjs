// P37.1 — section parsers + delta planner (PURE, no network). Proves: the /export
// tokenizer handles the canonical export AND the read-only snapshot format
// (quoted values, `\` continuations, slash vs space paths); the delta is exact
// per section; malformed input is skipped, never turned into a wrong op; and the
// plan masks secrets. Acceptance A + H (pure parts).
//   node --test test/snaprestore.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { sliceSection, planSection, maskRec, sectionById, SECTIONS } from '../dist/snaprestore.js';

const EXPORT = `# 2026-07-22 by RouterOS 7.20.6
/ip firewall nat
add action=masquerade chain=srcnat comment="RUBYMIK-NAT: hairpin" out-interface=ether1
add action=dst-nat chain=dstnat dst-port=443 protocol=tcp \\
    to-addresses=10.0.0.5 comment="RUBYMIK-NAT: web"
/queue simple
add max-limit=10M/10M name=guest target=10.0.0.0/24
/ip dns
set allow-remote-requests=yes servers=1.1.1.1,8.8.8.8`;

const SNAPSHOT = `# RubyMIK read-only config snapshot
# identity = r1
/ip/firewall/nat
  action=masquerade chain=srcnat comment=RUBYMIK-NAT out-interface=ether1
/queue/simple
  max-limit=10M/10M name=guest target=10.0.0.0/24
/ip/dns
  allow-remote-requests=true servers=1.1.1.1`;

// ---------------- tokenizer: both formats ----------------

test('slices the canonical EXPORT format (quoted values + line continuation)', () => {
  const nat = sliceSection(EXPORT, ['/ip/firewall/nat']);
  assert.equal(nat.length, 2);
  assert.equal(nat[0].fields.comment, 'RUBYMIK-NAT: hairpin');       // quoted, with spaces
  assert.equal(nat[1].fields['to-addresses'], '10.0.0.5');           // continuation joined
  assert.equal(nat[1].fields.comment, 'RUBYMIK-NAT: web');
  const dns = sliceSection(EXPORT, ['/ip/dns']);
  assert.equal(dns[0].cmd, 'set');
  assert.equal(dns[0].fields.servers, '1.1.1.1,8.8.8.8');            // comma list preserved
});

test('slices the read-only SNAPSHOT format (slash paths, indented, no add/set)', () => {
  const nat = sliceSection(SNAPSHOT, ['/ip/firewall/nat']);
  assert.equal(nat.length, 1);
  assert.equal(nat[0].cmd, 'row');
  assert.equal(nat[0].fields.action, 'masquerade');
  const q = sliceSection(SNAPSHOT, ['/queue/simple']);
  assert.equal(q[0].fields.name, 'guest');
});

test('section header normalizes space-form and slash-form to the same slice', () => {
  assert.equal(sliceSection(EXPORT, ['/ip/firewall/nat']).length, 2);   // header was "/ip firewall nat"
  assert.equal(sliceSection(SNAPSHOT, ['/ip/firewall/nat']).length, 1); // header was "/ip/firewall/nat"
});

// ---------------- adapters fromSnapshot ----------------

test('adapters parse their slice into keyed records', () => {
  const nat = sectionById('nat').fromSnapshot(EXPORT);
  assert.equal(nat.length, 2);
  assert.ok(nat[0].key.includes('chain=srcnat'));
  const q = sectionById('queue').fromSnapshot(EXPORT);
  assert.equal(q[0].key, 'guest');
  assert.equal(q[0].fields['max-limit'], '10000000/10000000'); // rate normalized (10M → 10000000) so it compares equal to the REST read
  const dns = sectionById('dns').fromSnapshot(EXPORT);
  assert.equal(dns[0].key, 'dns');
  assert.equal(dns[0].fields.servers, '1.1.1.1,8.8.8.8');
});

// ---------------- delta planner (exact per section) ----------------

const rec = (key, fields, extra = {}) => ({ key, fields, ...extra });

test('DNS singleton: differing servers → one edit; identical → no op', () => {
  const snap = [rec('dns', { servers: '1.1.1.1,8.8.8.8', 'allow-remote-requests': 'yes' })];
  const cur = [rec('dns', { servers: '1.1.1.1', 'allow-remote-requests': 'yes' }, { id: 'dns', managed: true })];
  const ops = planSection(snap, cur, 'additive', { singleton: true, canEdit: true });
  assert.equal(ops.length, 1); assert.equal(ops[0].kind, 'edit');
  assert.equal(planSection(snap, snap.map((r) => ({ ...r, id: 'dns', managed: true })), 'additive', { singleton: true, canEdit: true }).length, 0);
});

test('queue: additive edits but never deletes; exact adds the delete', () => {
  const snap = [rec('q1', { name: 'q1', 'max-limit': '5M/5M' })];
  const cur = [rec('q1', { name: 'q1', 'max-limit': '10M/10M' }, { id: '*1', managed: true }), rec('q2', { name: 'q2' }, { id: '*2', managed: true })];
  const add = planSection(snap, cur, 'additive', { canEdit: true });
  assert.deepEqual(add.map((o) => o.kind), ['edit']);                 // q1 edited; q2 left alone
  const exact = planSection(snap, cur, 'exact', { canEdit: true });
  assert.deepEqual(exact.map((o) => `${o.kind}:${o.key}`), ['edit:q1', 'delete:q2']);
});

test('NAT (no edit): a change is delete+create; exact removes extras; creates missing', () => {
  const R1 = 'chain=srcnat action=masquerade';
  const snap = [rec(R1, { chain: 'srcnat', action: 'masquerade' })];
  const cur = [rec(R1, { chain: 'srcnat', action: 'masquerade' }, { id: '*1', managed: true }), rec('chain=dstnat action=dst-nat', { chain: 'dstnat', action: 'dst-nat' }, { id: '*2', managed: true })];
  assert.equal(planSection(snap, cur, 'additive').length, 0);          // R1 matches, no additive change
  assert.deepEqual(planSection(snap, cur, 'exact').map((o) => o.kind), ['delete']); // remove the extra
  // a missing rule is created in BOTH modes
  const snap2 = [rec('chain=dstnat action=redirect', { chain: 'dstnat', action: 'redirect' })];
  assert.deepEqual(planSection(snap2, [], 'additive').map((o) => o.kind), ['create']);
});

test('exact-mode delete of an UNMANAGED item is blocked (never issued)', () => {
  const snap = [];
  const cur = [rec('k', { name: 'x' }, { id: '*1', managed: false })];
  const ops = planSection(snap, cur, 'exact', { canEdit: true });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'delete');
  assert.match(ops[0].blockedNote, /unmanaged/i);                     // flagged, and the executor skips blocked ops
});

// ---------------- malformed input never yields a wrong plan ----------------

test('malformed / partial slices are SKIPPED, never turned into a broken op', () => {
  const bad = `/ip firewall nat
add action=masquerade
add chain=srcnat comment="unterminated
/queue simple
add target=10.0.0.0/24
add name=ok max-limit=1M/1M`;
  // NAT: a rule with no chain is dropped (would be an invalid create otherwise)
  const nat = sectionById('nat').fromSnapshot(bad);
  assert.ok(nat.every((r) => r.fields.chain), 'every parsed NAT rec has a chain');
  // queue: a queue with no name is dropped
  const q = sectionById('queue').fromSnapshot(bad);
  assert.deepEqual(q.map((r) => r.key), ['ok']);
  // parsing never throws on garbage
  assert.doesNotThrow(() => sectionById('nat').fromSnapshot('/ip firewall nat\nadd =\nadd action='));
});

test('an ABSENT section parses to [] (no phantom records)', () => {
  assert.equal(sectionById('nat').fromSnapshot('/ip dns\nset servers=1.1.1.1').length, 0);
});

// ---------------- secret masking (acceptance H, pure part) ----------------

test('maskRec masks secret values but keeps the field visible', () => {
  const m = maskRec(rec('t', { name: 'vpn', 'ipsec-secret': 'TopSecretPSK', password: 'hunter2', 'connect-to': 'a.b' }));
  assert.equal(m.fields['ipsec-secret'], '••••••');
  assert.equal(m.fields.password, '••••••');
  assert.equal(m.fields['connect-to'], 'a.b');      // non-secret visible
  assert.deepEqual(m.masked.sort(), ['ipsec-secret', 'password']);
  assert.equal(m.raw, undefined, 'raw (real secret values) is stripped from the plan view');
});

test('pppoe secret: parsed with hasSecret, masked in the plan, forces a re-apply edit', () => {
  const text = '/interface pppoe-client\nadd name=wan interface=ether2 user=alice password="s3cr3tPw" comment=isp';
  const recs = sectionById('pppoe').fromSnapshot(text);
  assert.equal(recs[0].key, 'wan');
  assert.equal(recs[0].hasSecret, true);
  assert.equal(recs[0].fields.password, 's3cr3tPw');              // real value server-side (for apply)
  assert.equal(maskRec(recs[0]).fields.password, '••••••');       // masked in the plan view
  // a current with identical NON-secret fields still edits — the secret can't be compared (masked on read)
  const cur = [{ key: 'wan', id: '*1', managed: true, hasSecret: true, fields: { name: 'wan', interface: 'ether2', user: 'alice', comment: 'isp' } }];
  const ops = planSection(recs, cur, 'additive', { canEdit: true });
  assert.equal(ops.length, 1); assert.equal(ops[0].kind, 'edit'); assert.equal(ops[0].secretChanged, true);
});

test('SECTIONS are dependency-ordered (addresses/routes before firewall/NAT)', () => {
  const ids = SECTIONS.map((s) => s.id);
  assert.ok(ids.indexOf('address') < ids.indexOf('nat'));
  assert.ok(ids.indexOf('route') < ids.indexOf('nat'));
  assert.ok(ids.indexOf('dns') < ids.indexOf('nat'));
});
