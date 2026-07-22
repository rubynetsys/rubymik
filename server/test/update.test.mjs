// P34 single-device update tests: honest state parsing (version + firmware
// tri-state) and the install preconditions (every blocker is a real reason it
// can't run now). The install FLOW itself reuses the P29 reboot dead-man, which
// is covered by reboot.test.mjs — here we prove the gate. No network.
//   node --test test/update.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdateState, checkUpdatePreconditions } from '../dist/update.js';

// ---------------- state parsing ----------------

test('parseUpdateState: update available when installed != latest', () => {
  const st = parseUpdateState(
    { channel: 'stable', 'installed-version': '7.15.2', 'latest-version': '7.16', status: 'New version is available' },
    { 'current-firmware': '7.15.2', 'upgrade-firmware': '7.16' });
  assert.equal(st.installed, '7.15.2');
  assert.equal(st.latest, '7.16');
  assert.equal(st.updateAvailable, true);
  assert.equal(st.firmwareUpgradeAvailable, true);
  assert.equal(st.channel, 'stable');
});

test('parseUpdateState: up to date → updateAvailable false', () => {
  const st = parseUpdateState({ 'installed-version': '7.16', 'latest-version': '7.16', status: 'System is already up to date' }, null);
  assert.equal(st.updateAvailable, false);
  assert.equal(st.firmwareUpgradeAvailable, null); // no routerboard info
});

test('parseUpdateState: latest unknown (never checked) → tri-state null', () => {
  const st = parseUpdateState({ 'installed-version': '7.16', channel: 'stable' }, null);
  assert.equal(st.latest, null);
  assert.equal(st.updateAvailable, null); // honest: don't guess
});

// ---------------- install preconditions ----------------

const upToDate = parseUpdateState({ 'installed-version': '7.16', 'latest-version': '7.16', status: 'up to date' }, null);
const hasUpdate = parseUpdateState({ 'installed-version': '7.15.2', 'latest-version': '7.16', status: 'New version is available' }, null);
const unchecked = parseUpdateState({ 'installed-version': '7.16' }, null);
const OK = { manageable: true, reachable: true, rebooting: false };

test('preconditions: a real, available update on a reachable manageable box passes', () => {
  const p = checkUpdatePreconditions(hasUpdate, OK);
  assert.equal(p.ok, true);
  assert.deepEqual(p.blockers, []);
});

test('preconditions: blocks when already up to date', () => {
  const p = checkUpdatePreconditions(upToDate, OK);
  assert.equal(p.ok, false);
  assert.match(p.blockers.join(' '), /up to date/i);
});

test('preconditions: blocks when latest is unknown (must check first)', () => {
  const p = checkUpdatePreconditions(unchecked, OK);
  assert.equal(p.ok, false);
  assert.match(p.blockers.join(' '), /Check for updates/i);
});

test('preconditions: monitor-only, unreachable, and rebooting each block', () => {
  assert.match(checkUpdatePreconditions(hasUpdate, { ...OK, manageable: false }).blockers.join(' '), /monitor-only/i);
  assert.match(checkUpdatePreconditions(hasUpdate, { ...OK, reachable: false }).blockers.join(' '), /not reachable/i);
  assert.match(checkUpdatePreconditions(hasUpdate, { ...OK, rebooting: true }).blockers.join(' '), /already rebooting/i);
});

test('preconditions: blocks when a download is already running', () => {
  const downloading = parseUpdateState({ 'installed-version': '7.15.2', 'latest-version': '7.16', status: 'Downloading...' }, null);
  const p = checkUpdatePreconditions(downloading, OK);
  assert.equal(p.ok, false);
  assert.match(p.blockers.join(' '), /download/i);
});
