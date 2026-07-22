import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  clearSessionCookie, createSession, destroySession, destroyUserSessions, getSessionId,
  getSessionUser, hashPassword, setSessionCookie, verifyPassword, writeAuthAudit,
} from '../auth.js';
import {
  consumeRecoveryCode, generateRecoveryCodes, generateSecret, storeRecoveryCodes, totpUri, verifyTotp,
} from '../totp.js';
import { log } from '../log.js';

interface UserRow {
  id: number; username: string; password_hash: string;
  disabled?: number; totp_enabled?: number; totp_secret?: string | null;
}

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

const THEMES = ['ruby-light', 'ruby-dark', 'modern-dark', 'modern-light', 'glass', 'classic'];
const ACCENTS = ['ruby', 'blue', 'red', 'green', 'purple', 'amber', 'teal'];

export function authRoutes(db: DatabaseSync, defaults: { theme: string; accent: string | null }): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/status', (req, res) => {
    res.json({
      needsSetup: userCount(db) === 0,
      authenticated: getSessionUser(db, req) !== undefined,
      installDefault: { theme: defaults.theme, accent: defaults.accent },
    });
  });

  // First-run only: create the admin account. Rejected once any user exists.
  router.post('/setup', async (req, res) => {
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
    db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)")
      .run(name, await hashPassword(password as string), new Date().toISOString());
    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(name) as unknown as UserRow;
    setSessionCookie(res, createSession(db, user.id));
    log.info(`Admin account "${name}" created (first-run setup)`);
    res.status(201).json({ username: user.username });
  });

  router.post('/login', async (req, res) => {
    const { username, password, code } = (req.body ?? {}) as Record<string, unknown>;
    const user = typeof username === 'string'
      ? db.prepare('SELECT id, username, password_hash, disabled, totp_enabled, totp_secret FROM users WHERE username = ?').get(username.trim()) as unknown as UserRow | undefined
      : undefined;
    if (!user || typeof password !== 'string' || !(await verifyPassword(password, user.password_hash))) {
      await sleep(500); // blunt brute-force damper
      writeAuthAudit(db, username, 'auth.login.fail', 'Invalid username or password.');
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }
    if (user.disabled) {
      writeAuthAudit(db, user.username, 'auth.login.fail', 'Account disabled.');
      res.status(403).json({ error: 'This account has been disabled.' });
      return;
    }
    // Second factor, if enrolled: accept a TOTP code OR a one-time recovery code.
    if (user.totp_enabled) {
      const c = typeof code === 'string' ? code.trim() : '';
      if (!c) { res.status(401).json({ error: 'A 2FA code is required.', needsCode: true }); return; }
      const ok = verifyTotp(user.totp_secret ?? '', c) || consumeRecoveryCode(db, user.id, c);
      if (!ok) {
        await sleep(500);
        writeAuthAudit(db, user.username, 'auth.2fa.fail', 'Invalid 2FA code.');
        res.status(401).json({ error: 'That 2FA code is not valid.', needsCode: true });
        return;
      }
    }
    setSessionCookie(res, createSession(db, user.id));
    writeAuthAudit(db, user.username, 'auth.login.ok', '2FA: ' + (user.totp_enabled ? 'yes' : 'no'));
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
    const row = db.prepare('SELECT theme, accent, totp_enabled FROM users WHERE id = ?').get(user.id) as { theme: string | null; accent: string | null; totp_enabled: number } | undefined;
    res.json({ username: user.username, role: user.role, twoFactor: row?.totp_enabled === 1, theme: row?.theme ?? null, accent: row?.accent ?? null });
  });

  // Per-user theme override (purely presentational). null clears → install default.
  router.put('/me/theme', (req, res) => {
    const user = getSessionUser(db, req);
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const theme = b.theme === null ? null : typeof b.theme === 'string' && THEMES.includes(b.theme) ? b.theme : undefined;
    const accent = b.accent === null ? null : typeof b.accent === 'string' && ACCENTS.includes(b.accent) ? b.accent : undefined;
    if (theme === undefined && accent === undefined) { res.status(400).json({ error: 'Provide a valid theme and/or accent.' }); return; }
    if (theme !== undefined) db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, user.id);
    if (accent !== undefined) db.prepare('UPDATE users SET accent = ? WHERE id = ?').run(accent, user.id);
    const row = db.prepare('SELECT theme, accent FROM users WHERE id = ?').get(user.id) as { theme: string | null; accent: string | null };
    res.json({ theme: row.theme, accent: row.accent });
  });

  // --- P30 self-service (any authenticated role, including viewers) ---

  // Change own password (requires the current one). Logs OUT other sessions.
  router.put('/me/password', async (req, res) => {
    const user = getSessionUser(db, req);
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const next = typeof b.newPassword === 'string' ? b.newPassword : '';
    if (next.length < 8) { res.status(400).json({ error: 'New password must be at least 8 characters.' }); return; }
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!(await verifyPassword(typeof b.currentPassword === 'string' ? b.currentPassword : '', row.password_hash))) {
      res.status(403).json({ error: 'Your current password is incorrect.' }); return;
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), user.id);
    destroyUserSessions(db, user.id, getSessionId(req)); // keep this session, drop the rest
    writeAuthAudit(db, user.username, 'user.password_change', 'Changed own password');
    res.json({ ok: true });
  });

  // 2FA enrolment: begin → (scan the QR) → enable (confirm a code) → recovery codes (shown once).
  router.post('/me/2fa/begin', (req, res) => {
    const user = getSessionUser(db, req);
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const secret = generateSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, user.id);
    res.json({ secret, uri: totpUri(secret, user.username) });
  });

  router.post('/me/2fa/enable', (req, res) => {
    const user = getSessionUser(db, req);
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const code = String((req.body as { code?: unknown } | undefined)?.code ?? '').trim();
    const row = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(user.id) as { totp_secret: string | null };
    if (!row?.totp_secret) { res.status(400).json({ error: 'Start 2FA setup first.' }); return; }
    if (!verifyTotp(row.totp_secret, code)) { res.status(400).json({ error: 'That code is not valid — enter the current 6-digit code.' }); return; }
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
    const codes = generateRecoveryCodes();
    storeRecoveryCodes(db, user.id, codes);
    writeAuthAudit(db, user.username, 'user.2fa_enable', 'Enabled 2FA');
    res.json({ ok: true, recoveryCodes: codes }); // shown exactly once
  });

  router.post('/me/2fa/disable', async (req, res) => {
    const user = getSessionUser(db, req);
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    const pw = String((req.body as { password?: unknown } | undefined)?.password ?? '');
    if (!(await verifyPassword(pw, row.password_hash))) {
      res.status(403).json({ error: 'Password incorrect.' }); return;
    }
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
    writeAuthAudit(db, user.username, 'user.2fa_disable', 'Disabled own 2FA');
    res.json({ ok: true });
  });

  return router;
}
