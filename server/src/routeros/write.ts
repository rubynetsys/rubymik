import http from 'node:http';
import https from 'node:https';
import type { DeviceTarget } from './types.js';
import { RouterOsError } from './rest.js';

/**
 * ============================================================================
 *  THE WRITE PATH — the ONLY module in RubyMIK that issues a non-GET verb to
 *  a RouterOS device. All monitoring lives in rest.ts and is GET-only.
 *
 *  Structural invariant (grep-enforced, see the read-only test):
 *    - rest.ts contains exactly one HTTP method: 'GET'.
 *    - write.ts is the sole home of PUT / PATCH / DELETE toward RouterOS.
 *    - Nothing here is reachable from the poller or any monitoring route;
 *      only the safe-apply pipeline calls it, and only with a device's
 *      explicit WRITE credential (never the monitoring/read credential).
 * ============================================================================
 */

const DEFAULT_TIMEOUT_MS = 10_000;

type WriteMethod = 'PUT' | 'PATCH' | 'DELETE';

function writeRequest(
  target: DeviceTarget,
  scheme: 'https' | 'http',
  port: number,
  method: WriteMethod,
  apiPath: string,
  body: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const lib = scheme === 'https' ? https : http;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const options: https.RequestOptions = {
      host: target.host,
      port,
      path: `/rest${apiPath}`,
      method,
      timeout: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${target.username}:${target.password}`).toString('base64'),
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
      },
    };
    if (scheme === 'https') options.rejectUnauthorized = target.verifyTls === true;

    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401) {
          return reject(new RouterOsError('Write rejected: authentication failed for the write credential.', 401));
        }
        if (res.statusCode === 403) {
          return reject(new RouterOsError('Write rejected: this credential lacks write permission (needs group=write or full).', 403));
        }
        if (!res.statusCode || res.statusCode >= 400) {
          let msg = `RouterOS returned HTTP ${res.statusCode} for ${method} ${apiPath}`;
          try {
            const j = JSON.parse(raw);
            if (j?.message) msg = `RouterOS: ${j.message}`;
          } catch { /* keep default */ }
          return reject(new RouterOsError(msg, res.statusCode));
        }
        if (!raw) return resolve(null);
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (err: NodeJS.ErrnoException) =>
      reject(new RouterOsError(`Write transport failed (${method} ${apiPath}): ${err.code ?? err.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

export interface WriteTransport {
  scheme: 'https' | 'http';
  port: number;
}

/** Create (RouterOS REST PUT). Returns the created object (incl. .id). */
export function restAdd(t: DeviceTarget, tr: WriteTransport, apiPath: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return writeRequest(t, tr.scheme, tr.port, 'PUT', apiPath, body) as Promise<Record<string, unknown>>;
}

/** Update by id (RouterOS REST PATCH). */
export function restSet(t: DeviceTarget, tr: WriteTransport, apiPath: string, id: string, body: Record<string, unknown>): Promise<unknown> {
  return writeRequest(t, tr.scheme, tr.port, 'PATCH', `${apiPath}/${encodeURIComponent(id)}`, body);
}

/** Remove by id (RouterOS REST DELETE). */
export function restRemove(t: DeviceTarget, tr: WriteTransport, apiPath: string, id: string): Promise<unknown> {
  return writeRequest(t, tr.scheme, tr.port, 'DELETE', `${apiPath}/${encodeURIComponent(id)}`, undefined);
}
