import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, NextFunction } from 'express';

const SESSION_COOKIE = 'rubymik_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;

// --- Password hashing (Node built-in scrypt — no native deps) ---

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return `scrypt:${SCRYPT_PARAMS.N}:${SCRYPT_PARAMS.r}:${SCRYPT_PARAMS.p}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(hashB64!, 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: Number(nStr), r: Number(rStr), p: Number(pStr),
  });
  return crypto.timingSafeEqual(actual, expected);
}

// --- Sessions (stored in SQLite, opaque random id in an HttpOnly cookie) ---

export interface SessionUser {
  id: number;
  username: string;
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
    SELECT u.id AS id, u.username AS username
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?
  `).get(sid, new Date().toISOString()) as SessionUser | undefined;
  return row;
}

export function setSessionCookie(res: Response, sessionId: string): void {
  // Not `Secure` by default: RubyMIK's default deployment is plain HTTP on a
  // LAN (http://localhost:8080, http://raspberrypi.local:8080).
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function requireAuth(db: DatabaseSync) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getSessionUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    (req as Request & { user: SessionUser }).user = user;
    next();
  };
}
