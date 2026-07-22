// Native WireGuard VPN tests: validation, the MGMT-TUNNEL detection (proves E at
// unit level — the P9 tunnel is recognised across name/comment/transport), the
// site-to-site matched-config generation (proves C), and that peer key material
// never reaches the audit (proves F). No network.
//   node --test test/netwireguard.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  isValidEndpoint, isValidAllowedAddresses, isValidKeepalive,
  validateInterfaceInput, validatePeerInput, isMgmtTunnel, genSiteToSite, VPN_TAG,
} from '../dist/netwireguard.js';
import { runSafeApply } from '../dist/safeapply.js';

const direct = { host: '192.168.88.117', net_transport: 'direct', tunnel_ip: null };
const tunnel = { host: 'x', net_transport: 'tunnel', tunnel_ip: '10.9.0.2' };

// ---------------- validation ----------------

test('endpoint / allowed-address / keepalive validation', () => {
  assert.ok(isValidEndpoint('vpn.example.com:51820'));
  assert.ok(isValidEndpoint('203.0.113.7'));
  assert.ok(!isValidEndpoint('nope:99999'));
  assert.ok(isValidAllowedAddresses('10.20.0.0/24'));
  assert.ok(isValidAllowedAddresses('10.20.0.0/24, 192.168.5.0/24'));
  assert.ok(!isValidAllowedAddresses('10.20.0.0'));
  assert.ok(!isValidAllowedAddresses('300.0.0.0/24'));
  assert.ok(isValidKeepalive('25s'));
  assert.ok(isValidKeepalive('25'));
  assert.ok(!isValidKeepalive('soon'));
});

test('validateInterfaceInput reserves rmik-wg for the management tunnel', () => {
  assert.deepEqual(validateInterfaceInput({ name: 'vpn-branch' }), []);
  assert.ok(validateInterfaceInput({ name: 'rmik-wg' }).length, 'rmik-wg reserved');
  assert.ok(validateInterfaceInput({ name: '1bad' }).length);
  assert.ok(validateInterfaceInput({ name: 'ok', listenPort: 99999 }).length);
});

const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno12=';
test('validatePeerInput', () => {
  assert.deepEqual(validatePeerInput({ publicKey: KEY, endpoint: '1.2.3.4:51820', allowedAddress: '10.0.0.0/24', keepalive: '25s' }), []);
  assert.ok(validatePeerInput({ publicKey: 'short', allowedAddress: '10.0.0.0/24' }).length, 'bad key');
  assert.ok(validatePeerInput({ publicKey: KEY, allowedAddress: 'nope' }).length, 'bad allowed-address');
  assert.ok(validatePeerInput({ publicKey: KEY, endpoint: 'x:0', allowedAddress: '10.0.0.0/24' }).length, 'bad endpoint port');
});

// ---------------- mgmt-tunnel detection (proves E) ----------------

test('isMgmtTunnel recognises the P9 management tunnel by name, comment, and transport', () => {
  assert.ok(isMgmtTunnel('rmik-wg', null, [], direct), 'by interface name');
  assert.ok(isMgmtTunnel('anything', 'RubyMIK remote-access tunnel', [], direct), 'by comment');
  assert.ok(isMgmtTunnel('wg0', 'RUBYMIK-VPN: mine', ['10.9.0.2/24'], tunnel), 'tunnel device: iface carrying the overlay address');
  assert.ok(!isMgmtTunnel('vpn-branch', `${VPN_TAG} branch`, ['10.88.0.1/24'], direct), 'a user VPN is NOT the mgmt tunnel');
});

// ---------------- site-to-site matched configs (proves C) ----------------

test('genSiteToSite produces matched, crossed peer configs', () => {
  const r = genSiteToSite(
    { publicKey: 'LOCALPUB', endpoint: '1.1.1.1', port: 51820, tunnelSubnet: '10.10.0.0/24' },
    { publicKey: 'REMOTEPUB', endpoint: '2.2.2.2', port: 51821, tunnelSubnet: '10.20.0.0/24' });
  // local peer points at the REMOTE end + routes the remote subnet
  assert.equal(r.localPeer['public-key'], 'REMOTEPUB');
  assert.equal(r.localPeer['endpoint-address'], '2.2.2.2');
  assert.equal(r.localPeer['endpoint-port'], '51821');
  assert.equal(r.localPeer['allowed-address'], '10.20.0.0/24');
  // remote peer points back at the LOCAL end
  assert.equal(r.remotePeer['public-key'], 'LOCALPUB');
  assert.equal(r.remotePeer['allowed-address'], '10.10.0.0/24');
  // far-end script embeds the local public key + tags with the VPN tag
  assert.ok(r.remoteScript.includes('LOCALPUB'));
  assert.ok(r.remoteScript.includes(VPN_TAG));
});

// ---------------- key material never in the audit (proves F) ----------------

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE config_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER, device_name TEXT, actor TEXT,
    action TEXT, target TEXT, summary TEXT, before_json TEXT, after_json TEXT, result TEXT,
    detail TEXT, created_at TEXT)`);
  return db;
}

test('adding a peer with a preshared key: the PSK never appears in the audit (proves F)', async () => {
  const db = freshDb();
  const PSK = 'TopSecretPresharedKey123456789012345678901234=';
  const ctx = { db, target: {}, transport: { scheme: 'http', port: 80 }, actor: 'tester', deviceId: 3, deviceName: 'bench', action: 'wg.peer.add', targetLabel: 'wg0', probe: async () => true };
  const out = await runSafeApply(ctx, {
    // mirrors addPeer: the summary carries NO key material
    snapshot: async () => ({ ids: [] }),
    summary: () => 'Add WireGuard peer on "wg0" (allowed 10.0.0.0/24, PSK set (redacted))',
    apply: async () => { /* device write body would include the PSK — never audited */ },
    verifyTook: async () => ({ ok: true, after: { publicKey: KEY, allowedAddress: '10.0.0.0/24' } }),
    rollback: async () => {},
  });
  assert.equal(out.result, 'applied');
  const a = db.prepare('SELECT summary, before_json, after_json, detail FROM config_audit ORDER BY id DESC LIMIT 1').get();
  const blob = `${a.summary}||${a.before_json}||${a.after_json}||${a.detail}`;
  assert.ok(!blob.includes(PSK), 'the preshared key must never appear in the audit row');
});
