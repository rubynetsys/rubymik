import type { DatabaseSync } from 'node:sqlite';
import { restConnect } from './routeros/rest.js';
import type { DeviceTarget } from './routeros/types.js';
import type { WriteTransport } from './routeros/write.js';
import type { SecretBox } from './secretbox.js';
import { exportCanonical, snapshotReadonly, storeBackup, type StoredBackup } from './backup.js';
import { log } from './log.js';

/**
 * Scheduled config backups. A LOW-FREQUENCY timer, independent of the metrics
 * poller (backups are reads; this never touches the monitoring cadence). Backs
 * up EVERY device (backup is a safe read, so monitor-only devices are included
 * too), staggered so a fleet isn't hit at once.
 */

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
}

const DEVICE_COLS = 'id, name, host, port, use_tls, verify_tls, username_enc, password_enc, write_username_enc, write_password_enc';
const STAGGER_MS = 400;

export class BackupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly intervalMs: number,
    private readonly keepN: number,
  ) {}

  start(): void {
    log.info(`Backup scheduler started — every ${Math.round(this.intervalMs / 1000)}s, keep ${this.keepN} per device`);
    setTimeout(() => void this.runAll('startup'), 8000).unref();
    this.timer = setInterval(() => void this.runAll('scheduled'), this.intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  private target(d: DeviceRow, which: 'read' | 'write'): DeviceTarget {
    const [u, p] = which === 'write'
      ? [d.write_username_enc!, d.write_password_enc!]
      : [d.username_enc, d.password_enc];
    return {
      host: d.host, port: d.port ?? undefined,
      useTls: d.use_tls === null ? undefined : d.use_tls === 1,
      verifyTls: d.verify_tls === 1,
      username: this.box.decrypt(u), password: this.box.decrypt(p),
    };
  }

  async backupOne(d: DeviceRow, source: string): Promise<StoredBackup | null> {
    try {
      const read = this.target(d, 'read');
      const result = await restConnect(read); // resolves scheme/port (and confirms reachable)
      const transport: WriteTransport = { scheme: result.scheme, port: result.port };
      // Manageable (has an ftp-capable write cred) → canonical, importable export.
      // Monitor-only → read-only GET snapshot (nothing written to the device).
      const manageable = !!(d.write_username_enc && d.write_password_enc);
      const { text, meta } = manageable
        ? await exportCanonical(this.target(d, 'write'), transport)
        : await snapshotReadonly(read, transport);
      return storeBackup(this.db, d.id, d.name, source, manageable ? 'export' : 'snapshot', text, meta, this.keepN);
    } catch (err) {
      log.warn(`Backup of "${d.name}" failed: ${(err as Error).message}`);
      return null;
    }
  }

  async runAll(reason: string): Promise<{ ok: number; failed: number }> {
    if (this.running) { log.warn('Backup run skipped — a run is already in progress'); return { ok: 0, failed: 0 }; }
    this.running = true;
    try {
      const devices = this.db.prepare(`SELECT ${DEVICE_COLS} FROM devices ORDER BY id`)
        .all() as unknown as DeviceRow[];
      if (devices.length === 0) return { ok: 0, failed: 0 };
      log.info(`Backup run (${reason}) — ${devices.length} device(s)`);
      let ok = 0, failed = 0;
      for (const d of devices) {
        const res = await this.backupOne(d, reason === 'manual' ? 'manual' : 'scheduled');
        if (res) ok++; else failed++;
        await new Promise((r) => setTimeout(r, STAGGER_MS));
      }
      log.info(`Backup run done — ${ok} ok, ${failed} failed`);
      return { ok, failed };
    } finally {
      this.running = false;
    }
  }

  /** Manual single-device backup (returns the stored backup or throws). */
  async manualBackup(deviceId: number): Promise<StoredBackup> {
    const d = this.db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE id = ?`)
      .get(deviceId) as unknown as DeviceRow | undefined;
    if (!d) throw new Error('Device not found.');
    const res = await this.backupOne(d, 'manual');
    if (!res) throw new Error('Backup failed — could not export config from the device.');
    return res;
  }
}
