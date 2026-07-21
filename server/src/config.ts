import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  port: number;
  dataDir: string;
  logLevel: LogLevel;
  encryptionKeyHex: string | undefined;
  /** Seconds between device poll cycles. */
  pollIntervalSec: number;
  /** Max devices polled in parallel within a cycle. */
  pollConcurrency: number;
  /** Seconds between scheduled config-backup runs (all devices). */
  backupIntervalSec: number;
  /** How many backups to retain per device. */
  backupKeep: number;
  /** Instance default theme (a user's own choice overrides it). */
  defaultTheme: string;
  defaultAccent: string | null;
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

  const pollIntervalSec = intEnv('RUBYMIK_POLL_INTERVAL', 30, 5, 3600);
  const pollConcurrency = intEnv('RUBYMIK_POLL_CONCURRENCY', 4, 1, 16);
  const backupIntervalSec = intEnv('RUBYMIK_BACKUP_INTERVAL', 86400, 60, 2592000);
  const backupKeep = intEnv('RUBYMIK_BACKUP_KEEP', 10, 1, 500);

  const defaultTheme = (process.env.RUBYMIK_DEFAULT_THEME || 'ruby-light').trim();
  const defaultAccent = process.env.RUBYMIK_DEFAULT_ACCENT ? process.env.RUBYMIK_DEFAULT_ACCENT.trim() : null;

  return { port, dataDir, logLevel, encryptionKeyHex, pollIntervalSec, pollConcurrency, backupIntervalSec, backupKeep, defaultTheme, defaultAccent };
}
