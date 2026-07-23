// Provisioning ROUTE tests (v1.1.1 regression) — the wizard's remote happy path
// must not silently 400, and the coherence/Review step must catch a missing
// prerequisite (the WireGuard hub) instead of letting Apply's /generate 400 after
// Review already said "coherent".
//   node --test test/provision.route.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../dist/db.js';
import { provisionRoutes } from '../dist/routes/provision.js';

// A full remote-site spec — hEX S (RB760iGS) shape: ether1 WAN, ether2-5 + sfp1 LAN.
// 192.168.88.x per the public-repo convention (no internal IPs in committed tests).
function remoteSpec(over = {}) {
  return {
    identity: 'branch-gw',
    interfaces: [
      { name: 'ether1', role: 'wan' },
      { name: 'ether2', role: 'lan' }, { name: 'ether3', role: 'lan' },
      { name: 'ether4', role: 'lan' }, { name: 'ether5', role: 'lan' },
      { name: 'sfp1', role: 'lan' },
    ],
    wan: { type: 'dhcp' },
    lan: { routerIp: '192.168.88.1', prefix: 24 },
    dhcp: { enabled: true, poolStart: '192.168.88.10', poolEnd: '192.168.88.254', dns: '1.1.1.1', leaseTime: '1h' },
    firewall: 'standard',
    remote: true,
    ...over,
  };
}

function fixture({ withHub } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-prov-'));
  const db = openDb(dir);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)').run('admin', 'x', now);
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run('testsid', now, new Date(Date.now() + 3600_000).toISOString());
  if (withHub) {
    db.prepare(
      'INSERT INTO wg_hub (id, enabled, endpoint, listen_port, overlay_cidr, hub_address, public_key, created_at, updated_at) VALUES (1, 1, ?, 51820, ?, ?, ?, ?, ?)',
    ).run('vpn.example.com', '10.9.0.0/24', '10.9.0.1', 'kQ9jV0m3l8sPxYbNc2fWtR6uZ1aH4dEgJ7oL5pMnQ0=', now, now);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/provision', provisionRoutes(db));
  const server = app.listen(0);
  return { dir, db, server, port: server.address().port };
}
const COOKIE = 'rubymik_session=testsid';
const post = (port, p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE }, body: JSON.stringify(body),
});

// THE regression the bug report asked for: full remote spec + hub ready → 200 + non-empty .rsc.
test('remote happy path: hub configured → /generate returns 200 + non-empty tunnel-back script', async () => {
  const f = fixture({ withHub: true });
  try {
    const res = await post(f.port, '/api/provision/generate', { spec: remoteSpec() });
    assert.equal(res.status, 200, 'remote generate must not 400 when the hub is configured');
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.ok(typeof j.script === 'string' && j.script.trim().length > 0, 'script is non-empty');
    assert.ok(j.script.includes('rmik-wg'), 'remote baseline embeds the tunnel-back');
    assert.ok(j.script.includes('/system identity set name=branch-gw'), 'baseline is complete (identity)');
    assert.ok(j.script.includes('address=192.168.88.1/24'), 'baseline is complete (LAN)');
    assert.ok(j.peer && typeof j.peer.tunnelIp === 'string', 'a peer was allocated');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// The root-cause fix: Review/coherence must catch the missing hub as a PREREQUISITE
// (not "incoherent"), so it never says OK then 400s at Apply.
test('remote + NO hub: /validate reports a precondition (ok:false), spec errors empty', async () => {
  const f = fixture({ withHub: false });
  try {
    const res = await post(f.port, '/api/provision/validate', { spec: remoteSpec() });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, false, 'not OK — a prerequisite is missing');
    assert.deepEqual(j.errors, [], 'the spec itself is coherent (no spec errors)');
    assert.ok(Array.isArray(j.preconditions) && j.preconditions.length >= 1, 'a precondition is reported');
    assert.match(j.preconditions.join(' '), /Remote Access/i, 'the precondition is actionable (points at Remote Access)');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// Belt-and-suspenders: an API caller that skips /validate still gets a clear,
// surfaceable reason in the body (errors[]), never a bare 400.
test('remote + NO hub: /generate 400 carries the reason in errors[] (surfaceable, not bare)', async () => {
  const f = fixture({ withHub: false });
  try {
    const res = await post(f.port, '/api/provision/generate', { spec: remoteSpec() });
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.ok(Array.isArray(j.errors) && j.errors.length >= 1 && /hub/i.test(j.errors[0]), 'body carries a hub reason');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// The breakage is remote-only: a local spec needs no hub and generates clean.
test('local spec: /generate returns 200 + script with NO hub configured (remote-only breakage)', async () => {
  const f = fixture({ withHub: false });
  try {
    const res = await post(f.port, '/api/provision/generate', { spec: remoteSpec({ remote: false }) });
    assert.equal(res.status, 200, 'local generate needs no hub');
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.ok(j.script.includes('/system identity set name=branch-gw'));
    assert.ok(!j.script.includes('rmik-wg'), 'a local baseline carries no tunnel');
    assert.equal(j.peer, undefined, 'no peer allocated for a local baseline');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// Validate a local spec also reports no preconditions (the new field is well-formed).
test('local spec: /validate ok:true with an empty preconditions list', async () => {
  const f = fixture({ withHub: false });
  try {
    const res = await post(f.port, '/api/provision/validate', { spec: remoteSpec({ remote: false }) });
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.deepEqual(j.preconditions, []);
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});
