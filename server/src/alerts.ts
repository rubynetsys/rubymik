import type { DatabaseSync } from 'node:sqlite';
import type { Notifier } from './notify.js';
import { log } from './log.js';

/**
 * Alert engine. Runs ONCE at the end of each poll cycle against state the
 * poller already collected — it never calls a device and adds no polling.
 *
 * Anti-flap (the quality bar): every rule runs through a consecutive-cycle
 * debouncer with a hysteresis dead band. A value between clear_threshold and
 * threshold is "in band": it RESETS the fire streak (so hovering never
 * accumulates the N consecutive breaches needed to fire) and RESETS the
 * resolve streak (so a firing alert never resolves until the value stays at
 * or below clear_threshold for N consecutive cycles). One firing row per
 * (device, rule, target) is enforced by a partial unique index.
 *
 * Debounce streaks are in-memory: a restart re-arms them, which at worst
 * delays an alert by the debounce window — never a false fire.
 */

export type Severity = 'info' | 'warning' | 'critical';
export type Condition = 'breach' | 'clear' | 'band';
export type StepResult = 'fire' | 'resolve' | null;

export const RULE_META: Record<string, { label: string; severity: Severity; unit: string | null }> = {
  device_down: { label: 'Device down', severity: 'critical', unit: null },
  cpu_high: { label: 'High CPU', severity: 'warning', unit: '%' },
  mem_high: { label: 'High memory', severity: 'warning', unit: '%' },
  temp_high: { label: 'High temperature', severity: 'warning', unit: '°C' },
  iface_down: { label: 'Interface down', severity: 'warning', unit: null },
};

/** Pure consecutive-cycle debouncer — exported for unit tests. */
export class Debouncer {
  private streaks = new Map<string, { breach: number; clear: number }>();

  step(key: string, cond: Condition, fireCycles: number, resolveCycles: number, isActive: boolean): StepResult {
    let s = this.streaks.get(key);
    if (!s) this.streaks.set(key, (s = { breach: 0, clear: 0 }));
    if (!isActive) {
      s.clear = 0;
      if (cond === 'breach') {
        s.breach++;
        if (s.breach >= fireCycles) {
          s.breach = 0;
          return 'fire';
        }
      } else {
        // 'clear' or in-band both break the consecutive-breach streak.
        s.breach = 0;
      }
    } else {
      s.breach = 0;
      if (cond === 'clear') {
        s.clear++;
        if (s.clear >= resolveCycles) {
          s.clear = 0;
          return 'resolve';
        }
      } else {
        // breach or in-band: the alert holds; the resolve streak resets.
        s.clear = 0;
      }
    }
    return null;
  }

  drop(prefix: string): void {
    for (const k of this.streaks.keys()) {
      if (k.startsWith(prefix)) this.streaks.delete(k);
    }
  }
}

export interface IfaceState {
  name: string;
  running: boolean;
  disabled: boolean;
}

/**
 * Interface transition semantics — exported for unit tests.
 * Alert only on "was running, now down, not admin-disabled". A disable is an
 * operator action, not a fault; an interface already down at baseline is not
 * a transition; an interface we've never seen has no baseline.
 */
export function ifaceCondition(prev: IfaceState | undefined, now: IfaceState): Condition | 'ignore' {
  if (now.disabled) return 'ignore';
  if (now.running) return 'clear';
  if (!prev) return 'ignore'; // no baseline — never fire on first sight
  if (prev.disabled) return 'ignore'; // was admin-disabled — re-enable settling isn't a fault yet
  if (prev.running) return 'breach'; // was running, now down → the real case
  return 'ignore'; // down at baseline stays non-alerting until it runs once
}

interface RuleRow {
  rule: string;
  enabled: number;
  threshold: number | null;
  clear_threshold: number | null;
  fire_cycles: number;
  resolve_cycles: number;
}

interface DeviceRow {
  id: number;
  name: string;
  host: string;
  site_id: number | null;
  site_name: string | null;
  state: string | null;
  consecutive_failures: number | null;
  last_error: string | null;
  cpu_load: number | null;
  mem_total: number | null;
  mem_free: number | null;
  temp_c: number | null;
}

interface ActiveAlert {
  id: number;
  device_id: number;
  rule: string;
  target: string | null;
  fired_at: string;
}

const HISTORY_RETENTION_DAYS = 30;

export class AlertEngine {
  private debounce = new Debouncer();
  private prevIfaces = new Map<number, Map<string, IfaceState>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly notifier: Notifier,
  ) {}

  /**
   * Resolve the effective rule for a device. P4 ships global rows only, but
   * the lookup order (device > site > global) is already here so overrides
   * later are data, not code.
   */
  private effectiveRule(rules: RuleRow[], _deviceId: number, _siteId: number | null, name: string): RuleRow | undefined {
    return rules.find((r) => r.rule === name);
  }

  evaluateCycle(ifaceStates: Map<number, IfaceState[]>): void {
    const now = new Date().toISOString();
    const rules = this.db.prepare(`
      SELECT rule, enabled, threshold, clear_threshold, fire_cycles, resolve_cycles
      FROM alert_rules WHERE scope_kind = 'global'
    `).all() as unknown as RuleRow[];

    const devices = this.db.prepare(`
      SELECT d.id, d.name, d.host, d.site_id, s.name AS site_name,
             st.state, st.consecutive_failures, st.last_error,
             st.cpu_load, st.mem_total, st.mem_free, st.temp_c
      FROM devices d
      LEFT JOIN sites s ON s.id = d.site_id
      LEFT JOIN device_status st ON st.device_id = d.id
    `).all() as unknown as DeviceRow[];

    const active = new Map<string, ActiveAlert>();
    for (const a of this.db.prepare(
      `SELECT id, device_id, rule, target, fired_at FROM alerts WHERE state = 'firing'`,
    ).all() as unknown as ActiveAlert[]) {
      active.set(`${a.device_id}:${a.rule}:${a.target ?? ''}`, a);
    }

    const knownIds = new Set(devices.map((d) => d.id));
    for (const id of [...this.prevIfaces.keys()]) {
      if (!knownIds.has(id)) {
        this.prevIfaces.delete(id);
        this.debounce.drop(`${id}:`);
      }
    }

    for (const d of devices) {
      if (d.state === null) continue; // never polled — nothing to evaluate

      this.binaryRule(d, this.effectiveRule(rules, d.id, d.site_id, 'device_down'), active, now,
        d.state === 'down',
        () => `Unreachable (${d.consecutive_failures ?? '?'} failed polls) — ${d.last_error ?? 'no response'}`,
        () => `${d.consecutive_failures ?? '?'} failed polls`);

      const memPct = d.mem_total && d.mem_free !== null
        ? Math.round(((d.mem_total - d.mem_free) / d.mem_total) * 1000) / 10
        : null;
      this.valueRule(d, this.effectiveRule(rules, d.id, d.site_id, 'cpu_high'), active, now,
        d.state === 'up' ? d.cpu_load : null, (v, t) => `CPU at ${v}% (threshold ${t}%)`);
      this.valueRule(d, this.effectiveRule(rules, d.id, d.site_id, 'mem_high'), active, now,
        d.state === 'up' ? memPct : null, (v, t) => `Memory at ${v}% (threshold ${t}%)`);
      this.valueRule(d, this.effectiveRule(rules, d.id, d.site_id, 'temp_high'), active, now,
        d.state === 'up' ? d.temp_c : null, (v, t) => `Temperature at ${v}°C (threshold ${t}°C)`);

      this.ifaceRule(d, this.effectiveRule(rules, d.id, d.site_id, 'iface_down'), active, now, ifaceStates.get(d.id));
    }

    this.db.prepare(`DELETE FROM alerts WHERE state = 'resolved' AND resolved_at < datetime('now', ?)`)
      .run(`-${HISTORY_RETENTION_DAYS} days`);
  }

  private binaryRule(
    d: DeviceRow, rule: RuleRow | undefined, active: Map<string, ActiveAlert>, now: string,
    breach: boolean, message: () => string, value: () => string,
  ): void {
    if (!rule?.enabled) return;
    const key = `${d.id}:${rule.rule}:`;
    const isActive = active.has(key);
    const cond: Condition = breach ? 'breach' : 'clear';
    this.applyStep(d, rule, null, active, now, cond, isActive, message, value);
  }

  private valueRule(
    d: DeviceRow, rule: RuleRow | undefined, active: Map<string, ActiveAlert>, now: string,
    value: number | null, message: (v: number, t: number) => string,
  ): void {
    if (!rule?.enabled || rule.threshold === null) return;
    const key = `${d.id}:${rule.rule}:`;
    const isActive = active.has(key);
    // No reading (down, or the board doesn't report it) → hold current state.
    if (value === null) {
      this.debounce.step(key, 'band', rule.fire_cycles, rule.resolve_cycles, isActive);
      return;
    }
    const clearAt = rule.clear_threshold ?? rule.threshold;
    const cond: Condition = value >= rule.threshold ? 'breach' : value <= clearAt ? 'clear' : 'band';
    log.debug(`alert eval "${d.name}" ${rule.rule}: ${value}${RULE_META[rule.rule]?.unit ?? ''} → ${cond}${isActive ? ' (firing)' : ''}`);
    this.applyStep(d, rule, null, active, now, cond, isActive,
      () => message(value, rule.threshold!), () => `${value}${RULE_META[rule.rule]?.unit ?? ''}`);
  }

  private ifaceRule(
    d: DeviceRow, rule: RuleRow | undefined, active: Map<string, ActiveAlert>, now: string,
    states: IfaceState[] | undefined,
  ): void {
    // No fresh interface data this cycle (device down / sample failed):
    // keep the previous baseline, hold streaks — never guess.
    if (!states) return;
    const prev = this.prevIfaces.get(d.id);
    if (rule?.enabled && prev) {
      for (const iface of states) {
        const cond = ifaceCondition(prev.get(iface.name), iface);
        if (cond === 'ignore') continue;
        const key = `${d.id}:iface_down:${iface.name}`;
        const isActive = active.has(key);
        if (cond === 'breach' || isActive) {
          this.applyStep(d, rule, iface.name, active, now, cond, isActive,
            () => `Interface ${iface.name} went down (was running)`,
            () => (iface.running ? 'running' : 'down'));
        }
      }
    }
    this.prevIfaces.set(d.id, new Map(states.map((s) => [s.name, s])));
  }

  private applyStep(
    d: DeviceRow, rule: RuleRow, target: string | null, active: Map<string, ActiveAlert>, now: string,
    cond: Condition, isActive: boolean, message: () => string, value: () => string,
  ): void {
    const key = `${d.id}:${rule.rule}:${target ?? ''}`;
    const result = this.debounce.step(key, cond, rule.fire_cycles, rule.resolve_cycles, isActive);
    const meta = RULE_META[rule.rule]!;

    if (result === 'fire') {
      const msg = message();
      this.db.prepare(`
        INSERT INTO alerts (device_id, rule, target, severity, state, message, value, fired_at, last_seen_at, cycles)
        VALUES (?, ?, ?, ?, 'firing', ?, ?, ?, ?, ?)
      `).run(d.id, rule.rule, target, meta.severity, msg, value(), now, now, rule.fire_cycles);
      log.info(`ALERT FIRED [${meta.severity}] ${meta.label} — "${d.name}"${target ? ` ${target}` : ''}: ${msg}`);
      this.notifier.send('alert.fired', {
        rule: rule.rule, label: meta.label, severity: meta.severity, message: msg, value: value(),
        target, firedAt: now, resolvedAt: null,
        device: { id: d.id, name: d.name, host: d.host, site: d.site_name },
      });
    } else if (result === 'resolve') {
      const a = active.get(key)!;
      this.db.prepare(`UPDATE alerts SET state = 'resolved', resolved_at = ?, last_seen_at = ? WHERE id = ?`)
        .run(now, now, a.id);
      const durationSec = Math.round((Date.parse(now) - Date.parse(a.fired_at)) / 1000);
      log.info(`ALERT RESOLVED [${meta.severity}] ${meta.label} — "${d.name}"${target ? ` ${target}` : ''} after ${durationSec}s`);
      this.notifier.send('alert.resolved', {
        rule: rule.rule, label: meta.label, severity: meta.severity,
        message: `Resolved after ${durationSec}s`, value: value(),
        target, firedAt: a.fired_at, resolvedAt: now,
        device: { id: d.id, name: d.name, host: d.host, site: d.site_name },
      });
    } else if (isActive && cond === 'breach') {
      // Condition still holds → the ONE active row is refreshed, never duplicated.
      const a = active.get(key)!;
      this.db.prepare(`UPDATE alerts SET last_seen_at = ?, cycles = cycles + 1, value = ? WHERE id = ?`)
        .run(now, value(), a.id);
    }
  }
}
