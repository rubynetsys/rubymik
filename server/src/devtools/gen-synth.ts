import path from 'node:path';
import fs from 'node:fs';
import { openDb } from '../db.js';
import { hashPassword } from '../auth.js';
import { generateSyntheticFleet } from './synthfleet.js';

/**
 * CLI: populate a FRESH data dir with a synthetic fleet, for scale/demo testing
 * of the topology map. TEST-ONLY — guarded three ways:
 *   1. requires RUBYMIK_SYNTH_OK=1 in the environment,
 *   2. refuses to run against a DB that already contains devices (unless --force),
 *   3. lives under devtools/ and is never imported by the running server.
 *
 * Usage (inside a throwaway container / scratch data dir ONLY):
 *   RUBYMIK_SYNTH_OK=1 RUBYMIK_DATA_DIR=/data node dist/devtools/gen-synth.js <devices> <sites> [--force]
 */
async function main(): Promise<void> {
  if (process.env.RUBYMIK_SYNTH_OK !== '1') {
    console.error('Refusing to run: set RUBYMIK_SYNTH_OK=1 to confirm this is a throwaway test/demo data dir.');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
  const devices = nums[0] ?? 150;
  const sites = nums[1] ?? Math.max(3, Math.round(devices / 20));

  const dataDir = path.resolve(process.env.RUBYMIK_DATA_DIR ?? './data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb(dataDir);

  // seed an admin so the throwaway instance can be logged into for screenshots
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin') as { id: number } | undefined;
  if (!admin) {
    db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run('admin', await hashPassword('synthetic-demo'), new Date().toISOString());
  }

  const t0 = Date.now();
  const r = generateSyntheticFleet(db, { devices, sites, force });
  console.log(`Synthetic fleet: ${r.managed} managed devices + ${r.discovered} discovered nodes across ${r.sites} sites, ${r.edges} managed links, in ${Date.now() - t0}ms`);
  console.log('Login: admin / synthetic-demo   (run the instance with RUBYMIK_POLL_INTERVAL=0)');
  db.close();
}

main();
