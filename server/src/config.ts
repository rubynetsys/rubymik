import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  port: number;
  dataDir: string;
  logLevel: LogLevel;
  encryptionKeyHex: string | undefined;
  /** P36: DEDICATED key for RubyMIK's own DB self-backup (NOT the field key).
   *  When unset, self-backups are DISABLED and the UI prompts to set one up. */
  backupKeyHex: string | undefined;
  /** Seconds between RubyMIK DB self-backups (P36). */
  selfBackupIntervalSec: number;
  /** How many DB self-backups to retain locally (P36). */
  selfBackupKeep: number;
  /** Seconds between device poll cycles. */
  pollIntervalSec: number;
  /** Max devices polled in parallel within a cycle. */
  pollConcurrency: number;
  /** Dedicated port for the WebFig reverse proxy (router admin UIs need web-root
   *  '/', so they get their own listener). 0 disables the WebFig feature. */
  webfigPort: number;
  /** Seconds between scheduled config-backup runs (all devices). */
  backupIntervalSec: number;
  /** How many backups to retain per device. */
  backupKeep: number;
  /** Seconds between scheduled config-SNAPSHOT runs (P21; all devices, read-only). */
  snapshotIntervalSec: number;
  /** Instance default theme (a user's own choice overrides it). */
  defaultTheme: string;
  defaultAccent: string | null;
  /** P38: override the version.json URL the update check fetches (else the built-in
   *  default). The DB config row can also override it per-instance. */
  updateUrl: string | undefined;
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

export function loadConfig(): Config {
  const port = Number(process.env.RUBYMIK_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`RUBYMIK_PORT must be a port number, got "${process.env.RUBYMIK_PORT}"`);
  }

  const dataDir = path.resolve(process.env.RUBYMIK_DATA_DIR ?? './data');
  fs.mkdirSync(dataDir, { recursive: true });

  const rawLevel = (process.env.RUBYMIK_LOG_LEVEL ?? 'info').toLowerCase();
  const logLevel = (LOG_LEVELS as string[]).includes(rawLevel) ? (rawLevel as LogLevel) : 'info';

  const encryptionKeyHex = process.env.RUBYMIK_ENCRYPTION_KEY || undefined;
  if (encryptionKeyHex !== undefined && !/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
    throw new Error('RUBYMIK_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  }

  // P36: a SEPARATE key for the DB self-backup. Deliberately no file fallback
  // (unlike the field key) — a backup encrypted with the field key would defeat
  // the point, so this must be set explicitly or self-backups stay disabled.
  const backupKeyHex = process.env.RUBYMIK_BACKUP_KEY || undefined;
  if (backupKeyHex !== undefined && !/^[0-9a-fA-F]{64}$/.test(backupKeyHex)) {
    throw new Error('RUBYMIK_BACKUP_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  }
  if (backupKeyHex !== undefined && backupKeyHex === encryptionKeyHex) {
    throw new Error('RUBYMIK_BACKUP_KEY must differ from RUBYMIK_ENCRYPTION_KEY — the backup key protects the whole DB (which already contains field-encrypted secrets).');
  }
  const selfBackupIntervalSec = intEnv('RUBYMIK_SELFBACKUP_INTERVAL', 21600, 300, 2592000); // 6h default
  const selfBackupKeep = intEnv('RUBYMIK_SELFBACKUP_KEEP', 28, 2, 500);                      // 7 days @ 6h

  // 0 = polling disabled (serve stored status/topology only — useful for a
  // frozen/demo/read-only instance); otherwise 5..3600s.
  const pollIntervalSec = process.env.RUBYMIK_POLL_INTERVAL === '0'
    ? 0
    : intEnv('RUBYMIK_POLL_INTERVAL', 30, 5, 3600);
  const pollConcurrency = intEnv('RUBYMIK_POLL_CONCURRENCY', 4, 1, 16);
  // WebFig proxy gets its own port (default main+1) because WebFig assumes it is
  // served from web-root '/'. 0 turns the feature off.
  const webfigPort = process.env.RUBYMIK_WEBFIG_PORT === '0'
    ? 0
    : intEnv('RUBYMIK_WEBFIG_PORT', port + 1, 1, 65535);
  const backupIntervalSec = intEnv('RUBYMIK_BACKUP_INTERVAL', 86400, 60, 2592000);
  const backupKeep = intEnv('RUBYMIK_BACKUP_KEEP', 10, 1, 500);
  const snapshotIntervalSec = intEnv('RUBYMIK_SNAPSHOT_INTERVAL', 86400, 60, 2592000);

  const defaultTheme = (process.env.RUBYMIK_DEFAULT_THEME || 'ruby-light').trim();
  const defaultAccent = process.env.RUBYMIK_DEFAULT_ACCENT ? process.env.RUBYMIK_DEFAULT_ACCENT.trim() : null;

  const updateUrl = process.env.RUBYMIK_UPDATE_URL ? process.env.RUBYMIK_UPDATE_URL.trim() : undefined;
  if (updateUrl !== undefined && !/^https?:\/\//i.test(updateUrl)) {
    throw new Error('RUBYMIK_UPDATE_URL must be an http(s) URL.');
  }

  return { port, dataDir, logLevel, encryptionKeyHex, backupKeyHex, selfBackupIntervalSec, selfBackupKeep, pollIntervalSec, pollConcurrency, webfigPort, backupIntervalSec, backupKeep, snapshotIntervalSec, defaultTheme, defaultAccent, updateUrl };
}
