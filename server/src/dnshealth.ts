// P43 — filtering-resolver health monitor. A dead resolver on a FAIL-OPEN site is silent
// no-filtering: everything resolves, nobody's told. That silence is the failure mode (the P36
// lesson). This watches the resolver and emits dnsfilter.resolver.down / .restored through the
// P31 notifier. Debounced so a brief Save & apply reload blip never false-alarms.
import type { Notifier, AlertPayload } from './notify.js';
import { dnsQuery } from './resolver.js';
import { log } from './log.js';

export type RawHealth = 'up' | 'down';
export interface HealthTimers { downConfirmChecks: number } // consecutive DOWN checks before we alert
export const DEFAULT_HEALTH_TIMERS: HealthTimers = { downConfirmChecks: 2 };

export interface HealthPersisted { stable: 'up' | 'down' | 'unknown'; downStreak: number }
export const INITIAL_HEALTH: HealthPersisted = { stable: 'unknown', downStreak: 0 };

export type HealthEventType = 'dnsfilter.resolver.down' | 'dnsfilter.resolver.restored';
export interface HealthEvent { type: HealthEventType; detail: string; severity: 'critical' | 'info' }

/** Pure reducer: fold one health sample into the state, emitting confirmed transitions only. */
export function stepResolverHealth(prev: HealthPersisted, raw: RawHealth, timers: HealthTimers): { persisted: HealthPersisted; events: HealthEvent[] } {
  const events: HealthEvent[] = [];
  if (raw === 'up') {
    if (prev.stable === 'down') events.push({ type: 'dnsfilter.resolver.restored', detail: 'The filtering resolver is answering again — DNS filtering is back in effect.', severity: 'info' });
    return { persisted: { stable: 'up', downStreak: 0 }, events };
  }
  const downStreak = prev.downStreak + 1;
  if (downStreak >= timers.downConfirmChecks && prev.stable !== 'down') {
    events.push({
      type: 'dnsfilter.resolver.down',
      detail: `The filtering resolver has not answered for ${downStreak} consecutive checks. On fail-open sites this means NO filtering is being applied right now — every domain resolves. Check the resolver.`,
      severity: 'critical',
    });
    return { persisted: { stable: 'down', downStreak }, events };
  }
  return { persisted: { stable: prev.stable, downStreak }, events };
}

/** Rides its own interval (the resolver is a single global resource, unlike the per-device
 *  poller). Only started when filtering is enabled. Health state is in-memory: on a RubyMIK
 *  restart it re-baselines silently, then alerts on the next confirmed transition. */
export class ResolverHealthMonitor {
  private state: HealthPersisted = INITIAL_HEALTH;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly cfg: { dnsHost: string; dnsPort: number },
    private readonly notifier: Notifier,
    private readonly intervalSec: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.intervalSec * 1000);
    this.timer.unref();
    void this.check();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async check(): Promise<void> {
    let raw: RawHealth;
    try { await dnsQuery(this.cfg.dnsHost, this.cfg.dnsPort, 'cloudflare.com'); raw = 'up'; }
    catch { raw = 'down'; }
    const r = stepResolverHealth(this.state, raw, DEFAULT_HEALTH_TIMERS);
    this.state = r.persisted;
    for (const e of r.events) {
      const at = new Date().toISOString();
      const payload: AlertPayload = {
        rule: e.type, label: 'DNS filtering resolver', severity: e.severity, message: e.detail,
        value: r.persisted.stable, target: 'dns-resolver', firedAt: at,
        resolvedAt: e.type === 'dnsfilter.resolver.restored' ? at : null,
        device: { id: 0, name: 'Filtering resolver', host: this.cfg.dnsHost, site: null },
      };
      this.notifier.send(e.type, payload);
      log.info(`DNS resolver health event "${e.type}": ${e.detail}`);
    }
  }
}
