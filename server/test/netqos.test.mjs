// P23 QoS: bandwidth parsing, queue validation, the queueMgmtGuard's four classes,
// and the NEW latency dead-man — including the acceptance-C assertion that the OLD
// reachability-only verify would have wrongly COMMITTED a reachable-but-strangled
// change that the latency check rolls back.
//   node --test test/netqos.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../dist/db.js';
import { parseBps, fmtBps, validateQueueInput, queueMgmtGuard } from '../dist/netqos.js';
import { runSafeApply } from '../dist/safeapply.js';

const MGMT = { mgmtIp: '10.0.0.1', mgmtInterface: 'ether1', mgmtPort: 80, mgmtScheme: 'http' };

test('parseBps / fmtBps', () => {
  assert.equal(parseBps('8k'), 8000);
  assert.equal(parseBps('10M'), 10_000_000);
  assert.equal(parseBps('1G'), 1e9);
  assert.equal(parseBps('8000000'), 8_000_000);
  assert.equal(parseBps('0'), 0);
  assert.ok(Number.isNaN(parseBps('fast')));
  assert.equal(fmtBps(1_000_000), '1M');
});

test('validateQueueInput', () => {
  assert.deepEqual(validateQueueInput({ name: 'q', target: '192.168.88.0/24', maxLimitUp: '10M', maxLimitDown: '10M' }), []);
  assert.ok(validateQueueInput({ name: '', target: '1.2.3.4' }).length, 'name required');
  assert.ok(validateQueueInput({ name: 'q', target: '' }).length, 'target required');
  assert.ok(validateQueueInput({ name: 'q', target: '1.2.3.4', maxLimitUp: 'fast' }).length, 'bad rate');
  assert.ok(validateQueueInput({ name: 'q', target: '1.2.3.4', priority: '9' }).length, 'priority 1-8');
  assert.deepEqual(validateQueueInput({ name: 'q', target: 'ether5', maxLimitUp: '512k' }), []);
});

test('queueMgmtGuard classes 1-4 (floor 1M)', () => {
  // class 1: target = mgmt IP /32 below floor → refused
  assert.ok(queueMgmtGuard(MGMT, { name: 'q', target: '10.0.0.1/32', maxLimitUp: '64k', maxLimitDown: '64k' }));
  assert.ok(queueMgmtGuard(MGMT, { name: 'q', target: '10.0.0.1', maxLimitUp: '64k' }), 'bare mgmt IP too');
  // class 1: target = mgmt interface below floor → refused
  assert.ok(queueMgmtGuard(MGMT, { name: 'q', target: 'ether1', maxLimitUp: '512k' }));
  // class 2: 0.0.0.0/0 below floor → refused
  assert.ok(queueMgmtGuard(MGMT, { name: 'q', target: '0.0.0.0/0', maxLimitDown: '8k' }));
  // class 3: broad LAN /24 that INCLUDES the mgmt IP, below floor → NOT refused (→ dead-man)
  assert.equal(queueMgmtGuard(MGMT, { name: 'q', target: '10.0.0.0/24', maxLimitUp: '8k', maxLimitDown: '8k' }), null);
  // at/above the floor on the mgmt IP → not a strangle
  assert.equal(queueMgmtGuard(MGMT, { name: 'q', target: '10.0.0.1/32', maxLimitUp: '10M', maxLimitDown: '10M' }), null);
  // unlimited (0) on the mgmt IP → not a strangle
  assert.equal(queueMgmtGuard(MGMT, { name: 'q', target: '10.0.0.1/32', maxLimitUp: '0', maxLimitDown: '0' }), null);
  // class 4: disabled → never refused
  assert.equal(queueMgmtGuard(MGMT, { name: 'q', target: '10.0.0.1/32', maxLimitUp: '64k', disabled: true }), null);
});

// ---- the latency dead-man (safeapply extension) ----

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmik-qos-'));
  const db = openDb(dir);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO devices (name,host,username_enc,password_enc,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('R', '1.1.1.1', 'x', 'x', now, now);
  const id = db.prepare('SELECT id FROM devices WHERE name=?').get('R').id;
  return { db, id };
}
const steps = () => ({ snapshot: async () => ({}), summary: () => 'shape', apply: async () => {}, verifyTook: async () => ({ ok: true }), rollback: async () => {} });
// baseline is measured first (N low samples), then post (N high samples).
function lowThenHigh(samples, lo, hi) { let c = 0; return async () => (c++ < samples ? lo : hi); }

test('latency dead-man: reachable-but-slow → ROLLED BACK (new check catches the strangle)', async () => {
  const { db, id } = fixture();
  const ctx = { db, target: {}, transport: { scheme: 'http', port: 80 }, actor: 't', deviceId: id, deviceName: 'R', action: 'queue.create', targetLabel: 'q',
    probe: async () => true, latency: { samples: 3, multiplier: 10, ceilingMs: 2000 }, latencyProbe: lowThenHigh(3, 5, 2500) };
  const o = await runSafeApply(ctx, steps());
  assert.equal(o.result, 'rolled_back', 'reachable=true but latency 2500ms > 2000ms budget → rollback');
  assert.match(o.detail, /latency/i);
});

test('latency dead-man: within budget → APPLIED', async () => {
  const { db, id } = fixture();
  const ctx = { db, target: {}, transport: { scheme: 'http', port: 80 }, actor: 't', deviceId: id, deviceName: 'R', action: 'queue.create', targetLabel: 'q',
    probe: async () => true, latency: { samples: 3, multiplier: 10, ceilingMs: 2000 }, latencyProbe: async () => 6 };
  const o = await runSafeApply(ctx, steps());
  assert.equal(o.result, 'applied');
});

test('acceptance C: the OLD reachability-only verify would have COMMITTED the same strangle', async () => {
  const { db, id } = fixture();
  // identical scenario, but WITHOUT the latency config = the pre-P23 verify path.
  const ctxOld = { db, target: {}, transport: { scheme: 'http', port: 80 }, actor: 't', deviceId: id, deviceName: 'R', action: 'queue.create', targetLabel: 'q',
    probe: async () => true, latencyProbe: lowThenHigh(3, 5, 2500) /* ignored: no ctx.latency */ };
  const o = await runSafeApply(ctxOld, steps());
  assert.equal(o.result, 'applied', 'reachability-only verify commits the reachable-but-strangled change — exactly what the latency dimension fixes');
});
