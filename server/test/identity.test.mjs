// P40 — email as identity + forgot-password. Migration (email column on a pre-P40
// fixture), login-by-email, the one-time legacy claim, user create by email, and the
// enumeration-safe / single-use / expiring reset-token flow.
//   node --test test/identity.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { openDb, applyMigrations, ensureBootstrap, TARGET_SCHEMA } from '../dist/db.js';
import { SecretBox } from '../dist/secretbox.js';
import { normalizeEmail, findLoginUser } from '../dist/auth.js';
import { createResetToken, findValidReset, hashToken } from '../dist/passwordreset.js';
import { authRoutes } from '../dist/routes/auth.js';
import { roleEnforcer } from '../dist/auth.js';
import { userRoutes } from '../dist/routes/users.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-id-'));
const cleanup = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };

test('normalizeEmail — trims, lowercases, validates', () => {
  assert.equal(normalizeEmail('  Ray@Rubynet.CO.za '), 'ray@rubynet.co.za');
  assert.equal(normalizeEmail('nope'), null);
  assert.equal(normalizeEmail('a@b'), null);
  assert.equal(normalizeEmail('a b@c.d'), null);
  assert.equal(normalizeEmail(42), null);
});

test('migration — a pre-P40 (schema 20) DB with a username-only admin migrates to email identity', () => {
  const dir = tmp();
  try {
    // Build the old fixture: bootstrap + migrate only up to schema 20 (before email),
    // insert an admin with a username and NO email column yet.
    const raw = new DatabaseSync(path.join(dir, 'rubymik.db'));
    raw.exec('PRAGMA foreign_keys = ON');
    ensureBootstrap(raw);
    applyMigrations(raw, 20);
    assert.equal(raw.prepare("SELECT COUNT(*) c FROM pragma_table_info('users') WHERE name='email'").get().c, 0, 'no email column at schema 20');
    raw.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES ('admin', 'h', 'admin', '2020-01-01')").run();
    raw.close();

    // Boot the full app path → migrates to TARGET (22), email column added, admin email NULL.
    const db = openDb(dir, { appVersion: '0.9.1' });
    assert.equal((db.prepare('SELECT COALESCE(MAX(version),0) v FROM schema_migrations').get()).v, TARGET_SCHEMA);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM pragma_table_info('users') WHERE name='email'").get().c, 1, 'email column now exists');
    const admin = db.prepare("SELECT username, email FROM users WHERE username='admin'").get();
    assert.equal(admin.email, null, 'existing admin has no email yet (claims on next login)');
    // findLoginUser resolves the un-claimed admin by its legacy username
    assert.ok(findLoginUser(db, 'admin'), 'legacy username still resolves for the claim login');
    assert.equal(findLoginUser(db, 'admin').email, null);
    db.close();
  } finally { cleanup(dir); }
});

test('reset tokens — single-use, expiring, hashed at rest', () => {
  const dir = tmp();
  try {
    const db = openDb(dir, { appVersion: '0.9.1' });
    db.prepare("INSERT INTO users (username, email, password_hash, role, created_at) VALUES ('u@t.test','u@t.test','h','admin','2020')").run();
    const uid = db.prepare("SELECT id FROM users WHERE email='u@t.test'").get().id;
    const raw = createResetToken(db, uid);
    // stored only as a hash
    const row = db.prepare('SELECT token_hash FROM password_reset_tokens WHERE user_id = ?').get(uid);
    assert.equal(row.token_hash, hashToken(raw));
    assert.notEqual(row.token_hash, raw);
    // valid now
    assert.equal(findValidReset(db, raw).userId, uid);
    // expired → null
    assert.equal(findValidReset(db, raw, Date.now() + 31 * 60_000), null, 'expired after 30 min');
    // wrong token → null
    assert.equal(findValidReset(db, 'garbage'), null);
    db.close();
  } finally { cleanup(dir); }
});

// ---------------- integration ----------------

function fixture({ smtp = false } = {}) {
  const dir = tmp();
  const db = openDb(dir, { appVersion: '0.9.1' });
  const box = SecretBox.load(dir, undefined);
  const notifier = { ready: smtp, sent: [], smtpReady() { return this.ready; }, smtpFrom() { return 'noreply@test'; }, async sendMailTo(to, s, t) { this.sent.push({ to, s, t }); } };
  const app = express();
  app.use('/api', express.json());
  app.use('/api', authRoutes(db, { theme: 'ruby-dark', accent: null }, notifier, 'http://test.local'));
  app.use('/api', roleEnforcer(db));
  app.use('/api/users', userRoutes(db));
  const server = app.listen(0);
  return { dir, db, notifier, server, port: server.address().port };
}
const J = { 'content-type': 'application/json' };
async function req(port, method, p, { cookie, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...J, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setC = res.headers.get('set-cookie');
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, cookie: setC ? setC.split(';')[0] : undefined };
}
const close = (f) => { f.server.close(); f.db.close(); cleanup(f.dir); };

test('setup + login by email; /me carries email; no email claim needed for new accounts', async () => {
  const f = fixture();
  try {
    assert.equal((await req(f.port, 'POST', '/api/setup', { body: { email: 'Admin@T.test', password: 'adminpass1' } })).status, 201);
    // stored lowercased
    assert.equal(f.db.prepare('SELECT email FROM users').get().email, 'admin@t.test');
    const login = await req(f.port, 'POST', '/api/login', { body: { email: 'admin@t.test', password: 'adminpass1' } });
    assert.equal(login.status, 200);
    assert.equal(login.json.needsEmailClaim, false);
    const me = await req(f.port, 'GET', '/api/me', { cookie: login.cookie });
    assert.equal(me.json.email, 'admin@t.test');
  } finally { close(f); }
});

test('legacy account claims an email on first login; then logs in by email', async () => {
  const g = fixture();
  try {
    const { hashPassword } = await import('../dist/auth.js');
    g.db.prepare("INSERT INTO users (username, email, password_hash, role, created_at) VALUES ('legacy', NULL, ?, 'admin', '2020')")
      .run(await hashPassword('legacypass1'));
    // logs in by the legacy username, flagged to claim
    const login = await req(g.port, 'POST', '/api/login', { body: { email: 'legacy', password: 'legacypass1' } });
    assert.equal(login.status, 200);
    assert.equal(login.json.needsEmailClaim, true, 'must claim an email');
    // claim
    const claim = await req(g.port, 'POST', '/api/me/claim-email', { cookie: login.cookie, body: { email: 'Legacy@T.test' } });
    assert.equal(claim.status, 200);
    const row = g.db.prepare("SELECT email, username FROM users WHERE id=1").get();
    assert.equal(row.email, 'legacy@t.test');
    assert.equal(row.username, 'legacy@t.test', 'username mirrors the claimed email');
    // now logs in by the new email, no longer needs a claim
    const relogin = await req(g.port, 'POST', '/api/login', { body: { email: 'legacy@t.test', password: 'legacypass1' } });
    assert.equal(relogin.json.needsEmailClaim, false);
  } finally { close(g); }
});

test('user create by email; duplicate email → 409; audit references email', async () => {
  const f = fixture();
  try {
    const admin = (await req(f.port, 'POST', '/api/setup', { body: { email: 'admin@t.test', password: 'adminpass1' } })).cookie;
    const c = await req(f.port, 'POST', '/api/users', { cookie: admin, body: { email: 'Editor@T.test', role: 'editor' } });
    assert.equal(c.status, 201);
    assert.equal(c.json.email, 'editor@t.test');
    assert.ok(c.json.generatedPassword.length >= 12);
    const dup = await req(f.port, 'POST', '/api/users', { cookie: admin, body: { email: 'editor@t.test', role: 'viewer' } });
    assert.equal(dup.status, 409);
    const audit = f.db.prepare("SELECT actor, detail FROM config_audit WHERE action='user.create' ORDER BY id DESC LIMIT 1").get();
    assert.equal(audit.actor, 'admin@t.test', 'audit actor is the admin email');
    assert.match(audit.detail, /editor@t\.test/);
  } finally { close(f); }
});

test('forgot-password — enumeration-safe, SMTP-gated; token flow single-use', async () => {
  // no SMTP configured → smtpConfigured=false, identical for existing vs non-existent
  const noSmtp = fixture({ smtp: false });
  try {
    await req(noSmtp.port, 'POST', '/api/setup', { body: { email: 'admin@t.test', password: 'adminpass1' } });
    const a = await req(noSmtp.port, 'POST', '/api/forgot-password', { body: { email: 'admin@t.test' } });
    const b = await req(noSmtp.port, 'POST', '/api/forgot-password', { body: { email: 'ghost@t.test' } });
    assert.deepEqual(a.json, b.json, 'identical response — no user enumeration');
    assert.equal(a.json.smtpConfigured, false);
    assert.equal(noSmtp.notifier.sent.length, 0, 'no email without SMTP');
  } finally { close(noSmtp); }

  // SMTP configured → real account gets a token + email; non-existent gets neither, same response
  const f = fixture({ smtp: true });
  try {
    const admin = (await req(f.port, 'POST', '/api/setup', { body: { email: 'admin@t.test', password: 'adminpass1' } })).cookie;
    const good = await req(f.port, 'POST', '/api/forgot-password', { body: { email: 'admin@t.test' } });
    const bad = await req(f.port, 'POST', '/api/forgot-password', { body: { email: 'ghost@t.test' } });
    assert.deepEqual(good.json, bad.json, 'identical response');
    assert.equal(good.json.smtpConfigured, true);
    assert.equal(f.notifier.sent.length, 1, 'exactly one email — only for the real account');
    assert.match(f.notifier.sent[0].t, /http:\/\/test\.local\/reset-password\?token=/);
    // extract token, complete the reset
    const raw = f.notifier.sent[0].t.match(/token=([^\s]+)/)[1];
    // seed a session to prove it gets invalidated
    const login = await req(f.port, 'POST', '/api/login', { body: { email: 'admin@t.test', password: 'adminpass1' } });
    assert.equal((await req(f.port, 'GET', '/api/me', { cookie: login.cookie })).status, 200);
    const reset = await req(f.port, 'POST', '/api/reset-password', { body: { token: raw, password: 'brandnew123' } });
    assert.equal(reset.status, 200);
    assert.equal((await req(f.port, 'GET', '/api/me', { cookie: login.cookie })).status, 401, 'sessions invalidated');
    assert.equal((await req(f.port, 'POST', '/api/login', { body: { email: 'admin@t.test', password: 'brandnew123' } })).status, 200, 'new password works');
    // token is single-use
    assert.equal((await req(f.port, 'POST', '/api/reset-password', { body: { token: raw, password: 'again12345' } })).status, 400, 'token cannot be reused');
    // audited
    assert.ok(f.db.prepare("SELECT COUNT(*) c FROM config_audit WHERE action='auth.password_reset.complete'").get().c >= 1);
  } finally { close(f); }
});
