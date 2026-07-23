// P44 — the backup-key store: env > /data file > strict-memory > none, with the protection tiers
// and the strict-mode restart behaviour. This is security-sensitive (the key that decrypts every
// DB backup), so the source precedence + on-disk state are pinned exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupKeyStore } from '../dist/backupkey.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-bkey-'));
const keyFile = (d) => path.join(d, 'backup.key');
const strictFile = (d) => path.join(d, 'backup.strict');
const HEX = 'a'.repeat(64);

test('none → enable writes /data/backup.key (0600) and activates (convenience)', () => {
  const d = tmp();
  try {
    const s = new BackupKeyStore(d, undefined);
    assert.equal(s.configured(), false);
    assert.deepEqual(s.status(), { enabled: false, source: 'none', tier: 'none', needsKey: false });
    s.enable();
    assert.equal(s.configured(), true);
    assert.equal(s.status().tier, 'convenience');
    assert.ok(fs.existsSync(keyFile(d)), 'key file written');
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile(d)).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(keyFile(d), 'utf8').trim(), /^[0-9a-f]{64}$/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('env wins and is not app-managed (enable/strict/disable refused)', () => {
  const d = tmp();
  try {
    const s = new BackupKeyStore(d, HEX);
    assert.equal(s.status().source, 'env');
    assert.equal(s.status().tier, 'env');
    assert.ok(s.configured());
    for (const fn of [() => s.enable(), () => s.goStrict(), () => s.disable()]) assert.throws(fn, /RUBYMIK_BACKUP_KEY|env/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('file key persists across a restart (new store reads it)', () => {
  const d = tmp();
  try {
    new BackupKeyStore(d, undefined).enable();
    const s2 = new BackupKeyStore(d, undefined);
    assert.equal(s2.status().source, 'file');
    assert.ok(s2.configured());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('strict mode removes the on-disk key, keeps it in memory, marks strict', () => {
  const d = tmp();
  try {
    const s = new BackupKeyStore(d, undefined);
    s.enable();
    const before = s.recoveryHex();
    s.goStrict();
    assert.ok(!fs.existsSync(keyFile(d)), 'key removed from disk');
    assert.ok(fs.existsSync(strictFile(d)), 'strict marker written');
    assert.equal(s.configured(), true, 'still usable this process (in memory)');
    assert.equal(s.status().tier, 'strict');
    assert.equal(s.recoveryHex(), before, 'same key, just off-disk');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('strict RESTART → key not on disk → needs-key; provide() re-activates', () => {
  const d = tmp();
  try {
    const s1 = new BackupKeyStore(d, undefined); s1.enable(); s1.goStrict();
    const hex = s1.recoveryHex();
    // simulate restart: strict marker present, no key file
    const s2 = new BackupKeyStore(d, undefined);
    assert.equal(s2.configured(), false);
    assert.deepEqual(s2.status(), { enabled: false, source: 'none', tier: 'needs-key', needsKey: true });
    s2.provide(hex);
    assert.equal(s2.configured(), true);
    assert.equal(s2.recoveryHex(), hex);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('goConvenience writes the key back to /data and clears strict', () => {
  const d = tmp();
  try {
    const s = new BackupKeyStore(d, undefined); s.enable(); s.goStrict();
    s.goConvenience();
    assert.ok(fs.existsSync(keyFile(d)));
    assert.ok(!fs.existsSync(strictFile(d)));
    assert.equal(s.status().tier, 'convenience');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('disable removes key + marker; provide rejects a bad key', () => {
  const d = tmp();
  try {
    const s = new BackupKeyStore(d, undefined); s.enable();
    s.disable();
    assert.equal(s.configured(), false);
    assert.ok(!fs.existsSync(keyFile(d)));
    assert.throws(() => s.provide('nothex'), /64 hex/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a corrupt key file throws on load (fail loud, do not silently disable)', () => {
  const d = tmp();
  try {
    fs.writeFileSync(keyFile(d), 'not-a-key\n');
    assert.throws(() => new BackupKeyStore(d, undefined), /corrupt/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
