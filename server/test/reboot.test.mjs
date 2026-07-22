// P29.1 — the expected-outage reboot dead-man, driven directly (no real router).
//   node --test test/reboot.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../dist/db.js';
import { beginReboot, abortReboot, handleRebootFailure, handleRebootReturn, parseUptimeSec } from '../dist/reboot.js';
import { computeHealth } from '../dist/health.js';

function fx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-reboot-'));
  const db = openDb(dir);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO devices (id, name, host, username_enc, password_enc, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)')
    .run('zzz-bench', '10.0.0.1', 'enc', 'enc', now, now);
  db.prepare("INSERT INTO device_status (device_id, state, updated_at) VALUES (1, 'up', ?)").run(now);
  return { dir, db };
}
const state = (db) => db.prepare('SELECT state, reboot_expected_until AS until FROM device_status WHERE device_id = 1').get();
const lastAudit = (db) => db.prepare('SELECT action, result, detail FROM config_audit WHERE device_id = 1 ORDER BY id DESC LIMIT 1').get();
const future = () => new Date(Date.now() + 300000).toISOString();
const baseline = { serial: 'ABC', uptimeSec: 100000, at: new Date().toISOString() };

test('parseUptimeSec parses RouterOS uptime strings', () => {
  assert.equal(parseUptimeSec('5m'), 300);
  assert.equal(parseUptimeSec('1d4h36m42s'), 103002);
  assert.equal(parseUptimeSec('1w2d'), 777600);
  assert.equal(parseUptimeSec(null), null);
  assert.equal(parseUptimeSec('nonsense'), null);
});

test('computeHealth: rebooting never renders up/warning off stale metrics', () => {
  assert.equal(computeHealth({ state: 'rebooting', last_error: null, cpu_load: 99, mem_total: 100, mem_free: 1 }).status, 'rebooting');
});

test('beginReboot arms the dead-man → state rebooting', () => {
  const { dir, db } = fx();
  try {
    const until = future();
    beginReboot(db, 1, baseline, until);
    const s = state(db);
    assert.equal(s.state, 'rebooting');
    assert.equal(s.until, until);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed poll WITHIN the window is absorbed (rebooting, no down)', () => {
  const { dir, db } = fx();
  try {
    beginReboot(db, 1, baseline, future());
    const absorbed = handleRebootFailure(db, 1, Date.now());
    assert.equal(absorbed, true, 'absorbed as an expected outage — caller must NOT mark it down');
    assert.equal(state(db).state, 'rebooting');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('return with matching serial + uptime reset → verified (applied), flag cleared', () => {
  const { dir, db } = fx();
  try {
    beginReboot(db, 1, baseline, future());
    db.prepare("UPDATE device_status SET state = 'up' WHERE device_id = 1").run(); // recordSuccess did this
    handleRebootReturn(db, 1, 'ABC', '30s');
    assert.equal(state(db).until, null, 'reboot flag cleared');
    const a = lastAudit(db);
    assert.equal(a.action, 'system.reboot');
    assert.equal(a.result, 'applied');
    assert.match(a.detail, /uptime reset/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('window expires still-unreachable → not-returned (rejected), caller marks down', () => {
  const { dir, db } = fx();
  try {
    beginReboot(db, 1, baseline, new Date(Date.now() - 1000).toISOString()); // already expired
    const absorbed = handleRebootFailure(db, 1, Date.now());
    assert.equal(absorbed, false, 'not absorbed — caller proceeds to a normal down (down-alert fires)');
    assert.equal(state(db).until, null, 'flag cleared');
    const a = lastAudit(db);
    assert.equal(a.result, 'rejected');
    assert.match(a.detail, /did not come back/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('return with a DIFFERENT serial is flagged (rejected — possible hardware swap)', () => {
  const { dir, db } = fx();
  try {
    beginReboot(db, 1, baseline, future());
    db.prepare("UPDATE device_status SET state = 'up' WHERE device_id = 1").run();
    handleRebootReturn(db, 1, 'XYZ', '30s');
    const a = lastAudit(db);
    assert.equal(a.result, 'rejected');
    assert.match(a.detail, /DIFFERENT serial/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('poll WITHIN window but uptime not reset → keep waiting (flag stays, no verdict)', () => {
  const { dir, db } = fx();
  try {
    beginReboot(db, 1, baseline, future());
    db.prepare("UPDATE device_status SET state = 'up' WHERE device_id = 1").run(); // a poll landed before it dropped
    handleRebootReturn(db, 1, 'ABC', '2w'); // uptime NOT reset (2w >> baseline 100000s)
    assert.notEqual(state(db).until, null, 'dead-man stays armed — the box has not actually rebooted yet');
    assert.equal(lastAudit(db), undefined, 'no premature return verdict — this is the race the nudge-removal + reset-check guards against');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('window expired with uptime never reset → rejected (reboot may not have taken)', () => {
  const { dir, db } = fx();
  try {
    beginReboot(db, 1, baseline, new Date(Date.now() - 1000).toISOString()); // expired
    db.prepare("UPDATE device_status SET state = 'up' WHERE device_id = 1").run();
    handleRebootReturn(db, 1, 'ABC', '2w');
    assert.equal(state(db).until, null, 'flag cleared at expiry');
    const a = lastAudit(db);
    assert.equal(a.result, 'rejected');
    assert.match(a.detail, /never rebooted/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('abortReboot disarms and restores up', () => {
  const { dir, db } = fx();
  try {
    beginReboot(db, 1, baseline, future());
    abortReboot(db, 1);
    const s = state(db);
    assert.equal(s.until, null);
    assert.equal(s.state, 'up');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
