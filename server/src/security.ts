import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Request, Response, NextFunction } from 'express';

/**
 * P39 — go-live security hardening: a login rate-limiter/lockout, a Content-
 * Security-Policy + hardening headers, and the client-IP helper both rely on.
 * No new product features — this is the guard rail between "works on the bench"
 * and "reachable by strangers".
 */

// ---------------- client IP (honours a trusted proxy) ----------------

/** The client's IP. With `trust proxy` set on the app, Express populates req.ip
 *  from X-Forwarded-For; otherwise it's the socket address. Used for rate-limit
 *  keys and audit — never for authz. */
export function clientIp(req: Request): string {
  return (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

// ---------------- login rate-limit + lockout ----------------

export interface LimiterVerdict { locked: boolean; retryAfterSec: number; justLocked: boolean }

/**
 * In-memory failed-login limiter (single-process app — no shared store needed).
 * Keyed by ip+username so one attacker can't lock every account, and one account
 * under spray still locks. After `maxFails` failures inside `windowMs`, the key is
 * locked for `lockMs`. A success clears it.
 */
export class LoginLimiter {
  private readonly hits = new Map<string, { count: number; firstAt: number; lockUntil: number }>();
  constructor(
    private readonly maxFails = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly lockMs = 15 * 60_000,
  ) {}

  private key(ip: string, username: string): string { return `${ip}|${String(username).toLowerCase().trim()}`; }
  private prune(now: number): void {
    if (this.hits.size < 4096) return;
    for (const [k, v] of this.hits) if (v.lockUntil < now && now - v.firstAt > this.windowMs) this.hits.delete(k);
  }

  /** Is this key currently locked? (Call before verifying the password.) */
  check(ip: string, username: string, now = Date.now()): LimiterVerdict {
    const e = this.hits.get(this.key(ip, username));
    if (e && e.lockUntil > now) return { locked: true, retryAfterSec: Math.ceil((e.lockUntil - now) / 1000), justLocked: false };
    return { locked: false, retryAfterSec: 0, justLocked: false };
  }

  /** Record a failed attempt; returns whether this attempt tripped the lock. */
  fail(ip: string, username: string, now = Date.now()): LimiterVerdict {
    this.prune(now);
    const k = this.key(ip, username);
    let e = this.hits.get(k);
    if (!e || now - e.firstAt > this.windowMs) e = { count: 0, firstAt: now, lockUntil: 0 };
    e.count += 1;
    let justLocked = false;
    if (e.count >= this.maxFails) { const was = e.lockUntil > now; e.lockUntil = now + this.lockMs; justLocked = !was; }
    this.hits.set(k, e);
    const locked = e.lockUntil > now;
    return { locked, retryAfterSec: locked ? Math.ceil((e.lockUntil - now) / 1000) : 0, justLocked };
  }

  /** Clear on a successful login. */
  succeed(ip: string, username: string): void { this.hits.delete(this.key(ip, username)); }
}

// ---------------- Content-Security-Policy + hardening headers ----------------

/** sha256-CSP source tokens for every INLINE <script>…</script> in an index.html
 *  (Vite ships a small theme-flash preventer inline). Computed from the actually-
 *  served file at startup, so a rebuild can never desync the hash. */
export function inlineScriptHashes(indexHtmlPath: string): string[] {
  let html: string;
  try { html = fs.readFileSync(indexHtmlPath, 'utf8'); } catch { return []; }
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const hash = crypto.createHash('sha256').update(m[1] ?? '', 'utf8').digest('base64');
    out.push(`'sha256-${hash}'`);
  }
  return out;
}

export interface CspOptions { scriptHashes: string[]; webfigPort: number }

/** As strict as the app tolerates: default-src 'self'; scripts are 'self' + the
 *  known inline hash (NO 'unsafe-inline'); styles allow inline (Tailwind/React set
 *  style attributes); images allow data: (QR codes, favicons); the WebFig iframe
 *  (a router admin UI on the proxy port) is the only cross-origin frame allowed. */
export function buildCsp(opts: CspOptions): string {
  const scriptSrc = ["'self'", ...opts.scriptHashes].join(' ');
  const frameSrc = opts.webfigPort > 0 ? `'self' http://*:${opts.webfigPort} https://*:${opts.webfigPort}` : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${frameSrc}`,
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** Security headers on every response. Applied app-wide. */
export function securityHeaders(opts: CspOptions) {
  const csp = buildCsp(opts);
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  };
}
