// P36 self-backup tests: an online-safe VACUUM-INTO backup, encrypted with the
// DEDICATED backup key (not the field key), a manifest with sha256 + row counts,
// retention pruning, the raw-copy-absent proof, secrets-stay-encrypted-in-the-backup,
// and the restore DRILL proven green on a fixture AND red on every corruption
// (wrong key, tampered blob, row-count mismatch). No network.
//   node --test test/selfbackup.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../dist/db.js';
import { SecretBox } from '../dist/secretbox.js';
import { hashPassword, verifyPassword } from '../dist/auth.js';
import {
  runSelfBackup, listSelfBackups, pruneSelfBackups, restoreDrill,
  encryptBackup, decryptBackup, TEST_BASELINE,
} from '../dist/selfbackup.js';

const FIELD_KEY = 'a'.repeat(64);   // field-encryption key (device creds/snapshots)
const BACKUP_KEY = 'b'.repeat(64);  // DEDICATED backup key — deliberately different
const bkKey = Buffer.from(BACKUP_KEY, 'hex');
const SECRET_CRED = 'super-secret-router-password';

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmk-bk-'));
  const db = openDb(dir);
  const box = SecretBox.load(dir, FIELD_KEY);
  const now = new Date().toISOString();
  // a user with a REAL argon2id hash (so the drill's "login works" check is real)
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run('admin', await hashPassword('CorrectHorse!'), now);
  // a device with FIELD-ENCRYPTED credentials
  db.prepare('INSERT INTO devices (name, host, username_enc, password_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('bench', '10.0.0.1', box.encrypt('admin'), box.encrypt(SECRET_CRED), now, now);
  // an encrypted router snapshot
  const snapText = 'network config snapshot text';
  db.prepare('INSERT INTO snapshots (router_name, captured_at, trigger, format, size_bytes, sha256, content_encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('bench', now, 'manual', 'snapshot', snapText.length, crypto.createHash('sha256').update(snapText).digest('hex'), box.encrypt(snapText), now);
  return { dir, db, box, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ---------------- P36.1: the backup ----------------

test('backup is online-safe (VACUUM INTO), ENCRYPTED with the dedicated key, and manifested', async () => {
  const fx = await fixture();
  try {
    const r = runSelfBackup(fx.db, bkKey, fx.dir, 'manual');
    // the .bkp is NOT a raw SQLite file — raw-copy path is provably absent
    const blob = fs.readFileSync(r.file);
    assert.equal(blob.subarray(0, 6).toString('binary'), 'RMBK1\0', 'starts with the RubyMIK backup magic');
    assert.notEqual(blob.subarray(0, 15).toString('latin1'), 'SQLite format 3', 'is NOT a bare/raw SQLite file');
    // decrypt with the backup key → a real SQLite DB whose sha256 matches the manifest
    const plain = decryptBackup(bkKey, blob);
    assert.equal(plain.subarray(0, 15).toString('latin1'), 'SQLite format 3');
    assert.equal(crypto.createHash('sha256').update(plain).digest('hex'), r.manifest.sha256Plain);
    // manifest carries schema/app/testBaseline + per-table counts
    assert.ok(r.manifest.schemaVersion >= 19, 'schema version recorded');
    assert.equal(r.manifest.testBaseline, TEST_BASELINE);
    assert.equal(r.manifest.tableCounts.users, 1);
    assert.equal(r.manifest.tableCounts.devices, 1);
    assert.equal(r.manifest.cipher, 'aes-256-gcm');
  } finally { fx.cleanup(); }
});

test('the wrong (field) key CANNOT decrypt the backup', async () => {
  const fx = await fixture();
  try {
    const r = runSelfBackup(fx.db, bkKey, fx.dir, 'manual');
    const blob = fs.readFileSync(r.file);
    assert.throws(() => decryptBackup(Buffer.from(FIELD_KEY, 'hex'), blob), /bad magic|unable to authenticate|auth/i);
  } finally { fx.cleanup(); }
});

test('secrets stay ENCRYPTED inside the backup; the backup key is not in it', async () => {
  const fx = await fixture();
  try {
    const r = runSelfBackup(fx.db, bkKey, fx.dir, 'manual');
    const plain = decryptBackup(bkKey, fs.readFileSync(r.file)).toString('latin1');
    assert.ok(!plain.includes(SECRET_CRED), 'the device password is field-encrypted (gcm1:) inside the backup, never plaintext');
    assert.ok(!plain.includes(BACKUP_KEY), 'the backup key is never inside the backup');
    assert.ok(!plain.includes(FIELD_KEY), 'the field key is never inside the backup');
  } finally { fx.cleanup(); }
});

test('retention prunes to keep N (newest kept)', async () => {
  const fx = await fixture();
  try {
    for (let i = 0; i < 5; i++) { runSelfBackup(fx.db, bkKey, fx.dir, 'manual'); await new Promise((r) => setTimeout(r, 5)); }
    assert.equal(listSelfBackups(fx.dir).length, 5);
    const pruned = pruneSelfBackups(fx.dir, 3);
    assert.equal(pruned.length, 2);
    const left = listSelfBackups(fx.dir);
    assert.equal(left.length, 3);
    // newest three kept (sorted desc by createdAt)
    assert.ok(left[0].createdAt >= left[2].createdAt);
    // both .bkp and .manifest.json removed for pruned ones
    for (const name of pruned) assert.ok(!fs.existsSync(path.join(fx.dir, 'self-backups', `${name}.manifest.json`)));
  } finally { fx.cleanup(); }
});

// ---------------- P36.2: the restore DRILL ----------------

test('restore drill GREEN against a fresh backup (all asserts pass, live untouched)', async () => {
  const fx = await fixture();
  try {
    const r = runSelfBackup(fx.db, bkKey, fx.dir, 'manual');
    const liveBytesBefore = fs.statSync(path.join(fx.dir, 'rubymik.db')).size;
    const drill = await restoreDrill({
      backupFile: r.file, manifestFile: r.manifestFile, backupKey: bkKey, mainBox: fx.box,
      verifyPassword, knownLogin: { username: 'admin', password: 'CorrectHorse!' },
    });
    assert.ok(drill.ok, `drill failed: ${JSON.stringify(drill.checks.filter((c) => !c.ok))}`);
    const names = drill.checks.map((c) => c.name);
    for (const need of ['decrypt', 'sha256', 'sqlite-header', 'row-counts', 'snapshot-decrypt', 'cred-decrypt', 'login']) assert.ok(names.includes(need), `has ${need} check`);
    // the drill NEVER touches the live DB
    assert.equal(fs.statSync(path.join(fx.dir, 'rubymik.db')).size, liveBytesBefore, 'live DB untouched by the drill');
  } finally { fx.cleanup(); }
});

test('restore drill RED on a wrong password (login check fails)', async () => {
  const fx = await fixture();
  try {
    const r = runSelfBackup(fx.db, bkKey, fx.dir, 'manual');
    const drill = await restoreDrill({ backupFile: r.file, manifestFile: r.manifestFile, backupKey: bkKey, mainBox: fx.box, verifyPassword, knownLogin: { username: 'admin', password: 'WRONG' } });
    assert.equal(drill.ok, false);
    assert.equal(drill.checks.find((c) => c.name === 'login').ok, false);
  } finally { fx.cleanup(); }
});

test('restore drill RED on a tampered backup blob (GCM auth fails → loud, not silent)', async () => {
  const fx = await fixture();
  try {
    const r = runSelfBackup(fx.db, bkKey, fx.dir, 'manual');
    const blob = fs.readFileSync(r.file); blob[blob.length - 1] ^= 0xff; fs.writeFileSync(r.file, blob);
    const drill = await restoreDrill({ backupFile: r.file, manifestFile: r.manifestFile, backupKey: bkKey, mainBox: fx.box, verifyPassword });
    assert.equal(drill.ok, false);
    assert.equal(drill.checks.find((c) => c.name === 'decrypt').ok, false);
  } finally { fx.cleanup(); }
});

test('restore drill RED on a row-count mismatch (manifest tamper)', async () => {
  const fx = await fixture();
  try {
    const r = runSelfBackup(fx.db, bkKey, fx.dir, 'manual');
    const m = JSON.parse(fs.readFileSync(r.manifestFile, 'utf8'));
    m.tableCounts.users = 999; fs.writeFileSync(r.manifestFile, JSON.stringify(m));
    const drill = await restoreDrill({ backupFile: r.file, manifestFile: r.manifestFile, backupKey: bkKey, mainBox: fx.box, verifyPassword });
    assert.equal(drill.ok, false);
    assert.equal(drill.checks.find((c) => c.name === 'row-counts').ok, false);
  } finally { fx.cleanup(); }
});

test('encrypt/decrypt round-trips arbitrary bytes', () => {
  const data = crypto.randomBytes(5000);
  assert.ok(decryptBackup(bkKey, encryptBackup(bkKey, data)).equals(data));
});
