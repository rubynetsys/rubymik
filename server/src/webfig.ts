import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { Request, Response } from 'express';
import { resolveEndpoint, type AddressableRow, type NetTransport } from './transport.js';
import { log } from './log.js';

/**
 * ============================================================================
 *  WEBFIG REVERSE PROXY (P15)
 *
 *  Pipes a managed router's OWN WebFig admin UI through the RubyMIK dashboard,
 *  over whichever transport the device uses (direct LAN address or its P9
 *  WireGuard overlay IP). Full manual config for any managed router — including
 *  behind-NAT routers reachable only over the tunnel — from one pane.
 *
 *  SECURITY MODEL
 *  - Auth-gated: the proxy only runs for a logged-in RubyMIK user, and only for
 *    a device that user is authorized to see (scope re-checked on EVERY request).
 *  - Target-by-device-id ONLY: the browser never supplies a host/URL. The proxy
 *    resolves the target host+scheme+port SERVER-SIDE from the device record.
 *    A short-lived HMAC-signed cookie carries only {deviceId, userId} — it is
 *    NOT a bearer of any host, so it cannot be used to retarget the proxy.
 *  - Credential model = pass-through (Option A): RubyMIK does NOT inject the
 *    stored router credential. The user authenticates to WebFig themselves with
 *    the router's own login. The admin credential therefore never enters the
 *    proxy path — nothing to leak to the browser or logs.
 *  - Self-signed device certs are accepted TO THE DEVICE exactly as the
 *    monitoring client does; the RubyMIK<->browser side stays on RubyMIK's own
 *    session/TLS.
 * ============================================================================
 */

// Process-lifetime signing key. Cookies are short-lived and re-minted whenever
// the user re-opens WebFig, so a restart simply invalidates outstanding ones.
const SIGN_KEY = crypto.randomBytes(32);
export const WEBFIG_COOKIE = 'rubymik_webfig';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Mint the signed session cookie value. Carries NO host and NO credential. */
export function issueWebfigToken(deviceId: number, userId: number): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${deviceId}.${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', SIGN_KEY).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

/** Verify the cookie for THIS user; returns the authorized device id or null. */
export function verifyWebfigToken(value: string | undefined, userId: number): number | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  let payload: string;
  try {
    payload = Buffer.from(value.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sig = value.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SIGN_KEY).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  const [devStr, userStr, expStr] = payload.split('.');
  const deviceId = Number(devStr);
  const uid = Number(userStr);
  const exp = Number(expStr);
  if (!Number.isInteger(deviceId) || uid !== userId || !(exp > Date.now())) return null;
  return deviceId;
}

export function webfigCookieHeader(token: string): string {
  return `${WEBFIG_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

// Hop-by-hop headers are per-connection and must not be forwarded (RFC 7230).
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** Drop RubyMIK's own cookies so the RubyMIK session token never reaches the router. */
function sanitizeCookies(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header.split(';')
    .map((c) => c.trim())
    .filter((c) => c && !/^rubymik_(session|webfig)=/.test(c));
  return kept.length ? kept.join('; ') : undefined;
}

function isDefaultPort(scheme: 'http' | 'https', port: number): boolean {
  return (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
}

/** Rewrite an upstream Location so an absolute redirect to the router host stays on RubyMIK's origin. */
function rewriteLocation(loc: string, deviceHost: string): string {
  try {
    const u = new URL(loc);
    if (u.hostname === deviceHost) return u.pathname + u.search + u.hash;
    return loc;
  } catch {
    return loc; // relative path — already correct through the root-path proxy
  }
}

/** A router Set-Cookie must survive RubyMIK's (possibly plain-HTTP) origin. */
function rewriteSetCookie(values: string[]): string[] {
  return values.map((c) =>
    c.split(';')
      .filter((p) => !/^\s*(secure|domain=)/i.test(p))
      .join(';'));
}

export interface ProxyRow extends AddressableRow {
  id: number;
  name: string;
}

/**
 * Stream one request through to the device's WebFig, over the resolved transport.
 * `scheme`/`port` are resolved server-side (persisted on the device row at
 * session-open); `resolveEndpoint` picks direct host vs tunnel overlay IP.
 * No credential is added — pass-through auth (Option A).
 */
export function proxyToDevice(
  req: Request, res: Response, row: ProxyRow, scheme: 'http' | 'https', port: number,
): void {
  const { host, net } = resolveEndpoint(row);
  const lib = scheme === 'https' ? https : http;

  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (HOP.has(lk) || lk === 'host') continue;
    if (lk === 'cookie') {
      const c = sanitizeCookies(Array.isArray(v) ? v.join('; ') : v);
      if (c) headers['cookie'] = c;
      continue;
    }
    headers[k] = v;
  }
  headers['host'] = isDefaultPort(scheme, port) ? host : `${host}:${port}`;

  const options: https.RequestOptions = {
    host, port, method: req.method, path: req.originalUrl, headers, timeout: 20_000,
  };
  if (scheme === 'https') options.rejectUnauthorized = row.verify_tls === 1;

  const upstream = lib.request(options, (upRes) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (v === undefined) continue;
      const lk = k.toLowerCase();
      if (HOP.has(lk)) continue;
      // Strip frame/CSP blockers so WebFig renders inside RubyMIK's themed tab
      // (same-origin, auth-gated — this is our own proxied surface).
      if (lk === 'x-frame-options' || lk === 'content-security-policy' || lk === 'content-security-policy-report-only') continue;
      if (lk === 'set-cookie') { out['set-cookie'] = rewriteSetCookie(Array.isArray(v) ? v : [v]); continue; }
      if (lk === 'location' && typeof v === 'string') { out['location'] = rewriteLocation(v, host); continue; }
      out[k] = v;
    }
    res.writeHead(upRes.statusCode ?? 502, out);
    upRes.pipe(res);
  });

  upstream.on('timeout', () => upstream.destroy(new Error('device timed out')));
  upstream.on('error', (err) => {
    log.warn(`webfig proxy to "${row.name}" (${net}) failed: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: `Could not reach the router's web interface: ${err.message}` });
    else res.destroy();
  });
  req.pipe(upstream);
}

export type { NetTransport };
