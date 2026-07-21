// Transport resolution + remote-access provisioning pure-logic tests.
//   node --test test/transport.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEndpoint } from '../dist/transport.js';
import { allocateTunnelIp, isValidWgKey, generateBootstrap } from '../dist/remoteaccess.js';
import { openDb } from '../dist/db.js';

test('resolveEndpoint: direct is the default and unchanged', () => {
  assert.deepEqual(resolveEndpoint({ host: '192.168.1.1' }), { host: '192.168.1.1', net: 'direct' });
  assert.deepEqual(resolveEndpoint({ host: '192.168.1.1', net_transport: 'direct' }), { host: '192.168.1.1', net: 'direct' });
});

test('resolveEndpoint: tunnel uses the overlay IP', () => {
  assert.deepEqual(resolveEndpoint({ host: '192.168.1.1', net_transport: 'tunnel', tunnel_ip: '10.9.0.7' }), { host: '10.9.0.7', net: 'tunnel' });
});

test('resolveEndpoint: tunnel WITHOUT a tunnel_ip safely falls back to direct', () => {
  assert.deepEqual(resolveEndpoint({ host: '192.168.1.1', net_transport: 'tunnel', tunnel_ip: null }), { host: '192.168.1.1', net: 'direct' });
});

test('isValidWgKey accepts 44-char base64 keys, rejects junk', () => {
  assert.ok(isValidWgKey('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ='));
  assert.ok(!isValidWgKey('not-a-key'));
  assert.ok(!isValidWgKey(''));
  assert.ok(!isValidWgKey('short='));
});

test('generateBootstrap embeds the hub PUBLIC key + endpoint but no private key', () => {
  const hub = { endpoint: 'vpn.example.com', listenPort: 51820, overlayCidr: '10.9.0.0/24', hubAddress: '10.9.0.1', publicKey: 'HUBPUBKEY123=' };
  const s = generateBootstrap(hub, { id: 1, label: 'Branch', tunnel_ip: '10.9.0.5', public_key: null, status: 'pending', device_id: null, created_at: '', updated_at: '' });
  assert.match(s, /public-key="HUBPUBKEY123="/);
  assert.match(s, /endpoint-address=vpn\.example\.com/);
  assert.match(s, /address=10\.9\.0\.5\/24/);
  assert.ok(!/private-key=/.test(s), 'bootstrap must never carry a private key');
});

test('allocateTunnelIp skips the hub address and used peers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmik-tp-'));
  const db = openDb(dir);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO wg_peers (label, tunnel_ip, status, created_at, updated_at) VALUES ('a','10.9.0.2','registered',?,?)").run(now, now);
  db.prepare("INSERT INTO wg_peers (label, tunnel_ip, status, created_at, updated_at) VALUES ('b','10.9.0.3','registered',?,?)").run(now, now);
  const ip = allocateTunnelIp(db, '10.9.0.0/24', '10.9.0.1');
  assert.equal(ip, '10.9.0.4'); // .1 is the hub, .2/.3 are taken
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
