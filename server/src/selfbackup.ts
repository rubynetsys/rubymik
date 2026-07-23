import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { SecretBox } from './secretbox.js';

/**
 * P36 — RubyMIK's OWN database self-backup.
 *
 * The sqlite DB holds encrypted router snapshots, device/VPN/notification
 * credentials, users + 2FA, and the audit trail. This module makes an
 * ONLINE-SAFE, encrypted, restore-tested backup of the whole file.
 *
 * Why VACUUM INTO (not a raw copy, not node:sqlite's backup()):
 *  - the DB runs in WAL mode; a raw file copy would miss the -wal and could be
 *    torn. VACUUM INTO writes a single, consistent, defragmented snapshot of the
 *    committed state while the DB stays live.
 *  - node:sqlite's top-level backup() is Node ≥23.8; production ships on
 *    node:22-alpine, where it is undefined. VACUUM INTO is plain SQL, everywhere.
 *
 * Why a DEDICATED key (RUBYMIK_BACKUP_KEY, not the field-encryption key):
 *  - the DB already contains field-encrypted secrets, but the backup layer must
 *    protect the WHOLE file, including everything that isn't field-encrypted. A
 *    backup encrypted with the field key would be no better than the DB itself.
 *  - Backup + key stored together = plaintext-equivalent. The key is shown to the
 *    operator once, stored in .env, and kept OFF this machine. It is never in the
 *    repo and never inside a backup (the .env is not part of the DB).
 */

// The plaintext test-suite size at build time — a coarse "is this the app I think
// it is" signal carried in the manifest (bumped as the suite grows).
export const TEST_BASELINE = 197;

const MAGIC = Buffer.from('RMBK1\0', 'binary'); // 6 bytes — a RubyMIK backup, NOT a bare SQLite file
const SQLITE_HEADER = 'SQLite format 3';

const here = path.dirname(fileURLToPath(import.meta.url));
function appVersion(): string {
  try { return String((JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'); }
  catch { return '0.0.0'; }
}

// ---------------- binary AES-256-GCM (works on the whole DB file) ----------------

export function encryptBackup(key: Buffer, plain: Buffer): Buffer {
  if (key.length !== 32) throw new Error('Backup key must be 32 bytes.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ct]); // magic(6) ‖ iv(12) ‖ tag(16) ‖ ciphertext
}
export function decryptBackup(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < 34 || !blob.subarray(0, 6).equals(MAGIC)) throw new Error('Not a RubyMIK backup (bad magic) — or wrong key.');
  const iv = blob.subarray(6, 18), tag = blob.subarray(18, 34), ct = blob.subarray(34);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]); // throws on bad key/tamper (GCM auth)
}

// ---------------- manifest ----------------

export interface BackupManifest {
  format: 'RMBK1'; createdAt: string; kind: string;
  schemaVersion: number; appVersion: string; testBaseline: number;
  sha256Plain: string; sha256Cipher: string; bytesPlain: number; bytesCipher: number;
  tableCounts: Record<string, number>; cipher: 'aes-256-gcm'; keyId: 'backup';
}

function countTables(db: DatabaseSync): Record<string, number> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  const out: Record<string, number> = {};
  for (const t of tables) out[t.name] = (db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number }).c;
  return out;
}
function schemaVersion(db: DatabaseSync): number {
  return (db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations').get() as { v: number }).v;
}

const backupsDir = (dataDir: string) => path.join(dataDir, 'self-backups');

// ---------------- the backup run ----------------

export interface BackupResult { name: string; file: string; manifestFile: string; manifest: BackupManifest }

export function runSelfBackup(db: DatabaseSync, backupKey: Buffer, dataDir: string, kind: string): BackupResult {
  const dir = backupsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `rubymik-${stamp}`;
  const tmpPlain = path.join(dir, `${name}.sqlite.tmp`);
  try {
    // 1) ONLINE-SAFE consistent copy (never a raw file copy of the live WAL DB).
    db.exec(`VACUUM INTO '${tmpPlain.replace(/'/g, "''")}'`);

    // 2) describe the BACKUP itself (open the copy, count its rows/schema) so the
    //    manifest matches the file byte-for-byte and the drill can't false-fail.
    const snap = new DatabaseSync(tmpPlain, { readOnly: true });
    const tableCounts = countTables(snap);
    const schemaVer = schemaVersion(snap);
    snap.close();

    const plain = fs.readFileSync(tmpPlain);
    const sha256Plain = crypto.createHash('sha256').update(plain).digest('hex');
    const blob = encryptBackup(backupKey, plain);
    const sha256Cipher = crypto.createHash('sha256').update(blob).digest('hex');

    const file = path.join(dir, `${name}.bkp`);
    fs.writeFileSync(file, blob, { mode: 0o600 });

    const manifest: BackupManifest = {
      format: 'RMBK1', createdAt: new Date().toISOString(), kind,
      schemaVersion: schemaVer, appVersion: appVersion(), testBaseline: TEST_BASELINE,
      sha256Plain, sha256Cipher, bytesPlain: plain.length, bytesCipher: blob.length,
      tableCounts, cipher: 'aes-256-gcm', keyId: 'backup',
    };
    const manifestFile = path.join(dir, `${name}.manifest.json`);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    return { name, file, manifestFile, manifest };
  } finally {
    // SHRED the plaintext VACUUM copy — it must never linger unencrypted on disk.
    if (fs.existsSync(tmpPlain)) { try { fs.rmSync(tmpPlain); } catch { /* best-effort */ } }
  }
}

// ---------------- listing + retention ----------------

export interface BackupEntry { name: string; file: string; manifestFile: string; manifest: BackupManifest | null; sizeBytes: number; createdAt: string }

export function listSelfBackups(dataDir: string): BackupEntry[] {
  const dir = backupsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.bkp')).map((f) => {
    const name = f.slice(0, -4);
    const file = path.join(dir, f);
    const manifestFile = path.join(dir, `${name}.manifest.json`);
    let manifest: BackupManifest | null = null;
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as BackupManifest; } catch { /* orphan .bkp */ }
    const st = fs.statSync(file);
    return { name, file, manifestFile, manifest, sizeBytes: st.size, createdAt: manifest?.createdAt ?? st.mtime.toISOString() };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keep the newest `keep`, delete the rest (both .bkp and .manifest.json). */
export function pruneSelfBackups(dataDir: string, keep: number): string[] {
  const all = listSelfBackups(dataDir);
  const pruned: string[] = [];
  for (const e of all.slice(keep)) {
    try { fs.rmSync(e.file); pruned.push(e.name); } catch { /* ignore */ }
    try { fs.rmSync(e.manifestFile); } catch { /* ignore */ }
  }
  return pruned;
}

// ---------------- off-host copy (pluggable; v1 = copy to a path) ----------------

export interface OffhostTarget { kind: string; path: string | null }
export function offhostCopy(files: string[], target: OffhostTarget): { ok: boolean; detail: string } {
  if (target.kind !== 'path') return { ok: false, detail: `Off-host kind "${target.kind}" is not implemented in v1 (path only — SFTP/rclone are PENDING-RAY).` };
  if (!target.path) return { ok: false, detail: 'No off-host path configured.' };
  fs.mkdirSync(target.path, { recursive: true }); // throws if the target is unwritable → caller alerts
  for (const f of files) fs.copyFileSync(f, path.join(target.path, path.basename(f)));
  return { ok: true, detail: `Copied ${files.length} file(s) to ${target.path}` };
}

// ---------------- the restore DRILL (this is what makes a backup real) ----------------

export interface DrillCheck { name: string; ok: boolean; detail: string }
export interface DrillResult { ok: boolean; checks: DrillCheck[] }

/** Restore the latest (or given) backup into a SCRATCH dir and assert it's real:
 *  decrypts, sha256 matches, row counts match the manifest, a known encrypted
 *  snapshot decrypts, a device credential decrypts, and a user login verifies.
 *  NEVER touches the live instance — everything happens in a throwaway temp dir. */
export async function restoreDrill(opts: {
  backupFile: string; manifestFile: string; backupKey: Buffer; mainBox: SecretBox;
  verifyPassword: (pw: string, hash: string) => Promise<boolean>;
  knownLogin?: { username: string; password: string };
  scratchRoot?: string;
}): Promise<DrillResult> {
  const checks: DrillCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); };
  const scratch = fs.mkdtempSync(path.join(opts.scratchRoot ?? os.tmpdir(), 'rubymik-drill-'));
  try {
    const manifest = JSON.parse(fs.readFileSync(opts.manifestFile, 'utf8')) as BackupManifest;
    const blob = fs.readFileSync(opts.backupFile);

    let plain: Buffer;
    try { plain = decryptBackup(opts.backupKey, blob); add('decrypt', true, 'backup decrypted with the dedicated backup key'); }
    catch (e) { add('decrypt', false, `decrypt FAILED: ${(e as Error).message}`); return { ok: false, checks }; }

    const sha = crypto.createHash('sha256').update(plain).digest('hex');
    add('sha256', sha === manifest.sha256Plain, sha === manifest.sha256Plain ? 'plaintext sha256 matches the manifest' : `sha256 MISMATCH (${sha.slice(0, 12)}… vs ${manifest.sha256Plain.slice(0, 12)}…)`);
    add('sqlite-header', plain.subarray(0, SQLITE_HEADER.length).toString('latin1') === SQLITE_HEADER, 'the decrypted blob is a real SQLite database');

    const scratchDb = path.join(scratch, 'rubymik.db');
    fs.writeFileSync(scratchDb, plain);
    const sdb = new DatabaseSync(scratchDb, { readOnly: true });
    try {
      const counts = countTables(sdb);
      const mismatch = Object.entries(manifest.tableCounts).filter(([t, c]) => counts[t] !== c);
      add('row-counts', mismatch.length === 0, mismatch.length === 0 ? `all ${Object.keys(counts).length} tables match the manifest row counts` : `MISMATCH in: ${mismatch.map(([t]) => t).join(', ')}`);

      const snapRow = sdb.prepare("SELECT id, content_encrypted FROM snapshots WHERE content_encrypted IS NOT NULL LIMIT 1").get() as { id: number; content_encrypted: string } | undefined;
      if (snapRow) { try { const t = opts.mainBox.decrypt(snapRow.content_encrypted); add('snapshot-decrypt', t.length > 0, `encrypted router snapshot #${snapRow.id} decrypts (${t.length} bytes)`); } catch (e) { add('snapshot-decrypt', false, `snapshot decrypt FAILED: ${(e as Error).message}`); } }
      else add('snapshot-decrypt', true, 'no encrypted snapshot in this backup to test (skipped)');

      const devRow = sdb.prepare("SELECT id, name, username_enc FROM devices LIMIT 1").get() as { id: number; name: string; username_enc: string } | undefined;
      if (devRow) { try { const u = opts.mainBox.decrypt(devRow.username_enc); add('cred-decrypt', u.length > 0, `device "${devRow.name}" read-credential decrypts`); } catch (e) { add('cred-decrypt', false, `credential decrypt FAILED: ${(e as Error).message}`); } }
      else add('cred-decrypt', true, 'no device in this backup to test (skipped)');

      if (opts.knownLogin) {
        const u = sdb.prepare('SELECT username, password_hash FROM users WHERE username = ?').get(opts.knownLogin.username) as { username: string; password_hash: string } | undefined;
        if (u) { const ok = await opts.verifyPassword(opts.knownLogin.password, u.password_hash); add('login', ok, ok ? `login works — "${u.username}" verifies against the restored password hash` : 'login FAILED — password did not verify against the restored hash'); }
        else add('login', false, `user "${opts.knownLogin.username}" not found in the restored DB`);
      } else {
        const n = (sdb.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
        add('login', n > 0, n > 0 ? `${n} user row(s) restored with password hashes (no known password supplied to verify against)` : 'no users restored');
      }
    } finally { sdb.close(); }

    return { ok: checks.every((c) => c.ok), checks };
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort scratch cleanup */ }
  }
}

// ---------------- DB log + off-host config + health (P36.3/P36.4) ----------------

export interface SelfBackupLogRow {
  id: number; ts: string; kind: string; status: string; filename: string | null;
  bytes_plain: number | null; bytes_cipher: number | null; sha256: string | null;
  schema_version: number | null; app_version: string | null;
  offhost_status: string | null; offhost_target: string | null; detail: string | null;
}

export function writeSelfBackupLog(db: DatabaseSync, row: {
  kind: string; status: string; filename?: string | null; manifest?: BackupManifest | null;
  offhostStatus?: string | null; offhostTarget?: string | null; detail?: string | null;
}): void {
  db.prepare(`INSERT INTO self_backup_log (ts, kind, status, filename, bytes_plain, bytes_cipher, sha256, schema_version, app_version, offhost_status, offhost_target, detail)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    new Date().toISOString(), row.kind, row.status, row.filename ?? null,
    row.manifest?.bytesPlain ?? null, row.manifest?.bytesCipher ?? null, row.manifest?.sha256Plain ?? null,
    row.manifest?.schemaVersion ?? null, row.manifest?.appVersion ?? null,
    row.offhostStatus ?? null, row.offhostTarget ?? null, row.detail ?? null,
  );
  // keep the log bounded
  db.prepare('DELETE FROM self_backup_log WHERE id NOT IN (SELECT id FROM self_backup_log ORDER BY id DESC LIMIT 500)').run();
}

export function recentSelfBackupLog(db: DatabaseSync, limit = 50): SelfBackupLogRow[] {
  return db.prepare('SELECT * FROM self_backup_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as SelfBackupLogRow[];
}
export function lastSelfBackupLog(db: DatabaseSync): SelfBackupLogRow | undefined {
  return db.prepare('SELECT * FROM self_backup_log ORDER BY id DESC LIMIT 1').get() as unknown as SelfBackupLogRow | undefined;
}
export function lastOkSelfBackup(db: DatabaseSync): SelfBackupLogRow | undefined {
  return db.prepare("SELECT * FROM self_backup_log WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() as unknown as SelfBackupLogRow | undefined;
}

export interface OffhostConfig { enabled: boolean; kind: string; path: string | null }
export function readOffhostConfig(db: DatabaseSync): OffhostConfig {
  const r = db.prepare('SELECT offhost_enabled, offhost_kind, offhost_path FROM self_backup_config WHERE id = 1').get() as { offhost_enabled: number; offhost_kind: string; offhost_path: string | null } | undefined;
  return { enabled: !!r?.offhost_enabled, kind: r?.offhost_kind ?? 'path', path: r?.offhost_path ?? null };
}
export function writeOffhostConfig(db: DatabaseSync, patch: Partial<OffhostConfig>): OffhostConfig {
  const cur = readOffhostConfig(db);
  const next = { ...cur, ...patch };
  db.prepare('UPDATE self_backup_config SET offhost_enabled = ?, offhost_kind = ?, offhost_path = ?, updated_at = ? WHERE id = 1')
    .run(next.enabled ? 1 : 0, next.kind, next.path, new Date().toISOString());
  return next;
}

export interface BackupHealth {
  configured: boolean; healthy: boolean; severity: 'ok' | 'warn' | 'critical'; reason: string;
  lastOkAt: string | null; ageHours: number | null; lastRun: { ts: string; status: string; detail: string | null } | null;
  offhost: { enabled: boolean; lastStatus: string | null };
}

/** The single source of truth for the red banner + the /status endpoint. This is
 *  the 67h-outage guard: silence (no successful backup within `gapHours`) is
 *  itself a critical state, not a quiet one. */
export function backupHealth(db: DatabaseSync, opts: { configured: boolean; gapHours: number }): BackupHealth {
  const lastRunRow = lastSelfBackupLog(db);
  const lastRun = lastRunRow ? { ts: lastRunRow.ts, status: lastRunRow.status, detail: lastRunRow.detail } : null;
  const off = readOffhostConfig(db);
  const offhost = { enabled: off.enabled, lastStatus: lastRunRow?.offhost_status ?? null };

  if (!opts.configured) {
    return { configured: false, healthy: false, severity: 'critical', reason: 'Self-backups are OFF — enable them in one click from the Backup page.', lastOkAt: null, ageHours: null, lastRun, offhost };
  }
  const lastOk = lastOkSelfBackup(db);
  const ageHours = lastOk ? (Date.now() - Date.parse(lastOk.ts)) / 3_600_000 : null;
  if (!lastOk) return { configured: true, healthy: false, severity: 'critical', reason: 'No successful backup yet.', lastOkAt: null, ageHours: null, lastRun, offhost };
  if (ageHours! > opts.gapHours) return { configured: true, healthy: false, severity: 'critical', reason: `No successful backup in ${ageHours!.toFixed(1)}h (over the ${opts.gapHours}h limit).`, lastOkAt: lastOk.ts, ageHours, lastRun, offhost };
  if (lastRun && lastRun.status === 'failed') return { configured: true, healthy: false, severity: 'critical', reason: `The last backup run FAILED: ${lastRun.detail ?? 'unknown error'}.`, lastOkAt: lastOk.ts, ageHours, lastRun, offhost };
  if (off.enabled && offhost.lastStatus === 'failed') return { configured: true, healthy: false, severity: 'warn', reason: 'The last off-host copy failed (local backup is fine).', lastOkAt: lastOk.ts, ageHours, lastRun, offhost };
  return { configured: true, healthy: true, severity: 'ok', reason: `Last successful backup ${ageHours!.toFixed(1)}h ago.`, lastOkAt: lastOk.ts, ageHours, lastRun, offhost };
}
