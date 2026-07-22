// P31 — multi-channel notifier: secrets encrypted + masked, channel failures are
// logged (never thrown), WhatsApp is mocked until paired.
//   node --test test/notify.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../dist/db.js';
import { SecretBox } from '../dist/secretbox.js';
import { Notifier } from '../dist/notify.js';

function fx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-notify-'));
  const db = openDb(dir);
  const box = SecretBox.load(dir, undefined);
  return { dir, db, n: new Notifier(db, box) };
}
const rawRow = (db) => db.prepare('SELECT * FROM notification_settings WHERE id = 1').get();

test('secrets are encrypted at rest and masked on read (never plaintext)', () => {
  const { dir, db, n } = fx();
  try {
    n.saveConfig({ smtp: { enabled: true, host: 'mail.example.com', port: 2525, secure: 'starttls', user: 'u@example.com', password: 'supersecretpw', from: 'a@example.com', to: 'b@example.com' } });
    n.saveConfig({ telegram: { enabled: true, token: '123:ABCtoken', chatId: '42' } });
    const row = rawRow(db);
    assert.ok(String(row.smtp_pass_enc).startsWith('gcm1:'), 'SMTP password stored AES-GCM');
    assert.ok(String(row.telegram_token_enc).startsWith('gcm1:'), 'Telegram token stored AES-GCM');
    const dump = JSON.stringify(row);
    assert.ok(!dump.includes('supersecretpw') && !dump.includes('123:ABCtoken'), 'no plaintext secret in the row');
    const masked = n.getMasked();
    assert.equal(masked.smtp.passSet, true);
    assert.equal(masked.telegram.tokenSet, true);
    const mdump = JSON.stringify(masked);
    assert.ok(!mdump.includes('supersecretpw') && !mdump.includes('123:ABCtoken'), 'masked config exposes no secret');
    assert.equal(masked.smtp.host, 'mail.example.com', 'non-secret fields are returned');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('WhatsApp is mocked until paired/provisioned', async () => {
  const { dir, db, n } = fx();
  try {
    n.saveConfig({ whatsapp: { enabled: true, provider: 'baileys', to: '+27000000000' } });
    const r = await n.sendTest('whatsapp');
    assert.equal(r.status, 'mocked');
    assert.equal(r.ok, true, 'a mock is not a failure');
    const logRow = n.readLog(5).find((l) => l.channel === 'whatsapp');
    assert.equal(logRow.status, 'mocked', 'the mock is recorded in the notification log');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a broken channel is logged as failed and never throws', async () => {
  const { dir, db, n } = fx();
  try {
    // SMTP pointed at a dead local port → connection refused, must be caught
    n.saveConfig({ smtp: { enabled: true, host: '127.0.0.1', port: 1, secure: 'none', from: 'a@example.com', to: 'b@example.com' } });
    const r = await n.sendTest('smtp');
    assert.equal(r.ok, false);
    assert.equal(r.status, 'failed');
    const logRow = n.readLog(5).find((l) => l.channel === 'smtp');
    assert.equal(logRow.status, 'failed', 'the failure is recorded, not swallowed');
    // telegram with no token → validation failure, also caught (not thrown)
    n.saveConfig({ telegram: { enabled: true, chatId: '42' } });
    const t = await n.sendTest('telegram');
    assert.equal(t.ok, false);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
