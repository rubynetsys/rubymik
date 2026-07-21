import type { DatabaseSync } from 'node:sqlite';
import type { SecretBox } from './secretbox.js';
import { captureManualOrScheduled } from './snapshothook.js';
import { lastSnapshotAt } from './snapshots.js';
import { log } from './log.js';

/**
 * Scheduled config snapshots (P21). A low-frequency, staggered timer — separate
 * from the metrics poller and the P7 backup scheduler. Capture is a READ, so
 * EVERY device is included (monitor-only devices too, e.g. Home Lab). Skips a
 * router that already has a snapshot within the last 20h, so a daily run and
 * the pre/post write captures don't pile up redundant snapshots. This daily
 * capture is what catches out-of-band changes made directly in WebFig.
 */

const STAGGER_MS = 400;
const SKIP_IF_WITHIN_MS = 20 * 60 * 60 * 1000; // 20h

export class SnapshotScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    log.info(`Snapshot scheduler started — every ${Math.round(this.intervalMs / 1000)}s, skip a router captured within 20h`);
    setTimeout(() => void this.runAll('startup'), 12000).unref();
    this.timer = setInterval(() => void this.runAll('scheduled'), this.intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  async runAll(reason: string): Promise<{ ok: number; skipped: number; failed: number }> {
    if (this.running) { log.warn('Snapshot run skipped — a run is already in progress'); return { ok: 0, skipped: 0, failed: 0 }; }
    this.running = true;
    try {
      const devices = this.db.prepare('SELECT id, name FROM devices ORDER BY id').all() as Array<{ id: number; name: string }>;
      if (devices.length === 0) return { ok: 0, skipped: 0, failed: 0 };
      let ok = 0, skipped = 0, failed = 0;
      for (const d of devices) {
        const last = lastSnapshotAt(this.db, d.id);
        if (last && Date.now() - Date.parse(last) < SKIP_IF_WITHIN_MS) { skipped++; continue; }
        const r = await captureManualOrScheduled(this.db, this.box, d.id, 'scheduled');
        if (r.ok) ok++; else failed++;
        await new Promise((res) => setTimeout(res, STAGGER_MS));
      }
      log.info(`Scheduled snapshot run (${reason}) — ${ok} captured, ${skipped} skipped (fresh <20h), ${failed} failed`);
      return { ok, skipped, failed };
    } finally {
      this.running = false;
    }
  }

  /** Manual single-device capture (read-only, works on monitor-only devices too). */
  async manual(deviceId: number): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
    return captureManualOrScheduled(this.db, this.box, deviceId, 'manual');
  }
}
