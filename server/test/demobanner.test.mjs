// P41 — the demo banner surfaces via /api/status only when configured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../dist/db.js';
import { authRoutes } from '../dist/routes/auth.js';

function app(demoBanner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubymik-demo-'));
  const db = openDb(dir);
  const a = express();
  a.use('/api', express.json());
  a.use('/api', authRoutes(db, { theme: 'ruby-dark', accent: null, demoBanner }));
  const server = a.listen(0);
  return { db, dir, server, port: server.address().port };
}
const get = async (port) => (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json());

test('demoBanner present when set, null otherwise', async () => {
  const on = app('Demo instance — resets nightly — do not enter real credentials.');
  try { assert.equal((await get(on.port)).demoBanner, 'Demo instance — resets nightly — do not enter real credentials.'); }
  finally { on.server.close(); on.db.close(); fs.rmSync(on.dir, { recursive: true, force: true }); }
  const off = app(null);
  try { assert.equal((await get(off.port)).demoBanner, null); }
  finally { off.server.close(); off.db.close(); fs.rmSync(off.dir, { recursive: true, force: true }); }
});
