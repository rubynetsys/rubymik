#!/usr/bin/env node
// RubyMIK admin account recovery — the supported "I'm locked out" path for self-
// hosters. Resets a named account via the app's OWN argon2id hashing, invalidates
// its sessions, optionally clears 2FA, and audits the action. Prints the new
// password ONCE. Writes it nowhere.
//
// Interactive (default):
//   docker exec -it rubymik node scripts/reset-admin.mjs
//
// Non-interactive (automation / no TTY):
//   docker exec rubymik node scripts/reset-admin.mjs --account you@example.com --generate
//   …optional: --password 'newpass123'   --clear-2fa
//
// (Locally: run from the repo root after `npm run build`.)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import { DatabaseSync } from 'node:sqlite';

// --- locate the compiled auth module (in-image: /app/dist; local: server/dist) ---
async function loadAuth() {
  for (const rel of ['../dist/auth.js', '../server/dist/auth.js', './dist/auth.js']) {
    try { return await import(new URL(rel, import.meta.url).href); } catch { /* try next */ }
  }
  throw new Error('Could not find the compiled auth module. Build first (npm run build) or run inside the container.');
}
function findDb() {
  const cands = [];
  if (process.env.RUBYMIK_DATA_DIR) cands.push(path.join(process.env.RUBYMIK_DATA_DIR, 'rubymik.db'));
  cands.push('/data/rubymik.db', path.resolve('data/rubymik.db'), path.resolve('server/data/rubymik.db'));
  const hit = cands.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`Could not find rubymik.db. Looked in:\n  ${cands.join('\n  ')}\nSet RUBYMIK_DATA_DIR.`);
  return hit;
}
function genPassword(len = 18) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(len);
  return [...b].map((x) => abc[x % abc.length]).join('');
}

// --- args (non-interactive when --account is given) ---
const args = argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined; };
const argAccount = opt('--account');

const { hashPassword } = await loadAuth();
const dbPath = findDb();
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 8000');
const users = db.prepare('SELECT id, email, username, role, disabled, totp_enabled FROM users ORDER BY id').all();
if (!users.length) { console.error('No user accounts exist yet — nothing to reset.'); exit(1); }
const findUser = (who) => users.find((u) => (u.email ?? '').toLowerCase() === who || u.username.toLowerCase() === who);

async function pickInteractive() {
  console.log(`\nRubyMIK admin recovery  ·  DB: ${dbPath}\n\nAccounts:`);
  for (const u of users) console.log(`  - ${u.email ?? u.username}${u.email ? '' : '  (no email claimed)'}  [${u.role}${u.disabled ? ', disabled' : ''}${u.totp_enabled ? ', 2FA on' : ''}]`);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const who = (await rl.question('\nWhich account to reset? (email or username): ')).trim().toLowerCase();
    const user = findUser(who);
    if (!user) { console.error(`No account matches "${who}".`); exit(1); }
    const gen = (await rl.question('Generate a random password? [Y/n]: ')).trim().toLowerCase() !== 'n';
    let pw;
    if (gen) pw = genPassword();
    else { pw = await rl.question('New password (min 8 chars): '); if (typeof pw !== 'string' || pw.length < 8) { console.error('Password must be at least 8 characters.'); exit(1); } }
    let clear2fa = false;
    if (user.totp_enabled) clear2fa = (await rl.question("Clear this account's 2FA too? [y/N]: ")).trim().toLowerCase() === 'y';
    return { user, pw, clear2fa };
  } finally { rl.close(); }
}

function pickFromArgs() {
  const user = findUser(String(argAccount).toLowerCase());
  if (!user) { console.error(`No account matches "${argAccount}".`); exit(1); }
  const argPw = opt('--password');
  if (argPw !== undefined && argPw.length < 8) { console.error('--password must be at least 8 characters.'); exit(1); }
  const pw = argPw ?? genPassword();
  return { user, pw, clear2fa: flag('--clear-2fa') };
}

const { user, pw, clear2fa } = argAccount ? pickFromArgs() : await pickInteractive();

db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(pw), user.id);
if (clear2fa) {
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
}
const delSess = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
db.prepare(`INSERT INTO config_audit (device_id, device_name, actor, action, target, summary, before_json, after_json, result, detail, created_at)
  VALUES (NULL, '(auth)', 'cli-maintenance', 'user.admin_password_reset', 'auth', ?, NULL, NULL, 'applied', ?, ?)`).run(
  `CLI password reset for "${user.email ?? user.username}"`,
  `New password set via scripts/reset-admin.mjs; ${clear2fa ? '2FA cleared; ' : ''}${delSess.changes} session(s) invalidated. In-memory login lockout (if any) clears on the next container restart.`,
  new Date().toISOString(),
);
db.close();

console.log('\n─────────────────────────────────────────────');
console.log(`  Account:  ${user.email ?? user.username}`);
console.log(`  New password:  ${pw}`);
console.log('─────────────────────────────────────────────');
console.log('Shown once. Log in and change it. Sessions were invalidated.');
console.log('If the account was locked out from failed logins, restart the container to clear it.');
