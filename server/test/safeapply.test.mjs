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

test('apply throws mid-operation → rollback RUNS and restores pre-state (framework regression)', async () => {
  // Any safe-apply caller that commits objects incrementally can throw after some writes landed.
  // The framework must roll back to the pre-change snapshot, not leave the partial writes orphaned.
  // Model a device with mutable state: apply commits two objects then throws on the third; rollback
  // (delta vs the snapshot) must remove what was committed and leave the device exactly as captured.
  const db = freshDb();
  const device = new Set(['pre-A', 'pre-B']);            // pre-existing state
  const calls = [];
  const out = await runSafeApply(ctxFor(db, async () => true), {
    snapshot: async () => { calls.push('snapshot'); return { ids: [...device] }; },
    summary: () => 's',
    apply: async () => {
      device.add('new-1'); device.add('new-2');          // two writes committed …
      throw new Error('device said no on the third write'); // … then the op throws
    },
    verifyTook: async () => ({ ok: true }),
    rollback: async (before) => {
      calls.push('rollback');
      for (const id of [...device]) if (!before.ids.includes(id)) device.delete(id); // remove the delta
    },
  });
  assert.equal(out.result, 'rolled_back', 'a mid-apply throw rolls back (was silently "failed" pre-fix)');
  assert.deepEqual(calls, ['snapshot', 'rollback'], 'rollback ran after the throw');
  assert.deepEqual([...device].sort(), ['pre-A', 'pre-B'], 'device restored to the exact pre-change state — no orphans');
  assert.match(lastAudit(db).detail, /device said no|rolled back/i);
});

test('apply throws AND rollback throws → rollback_failed (loudest signal, partial state flagged)', async () => {
  const db = freshDb();
  const out = await runSafeApply(ctxFor(db, async () => true), {
    snapshot: async () => ({}),
    summary: () => 's',
    apply: async () => { throw new Error('half-applied'); },
    verifyTook: async () => ({ ok: true }),
    rollback: async () => { throw new Error('undo exploded'); },
  });
  assert.equal(out.result, 'rollback_failed');
  assert.match(out.detail, /half-applied/i);
  assert.match(out.detail, /rollback also failed/i);
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
