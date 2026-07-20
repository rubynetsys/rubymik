import type { DatabaseSync } from 'node:sqlite';
import { log } from './log.js';

/**
 * Outbound notifications. RubyMIK contacts NOTHING except what the user
 * configures here — no telemetry, no hard-coded endpoints, off by default.
 * Webhook is the primary channel (feeds ntfy/Gotify/Discord/Slack/HA/n8n…);
 * SMTP email is on the roadmap.
 */

export interface AlertPayload {
  rule: string;
  label: string;
  severity: string;
  message: string;
  value: string | null;
  target: string | null;
  firedAt: string;
  resolvedAt: string | null;
  device: { id: number; name: string; host: string; site: string | null };
}

const TIMEOUT_MS = 10_000;

export class Notifier {
  constructor(private readonly db: DatabaseSync) {}

  getSettings(): { webhookEnabled: boolean; webhookUrl: string | null } {
    const row = this.db.prepare('SELECT webhook_enabled, webhook_url FROM notification_settings WHERE id = 1')
      .get() as { webhook_enabled: number; webhook_url: string | null } | undefined;
    return { webhookEnabled: row?.webhook_enabled === 1, webhookUrl: row?.webhook_url ?? null };
  }

  /** Fire-and-forget; a broken webhook must never stall the poll cycle. */
  send(event: 'alert.fired' | 'alert.resolved' | 'test', alert: AlertPayload): void {
    const { webhookEnabled, webhookUrl } = this.getSettings();
    if (!webhookEnabled || !webhookUrl) return;
    void this.post(webhookUrl, event, alert)
      .then(() => log.debug(`webhook delivered: ${event} ${alert.rule} "${alert.device.name}"`))
      .catch((err) => log.warn(`webhook delivery failed (${event}): ${(err as Error).message}`));
  }

  /** Used by the settings "send test" button; returns the delivery outcome. */
  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    const { webhookEnabled, webhookUrl } = this.getSettings();
    if (!webhookUrl) return { ok: false, error: 'No webhook URL configured.' };
    if (!webhookEnabled) return { ok: false, error: 'Webhook is disabled — enable it first.' };
    try {
      await this.post(webhookUrl, 'test', {
        rule: 'test', label: 'Test notification', severity: 'info',
        message: 'RubyMIK webhook test — if you can read this, delivery works.',
        value: null, target: null, firedAt: new Date().toISOString(), resolvedAt: null,
        device: { id: 0, name: 'RubyMIK', host: 'localhost', site: null },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async post(url: string, event: string, alert: AlertPayload): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'RubyMIK' },
      body: JSON.stringify({ source: 'rubymik', event, generatedAt: new Date().toISOString(), alert }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`webhook endpoint returned HTTP ${res.status}`);
  }
}
