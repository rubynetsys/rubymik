// Remote-access peers: reservation dedup, delete guard, and the pending-setup
// selector (v1.1.8). Root cause: every remote /generate reserved a NEW peer, so
// re-running the wizard orphaned overlay IPs. Plus delete rules + the one pending
// source both feeds read (never counted in fleet health).
//   node --test test/remoteaccess.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../dist/db.js';
import { reservePeer, selectPending, isDeleteDangerous } from '../dist/remoteaccess.js';
import { remoteAccessRoutes } from '../dist/routes/remoteaccess.js';

const HUB = { endpoint: 'vpn.example.com', listenPort: 51820, overlayCidr: '10.9.0.0/24', hubAddress: '10.9.0.1', publicKey: 'HUBPUB=' };
const VALID_KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq=';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-ra-'));
  const db = openDb(dir);
  return { db, dir, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ---- ROOT CAUSE: reservePeer reuses an awaiting-key reservation for the same site ----
test('reservePeer: re-running the wizard for the same site name creates ONE peer, not duplicates', () => {
  const { db, cleanup } = tmpDb();
  try {
    const a = reservePeer(db, HUB, 'cpt-branch');
    const b = reservePeer(db, HUB, 'cpt-branch'); // "re-run the wizard"
    assert.equal(a.id, b.id, 'same reservation reused');
    assert.equal(a.tunnel_ip, b.tunnel_ip, 'same overlay IP — not orphaned');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM wg_peers').get().n, 1, 'exactly one peer row');
    // a genuinely different site DOES get its own peer + IP
    const c = reservePeer(db, HUB, 'jhb-branch');
    assert.notEqual(c.id, a.id);
    assert.notEqual(c.tunnel_ip, a.tunnel_ip);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM wg_peers').get().n, 2);
  } finally { cleanup(); }
});

test('reservePeer: a REGISTERED site with the same name is not reused (that reservation is in use)', () => {
  const { db, cleanup } = tmpDb();
  try {
    const a = reservePeer(db, HUB, 'cpt-branch');
    db.prepare('UPDATE wg_peers SET public_key = ? WHERE id = ?').run(VALID_KEY, a.id); // registered
    const b = reservePeer(db, HUB, 'cpt-branch');
    assert.notEqual(a.id, b.id, 'a new reservation, since the old one is registered');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM wg_peers').get().n, 2);
  } finally { cleanup(); }
});

// ---- pending selector (pure) — the ONE source; never a fleet device ----
test('selectPending: only peers without a device; categorised by key', () => {
  const peers = [
    { id: 1, label: 'awaiting', tunnel_ip: '10.9.0.2', public_key: null, device_id: null },
    { id: 2, label: 'keyed', tunnel_ip: '10.9.0.3', public_key: VALID_KEY, device_id: null },
    { id: 3, label: 'adopted', tunnel_ip: '10.9.0.4', public_key: VALID_KEY, device_id: 42 },
  ];
  const p = selectPending(peers);
  assert.deepEqual(p.map((x) => x.id), [1, 2], 'the adopted peer (a real device) is EXCLUDED');
  assert.equal(p.find((x) => x.id === 1).kind, 'awaiting-key');
  assert.equal(p.find((x) => x.id === 2).kind, 'awaiting-adoption');
  assert.ok(p.every((x) => x.tunnelIp && typeof x.hasKey === 'boolean'));
});

// ---- delete guard (pure) — free vs typed-confirm ----
test('isDeleteDangerous: awaiting-key deletes freely; live/adopted registered needs confirm', () => {
  assert.equal(isDeleteDangerous({ public_key: null, device_id: null }, false), false, 'awaiting-key → free');
  assert.equal(isDeleteDangerous({ public_key: VALID_KEY, device_id: null }, false), false, 'registered, no handshake, no device → free');
  assert.equal(isDeleteDangerous({ public_key: VALID_KEY, device_id: null }, true), true, 'registered + live handshake → confirm');
  assert.equal(isDeleteDangerous({ public_key: VALID_KEY, device_id: 7 }, false), true, 'registered + adopted device → confirm (never strand it)');
});

// ---- route-level: DELETE rules + /pending excluded from fleet devices ----
function routeFixture(livePeers = []) {
  const { db, dir, cleanup } = tmpDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)').run('admin', 'x', now);
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run('testsid', now, new Date(Date.now() + 3600_000).toISOString());
  const box = { encrypt: (s) => `enc:${s}`, decrypt: (s) => String(s).replace(/^enc:/, '') };
  const hub = { status: async () => ({ peers: livePeers }), syncPeers: async () => {} };
  const app = express();
  app.use(express.json());
  app.use('/api/remote-access', remoteAccessRoutes(db, box, hub));
  const server = app.listen(0);
  return { db, server, port: server.address().port, cleanup: () => { server.close(); cleanup(); } };
}
const COOKIE = 'rubymik_session=testsid';
const call = (port, method, p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
  method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE }, body: body ? JSON.stringify(body) : undefined,
});

test('DELETE: an awaiting-key site deletes freely and frees the overlay IP', async () => {
  const f = routeFixture();
  try {
    const a = reservePeer(f.db, HUB, 'cpt'); // 10.9.0.2
    const res = await call(f.port, 'DELETE', `/api/remote-access/sites/${a.id}`);
    assert.equal(res.status, 200);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM wg_peers').get().n, 0, 'peer gone');
    // the freed IP is reused, not skipped
    const b = reservePeer(f.db, HUB, 'cpt2');
    assert.equal(b.tunnel_ip, '10.9.0.2', 'overlay IP freed for reuse');
  } finally { f.cleanup(); }
});

test('DELETE: a live registered site needs the typed-name confirm (409 without, 200 with)', async () => {
  const peer = { public_key: VALID_KEY, state: 'recent' };
  const f = routeFixture([{ publicKey: VALID_KEY, state: 'recent' }]);
  try {
    const a = reservePeer(f.db, HUB, 'live-branch');
    f.db.prepare('UPDATE wg_peers SET public_key = ? WHERE id = ?').run(VALID_KEY, a.id); // registered + live (in livePeers)
    const bad = await call(f.port, 'DELETE', `/api/remote-access/sites/${a.id}`, { confirmName: 'wrong' });
    assert.equal(bad.status, 409, 'refused without the exact name');
    assert.ok((await bad.json()).requiresConfirm);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM wg_peers').get().n, 1, 'still there');
    const ok = await call(f.port, 'DELETE', `/api/remote-access/sites/${a.id}`, { confirmName: 'live-branch' });
    assert.equal(ok.status, 200, 'deletes with the typed name');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM wg_peers').get().n, 0);
  } finally { f.cleanup(); }
});

test('GET /pending: returns provisioned-not-adopted peers; an adopted peer (a fleet device) is excluded', async () => {
  const f = routeFixture();
  try {
    const a = reservePeer(f.db, HUB, 'pending-one');               // awaiting key → pending
    const b = reservePeer(f.db, HUB, 'adopted-one');
    // adopt b through the real path → creates a device row + sets device_id
    const adopt = await call(f.port, 'POST', `/api/remote-access/sites/${b.id}/device`, { name: 'adopted-dev', username: 'monitor', password: 'x' });
    assert.equal(adopt.status, 201, 'adoption creates a managed device');
    const res = await call(f.port, 'GET', '/api/remote-access/pending');
    const { items } = await res.json();
    assert.equal(items.length, 1, 'only the un-adopted peer is pending');
    assert.equal(items[0].id, a.id);
    assert.equal(items[0].kind, 'awaiting-key');
    assert.ok(!items.some((x) => x.id === b.id), 'the adopted peer (now a fleet device) is NOT in the pending feed');
    // and the adopted one IS a real device (would be in fleet counts), the pending one is NOT
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM devices').get().n, 1, 'exactly one fleet device; the pending peer is not counted');
  } finally { f.cleanup(); }
});
