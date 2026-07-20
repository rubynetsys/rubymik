import http from 'node:http';
import https from 'node:https';
import type { ConnectResult, DeviceTarget, RouterSystemInfo } from './types.js';
import { log } from '../log.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export class RouterOsError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = 'RouterOsError';
  }
}

type Scheme = 'https' | 'http';

function restGet(target: DeviceTarget, scheme: Scheme, port: number, apiPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const lib = scheme === 'https' ? https : http;
    const options: https.RequestOptions = {
      host: target.host,
      port,
      path: `/rest${apiPath}`,
      method: 'GET',
      timeout: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${target.username}:${target.password}`).toString('base64'),
        Accept: 'application/json',
      },
    };
    if (scheme === 'https') {
      // RouterOS devices almost always run a self-signed certificate.
      options.rejectUnauthorized = target.verifyTls === true;
    }
    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401) {
          return reject(new RouterOsError('Authentication failed — check the RouterOS username and password.', 401));
        }
        if (!res.statusCode || res.statusCode >= 400) {
          return reject(new RouterOsError(`RouterOS returned HTTP ${res.statusCode} for ${apiPath}`, res.statusCode));
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new RouterOsError('Response was not JSON — is this RouterOS 7.1+ with the www/www-ssl service enabled?'));
        }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (err: NodeJS.ErrnoException) => reject(normalizeNetError(err, scheme, port)));
    req.end();
  });
}

function normalizeNetError(err: NodeJS.ErrnoException, scheme: Scheme, port: number): RouterOsError {
  const service = scheme === 'https' ? 'www-ssl' : 'www';
  switch (err.code) {
    case 'ECONNREFUSED':
      return new RouterOsError(`Connection refused on ${scheme}:${port} — is the "${service}" service enabled on the router (IP → Services)?`);
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new RouterOsError(`No response on ${scheme}:${port} — check the IP address, and that RubyMIK can reach the router's network.`);
    case 'ENOTFOUND':
      return new RouterOsError(`Hostname could not be resolved.`);
    case 'ECONNRESET':
      return new RouterOsError(`Connection reset on ${scheme}:${port} — the port is open but does not speak ${scheme.toUpperCase()} REST (${service} may be disabled).`);
    default:
      if (err.message?.includes('SSL') || err.message?.includes('TLS') || err.code?.startsWith('ERR_SSL')) {
        return new RouterOsError(`TLS handshake failed on port ${port} — the port may not be serving the RouterOS www-ssl service.`);
      }
      return new RouterOsError(`Connection failed on ${scheme}:${port}: ${err.message}`);
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function fetchSystemInfo(target: DeviceTarget, scheme: Scheme, port: number): Promise<RouterSystemInfo> {
  type Dict = Record<string, unknown>;
  const [resource, identity] = await Promise.all([
    restGet(target, scheme, port, '/system/resource') as Promise<Dict>,
    restGet(target, scheme, port, '/system/identity') as Promise<Dict>,
  ]);
  // Not present on CHR / x86 installs — treat as optional.
  let routerboard: Dict | null = null;
  try {
    routerboard = await restGet(target, scheme, port, '/system/routerboard') as Dict;
  } catch (err) {
    log.debug(`No routerboard info from ${target.host}: ${(err as Error).message}`);
  }

  return {
    identity: str(identity['name']),
    model: str(routerboard?.['model']),
    boardName: str(resource['board-name']),
    serialNumber: str(routerboard?.['serial-number']),
    firmware: str(routerboard?.['current-firmware']),
    version: str(resource['version']) ?? 'unknown',
    architecture: str(resource['architecture-name']),
    uptime: str(resource['uptime']) ?? 'unknown',
    cpuCount: numOrNull(resource['cpu-count']),
    cpuLoad: num(resource['cpu-load']),
    totalMemory: num(resource['total-memory']),
    freeMemory: num(resource['free-memory']),
    totalHdd: numOrNull(resource['total-hdd-space']),
    freeHdd: numOrNull(resource['free-hdd-space']),
  };
}

/**
 * Connect to a RouterOS device over the REST API and pull its system snapshot.
 * When `useTls` is undefined, probes HTTPS first and falls back to HTTP —
 * whatever succeeds is reported back in the result so it can be persisted.
 */
export async function restConnect(target: DeviceTarget): Promise<ConnectResult> {
  const candidates: Array<{ scheme: Scheme; port: number }> =
    target.useTls === true ? [{ scheme: 'https', port: target.port ?? 443 }]
    : target.useTls === false ? [{ scheme: 'http', port: target.port ?? 80 }]
    : [
        { scheme: 'https', port: target.port ?? 443 },
        { scheme: 'http', port: target.port ?? 80 },
      ];

  const errors: RouterOsError[] = [];
  for (const { scheme, port } of candidates) {
    try {
      const info = await fetchSystemInfo(target, scheme, port);
      return { transport: 'rest', scheme, port, info };
    } catch (err) {
      const e = err instanceof RouterOsError ? err : new RouterOsError((err as Error).message);
      // 401 means we definitely reached RouterOS — trying other schemes won't help.
      if (e.statusCode === 401) throw e;
      errors.push(e);
      log.debug(`REST probe ${scheme}://${target.host}:${port} failed: ${e.message}`);
    }
  }
  throw errors[errors.length - 1] ?? new RouterOsError('Connection failed');
}
