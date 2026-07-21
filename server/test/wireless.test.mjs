// Native wireless config tests: validation, correct-stack write-body generation
// (proves F), the passphrase-redaction discipline (proves D at the audit layer),
// and the safe-apply reversibility for a wireless change (proves G) — all with
// NO network (pure functions + runSafeApply over an in-memory fake device).
//   node --test test/wireless.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  validateSsid, validatePassphrase, validateChannel,
  genSsidBody, genSecurityBody, genChannelBody,
} from '../dist/wireless.js';
import { runSafeApply } from '../dist/safeapply.js';

// ---------------- validation ----------------

test('validateSsid: 1–32 bytes', () => {
  assert.deepEqual(validateSsid('HomeNet'), []);
  assert.deepEqual(validateSsid('a'.repeat(32)), []);
  assert.ok(validateSsid('').length, 'empty rejected');
  assert.ok(validateSsid('a'.repeat(33)).length, '>32 bytes rejected');
});

test('validatePassphrase: WPA2 8–63 chars', () => {
  assert.deepEqual(validatePassphrase('correcthorse'), []);
  assert.deepEqual(validatePassphrase('a'.repeat(63)), []);
  assert.ok(validatePassphrase('short').length, '<8 rejected');
  assert.ok(validatePassphrase('a'.repeat(64)).length, '>63 rejected');
});

test('validateChannel: band/freq/width, per stack', () => {
  assert.deepEqual(validateChannel('wifi', { band: '2ghz-ax', frequency: 2412, width: '20mhz' }), []);
  assert.deepEqual(validateChannel('wireless', { band: '2ghz-b/g/n', frequency: 2437 }), []);
  assert.ok(validateChannel('wifi', { band: 'made-up-band' }).length, 'bad band rejected');
  assert.ok(validateChannel('wifi', { band: '2ghz-ax', frequency: 5200 }).length, '2.4GHz band with 5GHz freq rejected');
  assert.ok(validateChannel('wifi', { width: '999mhz' }).length, 'bad width rejected');
  // a band valid on modern wifi but not on the legacy stack is rejected for legacy
  assert.ok(validateChannel('wireless', { band: '2ghz-ax' }).length, 'modern-only band rejected on legacy stack');
});

// ---------------- correct-stack generation (proves F) ----------------

test('genSsidBody targets the RIGHT stack', () => {
  assert.deepEqual(genSsidBody('wifi', { ssid: 'Net', enabled: true }), { 'configuration.ssid': 'Net', disabled: 'no' });
  assert.deepEqual(genSsidBody('wireless', { ssid: 'Net', enabled: false }), { ssid: 'Net', disabled: 'yes' });
});

test('genSecurityBody targets the RIGHT stack and carries the passphrase to the device', () => {
  const modern = genSecurityBody('wifi', { authTypes: ['wpa2-psk', 'wpa3-psk'], passphrase: 'hunter2hunter2' });
  assert.equal(modern['security.authentication-types'], 'wpa2-psk,wpa3-psk');
  assert.equal(modern['security.passphrase'], 'hunter2hunter2'); // sent to device (necessary)
  assert.ok(!('wpa2-pre-shared-key' in modern), 'must NOT use legacy keys for a wifi device');

  const legacy = genSecurityBody('wireless', { authTypes: ['wpa2-psk'], passphrase: 'hunter2hunter2' });
  assert.equal(legacy['wpa2-pre-shared-key'], 'hunter2hunter2');
  assert.equal(legacy.mode, 'dynamic-keys');
  assert.ok(!('security.passphrase' in legacy), 'must NOT use modern keys for a legacy device');
});

test('genChannelBody targets the RIGHT stack', () => {
  assert.deepEqual(genChannelBody('wifi', { band: '5ghz-ax', frequency: 5180, width: '80mhz' }),
    { 'channel.band': '5ghz-ax', 'channel.frequency': '5180', 'channel.width': '80mhz' });
  assert.deepEqual(genChannelBody('wireless', { band: '5ghz-a/n/ac', frequency: 5180, width: '20/40/80mhz' }),
    { band: '5ghz-a/n/ac', frequency: '5180', 'channel-width': '20/40/80mhz' });
});

// ---------------- safe-apply reversibility + passphrase redaction ----------------

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE config_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER, device_name TEXT, actor TEXT,
    action TEXT, target TEXT, summary TEXT, before_json TEXT, after_json TEXT, result TEXT,
    detail TEXT, created_at TEXT)`);
  return db;
}
const ctxFor = (db) => ({
  db, target: {}, transport: { scheme: 'http', port: 80 }, actor: 'tester',
  deviceId: 3, deviceName: 'bench', action: 'wireless.ssid', targetLabel: 'wifi1', probe: async () => true,
});
const lastAudit = (db) => db.prepare('SELECT summary, before_json, after_json, detail, result FROM config_audit ORDER BY id DESC LIMIT 1').get();

test('wireless SSID change is reversible: forced verify failure rolls the SSID back', async () => {
  const db = freshDb();
  // a fake device interface, mutated by apply/rollback exactly like the real steps do
  const dev = { ssid: 'OldNet', disabled: 'false' };
  const out = await runSafeApply(ctxFor(db), {
    snapshot: async () => ({ ssid: dev.ssid, disabled: dev.disabled }),
    summary: (b) => `Wi-Fi "wifi1": SSID ${b.ssid} → NewNet, enabled`,
    apply: async () => { dev.ssid = 'NewNet'; dev.disabled = 'false'; },
    verifyTook: async () => ({ ok: dev.ssid === 'NewNet', after: { ssid: dev.ssid } }),
    rollback: async (b) => { dev.ssid = b.ssid; dev.disabled = b.disabled; },
    forceVerifyFail: true,
  });
  assert.equal(out.result, 'rolled_back');
  assert.equal(dev.ssid, 'OldNet', 'SSID restored to snapshot');
});

test('security change: the passphrase never appears in the audit summary/before/after/detail (proves D)', async () => {
  const db = freshDb();
  const SECRET = 'SuperSecretWifiPass!';
  // mirrors applySecurity: snapshot + after exclude the passphrase; summary excludes it;
  // only genSecurityBody (the device write body) carries it.
  const prof = { auth: 'wpa2-psk', pass: 'oldpass12' };
  const out = await runSafeApply({ ...ctxFor(db), action: 'wireless.security' }, {
    snapshot: async () => ({ authTypes: prof.auth.split(','), hadPassphrase: !!prof.pass }), // NO secret
    summary: (b) => `Wi-Fi security on "wifi1": ${b.authTypes.join('+')} → wpa2-psk+wpa3-psk (passphrase set, redacted)`,
    apply: async () => { const body = genSecurityBody('wifi', { authTypes: ['wpa2-psk', 'wpa3-psk'], passphrase: SECRET }); prof.auth = body['security.authentication-types']; prof.pass = body['security.passphrase']; },
    verifyTook: async () => ({ ok: true, after: { authTypes: prof.auth, hasPassphrase: !!prof.pass } }), // NO secret
    rollback: async () => {},
  });
  assert.equal(out.result, 'applied');
  const a = lastAudit(db);
  const blob = `${a.summary}||${a.before_json}||${a.after_json}||${a.detail}`;
  assert.ok(!blob.includes(SECRET), 'the passphrase must NOT be anywhere in the audit row');
  assert.ok(a.summary.includes('redacted'), 'summary notes the passphrase is redacted');
});
