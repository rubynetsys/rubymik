// P21 snapshot storage tests: AES-GCM roundtrip, sha256 dedup vs most-recent,
// retention (keep 100/router) with protected pre/post pairs of the 10 most recent
// write operations, and no-orphan pruning of a referenced duplicate.
//   node --test test/snapshots.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../dist/db.js';
import { SecretBox } from '../dist/secretbox.js';
import { storeSnapshotText, getSnapshotContent, listSnapshots, pruneRouter } from '../dist/snapshots.js';
import { SnapshotScheduler } from '../dist/snapshotscheduler.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmik-snap-'));
  const db = openDb(dir);
  const box = SecretBox.load(dir, 'ab'.repeat(32));
  const now = new Date().toISOString();
  db.prepare('INSERT INTO devices (name, host, username_enc, password_enc, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('R', '10.0.0.1', box.encrypt('u'), box.encrypt('p'), now, now);
  const rid = db.prepare('SELECT id FROM devices WHERE name=?').get('R').id;
  return { db, box, rid, dir };
}

// raw insert with explicit captured_at + op_group, bypassing per-insert prune.
let seq = 0;
function raw(db, rid, { at, trigger = 'manual', opGroup = null, content = null, dupOf = null }) {
  seq++;
  const r = db.prepare(`INSERT INTO snapshots
    (router_id, router_name, captured_at, trigger, operation, op_group, outcome, format, size_bytes, sha256, content_encrypted, duplicate_of, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(rid, 'R', at, trigger, null, opGroup, null, 'snapshot', content ? content.length : 0, 'sha' + seq, content, dupOf, at);
  return r.lastInsertRowid;
}
const ts = (n) => `2026-07-21T${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00.000Z`;

test('AES-GCM roundtrip: stored plaintext decrypts back exactly', () => {
  const { db, box, rid } = fixture();
  const cfg = '/ip address\n  add address=10.0.0.1/24 interface=ether1\n# secret=hunter2\n';
  const m = storeSnapshotText(db, box, rid, 'R', { trigger: 'manual', text: cfg, format: 'export' });
  assert.equal(m.isDuplicate, false);
  const got = getSnapshotContent(db, box, m.id);
  assert.equal(got.text, cfg, 'decrypted content matches the original');
  // the row must NOT hold plaintext — only the gcm1: ciphertext
  const rowEnc = db.prepare('SELECT content_encrypted FROM snapshots WHERE id=?').get(m.id).content_encrypted;
  assert.ok(rowEnc.startsWith('gcm1:'), 'stored encrypted');
  assert.ok(!rowEnc.includes('hunter2'), 'no plaintext secret in the stored blob');
});

test('sha256 dedup is vs the MOST RECENT snapshot only', () => {
  const { db, box, rid } = fixture();
  const A = 'config-A\n', B = 'config-B\n';
  const a1 = storeSnapshotText(db, box, rid, 'R', { trigger: 'manual', text: A, format: 'snapshot' });
  const a2 = storeSnapshotText(db, box, rid, 'R', { trigger: 'manual', text: A, format: 'snapshot' });
  assert.equal(a2.isDuplicate, true, 'identical-to-previous → duplicate');
  // duplicate still reads back the same text (via duplicate_of pointer)
  assert.equal(getSnapshotContent(db, box, a2.id).text, A);
  // and stores no second blob
  assert.equal(db.prepare('SELECT content_encrypted FROM snapshots WHERE id=?').get(a2.id).content_encrypted, null);
  storeSnapshotText(db, box, rid, 'R', { trigger: 'manual', text: B, format: 'snapshot' });
  const a3 = storeSnapshotText(db, box, rid, 'R', { trigger: 'manual', text: A, format: 'snapshot' });
  assert.equal(a3.isDuplicate, false, 'A after B is NOT a duplicate (dedup is vs most-recent, not all-time)');
  assert.equal(getSnapshotContent(db, box, a3.id).text, A);
});

test('retention keeps the 100 most recent per router', () => {
  const { db, box, rid } = fixture();
  for (let i = 0; i < 130; i++) storeSnapshotText(db, box, rid, 'R', { trigger: 'manual', text: `cfg-${i}\n`, format: 'snapshot' });
  assert.equal(listSnapshots(db, rid).length, 100);
});

test('protected: pre/post pairs of the 10 most recent write ops survive beyond 100', () => {
  const { db, rid } = fixture();
  // 12 write operations (oldest), each a pre+post pair sharing an op_group.
  const groups = [];
  for (let i = 1; i <= 12; i++) {
    const g = `op-${i}`;
    groups.push(g);
    raw(db, rid, { at: ts(i * 2), trigger: 'pre_write', opGroup: g, content: 'gcm1:x' });
    raw(db, rid, { at: ts(i * 2 + 1), trigger: 'post_write', opGroup: g, content: 'gcm1:x' });
  }
  // 100 newer filler snapshots (no op_group) — these fill the keep-100 window.
  for (let i = 0; i < 100; i++) raw(db, rid, { at: ts(100 + i), trigger: 'manual', content: 'gcm1:y' });

  pruneRouter(db, rid); // keep 100 + protect 10 most-recent op groups
  const rows = listSnapshots(db, rid);
  const present = new Set(rows.map((r) => r.opGroup).filter(Boolean));
  // op-1 and op-2 are the 2 OLDEST ops → outside both keep-100 and the protected-10 → pruned
  assert.ok(!present.has('op-1') && !present.has('op-2'), 'the 2 oldest ops are pruned');
  // op-3..op-12 are the 10 most recent ops → protected → survive even though outside top-100
  for (let i = 3; i <= 12; i++) assert.ok(present.has(`op-${i}`), `op-${i} protected & survives`);
  assert.equal(rows.length, 120, '100 filler + 20 protected pair-rows');
});

test('scheduler skips a router snapshotted within the last 20h (no capture attempted)', async () => {
  const { db, box, rid } = fixture();
  // a fresh snapshot exists → the scheduled run must SKIP it (and never touch the
  // network, which is why this is fast and deterministic with an unreachable host).
  storeSnapshotText(db, box, rid, 'R', { trigger: 'manual', text: 'fresh\n', format: 'snapshot' });
  const sched = new SnapshotScheduler(db, box, 86_400_000);
  const r = await sched.runAll('test');
  assert.deepEqual(r, { ok: 0, skipped: 1, failed: 0 }, 'fresh router skipped, no capture attempted');
});

test('pruning never orphans a surviving duplicate', () => {
  const { db, box, rid } = fixture();
  // C1 = content row (old, no op_group). D = a duplicate pointing at C1, carried by
  // a protected write op. Filler F is newest. With keepN=1, C1 would be deletable —
  // but D survives and references C1, so C1 must be protected-by-reference.
  const c1 = raw(db, rid, { at: ts(1), trigger: 'manual', content: box.encrypt('SHARED-X') });
  raw(db, rid, { at: ts(2), trigger: 'pre_write', opGroup: 'live-op', dupOf: c1 });
  raw(db, rid, { at: ts(3), trigger: 'manual', content: box.encrypt('filler') });

  pruneRouter(db, rid, 1); // keep only the newest; protect recent op groups
  const ids = new Set(listSnapshots(db, rid).map((r) => r.id));
  assert.ok(ids.has(c1), 'C1 survived because a surviving duplicate references it');
  const d = listSnapshots(db, rid).find((r) => r.isDuplicate);
  assert.equal(getSnapshotContent(db, box, d.id).text, 'SHARED-X', 'duplicate still resolves to its content');
});
