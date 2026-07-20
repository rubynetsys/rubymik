import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let threshold: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function emit(level: LogLevel, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] ${msg}`;
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra !== undefined) method(line, extra);
  else method(line);
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
