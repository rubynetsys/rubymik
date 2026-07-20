import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  clearSessionCookie, createSession, destroySession, getSessionId,
  getSessionUser, hashPassword, setSessionCookie, verifyPassword,
} from '../auth.js';
import { log } from '../log.js';

interface UserRow { id: number; username: string; password_hash: string }

function userCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

function validCredentials(username: unknown, password: unknown): string | null {
  if (typeof username !== 'string' || username.trim().length < 3) {
    return 'Username must be at least 3 characters.';
  }
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  return null;
}

export function authRoutes(db: DatabaseSync): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/status', (req, res) => {
    res.json({
      needsSetup: userCount(db) === 0,
      authenticated: getSessionUser(db, req) !== undefined,
    });
  });

  // First-run only: create the admin account. Rejected once any user exists.
  router.post('/setup', (req, res) => {
    if (userCount(db) > 0) {
      res.status(409).json({ error: 'Setup is already complete.' });
      return;
    }
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    const invalid = validCredentials(username, password);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    const name = (username as string).trim();
    db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(name, hashPassword(password as string), new Date().toISOString());
    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(name) as unknown as UserRow;
    setSessionCookie(res, createSession(db, user.id));
    log.info(`Admin account "${name}" created (first-run setup)`);
    res.status(201).json({ username: user.username });
  });

  router.post('/login', async (req, res) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    const user = typeof username === 'string'
      ? db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username.trim()) as unknown as UserRow | undefined
      : undefined;
    if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash)) {
      await sleep(500); // blunt brute-force damper
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }
    setSessionCookie(res, createSession(db, user.id));
    res.json({ username: user.username });
  });

  router.post('/logout', (req, res) => {
    const sid = getSessionId(req);
    if (sid) destroySession(db, sid);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const user = getSessionUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.json({ username: user.username });
  });

  return router;
}
