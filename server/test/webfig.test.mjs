import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { issueWebfigToken, verifyWebfigToken } from '../dist/webfig.js';
import { scopeFilter, siteScope, allSites } from '../dist/scope.js';

// ---- Signed session cookie: only a valid, unexpired token for the SAME user resolves ----

test('verifyWebfigToken: a freshly-issued token resolves to its device id for its user', () => {
  const token = issueWebfigToken(42, 7);
  assert.equal(verifyWebfigToken(token, 7), 42);
});

test('verifyWebfigToken: a token issued for another user is rejected', () => {
  const token = issueWebfigToken(42, 7);
  assert.equal(verifyWebfigToken(token, 8), null);
});

test('verifyWebfigToken: a tampered payload (device id swap) is rejected', () => {
  const token = issueWebfigToken(42, 7);
  const [payloadB64, sig] = token.split('.');
  const payload = Buffer.from(payloadB64, 'base64url').toString('utf8'); // "42.7.<exp>"
  const forged = Buffer.from(payload.replace(/^42\./, '99.'), 'utf8').toString('base64url') + '.' + sig;
  assert.equal(verifyWebfigToken(forged, 7), null);
});

test('verifyWebfigToken: a tampered signature is rejected', () => {
  const token = issueWebfigToken(42, 7);
  const [payloadB64] = token.split('.');
  assert.equal(verifyWebfigToken(`${payloadB64}.not-the-real-signature`, 7), null);
});

test('verifyWebfigToken: garbage / missing tokens are rejected', () => {
  assert.equal(verifyWebfigToken(undefined, 7), null);
  assert.equal(verifyWebfigToken('', 7), null);
  assert.equal(verifyWebfigToken('nope', 7), null);
});

test('verifyWebfigToken: a hand-built past-expiry token (no valid signature) is rejected', () => {
  // The signing key is process-private, so a past-expiry token can't be validly
  // signed here; it is rejected (by signature and, in code, by the exp > now check).
  const past = Buffer.from('42.7.1', 'utf8').toString('base64url') + '.x';
  assert.equal(verifyWebfigToken(past, 7), null);
});

// ---- Scope gate: a device outside the requester's scope is not selectable ----

function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE devices (id INTEGER PRIMARY KEY, name TEXT, site_id INTEGER);
    INSERT INTO sites (id, name) VALUES (1, 'A'), (2, 'B');
    INSERT INTO devices (id, name, site_id) VALUES (10, 'router-A', 1), (20, 'router-B', 2);
  `);
  return db;
}

function load(db, id, scope) {
  const f = scopeFilter(scope, 'd.site_id');
  return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${f.sql}`).get(id, ...f.params);
}

test('scope gate: a user scoped to site A cannot load a site-B device (would 403)', () => {
  const db = seed();
  // in scope
  assert.equal(load(db, 10, siteScope([1]))?.name, 'router-A');
  // OUT of scope → not returned → route returns 403
  assert.equal(load(db, 20, siteScope([1])), undefined);
  // admin (allSites) sees both
  assert.equal(load(db, 20, allSites())?.name, 'router-B');
  db.close();
});
