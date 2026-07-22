// P27 — device category override + polled-model exposure, and fleet count dedupe
// by host:port (one physical router entered twice must count once).
//   node --test test/devices.route.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../dist/db.js';
import { SecretBox } from '../dist/secretbox.js';
import { deviceRoutes } from '../dist/routes/devices.js';
import { fleetRoutes } from '../dist/routes/fleet.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-dev-'));
  const db = openDb(dir);
  const box = SecretBox.load(dir, undefined);
  const now = new Date();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)').run('admin', 'x', now.toISOString());
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run('testsid', now.toISOString(), new Date(now.getTime() + 3600_000).toISOString());
  const poller = { pollDeviceById() {}, runCycle() {} };
  const app = express();
  app.use(express.json());
  app.use('/api/devices', deviceRoutes(db, box, poller));
  app.use('/api/fleet', fleetRoutes(db, poller, 30));
  const server = app.listen(0);
  return { dir, db, server, port: server.address().port };
}
const COOKIE = 'rubymik_session=testsid';
const req = (port, method, p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
  method, headers: { Cookie: COOKIE, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

test('POST /api/devices stores a category override; GET exposes category + polled model', async () => {
  const f = fixture();
  try {
    const res = await req(f.port, 'POST', '/api/devices', { name: 'zzz-sw', host: '10.0.0.9', username: 'admin', password: 'pw', category: 'switch' });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.category, 'switch');
    assert.equal(created.model, null, 'no polled model yet');
    // simulate a poll writing the RouterOS model
    f.db.prepare('INSERT INTO device_status (device_id, state, model, updated_at) VALUES (?,?,?,?)')
      .run(created.id, 'up', 'CRS326-24G-2S+', new Date().toISOString());
    const list = await (await req(f.port, 'GET', '/api/devices')).json();
    const row = list.find((d) => d.id === created.id);
    assert.equal(row.category, 'switch', 'stored override round-trips');
    assert.equal(row.model, 'CRS326-24G-2S+', 'polled model surfaced for effective-category derivation');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('POST /api/devices rejects an invalid category with 400', async () => {
  const f = fixture();
  try {
    const res = await req(f.port, 'POST', '/api/devices', { name: 'zzz-x', host: '10.0.0.10', username: 'a', password: 'p', category: 'nope' });
    assert.equal(res.status, 400);
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('category omitted → null (auto/derive-from-model)', async () => {
  const f = fixture();
  try {
    const created = await (await req(f.port, 'POST', '/api/devices', { name: 'zzz-auto', host: '10.0.0.11', username: 'a', password: 'p' })).json();
    assert.equal(created.category, null);
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('fleet counts dedupe by host:port; a duplicate worst status wins; rows are not merged', async () => {
  const f = fixture();
  try {
    // two entries for the SAME physical router (same host:port), different names
    const a = await (await req(f.port, 'POST', '/api/devices', { name: 'zzz-a', host: '192.168.9.1', username: 'a', password: 'p' })).json();
    const b = await (await req(f.port, 'POST', '/api/devices', { name: 'zzz-b', host: '192.168.9.1', username: 'a', password: 'p' })).json();
    const ins = f.db.prepare('INSERT INTO device_status (device_id, state, updated_at) VALUES (?,?,?)');
    ins.run(a.id, 'up', new Date().toISOString());
    ins.run(b.id, 'down', new Date().toISOString());
    const devs = await (await req(f.port, 'GET', '/api/devices')).json();
    assert.equal(devs.length, 2, 'both rows still listed (never hard-blocked or merged)');
    const fleet = await (await req(f.port, 'GET', '/api/fleet')).json();
    assert.equal(fleet.summary.total, 1, 'counted once (deduped by host:port)');
    assert.equal(fleet.summary.down, 1, 'worst known status (down) wins the dedupe');
    assert.equal(fleet.summary.up, 0, 'the up copy is not also counted');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});
