// P38 — the migration chain is the load-bearing item. These prove the three
// scenarios the acceptance names, plus the fail-closed boot upgrade-guard:
//   1. fresh empty DB → full chain → converges (and re-run is a no-op / idempotent)
//   2. a fully-migrated ("real current") DB → chain re-runs as a no-op, data intact
//   3. a simulated v(N-3) DB fixture → chain migrates it forward → converges, old
//      data preserved, the new tables now exist
//   + preMigratePlan decision table, and fault injection: a REQUIRED pre-migration
//     backup that FAILS aborts startup and applies NO migration (fail-closed).
//   node --test test/migrate.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openDb, runMigrations, migrationStatus, preMigratePlan, applyMigrations, ensureBootstrap,
  getMeta, TARGET_SCHEMA, BootError,
} from '../dist/db.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-migrate-'));
const openRaw = (dir) => { const db = new DatabaseSync(path.join(dir, 'rubymik.db')); db.exec('PRAGMA foreign_keys = ON'); return db; };
const schemaVer = (db) => db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations').get().v;
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

test('proof 1 — fresh empty DB migrates the full chain and converges', () => {
  const dir = tmp();
  try {
    const db = openDb(dir, { appVersion: '1.0.0' });
    assert.equal(schemaVer(db), TARGET_SCHEMA, 'schema_migrations reaches the target');
    assert.equal(getMeta(db, 'app_version'), '1.0.0');
    assert.equal(getMeta(db, 'schema_version'), String(TARGET_SCHEMA));
    assert.ok(getMeta(db, 'booted_at'), 'boot recorded');
    // spot-check tables across the whole history + the new P38 one
    for (const t of ['users', 'devices', 'snapshots', 'self_backup_config', 'app_update_config']) {
      assert.ok(hasTable(db, t), `table ${t} exists`);
    }
    // the P38 config row is seeded enabled
    assert.equal(db.prepare('SELECT enabled FROM app_update_config WHERE id=1').get().enabled, 1);
    db.close();
  } finally { cleanup(dir); }
});

test('proof 1b — re-running the chain on a converged DB is an idempotent no-op', () => {
  const dir = tmp();
  try {
    const db1 = openDb(dir, { appVersion: '1.0.0' });
    const appliedAt = db1.prepare('SELECT applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1').get().applied_at;
    db1.close();
    // second boot, same version, nothing pending
    const db2 = openDb(dir, { appVersion: '1.0.0' });
    assert.equal(schemaVer(db2), TARGET_SCHEMA);
    const appliedAt2 = db2.prepare('SELECT applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1').get().applied_at;
    assert.equal(appliedAt2, appliedAt, 'no migration re-applied (timestamp unchanged)');
    const st = migrationStatus(db2, '1.0.0');
    assert.equal(st.pending, 0);
    assert.equal(st.changed, false);
    db2.close();
  } finally { cleanup(dir); }
});

test('proof 2 — a fully-migrated "real" DB with data: chain is a no-op, data intact', () => {
  const dir = tmp();
  try {
    const db = openDb(dir, { appVersion: '1.0.0' });
    db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)').run('admin', 'hash', new Date().toISOString());
    db.prepare('INSERT INTO devices (name, host, username_enc, password_enc, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('Bench', '10.0.0.1', 'enc', 'enc', new Date().toISOString(), new Date().toISOString());
    const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const devices = db.prepare('SELECT COUNT(*) c FROM devices').get().c;
    db.close();
    // reopen — simulates a restart on the same version
    const db2 = openDb(dir, { appVersion: '1.0.0' });
    assert.equal(schemaVer(db2), TARGET_SCHEMA);
    assert.equal(db2.prepare('SELECT COUNT(*) c FROM users').get().c, users, 'users intact');
    assert.equal(db2.prepare('SELECT COUNT(*) c FROM devices').get().c, devices, 'devices intact');
    db2.close();
  } finally { cleanup(dir); }
});

test('proof 3 — a simulated v(N-3) DB fixture migrates forward and preserves data', () => {
  const dir = tmp();
  const OLD = TARGET_SCHEMA - 3;
  try {
    // Build the old fixture directly: bootstrap + apply only the first N-3 migrations,
    // then seed data an old install would have. app_update_config etc. do NOT exist yet.
    const raw = openRaw(dir);
    ensureBootstrap(raw);
    applyMigrations(raw, OLD);
    assert.equal(schemaVer(raw), OLD);
    assert.equal(hasTable(raw, 'app_update_config'), false, 'the newest table is absent in the old fixture');
    raw.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)').run('olduser', 'oldhash', '2020-01-01T00:00:00Z');
    raw.close();

    // Now boot the real path against the old file — it must migrate the last 3.
    const db = openDb(dir, { appVersion: '2.0.0' });
    assert.equal(schemaVer(db), TARGET_SCHEMA, 'migrated forward to target');
    assert.ok(hasTable(db, 'app_update_config'), 'new table created by the forward migration');
    assert.equal(db.prepare("SELECT password_hash FROM users WHERE username='olduser'").get().password_hash, 'oldhash', 'old data preserved across the migration');
    assert.equal(getMeta(db, 'app_version'), '2.0.0');
    db.close();
  } finally { cleanup(dir); }
});

test('preMigratePlan — the decision table', () => {
  const base = { prevSchema: 5, targetSchema: TARGET_SCHEMA, prevAppVersion: '1.0.0', appVersion: '1.1.0' };
  // fresh install → never a backup
  assert.equal(preMigratePlan({ ...base, freshInstall: true, pending: TARGET_SCHEMA, appChanged: false, changed: true, prevAppVersion: null }, { backupConfigured: false }).action, 'skip');
  // pending migrations, key set → required
  assert.equal(preMigratePlan({ ...base, freshInstall: false, pending: 3, appChanged: true, changed: true }, { backupConfigured: true }).action, 'backup-required');
  // pending migrations, NO key → refuse (fail-closed)
  assert.equal(preMigratePlan({ ...base, freshInstall: false, pending: 3, appChanged: true, changed: true }, { backupConfigured: false }).action, 'refuse');
  // app changed only (schema same), key set → courtesy
  assert.equal(preMigratePlan({ ...base, freshInstall: false, pending: 0, appChanged: true, changed: true }, { backupConfigured: true }).action, 'backup-courtesy');
  // app changed only, no key → skip (nothing to migrate)
  assert.equal(preMigratePlan({ ...base, freshInstall: false, pending: 0, appChanged: true, changed: true }, { backupConfigured: false }).action, 'skip');
});

test('fault injection — a REQUIRED pre-migration backup that FAILS aborts startup and applies no migration', () => {
  const dir = tmp();
  const OLD = TARGET_SCHEMA - 2;
  try {
    const raw = openRaw(dir);
    ensureBootstrap(raw);
    applyMigrations(raw, OLD);
    raw.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)').run('u', 'h', '2020-01-01T00:00:00Z');
    raw.close();

    // A beforeMigrate that throws == the backup could not be taken.
    let calledWith = null;
    assert.throws(() => {
      openDb(dir, {
        appVersion: '3.0.0',
        beforeMigrate: (status) => { calledWith = status; throw new BootError('backup destination unwritable'); },
      });
    }, /backup destination unwritable/);
    assert.ok(calledWith && calledWith.pending === 2, 'hook saw the pending migrations');

    // The DB must be untouched — still at OLD, boot NOT recorded, data intact.
    const check = openRaw(dir);
    ensureBootstrap(check);
    assert.equal(schemaVer(check), OLD, 'no migration applied after the failed backup');
    assert.equal(getMeta(check, 'app_version'), null, 'boot was not recorded');
    assert.equal(check.prepare('SELECT COUNT(*) c FROM users').get().c, 1, 'data intact');
    check.close();
  } finally { cleanup(dir); }
});

test('boot hook — fires on schema change AND on app-only change; silent on no change', () => {
  const dir = tmp();
  try {
    // fresh → hook is called (changed), plan will be skip because freshInstall
    const calls = [];
    const db = openDb(dir, { appVersion: '1.0.0', beforeMigrate: (s) => calls.push(['fresh', s.pending, s.freshInstall]) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], true, 'fresh install flagged');
    db.close();

    // same version, no change → hook NOT called
    const calls2 = [];
    const db2 = openDb(dir, { appVersion: '1.0.0', beforeMigrate: () => calls2.push('x') });
    assert.equal(calls2.length, 0, 'no hook when nothing changed');
    db2.close();

    // app version bump, schema unchanged → hook called, pending 0, appChanged true
    const calls3 = [];
    const db3 = openDb(dir, { appVersion: '1.2.0', beforeMigrate: (s) => calls3.push([s.pending, s.appChanged]) });
    assert.equal(calls3.length, 1);
    assert.deepEqual(calls3[0], [0, true]);
    db3.close();
  } finally { cleanup(dir); }
});
