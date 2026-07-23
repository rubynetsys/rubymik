// Remote Access page state machine (P45). not-capable → capable-not-enabled →
// running. The invariant Ray wants: a not-capable install can NEVER reach a
// clickable Enable, so "not running" + a dead Enable never coexist with missing
// caps — that's exactly phaseFor(false, *) === 'setup'.
//   (runs under `node --experimental-transform-types --test`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { phaseFor } from '../src/lib/hubphase.ts';

test('not capable → setup, regardless of the enabled flag', () => {
  assert.equal(phaseFor(false, false), 'setup');
  assert.equal(phaseFor(false, true), 'setup', 'caps are the top gate — even a stale enabled flag stays in setup');
});

test('capable but hub off → ready (a live Enable is offered)', () => {
  assert.equal(phaseFor(true, false), 'ready');
});

test('capable and hub enabled → running', () => {
  assert.equal(phaseFor(true, true), 'running');
});
