// P44 — the DB self-backup encryption key, managed entirely in-app (no compose editing).
// A MUTABLE holder (the boot-time const Buffer is gone) so the key can be generated, downloaded,
// moved off-server, or provided at runtime without a restart.
//
// Source precedence + protection tiers:
//   env    — RUBYMIK_BACKUP_KEY set → wins, unchanged (existing installs). App-managed ops refused.
//   file   — /data/backup.key (0600) → the CONVENIENCE default (one-click enable). Encrypted at
//            rest, but the key sits beside the DB: protects partial leaks / off-host copy
//            interception, NOT full-volume theft.
//   memory — STRICT mode (opt-in): key held in memory only, /data/backup.strict marks it so a
//            restart re-prompts for the key via the UI. Key never on disk with the DB.
//   none   — no key yet → banner → one-click enable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

export type BackupKeySource = 'env' | 'file' | 'memory' | 'none';
export type ProtectionTier = 'env' | 'convenience' | 'strict' | 'none' | 'needs-key';
const isHex64 = (v: string) => /^[0-9a-fA-F]{64}$/.test(v);

export class BackupKeyStore {
  private key: Buffer | null = null;
  private source: BackupKeySource = 'none';
  private readonly keyPath: string;
  private readonly strictPath: string;

  constructor(dataDir: string, envKeyHex: string | undefined) {
    this.keyPath = path.join(dataDir, 'backup.key');
    this.strictPath = path.join(dataDir, 'backup.strict');
    if (envKeyHex) { this.key = Buffer.from(envKeyHex, 'hex'); this.source = 'env'; return; }
    if (fs.existsSync(this.keyPath)) {
      const hex = fs.readFileSync(this.keyPath, 'utf8').trim();
      if (!isHex64(hex)) throw new Error(`${this.keyPath} is corrupt — expected 64 hex characters. Restore it or remove it to re-enable.`);
      this.key = Buffer.from(hex, 'hex'); this.source = 'file'; return;
    }
    // no env, no file: 'none' — but a strict marker means we're waiting for the key (needs-key).
    this.source = 'none';
  }

  get(): Buffer | null { return this.key; }
  configured(): boolean { return this.key !== null; }
  isStrict(): boolean { return fs.existsSync(this.strictPath); }
  envManaged(): boolean { return this.source === 'env'; }

  status(): { enabled: boolean; source: BackupKeySource; tier: ProtectionTier; needsKey: boolean } {
    const strict = this.isStrict();
    const enabled = this.key !== null;
    const needsKey = strict && !enabled; // strict marker but no in-memory key yet (post-restart)
    const tier: ProtectionTier = this.source === 'env' ? 'env' : needsKey ? 'needs-key' : strict ? 'strict' : enabled ? 'convenience' : 'none';
    return { enabled, source: this.source, tier, needsKey };
  }

  private assertAppManaged() { if (this.source === 'env') throw new Error('The backup key is set via RUBYMIK_BACKUP_KEY (advanced/env). Unset it to manage the key from the UI.'); }

  /** One-click enable: generate a 32-byte key, persist to /data (0600), activate live. */
  enable(): void {
    this.assertAppManaged();
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key.toString('hex') + '\n', { mode: 0o600 });
    try { fs.rmSync(this.strictPath, { force: true }); } catch { /* ignore */ }
    this.key = key; this.source = 'file';
    log.info(`Self-backups enabled — key generated at ${this.keyPath} (0600).`);
  }

  /** The current key as hex, for the recovery-key download. */
  recoveryHex(): string | null { return this.key ? this.key.toString('hex') : null; }

  /** STRICT: remove the on-disk key, keep it in memory, mark strict so restart re-prompts. */
  goStrict(): void {
    this.assertAppManaged();
    if (!this.key) throw new Error('No backup key to protect — enable backups first.');
    try { fs.rmSync(this.keyPath, { force: true }); } catch { /* ignore */ }
    fs.writeFileSync(this.strictPath, 'strict\n', { mode: 0o600 });
    this.source = 'memory';
    log.info('Self-backup key moved OFF server storage (strict mode) — held in memory only.');
  }

  /** CONVENIENCE: write the in-memory key back to /data, clear strict. */
  goConvenience(): void {
    this.assertAppManaged();
    if (!this.key) throw new Error('No backup key available.');
    fs.writeFileSync(this.keyPath, this.key.toString('hex') + '\n', { mode: 0o600 });
    try { fs.rmSync(this.strictPath, { force: true }); } catch { /* ignore */ }
    this.source = 'file';
    log.info('Self-backup key stored on server (convenience mode).');
  }

  /** STRICT restart / migrated host: user supplies the key via the UI (paste or upload). */
  provide(hex: string): void {
    const h = hex.trim();
    if (!isHex64(h)) throw new Error('The recovery key must be 64 hex characters (32 bytes).');
    if (this.source === 'env') throw new Error('An env key is already active.');
    this.key = Buffer.from(h, 'hex');
    if (this.source === 'none') this.source = 'memory';
    log.info('Self-backup key provided at runtime.');
  }

  /** Turn backups off entirely (remove key + strict marker). */
  disable(): void {
    this.assertAppManaged();
    try { fs.rmSync(this.keyPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(this.strictPath, { force: true }); } catch { /* ignore */ }
    this.key = null; this.source = 'none';
    log.warn('Self-backups disabled — key removed.');
  }
}
