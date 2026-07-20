import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { restConnect, restGet } from './routeros/rest.js';
import type { RouterSystemInfo } from './routeros/types.js';
import type { SecretBox } from './secretbox.js';
import type { AlertEngine, IfaceState } from './alerts.js';
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
const TRAFFIC_RETENTION_MS = 6 * 60 * 60 * 1000;

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
    private readonly alerts?: AlertEngine,
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
      const cycleIfaces = new Map<number, IfaceState[]>();
      let up = 0;
      let down = 0;
      const worker = async (): Promise<void> => {
        for (let d = queue.shift(); d && !this.stopped; d = queue.shift()) {
          await this.waitForLaunchSlot();
          if (await this.pollDevice(d, cycleIfaces)) up++;
          else down++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, devices.length) }, worker));
      this.pruneHistory();
      // Alert evaluation rides THIS cycle — same cadence, no second loop.
      if (this.alerts) {
        try {
          this.alerts.evaluateCycle(cycleIfaces);
        } catch (err) {
          log.error(`alert evaluation failed: ${(err as Error).message}`);
        }
      }
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

  private async pollDevice(d: PollDeviceRow, cycleIfaces?: Map<number, IfaceState[]>): Promise<boolean> {
    const t0 = Date.now();
    log.debug(`→ polling "${d.name}" (${d.host})`);
    try {
      const target = {
        host: d.host,
        port: d.port ?? undefined,
        useTls: d.use_tls === null ? undefined : d.use_tls === 1,
        verifyTls: d.verify_tls === 1,
        username: this.box.decrypt(d.username_enc),
        password: this.box.decrypt(d.password_enc),
        timeoutMs: POLL_TIMEOUT_MS,
      };
      const result = await restConnect(target);
      const temp = await this.fetchTemp(target, result.scheme, result.port);
      this.recordSuccess(d.id, result.info, temp);
      // Persist what auto-probe discovered so future polls skip the probe.
      if (d.use_tls === null) {
        this.db.prepare('UPDATE devices SET use_tls = ?, port = ?, updated_at = ? WHERE id = ?')
          .run(result.scheme === 'https' ? 1 : 0, result.port, new Date().toISOString(), d.id);
      }
      await this.sampleInterfaces(d, target, result.scheme, result.port, cycleIfaces);
      await this.sampleNeighbors(d, target, result.scheme, result.port);
      log.debug(`✓ "${d.name}" up in ${Date.now() - t0}ms — cpu ${result.info.cpuLoad}%`);
      return true;
    } catch (err) {
      this.recordFailure(d.id, (err as Error).message);
      log.warn(`✗ "${d.name}" (${d.host}) unreachable after ${Date.now() - t0}ms: ${(err as Error).message}`);
      return false;
    }
  }

  /** Board temperature via /system/health — absent on boards without sensors. */
  private async fetchTemp(
    target: Parameters<typeof restGet>[0],
    scheme: 'https' | 'http',
    port: number,
  ): Promise<number | null> {
    try {
      const health = await restGet(target, scheme, port, '/system/health') as Array<Record<string, unknown>>;
      if (!Array.isArray(health)) return null;
      const temps = health
        .filter((h) => typeof h['name'] === 'string' && (h['name'] as string).includes('temperature'))
        .map((h) => Number(h['value']))
        .filter((v) => Number.isFinite(v));
      return temps.length > 0 ? Math.max(...temps) : null;
    } catch {
      return null;
    }
  }

  private recordSuccess(deviceId: number, info: RouterSystemInfo, temp: number | null): void {
    const now = new Date().toISOString();
    const memUsedPct = info.totalMemory > 0
      ? Math.round(((info.totalMemory - info.freeMemory) / info.totalMemory) * 1000) / 10
      : null;
    this.db.prepare(`
      INSERT INTO device_status (device_id, state, consecutive_failures, last_attempt_at, last_seen_at, last_error,
        identity, board_name, model, version, uptime, cpu_load, cpu_count, mem_total, mem_free, hdd_total, hdd_free, temp_c, updated_at)
      VALUES (?, 'up', 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        state = 'up', consecutive_failures = 0, last_attempt_at = excluded.last_attempt_at,
        last_seen_at = excluded.last_seen_at, last_error = NULL,
        identity = excluded.identity, board_name = excluded.board_name, model = excluded.model,
        version = excluded.version, uptime = excluded.uptime, cpu_load = excluded.cpu_load,
        cpu_count = excluded.cpu_count, mem_total = excluded.mem_total, mem_free = excluded.mem_free,
        hdd_total = excluded.hdd_total, hdd_free = excluded.hdd_free, temp_c = excluded.temp_c,
        updated_at = excluded.updated_at
    `).run(deviceId, now, now, info.identity, info.boardName, info.model, info.version, info.uptime,
      info.cpuLoad, info.cpuCount, info.totalMemory, info.freeMemory, info.totalHdd, info.freeHdd, temp, now);
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

  /**
   * One extra GET per device per cycle: /interface counters, written as a
   * single JSON-blob row (see the interface_traffic migration note). A
   * failure here never marks the device down — the health poll already
   * succeeded — it just skips this cycle's sample.
   */
  private async sampleInterfaces(
    d: PollDeviceRow,
    target: Parameters<typeof restGet>[0],
    scheme: 'https' | 'http',
    port: number,
    cycleIfaces?: Map<number, IfaceState[]>,
  ): Promise<void> {
    try {
      const ifaces = await restGet(target, scheme, port, '/interface') as Array<Record<string, unknown>>;
      const counters: Record<string, [number, number]> = {};
      const macs = new Set<string>();
      const states: IfaceState[] = [];
      for (const i of ifaces) {
        const name = typeof i['name'] === 'string' ? i['name'] : null;
        if (!name) continue;
        counters[name] = [Number(i['rx-byte']) || 0, Number(i['tx-byte']) || 0];
        if (typeof i['mac-address'] === 'string' && i['mac-address']) macs.add((i['mac-address'] as string).toLowerCase());
        states.push({ name, running: i['running'] === 'true' || i['running'] === true, disabled: i['disabled'] === 'true' || i['disabled'] === true });
      }
      cycleIfaces?.set(d.id, states);
      this.db.prepare('INSERT INTO interface_traffic (device_id, ts, data) VALUES (?, ?, ?)')
        .run(d.id, new Date().toISOString(), JSON.stringify(counters));
      this.db.prepare('UPDATE device_status SET if_macs = ? WHERE device_id = ?')
        .run(JSON.stringify([...macs]), d.id);
    } catch (err) {
      log.debug(`interface sample skipped for "${d.name}": ${(err as Error).message}`);
    }
  }

  /**
   * Neighbor discovery snapshot (MNDP/LLDP/CDP via /ip/neighbor) + the
   * device's discovery settings. Current-state only: rows are replaced
   * wholesale each cycle, so this table never grows. READ-ONLY — RubyMIK
   * surfaces restricted/disabled discovery but never changes it.
   */
  private async sampleNeighbors(
    d: PollDeviceRow,
    target: Parameters<typeof restGet>[0],
    scheme: 'https' | 'http',
    port: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
    try {
      const neighbors = await restGet(target, scheme, port, '/ip/neighbor') as Array<Record<string, unknown>>;
      this.db.exec('BEGIN');
      try {
        this.db.prepare('DELETE FROM device_neighbors WHERE device_id = ?').run(d.id);
        const ins = this.db.prepare(`
          INSERT INTO device_neighbors (device_id, seen_on, mac, identity, platform, board, version, address, remote_interface, discovered_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const n of neighbors) {
          ins.run(
            d.id, s(n['interface']), s(n['mac-address'])?.toLowerCase() ?? null, s(n['identity']),
            s(n['platform']), s(n['board']), s(n['version']),
            s(n['address4']) ?? s(n['address']), s(n['interface-name']), s(n['discovered-by']), now,
          );
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      log.debug(`neighbor sample skipped for "${d.name}": ${(err as Error).message}`);
    }
    try {
      const ds = await restGet(target, scheme, port, '/ip/neighbor/discovery-settings') as Record<string, unknown>;
      this.db.prepare(`
        INSERT INTO device_discovery (device_id, protocol, interface_list, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET protocol = excluded.protocol,
          interface_list = excluded.interface_list, updated_at = excluded.updated_at
      `).run(d.id, s(ds['protocol']), s(ds['discover-interface-list']), now);
    } catch (err) {
      log.debug(`discovery-settings sample skipped for "${d.name}": ${(err as Error).message}`);
    }
  }

  private pruneHistory(): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM device_metrics WHERE ts < ?')
      .run(new Date(now - HISTORY_RETENTION_MS).toISOString());
    this.db.prepare('DELETE FROM interface_traffic WHERE ts < ?')
      .run(new Date(now - TRAFFIC_RETENTION_MS).toISOString());
  }
}
