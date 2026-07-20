// Write-safety framework unit tests: DHCP input validation + the safe-apply
// rollback state machine (probe + apply/verify/rollback stubbed, no network).
//   node --test test/safeapply.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { isValidMac, isValidIpv4, ipInCidr } from '../dist/dhcp.js';
import { runSafeApply } from '../dist/safeapply.js';

// --- validation ---
test('MAC validation', () => {
  assert.ok(isValidMac('AA:BB:CC:DD:EE:FF'));
  assert.ok(isValidMac('00:0c:29:1d:eb:be'));
  assert.ok(!isValidMac('AA-BB-CC-DD-EE-FF'));
  assert.ok(!isValidMac('AA:BB:CC:DD:EE'));
  assert.ok(!isValidMac('nope'));
});

test('IPv4 validation', () => {
  assert.ok(isValidIpv4('192.168.90.50'));
  assert.ok(!isValidIpv4('192.168.90.256'));
  assert.ok(!isValidIpv4('192.168.90'));
  assert.ok(!isValidIpv4('1.2.3.4.5'));
});

test('IP-in-CIDR subnet check', () => {
  assert.ok(ipInCidr('192.168.90.50', '192.168.90.0/24'));
  assert.ok(!ipInCidr('192.168.91.50', '192.168.90.0/24'), 'outside /24 rejected');
  assert.ok(ipInCidr('10.0.5.7', '10.0.0.0/16'));
  assert.ok(!ipInCidr('10.1.5.7', '10.0.0.0/16'));
});

// --- safe-apply state machine ---
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE config_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER, device_name TEXT, actor TEXT,
    action TEXT, target TEXT, summary TEXT, before_json TEXT, after_json TEXT, result TEXT,
    detail TEXT, created_at TEXT)`);
  return db;
}
const ctxFor = (db, probe) => ({
  db, target: {}, transport: { scheme: 'http', port: 80 }, actor: 'tester',
  deviceId: 1, deviceName: 'bench', action: 'test.op', targetLabel: 'x', probe,
});
const lastAudit = (db) => db.prepare('SELECT result, detail FROM config_audit ORDER BY id DESC LIMIT 1').get();

test('happy path: apply + verify ok → applied, no rollback', async () => {
  const db = freshDb();
  const calls = [];
  const out = await runSafeApply(ctxFor(db, async () => true), {
    snapshot: async () => ({ snap: 1 }),
    summary: () => 'do the thing',
    apply: async () => { calls.push('apply'); },
    verifyTook: async () => ({ ok: true, after: { done: true } }),
    rollback: async () => { calls.push('rollback'); },
  });
  assert.equal(out.result, 'applied');
  assert.deepEqual(calls, ['apply'], 'rollback must NOT run on success');
  assert.equal(lastAudit(db).result, 'applied');
});

test('forced verify failure → auto-rollback runs, audited rolled_back', async () => {
  const db = freshDb();
  const calls = [];
  const out = await runSafeApply(ctxFor(db, async () => true), {
    snapshot: async () => ({ snap: 1 }),
    summary: () => 'do the thing',
    apply: async () => { calls.push('apply'); },
    verifyTook: async () => ({ ok: true }),
    rollback: async () => { calls.push('rollback'); },
    forceVerifyFail: true,
  });
  assert.equal(out.result, 'rolled_back');
  assert.deepEqual(calls, ['apply', 'rollback'], 'apply then rollback');
  assert.match(lastAudit(db).detail, /rolled back/i);
});

test('device unreachable after apply → rollback runs (management-loss path)', async () => {
  const db = freshDb();
  const calls = [];
  const out = await runSafeApply(ctxFor(db, async () => false), {
    snapshot: async () => ({}),
    summary: () => 's',
    apply: async () => { calls.push('apply'); },
    verifyTook: async () => ({ ok: true }),
    rollback: async () => { calls.push('rollback'); },
  });
  assert.equal(out.result, 'rolled_back');
  assert.deepEqual(calls, ['apply', 'rollback']);
  assert.match(out.detail, /unreachable/i);
});

test('change did not take → rollback', async () => {
  const db = freshDb();
  const out = await runSafeApply(ctxFor(db, async () => true), {
    snapshot: async () => ({}),
    summary: () => 's',
    apply: async () => {},
    verifyTook: async () => ({ ok: false, detail: 'not found on re-read' }),
    rollback: async () => {},
  });
  assert.equal(out.result, 'rolled_back');
  assert.match(out.detail, /not found on re-read/i);
});

test('apply itself throws → failed, rollback NOT run (nothing to undo)', async () => {
  const db = freshDb();
  const calls = [];
  const out = await runSafeApply(ctxFor(db, async () => true), {
    snapshot: async () => ({}),
    summary: () => 's',
    apply: async () => { throw new Error('device said no'); },
    verifyTook: async () => ({ ok: true }),
    rollback: async () => { calls.push('rollback'); },
  });
  assert.equal(out.result, 'failed');
  assert.deepEqual(calls, [], 'no rollback when apply never succeeded');
  assert.match(lastAudit(db).detail, /device said no/i);
});

test('rollback ALSO fails → rollback_failed (loudest signal)', async () => {
  const db = freshDb();
  const out = await runSafeApply(ctxFor(db, async () => true), {
    snapshot: async () => ({}),
    summary: () => 's',
    apply: async () => {},
    verifyTook: async () => ({ ok: false, detail: 'bad' }),
    rollback: async () => { throw new Error('rollback exploded'); },
    forceVerifyFail: true,
  });
  assert.equal(out.result, 'rollback_failed');
  assert.match(out.detail, /rollback also failed/i);
});
