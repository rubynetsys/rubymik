import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  requireAuth, requireRole, hashPassword, destroyUserSessions, writeAuthAudit,
  normalizeEmail, identityOf, type Role, type SessionUser,
} from '../auth.js';

const ROLES: Role[] = ['admin', 'editor', 'viewer'];

interface Row {
  id: number; username: string; email: string | null; role: string; disabled: number;
  totp_enabled: number; created_at: string;
}

/** A strong, unambiguous random password (no lookalike characters). */
function generatePassword(len = 18): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += abc[bytes[i]! % abc.length];
  return out;
}

function publicUser(r: Row) {
  return { id: r.id, email: r.email, username: r.username, role: r.role, disabled: r.disabled === 1, twoFactor: r.totp_enabled === 1, createdAt: r.created_at };
}
const SEL = 'SELECT id, username, email, role, disabled, totp_enabled, created_at FROM users';

export function userRoutes(db: DatabaseSync): Router {
  const router = Router();
  router.use(requireAuth(db));
  router.use(requireRole('admin')); // belt-and-braces alongside the global roleEnforcer

  const activeAdmins = () => (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
  const actor = (req: Request) => (req as Request & { user: SessionUser }).user;
  const byId = (id: number) => db.prepare(`${SEL} WHERE id = ?`).get(id) as unknown as Row | undefined;

  router.get('/', (_req, res) => {
    res.json((db.prepare(`${SEL} ORDER BY email`).all() as unknown as Row[]).map(publicUser));
  });

  router.post('/', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(b.email);
    const role = (typeof b.role === 'string' && (ROLES as string[]).includes(b.role)) ? b.role : 'viewer';
    if (!email) { res.status(400).json({ error: 'Enter a valid email address.' }); return; }
    // email is the identity; username mirrors it (keeps username NOT-NULL/UNIQUE and
    // makes every audit row read as the email).
    if (db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, email)) { res.status(409).json({ error: 'That email is already in use.' }); return; }
    let password = typeof b.password === 'string' && b.password.length > 0 ? b.password : null;
    if (password !== null && password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters.' }); return; }
    const generated = password === null;
    if (password === null) password = generatePassword();
    const now = new Date().toISOString();
    const r = db.prepare('INSERT INTO users (username, email, password_hash, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(email, email, await hashPassword(password), role, now);
    writeAuthAudit(db, identityOf(actor(req)), 'user.create', `Invited "${email}" as ${role}`);
    const row = byId(r.lastInsertRowid as number)!;
    // The password is returned exactly ONCE (generated or as typed), never stored/logged plaintext.
    res.status(201).json({ ...publicUser(row), ...(generated ? { generatedPassword: password } : {}) });
  });

  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare('SELECT id, username, role, disabled FROM users WHERE id = ?').get(id) as { id: number; username: string; role: string; disabled: number } | undefined;
    if (!target) { res.status(404).json({ error: 'User not found.' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const me = actor(req);
    const role = (typeof b.role === 'string' && (ROLES as string[]).includes(b.role)) ? b.role : target.role;
    const disabled = typeof b.disabled === 'boolean' ? (b.disabled ? 1 : 0) : target.disabled;
    const wasActiveAdmin = target.role === 'admin' && target.disabled === 0;
    const staysActiveAdmin = role === 'admin' && disabled === 0;
    if (wasActiveAdmin && !staysActiveAdmin && activeAdmins() <= 1) {
      res.status(400).json({ error: 'This is the last active administrator — promote another admin first.' }); return;
    }
    if (target.id === me.id && (role !== 'admin' || disabled === 1)) {
      res.status(400).json({ error: "You can't demote or disable your own account." }); return;
    }
    db.prepare('UPDATE users SET role = ?, disabled = ? WHERE id = ?').run(role, disabled, id);
    if (role !== target.role || disabled !== target.disabled) destroyUserSessions(db, id); // force re-login under the new access
    writeAuthAudit(db, identityOf(me), 'user.update', `Set "${target.username}" role=${role} disabled=${disabled === 1}`);
    res.json(publicUser(byId(id)!));
  });

  router.post('/:id/reset-password', async (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) as { id: number; username: string } | undefined;
    if (!target) { res.status(404).json({ error: 'User not found.' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    let password = typeof b.password === 'string' && b.password.length > 0 ? b.password : null;
    if (password !== null && password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters.' }); return; }
    const generated = password === null;
    if (password === null) password = generatePassword();
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), id);
    destroyUserSessions(db, id); // log the user out everywhere
    writeAuthAudit(db, identityOf(actor(req)), 'user.reset_password', `Reset the password for "${target.username}"`);
    res.json({ ok: true, username: target.username, ...(generated ? { generatedPassword: password } : {}) });
  });

  // Admin recovery path: force-disable a user's 2FA (e.g. lost authenticator).
  router.post('/:id/disable-2fa', (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) as { id: number; username: string } | undefined;
    if (!target) { res.status(404).json({ error: 'User not found.' }); return; }
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(id);
    writeAuthAudit(db, identityOf(actor(req)), 'user.2fa_reset', `Force-disabled 2FA for "${target.username}"`);
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare('SELECT id, username, role, disabled FROM users WHERE id = ?').get(id) as { id: number; username: string; role: string; disabled: number } | undefined;
    if (!target) { res.status(404).json({ error: 'User not found.' }); return; }
    const me = actor(req);
    if (target.id === me.id) { res.status(400).json({ error: "You can't delete your own account." }); return; }
    if (target.role === 'admin' && target.disabled === 0 && activeAdmins() <= 1) {
      res.status(400).json({ error: 'This is the last active administrator.' }); return;
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions + recovery codes cascade
    writeAuthAudit(db, identityOf(me), 'user.delete', `Deleted "${target.username}"`);
    res.json({ ok: true });
  });

  return router;
}
