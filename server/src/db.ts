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
