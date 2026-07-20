import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  port: number;
  dataDir: string;
  logLevel: LogLevel;
  encryptionKeyHex: string | undefined;
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

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

  return { port, dataDir, logLevel, encryptionKeyHex };
}
