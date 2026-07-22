import type { DatabaseSync } from 'node:sqlite';
import type { Notifier } from './notify.js';
import { log } from './log.js';
import {
  runSelfBackup, pruneSelfBackups, offhostCopy, writeSelfBackupLog,
  readOffhostConfig, lastOkSelfBackup, type BackupResult,
} from './selfbackup.js';

/**
 * P36 — orchestrates RubyMIK's own DB self-backup: a 6-hour timer + an 8-hour
 * WATCHDOG. The watchdog is the whole point: the precedent was a 67-hour silent
 * backup outage elsewhere in Rubynet with no alerting. Here, a failed run, a
 * failed off-host copy, or NO successful backup within the gap all fire a P31
 * alert (email) and drive the red banner. Silence is treated as failure.
 */
export class SelfBackupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private watchdogTimer: NodeJS.Timeout | undefined;
  private running = false;
  private gapAlerted = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly backupKey: Buffer | null,
    private readonly dataDir: string,
    private readonly intervalMs: number,
    private readonly keepN: number,
    private readonly notifier: Notifier,
    private readonly gapHours = 8,
  ) {}

  get enabled(): boolean { return this.backupKey !== null; }

  start(): void {
    if (!this.backupKey) {
      log.warn('Self-backup DISABLED — RUBYMIK_BACKUP_KEY is not set. Set it up from the Backup page (a backup key is shown once).');
      return; // nothing to schedule or watch until a key exists
    }
    log.info(`Self-backup scheduler started — every ${Math.round(this.intervalMs / 1000)}s, keep ${this.keepN}, watchdog ${this.gapHours}h`);
    setTimeout(() => void this.run('startup'), 12000).unref();
    this.timer = setInterval(() => void this.run('scheduled'), this.intervalMs);
    this.watchdogTimer = setInterval(() => this.checkWatchdog(), 30 * 60 * 1000); // every 30 min
    this.watchdogTimer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); if (this.watchdogTimer) clearInterval(this.watchdogTimer); }

  /** Run one backup: VACUUM+encrypt+manifest → prune → off-host → log → (alert on failure). */
  async run(kind: string): Promise<{ ok: boolean; result?: BackupResult; detail: string }> {
    if (!this.backupKey) return { ok: false, detail: 'No backup key configured.' };
    if (this.running) { log.warn('Self-backup skipped — a run is already in progress'); return { ok: false, detail: 'A backup is already running.' }; }
    this.running = true;
    try {
      let result: BackupResult;
      try {
        result = runSelfBackup(this.db, this.backupKey, this.dataDir, kind);
        pruneSelfBackups(this.dataDir, this.keepN);
      } catch (err) {
        const detail = `RubyMIK self-backup FAILED (${kind}): ${(err as Error).message}`;
        writeSelfBackupLog(this.db, { kind, status: 'failed', detail });
        this.alert('backup', detail);
        return { ok: false, detail };
      }

      // off-host copy (best-effort; its failure alerts but does NOT fail the backup)
      const off = readOffhostConfig(this.db);
      let offhostStatus = 'disabled';
      let offhostDetail = '';
      if (off.enabled) {
        try {
          const oc = offhostCopy([result.file, result.manifestFile], { kind: off.kind, path: off.path });
          offhostStatus = oc.ok ? 'ok' : 'failed'; offhostDetail = oc.detail;
          if (!oc.ok) throw new Error(oc.detail);
        } catch (err) {
          offhostStatus = 'failed'; offhostDetail = (err as Error).message;
          this.alert('offhost', `Off-host copy of ${result.name} FAILED: ${offhostDetail}`);
        }
      }

      writeSelfBackupLog(this.db, { kind, status: 'ok', filename: result.name, manifest: result.manifest, offhostStatus, offhostTarget: off.enabled ? off.path : null, detail: offhostDetail || null });
      this.gapAlerted = false; // a success clears the gap-alert latch
      log.info(`Self-backup ok (${kind}) — ${result.name} (${(result.manifest.bytesCipher / 1024).toFixed(0)} KiB, off-host ${offhostStatus})`);
      return { ok: true, result, detail: `Backup ${result.name} written (off-host ${offhostStatus}).` };
    } finally { this.running = false; }
  }

  /** The 67h-outage guard: no successful backup within the gap → alert once. */
  checkWatchdog(): void {
    if (!this.backupKey) return;
    const lastOk = lastOkSelfBackup(this.db);
    const ageMs = lastOk ? Date.now() - Date.parse(lastOk.ts) : Infinity;
    if (ageMs > this.gapHours * 3_600_000) {
      if (!this.gapAlerted) {
        const ageH = Number.isFinite(ageMs) ? (ageMs / 3_600_000).toFixed(1) + 'h' : 'ever';
        this.alert('gap', `NO successful RubyMIK backup in ${ageH} (limit ${this.gapHours}h) — this is the silent-outage failure mode. Last success: ${lastOk?.ts ?? 'never'}.`);
        this.gapAlerted = true;
      }
    } else {
      this.gapAlerted = false;
    }
  }

  private alert(kind: 'backup' | 'offhost' | 'gap', message: string): void {
    log.error(`[self-backup] ${message}`);
    // Reuse the P31 alert path with a synthetic non-device target (the sendTest idiom).
    this.notifier.send('alert.fired', {
      rule: `self_backup_${kind}`, label: 'RubyMIK self-backup', severity: 'critical',
      message, value: null, target: 'self-backup', firedAt: new Date().toISOString(), resolvedAt: null,
      device: { id: 0, name: 'RubyMIK', host: 'localhost', site: null },
    });
  }
}
