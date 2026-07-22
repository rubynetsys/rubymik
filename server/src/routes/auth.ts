import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  clearSessionCookie, createSession, destroySession, destroyUserSessions, getSessionId,
  getSessionUser, hashPassword, setSessionCookie, verifyPassword, writeAuthAudit,
  normalizeEmail, identityOf, findLoginUser,
} from '../auth.js';
import {
  consumeRecoveryCode, generateRecoveryCodes, generateSecret, storeRecoveryCodes, totpUri, verifyTotp,
} from '../totp.js';
import { APP_VERSION } from '../version.js';
import { TARGET_SCHEMA } from '../db.js';
import { LoginLimiter, clientIp } from '../security.js';
import { createResetToken, findValidReset, markResetUsed } from '../passwordreset.js';
import type { Notifier } from '../notify.js';
import { log } from '../log.js';

interface UserRow {
  id: number; username: string; password_hash: string;
  disabled?: number; totp_enabled?: number; totp_secret?: string | null;
}

function userCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

/** P40: accounts are keyed by email. Returns [normalizedEmail] or an error string. */
function validEmailCredentials(email: unknown, password: unknown): { email: string } | string {
  const e = normalizeEmail(email);
  if (!e) return 'Enter a valid email address.';
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  return { email: e };
}

const THEMES = ['ruby-light', 'ruby-dark', 'modern-dark', 'modern-light', 'glass', 'classic'];
const ACCENTS = ['ruby', 'blue', 'red', 'green', 'purple', 'amber', 'teal'];

export function authRoutes(db: DatabaseSync, defaults: { theme: string; accent: string | null; demoBanner?: string | null; demoCredentials?: { email: string; password: string } | null }, notifier?: Notifier, publicUrl?: string): Router {
  const router = Router();
  // P39: brute-force lockout — 5 failures per (IP, username) inside 15 min → locked
  // for 15 min. In-memory (single-process app). Cleared on a successful login.
  const limiter = new LoginLimiter();
  // P40: a hard per-IP cap on password-reset requests (anti-bombing / anti-enumeration).
  const resetLimiter = new LoginLimiter(10, 15 * 60_000, 15 * 60_000);

  // Liveness + a little diagnostic context. Public (the Docker HEALTHCHECK and any
  // uptime monitor hit it before login). If the server is listening, migrations have
  // already completed (openDb runs to completion before listen), so ok=true.
  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: APP_VERSION, schema: TARGET_SCHEMA });
  });

  router.get('/status', (req, res) => {
    res.json({
      needsSetup: userCount(db) === 0,
      authenticated: getSessionUser(db, req) !== undefined,
      installDefault: { theme: defaults.theme, accent: defaults.accent },
      demoBanner: defaults.demoBanner ?? null,
      // P41: only ever populated in demo mode — the login "Try the demo" card. The
      // password shown here is the PUBLIC read-only viewer credential (intentional).
      demoCredentials: defaults.demoCredentials ?? null,
    });
  });

  // First-run only: create the admin account. Rejected once any user exists.
  router.post('/setup', async (req, res) => {
    if (userCount(db) > 0) {
      res.status(409).json({ error: 'Setup is already complete.' });
      return;
    }
    const { email, password } = (req.body ?? {}) as Record<string, unknown>;
    const valid = validEmailCredentials(email, password);
    if (typeof valid === 'string') { res.status(400).json({ error: valid }); return; }
    // username mirrors the email so it stays NOT-NULL/UNIQUE and every audit row
    // (which records the username) automatically reads as the email.
    db.prepare("INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
      .run(valid.email, valid.email, await hashPassword(password as string), new Date().toISOString());
    const user = db.prepare('SELECT id, username, email FROM users WHERE email = ?').get(valid.email) as unknown as UserRow & { email: string };
    setSessionCookie(req, res, createSession(db, user.id));
    log.info(`Admin account "${valid.email}" created (first-run setup)`);
    res.status(201).json({ email: user.email });
  });

  router.post('/login', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const { password, code } = b;
    const ip = clientIp(req);
    // Accept `email` (the P40 field) or legacy `username` as the identifier.
    const identifier = typeof b.email === 'string' ? b.email.trim() : typeof b.username === 'string' ? b.username.trim() : '';
    const key = (normalizeEmail(identifier) ?? identifier).toLowerCase();

    // P39: refuse before we even check the password when this (IP, account) is
    // locked out — with an audit trail and a Retry-After so honest clients back off.
    const gate = limiter.check(ip, key);
    if (gate.locked) {
      writeAuthAudit(db, key || '(none)', 'auth.login.locked', `Locked out from ${ip} — ${gate.retryAfterSec}s remaining.`);
      res.setHeader('Retry-After', String(gate.retryAfterSec));
      res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(gate.retryAfterSec / 60)} minute(s).` });
      return;
    }

    const user = identifier ? findLoginUser(db, identifier) : undefined;
    const passOk = !!user && typeof password === 'string' && await verifyPassword(password, user.password_hash);
    if (!user || !passOk) {
      const v = limiter.fail(ip, key);
      await sleep(500); // blunt brute-force damper
      writeAuthAudit(db, key, 'auth.login.fail', `Invalid email or password from ${ip}.`);
      if (v.justLocked) writeAuthAudit(db, key || '(none)', 'auth.login.locked', `Account locked after repeated failures from ${ip}.`);
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    const who = identityOf(user);
    if (user.disabled) {
      writeAuthAudit(db, who, 'auth.login.fail', 'Account disabled.');
      res.status(403).json({ error: 'This account has been disabled.' });
      return;
    }
    // Second factor, if enrolled: accept a TOTP code OR a one-time recovery code.
    if (user.totp_enabled) {
      const c = typeof code === 'string' ? code.trim() : '';
      if (!c) { res.status(401).json({ error: 'A 2FA code is required.', needsCode: true }); return; }
      const ok = verifyTotp(user.totp_secret ?? '', c) || consumeRecoveryCode(db, user.id, c);
      if (!ok) {
        const v = limiter.fail(ip, key);
        await sleep(500);
        writeAuthAudit(db, who, 'auth.2fa.fail', `Invalid 2FA code from ${ip}.`);
        if (v.justLocked) writeAuthAudit(db, who, 'auth.login.locked', `Account locked after repeated 2FA failures from ${ip}.`);
        res.status(401).json({ error: 'That 2FA code is not valid.', needsCode: true });
        return;
      }
    }
    limiter.succeed(ip, key);
    setSessionCookie(req, res, createSession(db, user.id));
    writeAuthAudit(db, who, 'auth.login.ok', '2FA: ' + (user.totp_enabled ? 'yes' : 'no'));
    // A pre-P40 account with no email yet must claim one before using the app.
    res.json({ email: user.email, username: user.username, needsEmailClaim: user.email === null });
  });

  // P40 forgot-password — PUBLIC. Enumeration-safe (identical response whether the
  // email exists or not), hard rate-limited per IP, and SMTP-gated. When SMTP isn't
  // set up it never dead-ends: the caller learns smtpConfigured=false and the UI
  // points self-hosters at the CLI reset.
  router.post('/forgot-password', async (req, res) => {
    const ip = clientIp(req);
    const email = normalizeEmail((req.body as { email?: unknown } | undefined)?.email);
    const smtpConfigured = !!notifier?.smtpReady();
    const gate = resetLimiter.check(ip, ip);
    if (gate.locked) { res.setHeader('Retry-After', String(gate.retryAfterSec)); res.status(429).json({ error: 'Too many reset requests. Try again later.' }); return; }
    resetLimiter.fail(ip, ip); // every request counts toward the per-IP cap
    if (email && smtpConfigured) {
      const user = db.prepare('SELECT id, email FROM users WHERE email = ? AND disabled = 0').get(email) as { id: number; email: string } | undefined;
      if (user) {
        try {
          const raw = createResetToken(db, user.id);
          const base = (publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
          const link = `${base}/reset-password?token=${raw}`;
          await notifier!.sendMailTo(user.email, 'RubyMIK password reset',
            [`Someone asked to reset the password for your RubyMIK account (${user.email}).`, '',
             'Use this link within 30 minutes (single use):', link, '',
             "If you didn't request this, ignore this email — nothing has changed.", '', '— RubyMIK'].join('\n'));
          writeAuthAudit(db, email, 'auth.password_reset.request', `Reset email sent (from ${ip}).`);
        } catch (err) { log.warn(`password-reset email failed: ${(err as Error).message}`); }
      } else {
        writeAuthAudit(db, email, 'auth.password_reset.request', `Reset requested for a non-existent/disabled account (from ${ip}).`);
      }
    }
    res.json({ ok: true, smtpConfigured }); // identical regardless of whether the email exists
  });

  // P40 reset-password — PUBLIC. Complete a reset with a valid single-use token.
  router.post('/reset-password', async (req, res) => {
    const b = (req.body ?? {}) as { token?: unknown; password?: unknown };
    const token = typeof b.token === 'string' ? b.token : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters.' }); return; }
    const valid = findValidReset(db, token);
    if (!valid) { res.status(400).json({ error: 'This reset link is invalid or has expired — request a new one.' }); return; }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), valid.userId);
    markResetUsed(db, valid.id);
    destroyUserSessions(db, valid.userId); // log out everywhere
    const u = db.prepare('SELECT email, username FROM users WHERE id = ?').get(valid.userId) as { email: string | null; username: string };
    writeAuthAudit(db, u.email ?? u.username, 'auth.password_reset.complete', 'Password reset via emailed link; all sessions invalidated.');
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    const sid = getSessionId(req);
    if (sid) destroySession(db, sid);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const user = getSessionUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const row = db.prepare('SELECT theme, accent, totp_enabled FROM users WHERE id = ?').get(user.id) as { theme: string | null; accent: string | null; totp_enabled: number } | undefined;
    res.json({ email: user.email, username: user.username, needsEmailClaim: user.email === null, role: user.role, twoFactor: row?.totp_enabled === 1, theme: row?.theme ?? null, accent: row?.accent ?? null });
  });

  // P40: one-time email claim for a pre-P40 account. Sets the email (and mirrors it
  // to username so audits read as the email). Any authenticated user may claim, but
  // only if they don't already have one.
  router.post('/me/claim-email', async (req, res) => {
    const user = getSessionUser(db, req);
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    if (user.email) { res.status(409).json({ error: 'This account already has an email.' }); return; }
    const email = normalizeEmail((req.body as { email?: unknown } | undefined)?.email);
    if (!email) { res.status(400).json({ error: 'Enter a valid email address.' }); return; }
    const taken = db.prepare('SELECT id FROM users WHERE (email = ? OR username = ?) AND id != ?').get(email, email, user.id);
    if (taken) { res.status(409).json({ error: 'That email is already in use.' }); return; }
    db.prepare('UPDATE users SET email = ?, username = ? WHERE id = ?').run(email, email, user.id);
    writeAuthAudit(db, email, 'user.email_claim', `Claimed email for the account previously "${user.username}"`);
    res.json({ email });
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
    writeAuthAudit(db, identityOf(user), 'user.password_change', 'Changed own password');
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
    writeAuthAudit(db, identityOf(user), 'user.2fa_enable', 'Enabled 2FA');
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
    writeAuthAudit(db, identityOf(user), 'user.2fa_disable', 'Disabled own 2FA');
    res.json({ ok: true });
  });

  return router;
}
