// P36.4 — alerting fault-injection. Silence is the failure mode (the 67h-outage
// lesson), so each fault must ALARM: a failed backup run, a failed off-host copy,
// and NO successful backup within the gap all fire a P31 alert and flip health to
// critical. Recovery clears it. No network — a fake notifier records sends.
//   node --test test/selfbackup.alert.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../dist/db.js';
import { SelfBackupScheduler } from '../dist/selfbackupscheduler.js';
import { backupHealth, writeOffhostConfig } from '../dist/selfbackup.js';

const bkKey = Buffer.from('c'.repeat(64), 'hex');
function fx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmk-al-'));
  const db = openDb(dir);
  return { dir, db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
function fakeNotifier() { const sent = []; return { sent, send: (event, alert) => sent.push({ event, alert }) }; }
const rules = (n) => n.sent.map((s) => s.alert.rule);

test('a FAILED backup run alerts + logs failed + health goes critical', async () => {
  const f = fx();
  try {
    const notif = fakeNotifier();
    const sched = new SelfBackupScheduler(f.db, bkKey, f.dir, 21600000, 28, notif, 8);
    // INJECT: make the backups dir a FILE so the backup can't write → run throws.
    fs.writeFileSync(path.join(f.dir, 'self-backups'), 'blocked');
    const out = await sched.run('scheduled');
    assert.equal(out.ok, false, 'run reports failure');
    assert.ok(rules(notif).includes('self_backup_backup'), 'a backup-failed alert fired');
    const h = backupHealth(f.db, { configured: true, gapHours: 8 });
    assert.equal(h.severity, 'critical');
    assert.match(h.reason, /FAILED|No successful/i);
  } finally { f.cleanup(); }
});

test('a FAILED off-host copy alerts, but the local backup still succeeds', async () => {
  const f = fx();
  try {
    const notif = fakeNotifier();
    const sched = new SelfBackupScheduler(f.db, bkKey, f.dir, 21600000, 28, notif, 8);
    // INJECT: enable off-host to an UNWRITABLE path (a file, not a dir).
    const badPath = path.join(f.dir, 'not-a-dir');
    fs.writeFileSync(badPath, 'x');
    writeOffhostConfig(f.db, { enabled: true, kind: 'path', path: path.join(badPath, 'sub') });
    const out = await sched.run('scheduled');
    assert.equal(out.ok, true, 'the local backup itself succeeds');
    assert.ok(rules(notif).includes('self_backup_offhost'), 'an off-host-failed alert fired');
    // last log row records offhost failed; health is warn (local ok)
    const h = backupHealth(f.db, { configured: true, gapHours: 8 });
    assert.equal(h.offhost.lastStatus, 'failed');
    assert.equal(h.severity, 'warn');
  } finally { f.cleanup(); }
});

test('watchdog: NO successful backup within the gap fires ONE gap alert', () => {
  const f = fx();
  try {
    const notif = fakeNotifier();
    const sched = new SelfBackupScheduler(f.db, bkKey, f.dir, 21600000, 28, notif, 8);
    // INJECT: an "ok" backup 9h ago and nothing since.
    const nineHAgo = new Date(Date.now() - 9 * 3_600_000).toISOString();
    f.db.prepare("INSERT INTO self_backup_log (ts, kind, status) VALUES (?, 'scheduled', 'ok')").run(nineHAgo);
    sched.checkWatchdog();
    sched.checkWatchdog(); // second tick must NOT double-alert (latched)
    assert.equal(rules(notif).filter((r) => r === 'self_backup_gap').length, 1, 'exactly one gap alert');
    const h = backupHealth(f.db, { configured: true, gapHours: 8 });
    assert.equal(h.severity, 'critical');
    assert.match(h.reason, /No successful backup in 9/);
  } finally { f.cleanup(); }
});

test('health: not-configured is critical; a fresh ok is healthy (banner clears on recovery)', async () => {
  const f = fx();
  try {
    // not configured → critical (backups are OFF)
    const noKey = backupHealth(f.db, { configured: false, gapHours: 8 });
    assert.equal(noKey.severity, 'critical');
    assert.match(noKey.reason, /OFF|no backup key/i);
    // a real successful run → healthy, banner clears
    const notif = fakeNotifier();
    const sched = new SelfBackupScheduler(f.db, bkKey, f.dir, 21600000, 28, notif, 8);
    const out = await sched.run('manual');
    assert.ok(out.ok);
    const h = backupHealth(f.db, { configured: true, gapHours: 8 });
    assert.equal(h.healthy, true);
    assert.equal(h.severity, 'ok');
  } finally { f.cleanup(); }
});
