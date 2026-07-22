import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * P30 — TOTP (RFC 6238) + one-time recovery codes, on node:crypto only (no deps).
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A fresh base32 TOTP secret (20 bytes = 160 bits, per RFC 4226 recommendation). */
export function generateSecret(bytes = 20): string {
  const buf = crypto.randomBytes(bytes);
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = '';
  for (const c of clean) { const idx = B32.indexOf(c); if (idx >= 0) bits += idx.toString(2).padStart(5, '0'); }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return (code % 1_000_000).toString().padStart(6, '0');
}

/** Verify a 6-digit code against a base32 secret, ±`window` 30s steps for clock skew. */
export function verifyTotp(secretB32: string, code: string, window = 1, step = 30): boolean {
  if (!/^\d{6}$/.test(code) || !secretB32) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor(Date.now() / 1000 / step);
  const target = Buffer.from(code);
  for (let w = -window; w <= window; w++) {
    const candidate = Buffer.from(hotp(secret, counter + w));
    if (candidate.length === target.length && crypto.timingSafeEqual(candidate, target)) return true;
  }
  return false;
}

/** The current code (used by tests + the enrolment "self-test"). */
export function currentTotp(secretB32: string, step = 30): string {
  return hotp(base32Decode(secretB32), Math.floor(Date.now() / 1000 / step));
}

export function totpUri(secret: string, account: string, issuer = 'RubyMIK'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// --- One-time recovery codes ---

export function generateRecoveryCodes(n = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

const normalizeCode = (code: string): string => code.replace(/[\s-]/g, '').toLowerCase();
export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

/** Store a fresh set of hashed recovery codes for a user, replacing any prior set. */
export function storeRecoveryCodes(db: DatabaseSync, userId: number, codes: string[]): void {
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)');
  for (const c of codes) ins.run(userId, hashRecoveryCode(c));
}

/** Consume a recovery code (single-use). Returns true if a live code matched. */
export function consumeRecoveryCode(db: DatabaseSync, userId: number, code: string): boolean {
  const h = hashRecoveryCode(code);
  const row = db.prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
    .get(userId, h) as { id: number } | undefined;
  if (!row) return false;
  db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return true;
}

export function remainingRecoveryCodes(db: DatabaseSync, userId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { n: number }).n;
}
