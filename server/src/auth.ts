import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, NextFunction } from 'express';
import { argon2id, argon2Verify } from 'hash-wasm';

const SESSION_COOKIE = 'rubymik_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// P30: argon2id (OWASP minimum: 19 MiB, t=2, p=1) via hash-wasm — pure WASM, so it
// keeps the "no native deps / multi-arch" build invariant that ruled out native argon2.
const ARGON = { parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32 } as const;

// --- Password hashing (argon2id for new hashes; legacy scrypt still verified) ---

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return argon2id({ password, salt, ...ARGON, outputType: 'encoded' });
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith('$argon2')) {
    try { return await argon2Verify({ password, hash: stored }); } catch { return false; }
  }
  // Legacy scrypt hashes (the first admin, created before P30) still verify.
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(hashB64!, 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: Number(nStr), r: Number(rStr), p: Number(pStr),
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// --- Roles ---

export type Role = 'admin' | 'editor' | 'viewer';
export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

// --- Sessions (stored in SQLite, opaque random id in an HttpOnly cookie) ---

export interface SessionUser {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
}

/** Drop every session for a user (on disable, role change, or password change). */
export function destroyUserSessions(db: DatabaseSync, userId: number, exceptSessionId?: string): void {
  if (exceptSessionId) db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptSessionId);
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Audit an auth/user-management event (no device). Never records secrets. */
export function writeAuthAudit(db: DatabaseSync, actor: unknown, action: string, detail: string): void {
  const result = action.includes('fail') ? 'rejected' : 'applied';
  db.prepare(`
    INSERT INTO config_audit (device_id, device_name, actor, action, target, summary, before_json, after_json, result, detail, created_at)
    VALUES (NULL, '(auth)', ?, ?, 'auth', ?, NULL, NULL, ?, ?, ?)
  `).run(String(actor ?? 'unknown').slice(0, 64), action, action, result, detail, new Date().toISOString());
}

export function createSession(db: DatabaseSync, userId: number): string {
  const id = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(now).toISOString());
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString());
  return id;
}

export function destroySession(db: DatabaseSync, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function getSessionId(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

export function getSessionUser(db: DatabaseSync, req: Request): SessionUser | undefined {
  const sid = getSessionId(req);
  if (!sid) return undefined;
  const row = db.prepare(`
    SELECT u.id AS id, u.username AS username, u.role AS role, u.disabled AS disabled
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?
  `).get(sid, new Date().toISOString()) as { id: number; username: string; role: string; disabled: number } | undefined;
  if (!row) return undefined;
  const role: Role = row.role === 'editor' || row.role === 'viewer' ? row.role : 'admin';
  return { id: row.id, username: row.username, role, disabled: row.disabled === 1 };
}

export function setSessionCookie(req: Request, res: Response, sessionId: string): void {
  // `Secure` is added automatically when the request arrived over HTTPS — which,
  // behind a TLS-terminating reverse proxy, means X-Forwarded-Proto=https AND
  // `trust proxy` is enabled (see RUBYMIK_TRUST_PROXY). On a plain-HTTP LAN
  // (http://localhost:8080) it is omitted so the cookie still works.
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
}

export function clearSessionCookie(req: Request, res: Response): void {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

export function requireAuth(db: DatabaseSync) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getSessionUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (user.disabled) {
      res.status(403).json({ error: 'This account has been disabled.' });
      return;
    }
    (req as Request & { user: SessionUser }).user = user;
    next();
  };
}

/** Require at least `min` role on an already-authenticated request. */
export function requireRole(min: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: SessionUser }).user;
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    if (ROLE_RANK[user.role] < ROLE_RANK[min]) {
      res.status(403).json({ error: `This action requires the ${min} role or higher.` });
      return;
    }
    next();
  };
}

/**
 * P30 global role gate (mounted once on /api, AFTER the self-service auth routes).
 * Server-side is the source of truth; the UI only hides controls cosmetically.
 *   - unauthenticated → pass through (the per-router requireAuth returns 401)
 *   - disabled account → 403
 *   - /api/users, /api/settings → admin only
 *   - GET (reads) → any authenticated role
 *   - non-GET (writes) → editor or admin (viewer is read-only → 403)
 */
export function roleEnforcer(db: DatabaseSync) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getSessionUser(db, req);
    if (!user) { next(); return; }
    if (user.disabled) { res.status(403).json({ error: 'This account has been disabled.' }); return; }
    (req as Request & { user: SessionUser }).user = user;
    const url = (req.originalUrl.split('?')[0]) || '';
    if (/^\/api\/(users|settings)(\/|$)/.test(url)) {
      if (user.role !== 'admin') { res.status(403).json({ error: 'This area is for administrators only.' }); return; }
      next();
      return;
    }
    if (req.method === 'GET') { next(); return; }
    if (ROLE_RANK[user.role] < ROLE_RANK.editor) {
      res.status(403).json({ error: 'Your account is read-only — you do not have permission to make changes.' });
      return;
    }
    next();
  };
}
