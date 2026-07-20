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
  // 3: per-interface traffic counters. ONE row per device per poll cycle —
  // a JSON blob {ifname: [rxBytes, txBytes], …} — never a row per interface.
  // Rates are derived from consecutive samples at read time; pruned to 6h.
  `
  CREATE TABLE interface_traffic (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX idx_iftraffic_device_ts ON interface_traffic(device_id, ts);
  `,
  // 4: topology. Current-state neighbor tables (replaced wholesale each poll
  // cycle — no history growth), per-device discovery settings, and the
  // device's own interface MACs (for matching neighbors to managed devices).
  `
  ALTER TABLE device_status ADD COLUMN if_macs TEXT;

  CREATE TABLE device_neighbors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    seen_on TEXT,
    mac TEXT,
    identity TEXT,
    platform TEXT,
    board TEXT,
    version TEXT,
    address TEXT,
    remote_interface TEXT,
    discovered_by TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_device_neighbors_device ON device_neighbors(device_id);

  CREATE TABLE device_discovery (
    device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    protocol TEXT,
    interface_list TEXT,
    updated_at TEXT NOT NULL
  );
  `,
  // 5: alerting. Rules are seeded global; scope_kind/scope_id exist so
  // per-site/per-device overrides later are new rows, not a schema change.
  // One FIRING row per (device, rule, target) is enforced by a partial
  // unique index — dedup by construction. History pruned to 30 days.
  `
  ALTER TABLE device_status ADD COLUMN temp_c REAL;

  CREATE TABLE alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule TEXT NOT NULL,
    scope_kind TEXT NOT NULL DEFAULT 'global',
    scope_id INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    threshold REAL,
    clear_threshold REAL,
    fire_cycles INTEGER NOT NULL DEFAULT 2,
    resolve_cycles INTEGER NOT NULL DEFAULT 2,
    updated_at TEXT NOT NULL,
    UNIQUE(rule, scope_kind, scope_id)
  );
  INSERT INTO alert_rules (rule, enabled, threshold, clear_threshold, fire_cycles, resolve_cycles, updated_at) VALUES
    ('device_down', 1, NULL, NULL, 2, 2, datetime('now')),
    ('cpu_high',    1, 90,   80,   3, 3, datetime('now')),
    ('mem_high',    1, 90,   85,   3, 3, datetime('now')),
    ('temp_high',   1, 70,   65,   3, 3, datetime('now')),
    ('iface_down',  1, NULL, NULL, 2, 2, datetime('now'));

  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    rule TEXT NOT NULL,
    target TEXT,
    severity TEXT NOT NULL,
    state TEXT NOT NULL,
    message TEXT NOT NULL,
    value TEXT,
    fired_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT,
    cycles INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX idx_alerts_state ON alerts(state);
  CREATE INDEX idx_alerts_device ON alerts(device_id);
  CREATE UNIQUE INDEX idx_alerts_one_firing
    ON alerts(device_id, rule, IFNULL(target, '')) WHERE state = 'firing';

  CREATE TABLE notification_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    webhook_enabled INTEGER NOT NULL DEFAULT 0,
    webhook_url TEXT,
    updated_at TEXT NOT NULL
  );
  INSERT INTO notification_settings (id, webhook_enabled, webhook_url, updated_at)
    VALUES (1, 0, NULL, datetime('now'));
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
