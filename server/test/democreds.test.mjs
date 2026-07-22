// P41 — the login "Try the demo" credentials card. Two guarantees:
//   1. a NORMAL (non-demo) instance never exposes it (/api/status.demoCredentials = null);
//   2. in demo mode the SHOWN credentials match the SEEDED viewer and actually log in —
//      so a future viewer-password change can't silently break the card. Both the card
//      (config.ts) and the seed (scripts/reset-demo.sh) read the SAME env, defaulting to
//      demo@rubymik.com / rubymik-demo; this test pins that shared contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../dist/db.js';
import { loadConfig } from '../dist/config.js';
import { authRoutes } from '../dist/routes/auth.js';
import { userRoutes } from '../dist/routes/users.js';
import { roleEnforcer } from '../dist/auth.js';

const DEMO_ENV = ['RUBYMIK_DEMO_MODE', 'RUBYMIK_DEMO_BANNER', 'RUBYMIK_DEMO_VIEWER_EMAIL', 'RUBYMIK_DEMO_VIEWER_PASS'];
/** Run fn with a clean, controlled demo-env, restoring the process env afterwards. */
function withEnv(overrides, fn) {
  const saved = Object.fromEntries(DEMO_ENV.map((k) => [k, process.env[k]]));
  try {
    for (const k of DEMO_ENV) delete process.env[k];
    Object.assign(process.env, overrides);
    return fn(loadConfig());
  } finally {
    for (const k of DEMO_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function fixture(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-democreds-'));
  const db = openDb(dir);
  const app = express();
  app.use('/api', express.json());
  app.use('/api', authRoutes(db, { theme: 'ruby-dark', accent: null, demoBanner: cfg.demoBanner, demoCredentials: cfg.demoCredentials }));
  app.use('/api', roleEnforcer(db));
  app.use('/api/users', userRoutes(db));
  const server = app.listen(0);
  return { dir, db, server, port: server.address().port };
}
const J = { 'content-type': 'application/json' };
async function req(port, method, p, { cookie, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...J, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setC = res.headers.get('set-cookie');
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, cookie: setC ? setC.split(';')[0] : undefined };
}
const close = (f) => { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); };

test('non-demo instance NEVER exposes demo credentials', async () => {
  withEnv({}, async (cfg) => {
    assert.equal(cfg.demoCredentials, null, 'config: no demo creds without demo mode');
    assert.equal(cfg.demoBanner, null);
    const f = fixture(cfg);
    try {
      const s = await req(f.port, 'GET', '/api/status');
      assert.equal(s.json.demoCredentials, null, 'status: demoCredentials is null');
    } finally { close(f); }
  });
});

test('demo mode: shown credentials match the seeded viewer and log in (defaults)', async () => {
  await withEnv({ RUBYMIK_DEMO_MODE: '1' }, async (cfg) => {
    // config.ts defaults MUST equal scripts/reset-demo.sh literals (the shared contract).
    assert.deepEqual(cfg.demoCredentials, { email: 'demo@rubymik.com', password: 'rubymik-demo' });
    const f = fixture(cfg);
    try {
      // Reproduce the seed EXACTLY as reset-demo.sh does: admin, then a viewer created
      // from the SAME env source (email demo@rubymik.com, RUBYMIK_DEMO_VIEWER_PASS default).
      const seedEmail = process.env.RUBYMIK_DEMO_VIEWER_EMAIL || 'demo@rubymik.com';
      const seedPass = process.env.RUBYMIK_DEMO_VIEWER_PASS || 'rubymik-demo';
      const admin = await req(f.port, 'POST', '/api/setup', { body: { email: 'admin@zzz.test', password: 'adminpass1' } });
      assert.equal(admin.status, 201);
      const mk = await req(f.port, 'POST', '/api/users', { cookie: admin.cookie, body: { email: seedEmail, role: 'viewer', password: seedPass } });
      assert.equal(mk.status, 201, 'viewer seeded');

      // What the login CARD shows:
      const shown = (await req(f.port, 'GET', '/api/status')).json.demoCredentials;
      assert.deepEqual(shown, { email: seedEmail, password: seedPass }, 'card shows the seeded viewer creds');

      // Logging in with EXACTLY what the card shows must succeed as the viewer.
      const li = await req(f.port, 'POST', '/api/login', { body: { email: shown.email, password: shown.password } });
      assert.equal(li.status, 200, 'the shown credentials actually log in');
    } finally { close(f); }
  });
});

test('demo mode: a viewer-password change flows to BOTH the card and the login (single source)', async () => {
  await withEnv({ RUBYMIK_DEMO_MODE: '1', RUBYMIK_DEMO_VIEWER_PASS: 'changed-pass-9' }, async (cfg) => {
    assert.equal(cfg.demoCredentials.password, 'changed-pass-9', 'card reflects the new env password');
    const f = fixture(cfg);
    try {
      const seedPass = process.env.RUBYMIK_DEMO_VIEWER_PASS; // the seed reads the same var
      const admin = await req(f.port, 'POST', '/api/setup', { body: { email: 'admin@zzz.test', password: 'adminpass1' } });
      await req(f.port, 'POST', '/api/users', { cookie: admin.cookie, body: { email: cfg.demoCredentials.email, role: 'viewer', password: seedPass } });
      const shown = (await req(f.port, 'GET', '/api/status')).json.demoCredentials;
      const li = await req(f.port, 'POST', '/api/login', { body: { email: shown.email, password: shown.password } });
      assert.equal(li.status, 200, 'changed password still lets the shown creds log in');
    } finally { close(f); }
  });
});
