// P39 — go-live security hardening: the login limiter/lockout, the CSP + headers,
// the 401 (unauthenticated) sweep, the 429 lockout + audit, and the Secure-cookie-
// behind-a-proxy behaviour. (The role 403 matrix lives in auth.roles.test.mjs.)
//   node --test test/security.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../dist/db.js';
import { SecretBox } from '../dist/secretbox.js';
import { authRoutes } from '../dist/routes/auth.js';
import { roleEnforcer } from '../dist/auth.js';
import { deviceRoutes } from '../dist/routes/devices.js';
import { LoginLimiter, buildCsp, inlineScriptHashes, securityHeaders } from '../dist/security.js';

// ---------------- unit: LoginLimiter ----------------

test('LoginLimiter — locks after N fails, reports retry, unlocks after the window, clears on success', () => {
  const L = new LoginLimiter(3, 60_000, 60_000); // 3 fails, 1 min window, 1 min lock
  const t0 = 1_000_000;
  assert.equal(L.check('1.1.1.1', 'bob', t0).locked, false);
  assert.equal(L.fail('1.1.1.1', 'bob', t0).locked, false);
  assert.equal(L.fail('1.1.1.1', 'bob', t0).locked, false);
  const third = L.fail('1.1.1.1', 'bob', t0);
  assert.equal(third.locked, true, '3rd failure locks');
  assert.equal(third.justLocked, true, 'transition reported once');
  assert.ok(third.retryAfterSec > 0 && third.retryAfterSec <= 60);
  assert.equal(L.fail('1.1.1.1', 'bob', t0).justLocked, false, 'no second justLocked while already locked');
  // a DIFFERENT account from the same IP is unaffected (key is ip+username)
  assert.equal(L.check('1.1.1.1', 'alice', t0).locked, false);
  // after the lock expires, it's open again
  assert.equal(L.check('1.1.1.1', 'bob', t0 + 61_000).locked, false, 'unlocks after lockMs');
  // success clears any partial count
  L.fail('2.2.2.2', 'carol', t0); L.succeed('2.2.2.2', 'carol');
  assert.equal(L.check('2.2.2.2', 'carol', t0).locked, false);
});

// ---------------- unit: CSP ----------------

test('buildCsp — strict script-src (no unsafe-inline), inline hash included, webfig frame allowed', () => {
  const csp = buildCsp({ scriptHashes: ["'sha256-abc123'"], webfigPort: 8081 });
  assert.match(csp, /script-src 'self' 'sha256-abc123'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, "script-src must NOT allow unsafe-inline");
  assert.match(csp, /frame-src 'self' http:\/\/\*:8081 https:\/\/\*:8081/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  // webfig disabled → frame-src collapses to self
  assert.match(buildCsp({ scriptHashes: [], webfigPort: 0 }), /frame-src 'self';/);
});

test('inlineScriptHashes — hashes inline <script> but not external ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-csp-'));
  const p = path.join(dir, 'index.html');
  fs.writeFileSync(p, '<script>console.log(1)</script><script src="/a.js"></script>');
  try {
    const h = inlineScriptHashes(p);
    assert.equal(h.length, 1, 'one inline script hashed, the external one skipped');
    assert.match(h[0], /^'sha256-[A-Za-z0-9+/=]+'$/);
    assert.deepEqual(inlineScriptHashes(path.join(dir, 'missing.html')), [], 'missing file → no hashes, no throw');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------- integration ----------------

function fixture({ trustProxy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-sec-'));
  const db = openDb(dir);
  const box = SecretBox.load(dir, undefined);
  const poller = { pollDeviceById() {}, runCycle() {} };
  const app = express();
  if (trustProxy) app.set('trust proxy', true);
  app.use(securityHeaders({ scriptHashes: [], webfigPort: 8081 }));
  app.use('/api', express.json());
  app.use('/api', authRoutes(db, { theme: 'ruby-dark', accent: null }));
  app.use('/api', roleEnforcer(db));
  app.use('/api/devices', deviceRoutes(db, box, poller));
  const server = app.listen(0);
  return { dir, db, server, port: server.address().port };
}
const J = { 'content-type': 'application/json' };
async function req(port, method, p, { cookie, body, headers } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...J, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie'), csp: res.headers.get('content-security-policy'), retryAfter: res.headers.get('retry-after') };
}

test('security headers present on responses', async () => {
  const f = fixture();
  try {
    const r = await req(f.port, 'GET', '/api/status');
    assert.match(r.csp || '', /default-src 'self'/);
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('401 sweep — protected endpoints refuse the unauthenticated', async () => {
  const f = fixture();
  try {
    for (const [m, p] of [['GET', '/api/devices'], ['POST', '/api/devices'], ['GET', '/api/devices/1/detail']]) {
      const opts = m === 'GET' ? {} : { body: {} };
      assert.equal((await req(f.port, m, p, opts)).status, 401, `${m} ${p} → 401 without a session`);
    }
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('lockout — 5 bad logins → 429, audited; a good password is then refused; other account still works', async () => {
  const f = fixture();
  try {
    await req(f.port, 'POST', '/api/setup', { body: { email: 'admin@zzz.test', password: 'adminpass1' } });
    await req(f.port, 'POST', '/api/setup', { body: {} }); // no-op (already set up)
    // 5 wrong attempts
    for (let i = 0; i < 5; i++) {
      const r = await req(f.port, 'POST', '/api/login', { body: { email: 'admin@zzz.test', password: 'wrong' } });
      assert.equal(r.status, 401, `attempt ${i + 1} is 401`);
    }
    // now locked — even the CORRECT password is refused with 429 + Retry-After
    const locked = await req(f.port, 'POST', '/api/login', { body: { email: 'admin@zzz.test', password: 'adminpass1' } });
    assert.equal(locked.status, 429, 'locked out → 429');
    assert.ok(Number(locked.retryAfter) > 0, 'Retry-After set');
    // audited
    const audit = f.db.prepare("SELECT COUNT(*) c FROM config_audit WHERE action = 'auth.login.locked'").get().c;
    assert.ok(audit >= 1, 'lockout is audited');
    // a different account from the same IP is NOT locked (proves per-account keying)
    // (create one first via the admin? admin is locked; instead assert the limiter key isolation via a fresh username login attempt returns 401 not 429)
    const other = await req(f.port, 'POST', '/api/login', { body: { email: 'someone-else@zzz.test', password: 'nope' } });
    assert.equal(other.status, 401, 'a different username is not swept into the lockout');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('Secure cookie — omitted on plain HTTP, added behind an HTTPS proxy', async () => {
  // plain HTTP (no trust proxy) → no Secure
  let f = fixture({ trustProxy: false });
  try {
    const r = await req(f.port, 'POST', '/api/setup', { body: { email: 'a@zzz.test', password: 'adminpass1' } });
    assert.ok(/HttpOnly/i.test(r.setCookie) && /SameSite=Lax/i.test(r.setCookie), 'HttpOnly + SameSite always');
    assert.ok(!/;\s*Secure/i.test(r.setCookie), 'no Secure on plain HTTP');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
  // behind a trusted proxy presenting X-Forwarded-Proto: https → Secure
  f = fixture({ trustProxy: true });
  try {
    const r = await req(f.port, 'POST', '/api/setup', { body: { email: 'b@zzz.test', password: 'adminpass1' }, headers: { 'X-Forwarded-Proto': 'https' } });
    assert.ok(/;\s*Secure/i.test(r.setCookie), 'Secure added when the request arrived over HTTPS');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});
