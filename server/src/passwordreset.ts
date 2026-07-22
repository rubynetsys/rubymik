import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * P40 — forgot-password tokens. The raw 32-byte token is emailed to the user; only
 * its sha256 is stored, so a DB read can't mint a working link. Single-use
 * (used_at) and short-lived (30 min).
 */
const TTL_MS = 30 * 60 * 1000;

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Mint a single-use reset token for a user; returns the RAW token (shown once). */
export function createResetToken(db: DatabaseSync, userId: number, now = Date.now()): string {
  const raw = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, created_at, expires_at) VALUES (?,?,?,?)')
    .run(userId, hashToken(raw), new Date(now).toISOString(), new Date(now + TTL_MS).toISOString());
  // tidy up this user's spent/expired tokens
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND (used_at IS NOT NULL OR expires_at < ?)')
    .run(userId, new Date(now).toISOString());
  return raw;
}

/** Resolve a raw token to its (unused, unexpired) row → the user id, else null. */
export function findValidReset(db: DatabaseSync, raw: string, now = Date.now()): { id: number; userId: number } | null {
  if (!raw || typeof raw !== 'string') return null;
  const r = db.prepare('SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?')
    .get(hashToken(raw)) as { id: number; user_id: number; expires_at: string; used_at: string | null } | undefined;
  if (!r || r.used_at || Date.parse(r.expires_at) < now) return null;
  return { id: r.id, userId: r.user_id };
}

export function markResetUsed(db: DatabaseSync, tokenId: number): void {
  db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?').run(new Date().toISOString(), tokenId);
}
