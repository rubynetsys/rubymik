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
  // 6: config-WRITE support. A device becomes "manageable" only when it has a
  // separate, explicit WRITE credential (encrypted like the monitoring one).
  // Monitoring keeps using username_enc/password_enc (GET-only) — the write
  // credential is used exclusively by the safe-apply pipeline. Every write is
  // recorded in config_audit (before/after + outcome), pruned to 180 days.
  `
  ALTER TABLE devices ADD COLUMN write_username_enc TEXT;
  ALTER TABLE devices ADD COLUMN write_password_enc TEXT;

  CREATE TABLE config_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    device_name TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    summary TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    result TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_config_audit_device ON config_audit(device_id, created_at);
  `,
  // 7: managed firewall config per device (preset + interface scoping +
  // mgmt sources + custom rules). The applied rules live on the device
  // (RUBYMIK-tagged); this table stores the intent so the UI can re-render it.
  `
  CREATE TABLE device_firewall (
    device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    preset TEXT NOT NULL DEFAULT 'off',
    wan_interface TEXT,
    trusted_interface TEXT,
    mgmt_sources_json TEXT NOT NULL DEFAULT '[]',
    custom_rules_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  `,
  // 8: config backups. The full text export is gzip-compressed into a BLOB
  // (SQLite-light — a big router's export compresses ~10x), with
  // self-describing metadata so a backup knows which device/version it is.
  `
  CREATE TABLE device_backup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    identity TEXT,
    model TEXT,
    serial TEXT,
    version TEXT,
    source TEXT NOT NULL,
    raw_bytes INTEGER NOT NULL,
    gz BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_device_backup_device ON device_backup(device_id, created_at);
  `,
  // 9: backup format. 'export' = canonical RouterOS /export (needs an
  // ftp-capable write credential; importable → restorable). 'snapshot' = a
  // read-only GET reconstruction (works with a plain read credential; diffable
  // but not directly importable). Restore requires an 'export' backup.
  `
  ALTER TABLE device_backup ADD COLUMN format TEXT NOT NULL DEFAULT 'export';
  `,
  // 10: WireGuard remote-access (P9). A device is reached via DIRECT (its LAN
  // host, today's default) or TUNNEL (a WireGuard overlay IP). net_transport
  // defaults to 'direct' so EVERY existing device is byte-for-byte unchanged and
  // the zero-config LAN path is untouched. The hub is a singleton row; peers are
  // one per remote site. The only private key RubyMIK ever stores is the hub's,
  // AES-GCM encrypted; routers generate their own keys and register only pubkeys.
  `
  ALTER TABLE devices ADD COLUMN net_transport TEXT NOT NULL DEFAULT 'direct';
  ALTER TABLE devices ADD COLUMN tunnel_ip TEXT;

  CREATE TABLE wg_hub (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    endpoint TEXT,
    listen_port INTEGER NOT NULL DEFAULT 51820,
    overlay_cidr TEXT NOT NULL DEFAULT '10.9.0.0/24',
    hub_address TEXT NOT NULL DEFAULT '10.9.0.1',
    private_key_enc TEXT,
    public_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE wg_peers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    label TEXT NOT NULL,
    tunnel_ip TEXT NOT NULL UNIQUE,
    public_key TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    last_handshake_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_wg_peers_device ON wg_peers(device_id);
  `,
  // 11: per-device opt-in for scheduled backups (P10 onboarding). Defaults to 1
  // so EVERY existing device keeps being backed up exactly as before P10; the
  // onboarding wizard sets it explicitly (default OFF there — extras are opt-in).
  `
  ALTER TABLE devices ADD COLUMN backups_enabled INTEGER NOT NULL DEFAULT 1;
  `,
  // 12: per-user theme + accent override (P12). Both nullable — null means "use
  // the install default theme". Purely presentational.
  `
  ALTER TABLE users ADD COLUMN theme TEXT;
  ALTER TABLE users ADD COLUMN accent TEXT;
  `,
  // 13: automatic config snapshots (P21). Every managed router gets an /export
  // snapshot captured pre/post every write, plus manual + daily scheduled. Content
  // is AES-256-GCM encrypted at rest (show-sensitive exports carry secrets), the
  // same SecretBox used for device credentials. Dedup: a capture identical to the
  // router's most recent one stores a duplicate_of pointer, not a second blob.
  // This is CAPTURE + VIEW + DIFF only — there is deliberately NO restore path.
  `
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    router_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    router_name TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    trigger TEXT NOT NULL,             -- pre_write | post_write | manual | scheduled
    operation TEXT,                    -- e.g. "netl2.moveMgmtToBridge"
    op_group TEXT,                     -- shared by a pre/post pair (nullable)
    outcome TEXT,                      -- post_write: applied | rolled_back | failed | ...
    format TEXT NOT NULL,              -- export (canonical, show-sensitive) | snapshot (read-only GET)
    identity TEXT, model TEXT, serial TEXT, version TEXT,
    size_bytes INTEGER NOT NULL,       -- plaintext bytes
    sha256 TEXT NOT NULL,              -- of plaintext
    content_encrypted TEXT,            -- gcm1: AES-256-GCM (iv+tag embedded); NULL when duplicate_of set
    duplicate_of INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_snapshots_router ON snapshots(router_id, captured_at);
  CREATE INDEX idx_snapshots_opgroup ON snapshots(router_id, op_group);

  CREATE TABLE snapshot_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    router_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    operation TEXT,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_snapshot_failures_router ON snapshot_failures(router_id, created_at);
  `,

  // P27: optional per-device category override (router | switch | ap | other).
  // NULL means "derive from the polled model" (done in the frontend catalogue).
  `ALTER TABLE devices ADD COLUMN category TEXT`,

  // P29: expected-outage reboot dead-man. reboot_expected_until = ISO deadline the
  // device must return by; while set, a failed poll shows 'rebooting' (no down-alert)
  // instead of 'down'. reboot_baseline = JSON {serial, uptimeSec, at} for return-verify.
  `ALTER TABLE device_status ADD COLUMN reboot_expected_until TEXT;
   ALTER TABLE device_status ADD COLUMN reboot_baseline TEXT`,

  // P30: users, roles, optional 2FA. The existing single account becomes the first
  // admin (role defaults to 'admin'). totp_secret/totp_enabled hold per-user TOTP;
  // recovery_codes are one-time, hashed at rest, single-use (used_at set on use).
  `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
   ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE users ADD COLUMN totp_secret TEXT;
   ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE recovery_codes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     code_hash TEXT NOT NULL,
     used_at TEXT
   );
   CREATE INDEX idx_recovery_codes_user ON recovery_codes(user_id)`,

  // P31: notification channels + a delivery log. Secrets (*_enc) are AES-GCM at
  // rest and masked on read as *Set booleans, never returned plaintext. Desktop
  // notifications are client-side (no server config).
  `ALTER TABLE notification_settings ADD COLUMN smtp_enabled INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE notification_settings ADD COLUMN smtp_host TEXT;
   ALTER TABLE notification_settings ADD COLUMN smtp_port INTEGER;
   ALTER TABLE notification_settings ADD COLUMN smtp_secure TEXT;
   ALTER TABLE notification_settings ADD COLUMN smtp_user TEXT;
   ALTER TABLE notification_settings ADD COLUMN smtp_pass_enc TEXT;
   ALTER TABLE notification_settings ADD COLUMN smtp_from TEXT;
   ALTER TABLE notification_settings ADD COLUMN smtp_to TEXT;
   ALTER TABLE notification_settings ADD COLUMN telegram_enabled INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE notification_settings ADD COLUMN telegram_token_enc TEXT;
   ALTER TABLE notification_settings ADD COLUMN telegram_chat_id TEXT;
   ALTER TABLE notification_settings ADD COLUMN whatsapp_enabled INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE notification_settings ADD COLUMN whatsapp_provider TEXT;
   ALTER TABLE notification_settings ADD COLUMN whatsapp_config_enc TEXT;
   CREATE TABLE notification_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     channel TEXT NOT NULL,
     event TEXT NOT NULL,
     target TEXT,
     status TEXT NOT NULL,
     detail TEXT
   );
   CREATE INDEX idx_notification_log_ts ON notification_log(ts)`,

  // P33: geographic coordinates per site, for the topology map view.
  `ALTER TABLE sites ADD COLUMN latitude REAL;
   ALTER TABLE sites ADD COLUMN longitude REAL`,
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
