// Remote-site peer state + hub-side diagnostics (v1.1.7). The bug: a remote-
// provisioned router whose key was never registered dialled the tunnel and was
// silently dropped (unknown peer) with no UI cue. These assertions pin the two
// named causes to the two non-connected states.
//   (runs under `node --experimental-transform-types --test`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { peerState, peerHint, PEER_STATE_LABEL } from '../src/lib/peerstate.ts';

test('peerState: no key → awaiting-key, even if a stale live row lingers', () => {
  assert.equal(peerState(false, undefined), 'awaiting-key');
  assert.equal(peerState(false, 'recent'), 'awaiting-key', 'no registered key is the top gate');
});

test('peerState: registered peer maps by handshake liveness', () => {
  assert.equal(peerState(true, 'recent'), 'connected');
  assert.equal(peerState(true, 'stale'), 'stale');
  assert.equal(peerState(true, undefined), 'no-handshake', 'registered but never on the interface');
  assert.equal(peerState(true, 'never'), 'no-handshake');
});

test('peerHint: awaiting-key names cause #1 (key not registered → dropped as unknown peer)', () => {
  const h = peerHint('awaiting-key', 51820);
  assert.ok(h && /public key|RUBYMIK_PUBKEY/i.test(h), 'points at registering the key');
  assert.ok(/unknown peer|dropped|Rx/i.test(h), 'explains the silent drop');
});

test('peerHint: no-handshake names cause #2 (host firewall / published UDP port) with the hub port', () => {
  const h = peerHint('no-handshake', 51999);
  assert.ok(h && /firewall|UDP port/i.test(h), 'points at firewall / port');
  assert.ok(h.includes('51999'), 'names the actual configured hub port, not a hardcoded 51820');
});

test('peerHint: connected has no hint; stale explains the drop', () => {
  assert.equal(peerHint('connected', 51820), null);
  assert.ok(peerHint('stale', 51820));
});

test('every state has a human label', () => {
  for (const s of ['awaiting-key', 'connected', 'stale', 'no-handshake'] as const) {
    assert.ok(PEER_STATE_LABEL[s] && PEER_STATE_LABEL[s].length > 0);
  }
});
