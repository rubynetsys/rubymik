// P30 — TOTP (RFC 6238) verify + one-time recovery codes.
//   node --test test/totp.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../dist/db.js';
import { generateSecret, currentTotp, verifyTotp, generateRecoveryCodes, storeRecoveryCodes, consumeRecoveryCode, remainingRecoveryCodes } from '../dist/totp.js';

test('TOTP: the current code verifies; a wrong one does not', () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]+$/, 'secret is base32');
  const code = currentTotp(secret);
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotp(secret, code), true, 'current code verifies');
  assert.equal(verifyTotp(secret, '000000'), false, 'a wrong code is rejected');
  assert.equal(verifyTotp(secret, 'abc'), false, 'non-numeric rejected');
});

test('recovery codes are single-use', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-rc-'));
  const db = openDb(dir);
  try {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)').run('zzz-u', 'h', now);
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, 10);
    storeRecoveryCodes(db, 1, codes);
    assert.equal(remainingRecoveryCodes(db, 1), 10);
    assert.equal(consumeRecoveryCode(db, 1, codes[0]), true, 'first use of a code works');
    assert.equal(consumeRecoveryCode(db, 1, codes[0]), false, 'the same code cannot be used twice');
    assert.equal(remainingRecoveryCodes(db, 1), 9);
    assert.equal(consumeRecoveryCode(db, 1, 'not-a-real-code'), false);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
