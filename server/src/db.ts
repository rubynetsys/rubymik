import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { log } from './log.js';

// Schema lives here as ordered migrations. SQL is kept portable where practical
// so an optional Postgres backend can slot in later; SQLite is the default and
// only requirement.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER,
    transport TEXT NOT NULL DEFAULT 'rest',
    use_tls INTEGER,
    verify_tls INTEGER NOT NULL DEFAULT 0,
    username_enc TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 2: sites (tenancy grouping), device→site assignment, poller state + history.
  `
  CREATE TABLE sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    location TEXT,
    client_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  ALTER TABLE devices ADD COLUMN site_id INTEGER REFERENCES sites(id);
  ALTER TABLE devices ADD COLUMN notes TEXT;

  -- Latest reading per device: one row, UPSERTed each poll (no write thrash).
  CREATE TABLE device_status (
    device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_seen_at TEXT,
    last_error TEXT,
    identity TEXT,
    board_name TEXT,
    model TEXT,
    version TEXT,
    uptime TEXT,
    cpu_load INTEGER,
    cpu_count INTEGER,
    mem_total INTEGER,
    mem_free INTEGER,
    hdd_total INTEGER,
    hdd_free INTEGER,
    updated_at TEXT NOT NULL
  );

  -- Short recent history for the overview (sparklines); pruned to 24h each
  -- cycle. Deeper time-series is a later phase.
  CREATE TABLE device_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    up INTEGER NOT NULL,
    cpu_load INTEGER,
    mem_used_pct REAL
  );
  CREATE INDEX idx_device_metrics_device_ts ON device_metrics(device_id, ts);
  `,
];

export function openDb(dataDir: string): DatabaseSync {
  const dbPath = path.join(dataDir, 'rubymik.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  log.debug(`SQLite ready at ${dbPath}`);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(v + 1, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    log.info(`Applied database migration ${v + 1}/${MIGRATIONS.length}`);
  }
}
