import type { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';
import type { SecretBox } from './secretbox.js';
import { log } from './log.js';

/**
 * P31 — outbound notifications across channels. RubyMIK contacts NOTHING except
 * what the operator configures here; every secret is AES-GCM at rest and masked
 * on read; a broken channel NEVER stalls the poll cycle (fire-and-forget + retry,
 * every attempt written to the notification log). Desktop pops are client-side.
 *
 * Channel status today: SMTP + webhook + Telegram deliver for real; WhatsApp is
 * config-only (both providers) and logs 'mocked' until paired — see P31 notes.
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

type Channel = 'webhook' | 'smtp' | 'telegram' | 'whatsapp';
type Status = 'sent' | 'failed' | 'mocked' | 'skipped';
const TIMEOUT_MS = 10_000;
const RETRIES = 2;
const LOG_KEEP = 500;

interface Row {
  webhook_enabled: number; webhook_url: string | null;
  smtp_enabled: number; smtp_host: string | null; smtp_port: number | null; smtp_secure: string | null;
  smtp_user: string | null; smtp_pass_enc: string | null; smtp_from: string | null; smtp_to: string | null;
  telegram_enabled: number; telegram_token_enc: string | null; telegram_chat_id: string | null;
  whatsapp_enabled: number; whatsapp_provider: string | null; whatsapp_config_enc: string | null;
}

export class Notifier {
  constructor(private readonly db: DatabaseSync, private readonly box: SecretBox) {}

  private row(): Row {
    return this.db.prepare('SELECT * FROM notification_settings WHERE id = 1').get() as unknown as Row;
  }
  private dec(v: string | null): string | null { try { return v ? this.box.decrypt(v) : null; } catch { return null; } }

  /** Config for the settings API — secrets shown only as *Set booleans, never returned. */
  getMasked() {
    const r = this.row();
    let wa: { to?: string; wabaBaseUrl?: string; wabaPhoneId?: string } = {};
    try { if (r.whatsapp_config_enc) wa = JSON.parse(this.dec(r.whatsapp_config_enc) ?? '{}'); } catch { /* ignore */ }
    return {
      webhook: { enabled: r.webhook_enabled === 1, url: r.webhook_url ?? '' },
      smtp: { enabled: r.smtp_enabled === 1, host: r.smtp_host ?? '', port: r.smtp_port ?? 587, secure: r.smtp_secure ?? 'starttls', user: r.smtp_user ?? '', from: r.smtp_from ?? '', to: r.smtp_to ?? '', passSet: !!r.smtp_pass_enc },
      telegram: { enabled: r.telegram_enabled === 1, chatId: r.telegram_chat_id ?? '', tokenSet: !!r.telegram_token_enc },
      whatsapp: { enabled: r.whatsapp_enabled === 1, provider: r.whatsapp_provider ?? 'waba', to: wa.to ?? '', wabaBaseUrl: wa.wabaBaseUrl ?? '', wabaPhoneId: wa.wabaPhoneId ?? '', configSet: !!r.whatsapp_config_enc },
    };
  }

  /** Persist a channel-config patch, encrypting any secret it carries. */
  saveConfig(patch: Record<string, unknown>): void {
    const sets: string[] = []; const vals: unknown[] = [];
    const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    const s = patch as Record<string, Record<string, unknown>>;
    if (s.webhook) { set('webhook_enabled', s.webhook.enabled ? 1 : 0); if (typeof s.webhook.url === 'string') set('webhook_url', s.webhook.url || null); }
    if (s.smtp) {
      const c = s.smtp;
      set('smtp_enabled', c.enabled ? 1 : 0);
      if (typeof c.host === 'string') set('smtp_host', c.host || null);
      if (c.port !== undefined) set('smtp_port', Number(c.port) || null);
      if (typeof c.secure === 'string') set('smtp_secure', c.secure);
      if (typeof c.user === 'string') set('smtp_user', c.user || null);
      if (typeof c.from === 'string') set('smtp_from', c.from || null);
      if (typeof c.to === 'string') set('smtp_to', c.to || null);
      if (typeof c.password === 'string' && c.password) set('smtp_pass_enc', this.box.encrypt(c.password));
    }
    if (s.telegram) {
      const c = s.telegram;
      set('telegram_enabled', c.enabled ? 1 : 0);
      if (typeof c.chatId === 'string') set('telegram_chat_id', c.chatId || null);
      if (typeof c.token === 'string' && c.token) set('telegram_token_enc', this.box.encrypt(c.token));
    }
    if (s.whatsapp) {
      const c = s.whatsapp;
      set('whatsapp_enabled', c.enabled ? 1 : 0);
      if (typeof c.provider === 'string') set('whatsapp_provider', c.provider);
      const cfg = { to: c.to ?? '', wabaBaseUrl: c.wabaBaseUrl ?? '', wabaPhoneId: c.wabaPhoneId ?? '', wabaToken: c.wabaToken ?? '' };
      if (c.to !== undefined || c.wabaBaseUrl !== undefined || c.wabaToken !== undefined) set('whatsapp_config_enc', this.box.encrypt(JSON.stringify(cfg)));
    }
    if (!sets.length) return;
    sets.push('updated_at = ?'); vals.push(new Date().toISOString());
    this.db.prepare(`UPDATE notification_settings SET ${sets.join(', ')} WHERE id = 1`).run(...vals as never[]);
  }

  readLog(limit = 100) {
    return this.db.prepare('SELECT id, ts, channel, event, target, status, detail FROM notification_log ORDER BY id DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 500));
  }
  private logEntry(channel: Channel, event: string, target: string | null, status: Status, detail: string): void {
    this.db.prepare('INSERT INTO notification_log (ts, channel, event, target, status, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), channel, event, target, status, detail.slice(0, 500));
    // keep the log bounded
    this.db.prepare('DELETE FROM notification_log WHERE id NOT IN (SELECT id FROM notification_log ORDER BY id DESC LIMIT ?)').run(LOG_KEEP);
  }

  private subject(event: string, a: AlertPayload): string {
    if (event === 'test') return 'RubyMIK — test notification';
    const verb = event === 'alert.resolved' ? 'resolved' : 'FIRING';
    return `[RubyMIK] ${a.label} ${verb}: ${a.device.name}`;
  }
  private textBody(event: string, a: AlertPayload): string {
    return [
      this.subject(event, a),
      '',
      a.message,
      `Device: ${a.device.name} (${a.device.host})${a.device.site ? ` · ${a.device.site}` : ''}`,
      `Severity: ${a.severity}${a.value ? ` · ${a.value}` : ''}`,
      `At: ${a.resolvedAt ?? a.firedAt}`,
      '', '— RubyMIK',
    ].join('\n');
  }

  /** Deliver to every ENABLED channel. Fire-and-forget: never throws, never blocks. */
  send(event: 'alert.fired' | 'alert.resolved' | 'test', alert: AlertPayload): void {
    const r = this.row();
    if (r.webhook_enabled === 1 && r.webhook_url) void this.attempt('webhook', event, alert, () => this.postWebhook(r.webhook_url!, event, alert));
    if (r.smtp_enabled === 1) void this.attempt('smtp', event, alert, () => this.sendSmtp(r, event, alert));
    if (r.telegram_enabled === 1) void this.attempt('telegram', event, alert, () => this.sendTelegram(r, event, alert));
    if (r.whatsapp_enabled === 1) void this.attempt('whatsapp', event, alert, () => this.sendWhatsapp(r, event, alert));
  }

  /** Test a single channel from the settings UI; returns the outcome synchronously-awaited. */
  async sendTest(channel: Channel): Promise<{ ok: boolean; status: Status; detail: string }> {
    const r = this.row();
    const alert: AlertPayload = {
      rule: 'test', label: 'Test notification', severity: 'info',
      message: 'RubyMIK test — if you can read this, this channel is delivering.',
      value: null, target: null, firedAt: new Date().toISOString(), resolvedAt: null,
      device: { id: 0, name: 'RubyMIK', host: 'localhost', site: null },
    };
    try {
      const fn = channel === 'webhook' ? () => this.postWebhook(r.webhook_url ?? '', 'test', alert)
        : channel === 'smtp' ? () => this.sendSmtp(r, 'test', alert)
        : channel === 'telegram' ? () => this.sendTelegram(r, 'test', alert)
        : () => this.sendWhatsapp(r, 'test', alert);
      const status = await fn();
      this.logEntry(channel, 'test', null, status, status === 'mocked' ? 'Test mocked (channel not paired/live).' : 'Test delivered.');
      return { ok: status !== 'failed', status, detail: status === 'mocked' ? 'Sent as a mock — this channel is not paired/live yet.' : 'Delivered.' };
    } catch (err) {
      this.logEntry(channel, 'test', null, 'failed', (err as Error).message);
      return { ok: false, status: 'failed', detail: (err as Error).message };
    }
  }

  private async attempt(channel: Channel, event: string, alert: AlertPayload, fn: () => Promise<Status>): Promise<void> {
    for (let i = 0; i <= RETRIES; i++) {
      try {
        const status = await fn();
        this.logEntry(channel, event, alert.device.name, status, status === 'mocked' ? 'Mocked (channel not live).' : `Delivered "${alert.label}".`);
        return;
      } catch (err) {
        if (i === RETRIES) {
          this.logEntry(channel, event, alert.device.name, 'failed', (err as Error).message);
          log.warn(`notify ${channel} failed (${event}) after ${RETRIES + 1} tries: ${(err as Error).message}`);
          return;
        }
        await new Promise((res) => setTimeout(res, 500 * (i + 1))); // linear backoff
      }
    }
  }

  private async postWebhook(url: string, event: string, alert: AlertPayload): Promise<Status> {
    if (!url) throw new Error('No webhook URL configured.');
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'RubyMIK' }, body: JSON.stringify({ source: 'rubymik', event, generatedAt: new Date().toISOString(), alert }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`webhook endpoint returned HTTP ${res.status}`);
    return 'sent';
  }

  private async sendSmtp(r: Row, event: string, alert: AlertPayload): Promise<Status> {
    if (!r.smtp_host || !r.smtp_from || !r.smtp_to) throw new Error('SMTP host, from and to are required.');
    const pass = this.dec(r.smtp_pass_enc);
    const secure = r.smtp_secure === 'tls';
    const transport = nodemailer.createTransport({
      host: r.smtp_host, port: r.smtp_port ?? 587, secure,
      ...(r.smtp_secure === 'starttls' ? { requireTLS: true } : {}),
      ...(r.smtp_user && pass ? { auth: { user: r.smtp_user, pass } } : {}),
      connectionTimeout: TIMEOUT_MS,
    });
    await transport.sendMail({ from: r.smtp_from, to: r.smtp_to, subject: this.subject(event, alert), text: this.textBody(event, alert) });
    return 'sent';
  }

  private async sendTelegram(r: Row, event: string, alert: AlertPayload): Promise<Status> {
    const token = this.dec(r.telegram_token_enc);
    if (!token || !r.telegram_chat_id) throw new Error('Telegram bot token and chat ID are required.');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: r.telegram_chat_id, text: this.textBody(event, alert) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Telegram API returned HTTP ${res.status}`);
    return 'sent';
  }

  private async sendWhatsapp(r: Row, event: string, alert: AlertPayload): Promise<Status> {
    // Both providers are config-only until paired/provisioned. WABA can go live if a
    // real base URL + token + phone-id are set; otherwise (and always for Baileys) we
    // record a 'mocked' delivery so the wiring is proven without an account/pairing.
    let cfg: { to?: string; wabaBaseUrl?: string; wabaPhoneId?: string; wabaToken?: string } = {};
    try { if (r.whatsapp_config_enc) cfg = JSON.parse(this.dec(r.whatsapp_config_enc) ?? '{}'); } catch { /* ignore */ }
    if (r.whatsapp_provider === 'waba' && cfg.wabaBaseUrl && cfg.wabaToken && cfg.wabaPhoneId && cfg.to) {
      const res = await fetch(`${cfg.wabaBaseUrl.replace(/\/$/, '')}/${cfg.wabaPhoneId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.wabaToken}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: cfg.to, type: 'text', text: { body: this.textBody(event, alert) } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`WhatsApp Cloud API returned HTTP ${res.status}`);
      return 'sent';
    }
    return 'mocked';
  }

  /** P40: can we send a transactional email at all? (host + a from-address). The
   *  alert `enabled` toggle is about alert delivery — password-reset/invite email is
   *  transactional and only needs a working SMTP host + sender. */
  smtpReady(): boolean {
    const r = this.row();
    return !!r.smtp_host && !!r.smtp_from;
  }
  /** The configured sender address (PENDING-RAY: set this in Settings → Notifications;
   *  there is NO hardcoded default sender). */
  smtpFrom(): string | null { return this.row().smtp_from; }

  /** P40: send a one-off email to an explicit recipient (password reset / invite),
   *  using the configured SMTP transport + from-address. Throws if SMTP isn't set up. */
  async sendMailTo(to: string, subject: string, text: string): Promise<void> {
    const r = this.row();
    if (!r.smtp_host || !r.smtp_from) throw new Error('SMTP is not configured (set host + from in Settings → Notifications).');
    const pass = this.dec(r.smtp_pass_enc);
    const transport = nodemailer.createTransport({
      host: r.smtp_host, port: r.smtp_port ?? 587, secure: r.smtp_secure === 'tls',
      ...(r.smtp_secure === 'starttls' ? { requireTLS: true } : {}),
      ...(r.smtp_user && pass ? { auth: { user: r.smtp_user, pass } } : {}),
      connectionTimeout: TIMEOUT_MS,
    });
    try {
      await transport.sendMail({ from: r.smtp_from, to, subject, text });
      this.logEntry('smtp', 'transactional', to, 'sent', `Sent "${subject}".`);
    } catch (err) {
      this.logEntry('smtp', 'transactional', to, 'failed', (err as Error).message);
      throw err;
    }
  }

  // Back-compat for the old webhook-only settings API shape.
  getSettings(): { webhookEnabled: boolean; webhookUrl: string | null } {
    const r = this.row();
    return { webhookEnabled: r.webhook_enabled === 1, webhookUrl: r.webhook_url ?? null };
  }
}
