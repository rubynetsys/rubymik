// HTTP boundary tests for the DNS/NTP routes — hermetic, own fixtures, no real
// device contact (401/403/400 all short-circuit before any RouterOS call).
//   node --test test/netconfig.route.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../dist/db.js';
import { SecretBox } from '../dist/secretbox.js';
import { netconfigRoutes } from '../dist/routes/netconfig.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-route-'));
  const db = openDb(dir);
  const box = SecretBox.load(dir, 'ab'.repeat(32));
  const now = new Date();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)')
    .run('admin', 'x', now.toISOString());
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)')
    .run('testsid', now.toISOString(), new Date(now.getTime() + 3600_000).toISOString());
  const ins = db.prepare(`INSERT INTO devices
    (name, host, port, transport, use_tls, verify_tls, username_enc, password_enc, write_username_enc, write_password_enc, created_at, updated_at)
    VALUES (?, ?, 80, 'rest', 0, 0, ?, ?, ?, ?, ?, ?)`);
  const monId = ins.run('Monitor Only', '10.0.0.1', box.encrypt('u'), box.encrypt('p'), null, null, now.toISOString(), now.toISOString()).lastInsertRowid;
  const mgId = ins.run('Manageable', '10.0.0.2', box.encrypt('u'), box.encrypt('p'), box.encrypt('wu'), box.encrypt('wp'), now.toISOString(), now.toISOString()).lastInsertRowid;

  const app = express();
  app.use(express.json());
  app.use('/api/devices', netconfigRoutes(db, box));
  const server = app.listen(0);
  const port = server.address().port;
  return { dir, db, server, port, monId, mgId };
}
const COOKIE = 'rubymik_session=testsid';
const put = (port, p, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('write with no session cookie → 401', async () => {
  const f = fixture();
  try {
    const res = await put(f.port, `/api/devices/${f.monId}/dns`, { servers: ['1.1.1.1'], allowRemoteRequests: false, cacheSize: 2048 });
    assert.equal(res.status, 401);
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('write to a monitor-only device → 403 (never reaches the device)', async () => {
  const f = fixture();
  try {
    const res = await put(f.port, `/api/devices/${f.monId}/dns`, { servers: ['1.1.1.1'], allowRemoteRequests: false, cacheSize: 2048 }, { Cookie: COOKIE });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /monitor-only/i);
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('manageable device + invalid DNS (hostname) → 400 validation', async () => {
  const f = fixture();
  try {
    const res = await put(f.port, `/api/devices/${f.mgId}/dns`, { servers: ['dns.google'], allowRemoteRequests: false, cacheSize: 2048 }, { Cookie: COOKIE });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /valid DNS server IP/i);
    // and the rejection was audited
    const n = f.db.prepare("SELECT COUNT(*) AS n FROM config_audit WHERE result='rejected' AND device_id=?").get(f.mgId).n;
    assert.equal(n, 1);
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('NTP enable with no servers → 400 validation', async () => {
  const f = fixture();
  try {
    const res = await put(f.port, `/api/devices/${f.mgId}/ntp`, { enabled: true, servers: [] }, { Cookie: COOKIE });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /at least one NTP server/i);
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});
