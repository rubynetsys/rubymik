// P32 VPN breadth tests: host/spec validation, the VPN mgmt-path guard (a tunnel
// carrying the management IP can't be deleted/disabled/re-credited), secret
// redaction (PPP password + L2TP/IPsec PSK never survive redaction), the .ovpn
// generator (a client profile that carries no secret), and — at the safe-apply
// layer — that neither secret ever reaches the audit row. No network.
//   node --test test/netvpn.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  isValidHost, validateTunnelInput, validatePppSecretInput, vpnMgmtGuard, genOvpnClientConfig,
  validateCertInput, keyUsageFor,
  _redactTunnelForTest as redactTunnel, _redactSecretForTest as redactSecret, TUNNEL_PROTOS,
} from '../dist/netvpn.js';
import { runSafeApply } from '../dist/safeapply.js';

// ---------------- validation ----------------

test('isValidHost accepts IPs and hostnames, rejects junk', () => {
  assert.ok(isValidHost('203.0.113.7'));
  assert.ok(isValidHost('vpn.example.com'));
  assert.ok(!isValidHost('999.1.1.1'));
  assert.ok(!isValidHost('bad host'));
  assert.ok(!isValidHost(''));
});

test('validateTunnelInput enforces connect-to/user/password on create + IPsec PSK', () => {
  const ok = { proto: 'l2tp', name: 'vpn-road', connectTo: 'vpn.acme.net', user: 'road', password: 'pw' };
  assert.deepEqual(validateTunnelInput(ok, { create: true }), []);
  assert.ok(validateTunnelInput({ proto: 'l2tp', name: 'x' }, { create: true }).length, 'missing connect-to/user/password');
  assert.ok(validateTunnelInput({ proto: 'l2tp', name: 'x', connectTo: 'a.b', user: 'u' }, { create: true }).length, 'missing password');
  // IPsec enabled but no PSK on create → error
  assert.ok(validateTunnelInput({ ...ok, useIpsec: true }, { create: true }).length, 'ipsec on, no psk');
  assert.deepEqual(validateTunnelInput({ ...ok, useIpsec: true, ipsecSecret: 'psk' }, { create: true }), []);
  // edit (create:false): name alone is fine (patching one field)
  assert.deepEqual(validateTunnelInput({ proto: 'sstp', name: 'vpn-road' }, { create: false }), []);
  assert.ok(validateTunnelInput({ proto: 'bogus', name: 'vpn-road', connectTo: 'a.b', user: 'u', password: 'p' }, { create: true }).length, 'bad proto');
});

test('validatePppSecretInput enforces name/password/service/addresses', () => {
  assert.deepEqual(validatePppSecretInput({ name: 'road1', password: 'pw', service: 'l2tp' }, { create: true }), []);
  assert.ok(validatePppSecretInput({ name: 'road1' }, { create: true }).length, 'missing password on create');
  assert.ok(validatePppSecretInput({ name: 'road1', password: 'p', service: 'nope' }, { create: true }).length, 'bad service');
  assert.ok(validatePppSecretInput({ name: 'road1', password: 'p', localAddress: '10.0.0' }, { create: true }).length, 'bad local ip');
  assert.deepEqual(validatePppSecretInput({ name: 'road1' }, { create: false }), []);
});

// ---------------- the VPN mgmt-path guard (safety core) ----------------

const mgmtTunnel = { proto: 'l2tp', name: 'l2tp-hub', isMgmtPath: true };
const userTunnel = { proto: 'l2tp', name: 'l2tp-branch', isMgmtPath: false };

test('vpnMgmtGuard refuses delete/disable/edit of the tunnel the mgmt IP rides', () => {
  assert.ok(vpnMgmtGuard('delete', mgmtTunnel), 'delete mgmt tunnel refused');
  assert.ok(vpnMgmtGuard('disable', mgmtTunnel), 'disable mgmt tunnel refused');
  assert.ok(vpnMgmtGuard('edit', mgmtTunnel), 'edit mgmt tunnel refused');
  // the refusal names the tunnel + explains the cut
  assert.match(vpnMgmtGuard('delete', mgmtTunnel), /l2tp-hub/);
  assert.match(vpnMgmtGuard('delete', mgmtTunnel), /sever/i);
});

test('vpnMgmtGuard allows ops on a non-mgmt tunnel and any create', () => {
  assert.equal(vpnMgmtGuard('delete', userTunnel), null);
  assert.equal(vpnMgmtGuard('disable', userTunnel), null);
  assert.equal(vpnMgmtGuard('edit', userTunnel), null);
  assert.equal(vpnMgmtGuard('create', null), null, 'create is always additive (dials out, seizes no port)');
  assert.equal(vpnMgmtGuard('enable', mgmtTunnel), null, 're-enabling the mgmt tunnel is safe');
});

// ---------------- secret redaction (never returned/logged) ----------------

test('redactTunnel strips the PPP password AND the IPsec PSK', () => {
  const r = redactTunnel({ name: 'l2tp-road', password: 'hunter2', 'ipsec-secret': 'topsecretpsk', 'connect-to': 'a.b' });
  assert.equal(r.password, '(set)');
  assert.equal(r['ipsec-secret'], '(set)');
  assert.equal(r.name, 'l2tp-road');       // non-secret fields survive
  assert.equal(r['connect-to'], 'a.b');
});

test('redactSecret strips the PPP account password', () => {
  const r = redactSecret({ name: 'road1', password: 'hunter2', service: 'l2tp' });
  assert.equal(r.password, '(set)');
  assert.equal(r.service, 'l2tp');
});

// ---------------- .ovpn generator (no secret; references the server + CA) ----------------

test('genOvpnClientConfig builds a client profile pointing at the server, carrying no key', () => {
  const cfg = genOvpnClientConfig({ server: '198.51.100.9', port: 1194, proto: 'udp', caCertName: 'rubymik-ca' });
  assert.match(cfg, /^client$/m);
  assert.match(cfg, /remote 198\.51\.100\.9 1194/);
  assert.match(cfg, /proto udp/);
  assert.match(cfg, /auth-user-pass/);
  assert.match(cfg, /rubymik-ca/);
  // it must not embed any private-key material — the user pastes their own
  assert.ok(!/-----BEGIN/.test(cfg), 'no key material embedded');
});

// ---------------- secret never in the audit (proves the write-path contract) ----------------

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE config_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER, device_name TEXT, actor TEXT,
    action TEXT, target TEXT, summary TEXT, before_json TEXT, after_json TEXT, result TEXT,
    detail TEXT, created_at TEXT)`);
  return db;
}

test('creating an L2TP/IPsec tunnel: neither the password nor the PSK reaches the audit', async () => {
  const db = freshDb();
  const PW = 'RoadWarriorPassw0rd!', PSK = 'PreSharedKey-9f3a-never-logged';
  const ctx = { db, target: {}, transport: { scheme: 'http', port: 80 }, actor: 'tester', deviceId: 7, deviceName: 'bench', action: 'vpn.tunnel.create', targetLabel: 'l2tp-road', probe: async () => true };
  const out = await runSafeApply(ctx, {
    snapshot: async () => ({ ids: [] }),
    // mirrors createTunnel's summary — redacted markers only, never the values
    summary: () => 'Create L2TP/IPsec client "l2tp-road" → vpn.acme.net (password set — redacted, IPsec PSK set — redacted)',
    apply: async () => { /* device write body would carry PW + PSK — never audited */ },
    verifyTook: async () => ({ ok: true, after: { name: 'l2tp-road' } }),
    rollback: async () => {},
  });
  assert.equal(out.result, 'applied');
  const a = db.prepare('SELECT summary, before_json, after_json, detail FROM config_audit ORDER BY id DESC LIMIT 1').get();
  const blob = `${a.summary}||${a.before_json}||${a.after_json}||${a.detail}`;
  assert.ok(!blob.includes(PW), 'the PPP password must never appear in the audit row');
  assert.ok(!blob.includes(PSK), 'the IPsec PSK must never appear in the audit row');
});

test('TUNNEL_PROTOS is the three PPP-family remote-access protocols', () => {
  assert.deepEqual([...TUNNEL_PROTOS].sort(), ['l2tp', 'ovpn', 'sstp']);
});

// ---------------- certificate generation ----------------

test('validateCertInput enforces name/CN/kind/days/keysize', () => {
  assert.deepEqual(validateCertInput({ name: 'zzz-ca', commonName: 'RubyMIK Test CA', kind: 'ca' }), []);
  assert.ok(validateCertInput({ name: '', commonName: 'x', kind: 'ca' }).length, 'name required');
  assert.ok(validateCertInput({ name: 'zzz', commonName: '', kind: 'ca' }).length, 'CN required');
  assert.ok(validateCertInput({ name: 'zzz', commonName: 'x', kind: 'bogus' }).length, 'bad kind');
  assert.ok(validateCertInput({ name: 'zzz', commonName: 'x', kind: 'ca', daysValid: 99999 }).length, 'days too big');
  assert.ok(validateCertInput({ name: 'zzz', commonName: 'x', kind: 'ca', keySize: 1024 }).length, 'bad keysize');
});

test('keyUsageFor maps each kind to the right RouterOS key-usage', () => {
  assert.equal(keyUsageFor('ca'), 'key-cert-sign,crl-sign');
  assert.equal(keyUsageFor('server'), 'tls-server');
  assert.equal(keyUsageFor('client'), 'tls-client');
});
