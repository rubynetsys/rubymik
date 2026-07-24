// Pending-setup shared shaping (v1.1.8). The selector/copy both feeds use.
//   (runs under `node --experimental-transform-types --test`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingCopy, type PendingItem } from '../src/lib/pending.ts';

test('pendingCopy: awaiting-key → paste-key hint; awaiting-adoption → adopt hint', () => {
  const k: PendingItem = { id: 1, label: 'cpt', tunnelIp: '10.9.0.2', hasKey: false, kind: 'awaiting-key' };
  const a: PendingItem = { id: 2, label: 'jhb', tunnelIp: '10.9.0.3', hasKey: true, kind: 'awaiting-adoption' };
  assert.equal(pendingCopy(k).chip, 'awaiting key');
  assert.match(pendingCopy(k).sub, /paste the router's key/i);
  assert.ok(pendingCopy(k).sub.includes('10.9.0.2'), 'names the reserved overlay IP');
  assert.equal(pendingCopy(a).chip, 'awaiting adoption');
  assert.match(pendingCopy(a).sub, /adopt it/i);
  assert.ok(pendingCopy(a).sub.includes('10.9.0.3'));
});
