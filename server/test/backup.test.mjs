// Backup unit tests: export-header parse, LCS diff, gzip round-trip + retention.
//   node --test test/backup.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseExportHeader, diffExports, storeBackup, listBackups, getBackupRow, parseDhcpLeases } from '../dist/backup.js';

const SAMPLE = `# 2026-07-21 01:06:48 by RouterOS 7.20.6
# software id = DLYK-A2QS
#
# model = RB5009
# serial number = TESTSERIAL01234
/interface bridge
add name=rmik-test
/ip pool
add name=rmik-test-pool ranges=192.168.90.10-192.168.90.100`;

test('parseExportHeader pulls model / serial / version', () => {
  const m = parseExportHeader(SAMPLE);
  assert.equal(m.model, 'RB5009');
  assert.equal(m.serial, 'TESTSERIAL01234');
  assert.equal(m.version, '7.20.6');
});

test('diff ignores the volatile header timestamp, flags real changes', () => {
  const a = SAMPLE;
  const b = SAMPLE.replace('# 2026-07-21 01:06:48', '# 2026-07-21 09:30:00')
    + '\n/ip dhcp-server/lease\nadd address=192.168.90.50 mac-address=AA:BB:CC:00:00:50';
  const d = diffExports(a, b);
  assert.equal(d.removed, 0, 'header timestamp change is NOT counted as a diff');
  assert.equal(d.added, 2, 'the two new lease lines are added');
  assert.ok(d.lines.some((l) => l.t === '+' && l.s.includes('192.168.90.50')));
});

test('diff detects a removed line', () => {
  const a = SAMPLE + '\n/ip firewall filter\nadd action=drop chain=input';
  const b = SAMPLE;
  const d = diffExports(a, b);
  assert.equal(d.removed, 2);
  assert.equal(d.added, 0);
});

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE device_backup (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER, device_name TEXT, identity TEXT,
    model TEXT, serial TEXT, version TEXT, source TEXT, format TEXT DEFAULT 'export', raw_bytes INTEGER, gz BLOB, created_at TEXT)`);
  return db;
}

test('gzip round-trip: stored backup decompresses to the original text', () => {
  const db = freshDb();
  const meta = parseExportHeader(SAMPLE);
  const b = storeBackup(db, 1, 'Bench', 'manual', 'export', SAMPLE, meta, 10);
  assert.ok(b.gzBytes > 0 && b.gzBytes < b.rawBytes + 40, 'gz is a blob');
  const got = getBackupRow(db, b.id);
  assert.equal(got.text, SAMPLE, 'decompresses exactly');
  assert.equal(got.serial, 'TESTSERIAL01234');
});

test('retention keeps only the newest N per device (by id/created_at)', () => {
  const db = freshDb();
  const meta = parseExportHeader(SAMPLE);
  let last;
  for (let i = 0; i < 7; i++) {
    last = storeBackup(db, 1, 'Bench', 'scheduled', 'export', SAMPLE + `\n# rev ${i}`, meta, 3);
  }
  const kept = listBackups(db, 1);
  assert.equal(kept.length, 3, 'only 3 retained after 7 inserts');
  assert.equal(kept[0].id, last.id, 'the newest insert survived retention');
});

test('parseDhcpLeases extracts static leases (handles continuations + quotes)', () => {
  const exp = `# 2026 by RouterOS 7.20.6
/ip dhcp-server lease
add address=192.168.90.55 comment="my NAS" mac-address=AA:BB:CC:00:00:55 server=rmik-test-dhcp
add address=192.168.90.60 mac-address=AA:BB:CC:00:00:60 \\
    server=rmik-test-dhcp
/ip dns
set servers=1.1.1.1`;
  const leases = parseDhcpLeases(exp);
  assert.equal(leases.length, 2);
  assert.deepEqual(leases[0], { address: '192.168.90.55', mac: 'AA:BB:CC:00:00:55', server: 'rmik-test-dhcp', comment: 'my NAS' });
  assert.equal(leases[1].address, '192.168.90.60', 'line-continuation joined');
});

test('backups for a different device are independent', () => {
  const db = freshDb();
  const meta = parseExportHeader(SAMPLE);
  storeBackup(db, 1, 'A', 'manual', 'export', SAMPLE, meta, 10);
  storeBackup(db, 2, 'B', 'manual', 'export', SAMPLE, meta, 10);
  assert.equal(listBackups(db, 1).length, 1);
  assert.equal(listBackups(db, 2).length, 1);
});
