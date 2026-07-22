// P42 — WAN failover NOTIFICATION engine. Rides the poll cycle (like AlertEngine): reads the
// per-device raw WAN state the poller sampled, runs the pure state machine (confirm-delay /
// hold-down / flap-suppression), persists timer state to device_status, and emits the 3 WAN
// events through the notifier. Timers gate ALERTS only — RouterOS check-gateway does the
// actual failover in ~20-30s.
import type { DatabaseSync } from 'node:sqlite';
import type { Notifier } from './notify.js';
import { stepWanState, INITIAL, DEFAULT_TIMERS, type WanPersisted, type RawWanState } from './wanstate.js';
import { log } from './log.js';

export class WanEngine {
  constructor(private readonly db: DatabaseSync, private readonly notifier: Notifier) {}

  /** One pass over the devices the poller found a configured RUBYMIK-WAN failover on. */
  evaluateCycle(cycleWan: Map<number, RawWanState>): void {
    const now = Date.now();
    for (const [deviceId, raw] of cycleWan) {
      const row = this.db.prepare('SELECT wan_state_json FROM device_status WHERE device_id = ?').get(deviceId) as { wan_state_json: string | null } | undefined;
      let prev: WanPersisted = INITIAL;
      if (row?.wan_state_json) { try { prev = { ...INITIAL, ...JSON.parse(row.wan_state_json) as Partial<WanPersisted> }; } catch { /* corrupt → reset */ } }
      const r = stepWanState(prev, raw, now, DEFAULT_TIMERS);
      this.db.prepare('UPDATE device_status SET wan_state_json = ? WHERE device_id = ?').run(JSON.stringify(r.persisted), deviceId);
      if (r.events.length === 0) continue;

      const dev = this.db.prepare('SELECT d.id, d.name, d.host, s.name AS site FROM devices d LEFT JOIN sites s ON s.id = d.site_id WHERE d.id = ?')
        .get(deviceId) as { id: number; name: string; host: string; site: string | null } | undefined;
      if (!dev) continue;
      for (const e of r.events) {
        const at = new Date(now).toISOString();
        this.notifier.send(e.type, {
          rule: e.type, label: 'WAN failover', severity: e.severity, message: e.detail,
          value: r.persisted.stable, target: 'wan-failover',
          firedAt: at, resolvedAt: e.type === 'wan.primary.restored' ? at : null,
          device: { id: dev.id, name: dev.name, host: dev.host, site: dev.site },
        });
        log.info(`WAN event "${e.type}" on "${dev.name}": ${e.detail}`);
      }
    }
  }
}
