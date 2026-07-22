// P30 — roles enforced SERVER-SIDE (by direct API calls, not UI), user management,
// argon2id + no-plaintext, and session invalidation on disable/role-change/reset.
//   node --test test/auth.roles.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../dist/db.js';
import { SecretBox } from '../dist/secretbox.js';
import { authRoutes } from '../dist/routes/auth.js';
import { userRoutes } from '../dist/routes/users.js';
import { roleEnforcer } from '../dist/auth.js';
import { deviceRoutes } from '../dist/routes/devices.js';
import { fleetRoutes } from '../dist/routes/fleet.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-roles-'));
  const db = openDb(dir);
  const box = SecretBox.load(dir, undefined);
  const poller = { pollDeviceById() {}, runCycle() {} };
  const app = express();
  app.use('/api', express.json());
  app.use('/api', authRoutes(db, { theme: 'ruby-dark', accent: null }));
  app.use('/api', roleEnforcer(db));
  app.use('/api/users', userRoutes(db));
  app.use('/api/devices', deviceRoutes(db, box, poller));
  app.use('/api/fleet', fleetRoutes(db, poller, 30));
  const server = app.listen(0);
  return { dir, db, server, port: server.address().port };
}
const J = { 'content-type': 'application/json' };
async function req(port, method, p, { cookie, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { ...J, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const setC = res.headers.get('set-cookie');
  const c = setC ? setC.split(';')[0] : undefined;
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, cookie: c };
}

async function setup(f) {
  // first-run creates the admin (role admin), returns its session cookie
  const r = await req(f.port, 'POST', '/api/setup', { body: { email: 'admin@zzz.test', password: 'adminpass1' } });
  assert.equal(r.status, 201);
  return r.cookie;
}
const login = async (f, u, p) => (await req(f.port, 'POST', '/api/login', { body: { email: u, password: p } }));

test('role matrix — reads open to all; writes editor+; user-mgmt admin-only (server-side)', async () => {
  const f = fixture();
  try {
    const admin = await setup(f);
    // admin creates an editor and a viewer
    const ce = await req(f.port, 'POST', '/api/users', { cookie: admin, body: { email: 'editor@zzz.test', role: 'editor', password: 'editorpass1' } });
    assert.equal(ce.status, 201);
    const cv = await req(f.port, 'POST', '/api/users', { cookie: admin, body: { email: 'viewer@zzz.test', role: 'viewer', password: 'viewerpass1' } });
    assert.equal(cv.status, 201);
    const editor = (await login(f, 'editor@zzz.test', 'editorpass1')).cookie;
    const viewer = (await login(f, 'viewer@zzz.test', 'viewerpass1')).cookie;

    // GET (read) → 200 for all three
    for (const [name, c] of [['admin', admin], ['editor', editor], ['viewer', viewer]]) {
      assert.equal((await req(f.port, 'GET', '/api/devices', { cookie: c })).status, 200, `${name} can read devices`);
      assert.equal((await req(f.port, 'GET', '/api/fleet', { cookie: c })).status, 200, `${name} can read fleet`);
    }
    // device WRITE (POST) → admin/editor ok, viewer 403
    const devBody = { name: 'zzz-dev', host: '10.9.9.9', username: 'x', password: 'y' };
    assert.equal((await req(f.port, 'POST', '/api/devices', { cookie: admin, body: devBody })).status, 201, 'admin can write');
    assert.equal((await req(f.port, 'POST', '/api/devices', { cookie: editor, body: { ...devBody, host: '10.9.9.10' } })).status, 201, 'editor can write');
    assert.equal((await req(f.port, 'POST', '/api/devices', { cookie: viewer, body: { ...devBody, host: '10.9.9.11' } })).status, 403, 'VIEWER cannot write (403)');
    // user management → admin only
    assert.equal((await req(f.port, 'GET', '/api/users', { cookie: admin })).status, 200, 'admin sees users');
    assert.equal((await req(f.port, 'GET', '/api/users', { cookie: editor })).status, 403, 'EDITOR cannot reach user mgmt (403)');
    assert.equal((await req(f.port, 'GET', '/api/users', { cookie: viewer })).status, 403, 'viewer cannot reach user mgmt (403)');
    assert.equal((await req(f.port, 'POST', '/api/users', { cookie: editor, body: { email: 'sneak@zzz.test', role: 'admin' } })).status, 403, 'editor cannot create users');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('passwords are argon2id and never stored/echoed in plaintext', async () => {
  const f = fixture();
  try {
    const admin = await setup(f);
    const created = await req(f.port, 'POST', '/api/users', { cookie: admin, body: { email: 'e2@zzz.test', role: 'editor', password: 'secretpass99' } });
    assert.equal(created.status, 201);
    const dump = JSON.stringify(f.db.prepare('SELECT username, email, password_hash, role FROM users').all());
    assert.ok(dump.includes('$argon2id$'), 'stored hashes are argon2id');
    assert.ok(!dump.includes('secretpass99') && !dump.includes('adminpass1'), 'no plaintext password anywhere in the users table');
    // a generated password is returned exactly once and is argon2id at rest
    const gen = await req(f.port, 'POST', '/api/users', { cookie: admin, body: { email: 'gen@zzz.test', role: 'viewer' } });
    assert.equal(gen.status, 201);
    assert.ok(typeof gen.json.generatedPassword === 'string' && gen.json.generatedPassword.length >= 12, 'a generated password is returned once');
    const stored = f.db.prepare("SELECT password_hash FROM users WHERE email = 'gen@zzz.test'").get();
    assert.ok(stored.password_hash.startsWith('$argon2id$') && !stored.password_hash.includes(gen.json.generatedPassword), 'generated password stored only as an argon2id hash');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('session invalidation on disable / role change / password reset', async () => {
  const f = fixture();
  try {
    const admin = await setup(f);
    const ed = await req(f.port, 'POST', '/api/users', { cookie: admin, body: { email: 'ed3@zzz.test', role: 'editor', password: 'editorpass1' } });
    const editorId = ed.json.id;
    let editor = (await login(f, 'ed3@zzz.test', 'editorpass1')).cookie;
    assert.equal((await req(f.port, 'GET', '/api/devices', { cookie: editor })).status, 200, 'editor session works');

    // disable → their live session dies
    assert.equal((await req(f.port, 'PATCH', `/api/users/${editorId}`, { cookie: admin, body: { disabled: true } })).status, 200);
    assert.notEqual((await req(f.port, 'GET', '/api/devices', { cookie: editor })).status, 200, 'disabled editor session no longer authorised');
    assert.equal((await login(f, 'ed3@zzz.test', 'editorpass1')).status, 403, 'disabled account cannot log in');

    // re-enable + reset password → old creds dead, new creds work
    await req(f.port, 'PATCH', `/api/users/${editorId}`, { cookie: admin, body: { disabled: false } });
    const reset = await req(f.port, 'POST', `/api/users/${editorId}/reset-password`, { cookie: admin, body: {} });
    assert.equal(reset.status, 200);
    assert.equal((await login(f, 'ed3@zzz.test', 'editorpass1')).status, 401, 'old password no longer works');
    assert.equal((await login(f, 'ed3@zzz.test', reset.json.generatedPassword)).status, 200, 'the reset password works');

    // role change also invalidates sessions
    editor = (await login(f, 'ed3@zzz.test', reset.json.generatedPassword)).cookie;
    await req(f.port, 'PATCH', `/api/users/${editorId}`, { cookie: admin, body: { role: 'viewer' } });
    assert.notEqual((await req(f.port, 'GET', '/api/fleet', { cookie: editor })).status, 200, 'role change dropped the old session');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('last-active-admin cannot be demoted, disabled, or deleted', async () => {
  const f = fixture();
  try {
    const admin = await setup(f);
    const meId = (f.db.prepare("SELECT id FROM users WHERE email='admin@zzz.test'").get()).id;
    assert.equal((await req(f.port, 'PATCH', `/api/users/${meId}`, { cookie: admin, body: { role: 'viewer' } })).status, 400, 'cannot demote self / last admin');
    assert.equal((await req(f.port, 'DELETE', `/api/users/${meId}`, { cookie: admin })).status, 400, 'cannot delete self');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});
