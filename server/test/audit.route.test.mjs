// P25 Bug 1 — the audit list endpoint must serialize EVERY row shape without
// error: the safe-apply outcomes, the non-write 'ok' result (webfig.open) that
// blanked the page, and P24-era redacted PPPoE rows (password already '(set)').
//   node --test test/audit.route.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../dist/db.js';
import { auditRoutes } from '../dist/routes/dhcp.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-audit-'));
  const db = openDb(dir);
  const now = new Date();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)').run('admin', 'x', now.toISOString());
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run('testsid', now.toISOString(), new Date(now.getTime() + 3600_000).toISOString());
  const ins = db.prepare(`INSERT INTO config_audit (device_name, actor, action, target, summary, before_json, after_json, result, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const at = (m) => new Date(now.getTime() - m * 60000).toISOString();
  ins.run('R1', 'admin', 'l2.bridge.add', 'br0', 'Create bridge br0', null, '{"name":"br0"}', 'applied', 'Applied and verified.', at(1));
  ins.run('router', 'admin', 'webfig.open', 'direct', 'Opened WebFig', null, null, 'ok', null, at(2)); // the row that blanked the page
  ins.run('R1', 'admin', 'nat.create', 'dstnat', 'Add NAT rule', null, null, 'rejected', 'Blocked by guard.', at(3));
  // a P24-era redacted PPPoE row: the password is already '(set)', never plaintext
  ins.run('R1', 'admin', 'pppoe.edit', '*1', 'Edit PPPoE client "wan" (password changed — redacted)', '{"name":"wan","user":"p24test","password":"(set)"}', null, 'applied', 'Applied and verified.', at(4));

  const app = express();
  app.use(express.json());
  app.use('/api/audit', auditRoutes(db));
  const server = app.listen(0);
  return { dir, db, server, port: server.address().port };
}
const COOKIE = 'rubymik_session=testsid';
const get = (port, p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Cookie: COOKIE } });

test('GET /api/audit → 200, all row shapes serialized (incl. ok + redacted pppoe), newest-first', async () => {
  const f = fixture();
  try {
    const res = await get(f.port, '/api/audit');
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.ok(Array.isArray(rows) && rows.length === 4, 'four rows returned');
    // newest-first
    const ts = rows.map((r) => r.createdAt);
    assert.deepEqual(ts, [...ts].sort().reverse(), 'ordered newest-first');
    // the non-write 'ok' row (webfig.open) is present and well-formed
    const ok = rows.find((r) => r.result === 'ok');
    assert.ok(ok && ok.action === 'webfig.open', "the 'ok' webfig.open row is serialized (this is the one that blanked the page)");
    // every row has the expected keys + parsed before/after (or null)
    for (const r of rows) {
      for (const k of ['id', 'action', 'result', 'summary', 'createdAt', 'before', 'after']) assert.ok(k in r, `row has ${k}`);
    }
    // the redacted PPPoE row parses, and the password is the redaction marker — never plaintext
    const p = rows.find((r) => r.action === 'pppoe.edit');
    assert.equal(p.before.password, '(set)', 'PPPoE password stays redacted through serialization');
    assert.ok(!JSON.stringify(rows).includes('p24testpass'), 'no plaintext PPPoE password anywhere in the response');
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('GET /api/audit with no session → 401', async () => {
  const f = fixture();
  try {
    const res = await fetch(`http://127.0.0.1:${f.port}/api/audit`);
    assert.equal(res.status, 401);
  } finally { f.server.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});
