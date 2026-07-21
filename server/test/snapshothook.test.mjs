// P22.0(b) — the pre/post snapshot hook must NOT re-trigger itself. Capture rides
// POST /export (read-only) + GETs; it must never spawn a snapshot-of-snapshot nor
// be fail-closed-refused by its own guard. Proven against an in-process fake router
// so it's hermetic. Also proves: an UNbracketed config write (PUT) is refused, the
// capture's POST verb is exempt, and a nested op re-uses the outer bracket.
//   node --test test/snapshothook.test.mjs   (after `npm run build`)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../dist/db.js';
import { SecretBox } from '../dist/secretbox.js';
import { installCaptureHook, _uninstallCaptureHook, withWriteOp, preWriteGuard, SnapshotRequiredError } from '../dist/snapshothook.js';
import { listSnapshots } from '../dist/snapshots.js';
import { restAdd } from '../dist/routeros/write.js';
import { readTarget, writeTarget, transportFor } from '../dist/transport.js';

// ---- in-process fake RouterOS (answers just enough for /export capture + a PUT) ----
let server, port, exportPosts = 0;
before(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const p = req.url.replace(/^\/rest/, '').split('?')[0];
      const send = (o) => { const b = JSON.stringify(o); res.writeHead(200, { 'content-type': 'application/json' }); res.end(b); };
      if (req.method === 'GET' && p === '/system/routerboard') return send({ model: 'CCR', 'serial-number': 'REENTRANT-1' });
      if (req.method === 'GET' && p === '/system/resource') return send({ version: '7.20.6', 'board-name': 'x' });
      if (req.method === 'GET' && p === '/system/identity') return send({ name: 'reentrant' });
      if (req.method === 'POST' && p === '/export') { exportPosts++; return send([]); }
      if (req.method === 'GET' && p === '/file') return send([{ '.id': '*f', name: 'rubymik-snapshot.rsc', contents: '# cfg\n/ip address\nadd address=1.1.1.1/24\n' }]);
      if (req.method === 'PUT' && p === '/interface/bridge') return send({ '.id': '*1', name: 'x' });
      return send([]);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { server.close(); _uninstallCaptureHook(); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmik-hook-'));
  const db = openDb(dir);
  const box = SecretBox.load(dir, 'cd'.repeat(32));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO devices (name,host,port,use_tls,verify_tls,username_enc,password_enc,write_username_enc,write_password_enc,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('R', '127.0.0.1', port, 0, 0, box.encrypt('u'), box.encrypt('p'), box.encrypt('wu'), box.encrypt('wp'), now, now);
  const row = db.prepare('SELECT * FROM devices WHERE name=?').get('R');
  return { db, box, row };
}

test('one withWriteOp → EXACTLY one pre/post pair (capture does not snapshot-of-snapshot)', async () => {
  const { db, box, row } = fixture();
  installCaptureHook(db, box);
  try {
    const before = exportPosts;
    await withWriteOp(row.id, 'test.op', async () => ({ result: 'applied' }));
    const snaps = listSnapshots(db, row.id);
    assert.equal(snaps.length, 2, 'exactly pre + post — capture rode /export without re-entering the hook');
    assert.deepEqual(snaps.map((s) => s.trigger).sort(), ['post_write', 'pre_write']);
    assert.ok(snaps.every((s) => s.operation === 'test.op'));
    assert.equal(exportPosts - before, 2, 'exactly two /export calls (one per snapshot), no recursion');
  } finally { _uninstallCaptureHook(); }
});

test('nested withWriteOp on the same device reuses the outer bracket (still one pair)', async () => {
  const { db, box, row } = fixture();
  installCaptureHook(db, box);
  try {
    await withWriteOp(row.id, 'outer', async () => {
      await withWriteOp(row.id, 'inner', async () => ({ result: 'applied' })); // must NOT open a 2nd bracket
      return { result: 'applied' };
    });
    const snaps = listSnapshots(db, row.id);
    assert.equal(snaps.length, 2, 'nested op did not create a second pre/post pair');
    assert.ok(snaps.every((s) => s.operation === 'outer'), 'both rows tagged with the OUTER operation');
  } finally { _uninstallCaptureHook(); }
});

test('guard refuses an UNbracketed config write (PUT), exempts capture POST, allows a bracketed write', async () => {
  const { db, box, row } = fixture();
  installCaptureHook(db, box);
  try {
    const write = writeTarget(box, row);
    const tr = await transportFor(row, readTarget(box, row));
    // Unbracketed PUT → refused (the guard throws synchronously, before the request).
    let refused = null;
    try { await restAdd(write, tr, '/interface/bridge', { name: 'x' }); } catch (e) { refused = e; }
    assert.ok(refused instanceof SnapshotRequiredError, 'unbracketed PUT refused with SnapshotRequiredError');
    // The capture verb (POST) is exempt → never throws even with no bracket.
    assert.doesNotThrow(() => preWriteGuard('POST'));
    // Inside a bracket, the same PUT is allowed (pre-snapshot already taken).
    const r = await withWriteOp(row.id, 'test.write', async () => restAdd(write, tr, '/interface/bridge', { name: 'x' }));
    assert.equal(r.name, 'x', 'bracketed PUT passed the guard and executed');
  } finally { _uninstallCaptureHook(); }
});
