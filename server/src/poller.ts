import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { restConnect } from './routeros/rest.js';
import type { RouterSystemInfo } from './routeros/types.js';
import type { SecretBox } from './secretbox.js';
import { log } from './log.js';

/**
 * Background device poller. READ-ONLY by design: the only RouterOS call it
 * makes is restConnect(), which issues GETs exclusively.
 *
 * Scale behavior (first-class, not an afterthought):
 * - Poll launches are STAGGERED: a shared launch-slot gate spaces device
 *   polls LAUNCH_SPACING_MS apart, so a 50-router fleet never receives a
 *   simultaneous burst.
 * - Concurrency is bounded by a worker pool (config.pollConcurrency), and
 *   each device has its own timeout — one dead/slow device occupies one
 *   worker slot for at most the timeout, never the whole cycle.
 * - If a cycle is still running when the next tick fires, the tick is
 *   skipped and logged (the interval is too short for the fleet, which is a
 *   visible condition — never a pile-up).
 * - SQLite-friendly writes: device_status is one UPSERTed row per device;
 *   device_metrics is append-only and pruned to 24h each cycle.
 */

const LAUNCH_SPACING_MS = 250;
const POLL_TIMEOUT_MS = 10_000;
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

interface PollDeviceRow {
  id: number;
  name: string;
  host: string;
  port: number | null;
  use_tls: number | null;
  verify_tls: number;
  username_enc: string;
  password_enc: string;
}

const DEVICE_COLS = 'id, name, host, port, use_tls, verify_tls, username_enc, password_enc';

export class Poller {
  private timer: NodeJS.Timeout | undefined;
  private cycleRunning = false;
  private cycleCount = 0;
  private nextLaunchAt = 0;
  private stopped = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly intervalMs: number,
    private readonly concurrency: number,
  ) {}

  start(): void {
    log.info(`Poller started — interval ${this.intervalMs / 1000}s, concurrency ${this.concurrency}, launch spacing ${LAUNCH_SPACING_MS}ms, per-device timeout ${POLL_TIMEOUT_MS / 1000}s`);
    setTimeout(() => void this.runCycle('startup'), 1500).unref();
    this.timer = setInterval(() => void this.runCycle('interval'), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  async runCycle(reason: string): Promise<void> {
    if (this.stopped) return;
    if (this.cycleRunning) {
      log.warn('Poll cycle skipped — previous cycle still running (poll interval may be too short for this fleet size)');
      return;
    }
    this.cycleRunning = true;
    const startedAt = Date.now();
    const cycle = ++this.cycleCount;
    try {
      const devices = this.db.prepare(`SELECT ${DEVICE_COLS} FROM devices ORDER BY id`).all() as unknown as PollDeviceRow[];
      if (devices.length === 0) return;
      log.info(`Poll cycle #${cycle} started — ${devices.length} device(s), reason=${reason}`);
      const queue = [...devices];
      let up = 0;
      let down = 0;
      const worker = async (): Promise<void> => {
        for (let d = queue.shift(); d && !this.stopped; d = queue.shift()) {
          await this.waitForLaunchSlot();
          if (await this.pollDevice(d)) up++;
          else down++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, devices.length) }, worker));
      this.pruneHistory();
      log.info(`Poll cycle #${cycle} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${up} up, ${down} down`);
    } finally {
      this.cycleRunning = false;
    }
  }

  /** Immediate one-off poll (device just added/edited) so status appears fast. */
  pollDeviceById(id: number): void {
    const row = this.db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE id = ?`).get(id) as unknown as PollDeviceRow | undefined;
    if (row) void this.pollDevice(row).catch(() => {});
  }

  /** Spaces poll launches LAUNCH_SPACING_MS apart across all workers. */
  private async waitForLaunchSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextLaunchAt);
    this.nextLaunchAt = slot + LAUNCH_SPACING_MS;
    if (slot > now) await sleep(slot - now);
  }

  private async pollDevice(d: PollDeviceRow): Promise<boolean> {
    const t0 = Date.now();
    log.debug(`→ polling "${d.name}" (${d.host})`);
    try {
      const result = await restConnect({
        host: d.host,
        port: d.port ?? undefined,
        useTls: d.use_tls === null ? undefined : d.use_tls === 1,
        verifyTls: d.verify_tls === 1,
        username: this.box.decrypt(d.username_enc),
        password: this.box.decrypt(d.password_enc),
        timeoutMs: POLL_TIMEOUT_MS,
      });
      this.recordSuccess(d.id, result.info);
      // Persist what auto-probe discovered so future polls skip the probe.
      if (d.use_tls === null) {
        this.db.prepare('UPDATE devices SET use_tls = ?, port = ?, updated_at = ? WHERE id = ?')
          .run(result.scheme === 'https' ? 1 : 0, result.port, new Date().toISOString(), d.id);
      }
      log.debug(`✓ "${d.name}" up in ${Date.now() - t0}ms — cpu ${result.info.cpuLoad}%`);
      return true;
    } catch (err) {
      this.recordFailure(d.id, (err as Error).message);
      log.warn(`✗ "${d.name}" (${d.host}) unreachable after ${Date.now() - t0}ms: ${(err as Error).message}`);
      return false;
    }
  }

  private recordSuccess(deviceId: number, info: RouterSystemInfo): void {
    const now = new Date().toISOString();
    const memUsedPct = info.totalMemory > 0
      ? Math.round(((info.totalMemory - info.freeMemory) / info.totalMemory) * 1000) / 10
      : null;
    this.db.prepare(`
      INSERT INTO device_status (device_id, state, consecutive_failures, last_attempt_at, last_seen_at, last_error,
        identity, board_name, model, version, uptime, cpu_load, cpu_count, mem_total, mem_free, hdd_total, hdd_free, updated_at)
      VALUES (?, 'up', 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        state = 'up', consecutive_failures = 0, last_attempt_at = excluded.last_attempt_at,
        last_seen_at = excluded.last_seen_at, last_error = NULL,
        identity = excluded.identity, board_name = excluded.board_name, model = excluded.model,
        version = excluded.version, uptime = excluded.uptime, cpu_load = excluded.cpu_load,
        cpu_count = excluded.cpu_count, mem_total = excluded.mem_total, mem_free = excluded.mem_free,
        hdd_total = excluded.hdd_total, hdd_free = excluded.hdd_free, updated_at = excluded.updated_at
    `).run(deviceId, now, now, info.identity, info.boardName, info.model, info.version, info.uptime,
      info.cpuLoad, info.cpuCount, info.totalMemory, info.freeMemory, info.totalHdd, info.freeHdd, now);
    this.db.prepare('INSERT INTO device_metrics (device_id, ts, up, cpu_load, mem_used_pct) VALUES (?, ?, 1, ?, ?)')
      .run(deviceId, now, info.cpuLoad, memUsedPct);
  }

  /** Marks the device down but keeps its last-known info fields intact. */
  private recordFailure(deviceId: number, error: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO device_status (device_id, state, consecutive_failures, last_attempt_at, last_error, updated_at)
      VALUES (?, 'down', 1, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        state = 'down', consecutive_failures = device_status.consecutive_failures + 1,
        last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(deviceId, now, error, now);
    this.db.prepare('INSERT INTO device_metrics (device_id, ts, up, cpu_load, mem_used_pct) VALUES (?, ?, 0, NULL, NULL)')
      .run(deviceId, now);
  }

  private pruneHistory(): void {
    const cutoff = new Date(Date.now() - HISTORY_RETENTION_MS).toISOString();
    this.db.prepare('DELETE FROM device_metrics WHERE ts < ?').run(cutoff);
  }
}
