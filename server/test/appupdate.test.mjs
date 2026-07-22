// P38 — the in-app update CHECK. Pure semver + evaluation, the config row round-trip,
// and the network behaviours that matter: a good check caches its result; an OFFLINE
// check fails silently and keeps the last cached report; the opt-out toggle short-
// circuits before any fetch. There is no "apply" here to test — by design.
//   node --test test/appupdate.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../dist/db.js';
import {
  parseSemver, cmpSemver, evaluateUpdate,
  readUpdateConfig, writeUpdateConfig, performUpdateCheck, DEFAULT_UPDATE_URL,
} from '../dist/appupdate.js';

const tmpDb = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-upd-')); const db = openDb(dir, { appVersion: '1.0.0' }); return { db, dir }; };
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

test('semver parse + compare', () => {
  assert.deepEqual(parseSemver('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseSemver('1.2.3-rc1+build'), [1, 2, 3]);
  assert.equal(parseSemver('not-a-version'), null);
  assert.equal(cmpSemver('1.0.0', '1.0.1'), -1);
  assert.equal(cmpSemver('1.2.0', '1.1.9'), 1);
  assert.equal(cmpSemver('2.0.0', '2.0.0'), 0);
  assert.equal(cmpSemver('v1.0.0', '1.0.0'), 0);
});

test('evaluateUpdate — available / not / below-minimum / breaking-ahead', () => {
  const doc = { latest: '1.3.0', minimum_supported: '1.1.0', changelog_url: 'https://x/CHANGELOG.md', breaking: ['0.9.0', '1.1.0', '1.2.0', '1.5.0'], notes: 'hi' };
  const r = evaluateUpdate('1.0.0', doc);
  assert.equal(r.updateAvailable, true);
  assert.equal(r.latest, '1.3.0');
  assert.equal(r.belowMinimum, true, '1.0.0 < minimum 1.1.0');
  assert.deepEqual(r.breakingAhead, ['1.1.0', '1.2.0'], 'only breaking versions in (current, latest]');
  assert.equal(r.changelogUrl, 'https://x/CHANGELOG.md');
  assert.equal(r.notes, 'hi');
  assert.match(r.pullCommand, /docker compose pull/);

  const up = evaluateUpdate('1.3.0', doc);
  assert.equal(up.updateAvailable, false, 'on latest → nothing to do');
  assert.equal(up.belowMinimum, false);
  assert.deepEqual(up.breakingAhead, []);

  const newer = evaluateUpdate('2.0.0', doc);
  assert.equal(newer.updateAvailable, false, 'running newer than latest → not "available"');
});

test('config round-trip — toggle + URL override, default when null', () => {
  const { db, dir } = tmpDb();
  try {
    let cfg = readUpdateConfig(db);
    assert.equal(cfg.enabled, true, 'enabled by default');
    assert.equal(cfg.url, null);
    cfg = writeUpdateConfig(db, { enabled: false, url: 'https://mirror.example/version.json' });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.url, 'https://mirror.example/version.json');
    cfg = writeUpdateConfig(db, { url: null });
    assert.equal(cfg.url, null, 'cleared back to default');
    assert.equal(cfg.enabled, false, 'enabled unchanged by a url-only patch');
  } finally { db.close(); cleanup(dir); }
});

test('performUpdateCheck — OK caches the report', async () => {
  const { db, dir } = tmpDb();
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ latest: '9.9.9', changelog_url: 'https://c' }) });
    const out = await performUpdateCheck(db, { currentVersion: '1.0.0' });
    assert.equal(out.status, 'ok');
    assert.equal(out.report.updateAvailable, true);
    const cfg = readUpdateConfig(db);
    assert.equal(cfg.lastStatus, 'ok');
    assert.equal(cfg.lastResult.latest, '9.9.9', 'result cached to the DB');
    assert.ok(cfg.lastCheckAt);
  } finally { globalThis.fetch = realFetch; db.close(); cleanup(dir); }
});

test('performUpdateCheck — OFFLINE fails silently and keeps the last cached report', async () => {
  const { db, dir } = tmpDb();
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ latest: '9.9.9' }) });
    await performUpdateCheck(db, { currentVersion: '1.0.0' }); // seed a good cache
    globalThis.fetch = async () => { throw new Error('ENOTFOUND'); };
    const out = await performUpdateCheck(db, { currentVersion: '1.0.0' });
    assert.equal(out.status, 'offline', 'offline is a normal outcome, not a throw');
    assert.equal(out.report.latest, '9.9.9', 'still surfaces the last good report');
    const cfg = readUpdateConfig(db);
    assert.equal(cfg.lastStatus, 'offline');
    assert.equal(cfg.lastResult.latest, '9.9.9', 'cached report NOT clobbered by the offline check');
  } finally { globalThis.fetch = realFetch; db.close(); cleanup(dir); }
});

test('performUpdateCheck — disabled toggle short-circuits before any fetch', async () => {
  const { db, dir } = tmpDb();
  const realFetch = globalThis.fetch;
  try {
    writeUpdateConfig(db, { enabled: false });
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return { ok: true, status: 200, json: async () => ({ latest: '9.9.9' }) }; };
    const out = await performUpdateCheck(db, { currentVersion: '1.0.0' });
    assert.equal(out.status, 'disabled');
    assert.equal(fetched, false, 'no network call when opted out');
  } finally { globalThis.fetch = realFetch; db.close(); cleanup(dir); }
});

test('DEFAULT_UPDATE_URL is a rubynet-controlled https URL', () => {
  assert.match(DEFAULT_UPDATE_URL, /^https:\/\//);
});
