import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Mail, MessageCircle, MonitorSmartphone, Send, TriangleAlert, Webhook } from 'lucide-react';
import { api } from '../api';
import Select from './Select';
import type { Alert, NotificationSettings } from '../types';

/** Fires a browser pop + sound for each NEW firing alert while the app is open
 *  (opt-in via the Desktop card; the initial backlog is not popped). Mount once. */
export function useDesktopAlerts() {
  useEffect(() => {
    const seen = new Set<number>();
    let first = true;
    const poll = async () => {
      if (localStorage.getItem('rubymik_desktop') !== '1') return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      try {
        const alerts = await api.get<Alert[]>('/api/alerts?state=firing');
        for (const a of alerts) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          if (!first) {
            new Notification(`RubyMIK — ${a.ruleLabel}`, { body: `${a.deviceName}: ${a.message}` });
            if (localStorage.getItem('rubymik_desktop_sound') !== '0') beep();
          }
        }
        first = false;
      } catch { /* transient */ }
    };
    void poll();
    const t = setInterval(() => { if (!document.hidden) void poll(); }, 12_000);
    return () => clearInterval(t);
  }, []);
}

const input = 'w-full rounded-lg border border-border-strong bg-app px-3 py-2 text-sm text-fg-body outline-none focus:border-accent-border-strong';

export default function NotificationChannels() {
  const [cfg, setCfg] = useState<NotificationSettings | null>(null);
  const load = useCallback(() => { api.get<NotificationSettings>('/api/alerts/notifications').then(setCfg).catch(() => {}); }, []);
  useEffect(() => load(), [load]);
  if (!cfg) return <div className="h-40 animate-pulse rounded-2xl border border-border bg-surface" />;
  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-dim">Off by default. RubyMIK sends alerts ONLY to the channels you configure here — nothing phones home. Secrets are encrypted at rest and never shown again once saved.</p>
      <SmtpCard cfg={cfg.smtp} onSaved={load} />
      <TelegramCard cfg={cfg.telegram} onSaved={load} />
      <WhatsappCard cfg={cfg.whatsapp} onSaved={load} />
      <WebhookCard cfg={cfg.webhook} onSaved={load} />
      <DesktopCard />
    </div>
  );
}

function Card({ icon: Icon, title, subtitle, children }: { icon: React.ComponentType<{ className?: string }>; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body"><Icon className="h-4 w-4 text-fg-faint" /> {title}</h3>
      <p className="mt-1 text-xs text-fg-dim">{subtitle}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">{label}</span>{children}</label>;
}
function useChannel(onSaved: () => void) {
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (patch: Record<string, unknown>) => { setBusy('save'); setMsg(null); try { await api.put('/api/alerts/notifications', patch); setMsg({ ok: true, text: 'Saved.' }); onSaved(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(null); } };
  const test = async (channel: string) => { setBusy('test'); setMsg(null); try { const r = await api.post<{ detail: string }>('/api/alerts/notifications/test', { channel }); setMsg({ ok: true, text: r.detail || 'Delivered.' }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(null); } };
  return { busy, msg, save, test };
}
function Actions({ enabled, onToggle, busy, msg, onSave, onTest, canTest }: {
  enabled: boolean; onToggle: (v: boolean) => void; busy: 'save' | 'test' | null; msg: { ok: boolean; text: string } | null; onSave: () => void; onTest: () => void; canTest: boolean;
}) {
  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-fg-body">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} className="h-4 w-4 accent-accent" /> Enabled
        </label>
        <button onClick={onSave} disabled={busy !== null} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button onClick={onTest} disabled={busy !== null || !canTest} title={canTest ? 'Send a test' : 'Save an enabled channel first'} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:border-accent-border hover:text-accent-text disabled:opacity-50">{busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send test</button>
      </div>
      {msg && <div className={`mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${msg.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg-strong'}`}>{msg.ok ? <Check className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}{msg.text}</div>}
    </>
  );
}

function SmtpCard({ cfg, onSaved }: { cfg: NotificationSettings['smtp']; onSaved: () => void }) {
  const [f, setF] = useState({ enabled: cfg.enabled, host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, from: cfg.from, to: cfg.to, password: '' });
  const c = useChannel(onSaved); const up = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Card icon={Mail} title="Email (SMTP)" subtitle="Send alert emails via your SMTP provider (SMTP2GO, Gmail, your mail server…).">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Host"><input className={input} value={f.host} onChange={(e) => up('host', e.target.value)} placeholder="mail.smtp2go.com" /></Field>
        <Field label="Port"><input className={input} value={f.port} onChange={(e) => up('port', Number(e.target.value) || 0)} inputMode="numeric" /></Field>
        <Field label="Security"><Select value={f.secure} onChange={(v) => up('secure', v)} className="w-full" ariaLabel="Security" options={[{ value: 'starttls', label: 'STARTTLS (587 / 2525)' }, { value: 'tls', label: 'TLS / SSL (465)' }, { value: 'none', label: 'None' }]} /></Field>
        <Field label="Username"><input className={input} value={f.user} onChange={(e) => up('user', e.target.value)} autoComplete="off" /></Field>
        <Field label={cfg.passSet ? 'Password (leave blank to keep)' : 'Password'}><input type="password" className={input} value={f.password} onChange={(e) => up('password', e.target.value)} autoComplete="new-password" /></Field>
        <Field label="From address"><input className={input} value={f.from} onChange={(e) => up('from', e.target.value)} placeholder="rubymik@yourdomain" /></Field>
        <Field label="Send alerts to"><input className={input} value={f.to} onChange={(e) => up('to', e.target.value)} placeholder="you@yourdomain" /></Field>
      </div>
      <Actions enabled={f.enabled} onToggle={(v) => up('enabled', v)} busy={c.busy} msg={c.msg} onSave={() => c.save({ smtp: f })} onTest={() => c.test('smtp')} canTest={cfg.enabled} />
    </Card>
  );
}

function TelegramCard({ cfg, onSaved }: { cfg: NotificationSettings['telegram']; onSaved: () => void }) {
  const [f, setF] = useState({ enabled: cfg.enabled, chatId: cfg.chatId, token: '' });
  const c = useChannel(onSaved); const up = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Card icon={MessageCircle} title="Telegram" subtitle="Message @BotFather to create a bot and get its token; add the bot to a chat and use that chat's ID here.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={cfg.tokenSet ? 'Bot token (leave blank to keep)' : 'Bot token'}><input type="password" className={input} value={f.token} onChange={(e) => up('token', e.target.value)} placeholder="123456:ABC-DEF…" autoComplete="off" /></Field>
        <Field label="Chat ID"><input className={input} value={f.chatId} onChange={(e) => up('chatId', e.target.value)} placeholder="-1001234567890" /></Field>
      </div>
      <Actions enabled={f.enabled} onToggle={(v) => up('enabled', v)} busy={c.busy} msg={c.msg} onSave={() => c.save({ telegram: f })} onTest={() => c.test('telegram')} canTest={cfg.enabled} />
    </Card>
  );
}

function WhatsappCard({ cfg, onSaved }: { cfg: NotificationSettings['whatsapp']; onSaved: () => void }) {
  const [f, setF] = useState({ enabled: cfg.enabled, provider: cfg.provider || 'waba', to: cfg.to, wabaBaseUrl: cfg.wabaBaseUrl, wabaPhoneId: cfg.wabaPhoneId, wabaToken: '' });
  const c = useChannel(onSaved); const up = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Card icon={MessageCircle} title="WhatsApp" subtitle="Choose one provider. Until it's paired/provisioned, sends are recorded as a mock in the log (untested-live).">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Provider"><Select value={f.provider} onChange={(v) => up('provider', v)} className="w-full" ariaLabel="Provider" options={[{ value: 'waba', label: 'WhatsApp Business (official)' }, { value: 'baileys', label: 'Baileys (unofficial)' }]} /></Field>
        <Field label="Recipient number"><input className={input} value={f.to} onChange={(e) => up('to', e.target.value)} placeholder="+27821234567" /></Field>
        {f.provider === 'waba' ? (
          <>
            <Field label="API base URL"><input className={input} value={f.wabaBaseUrl} onChange={(e) => up('wabaBaseUrl', e.target.value)} placeholder="https://graph.facebook.com/v20.0" /></Field>
            <Field label="Phone number ID"><input className={input} value={f.wabaPhoneId} onChange={(e) => up('wabaPhoneId', e.target.value)} /></Field>
            <Field label={cfg.configSet ? 'Access token (leave blank to keep)' : 'Access token'}><input type="password" className={input} value={f.wabaToken} onChange={(e) => up('wabaToken', e.target.value)} autoComplete="off" /></Field>
          </>
        ) : (
          <div className="sm:col-span-2 rounded-lg border border-warning-line bg-warning-bg px-3 py-2 text-xs text-warning-fg">
            <b>Unofficial WhatsApp client — account-ban risk.</b> Use a dedicated number. Pairing is by QR scan (pending); until paired, alerts are mocked. Not tested live.
          </div>
        )}
      </div>
      <Actions enabled={f.enabled} onToggle={(v) => up('enabled', v)} busy={c.busy} msg={c.msg} onSave={() => c.save({ whatsapp: f })} onTest={() => c.test('whatsapp')} canTest={cfg.enabled} />
    </Card>
  );
}

function WebhookCard({ cfg, onSaved }: { cfg: NotificationSettings['webhook']; onSaved: () => void }) {
  const [f, setF] = useState({ enabled: cfg.enabled, url: cfg.url });
  const c = useChannel(onSaved); const up = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Card icon={Webhook} title="Webhook" subtitle="POST JSON on fire/resolve — feeds ntfy, Gotify, Discord, Slack, Home Assistant, n8n…">
      <Field label="Webhook URL"><input className={input} value={f.url} onChange={(e) => up('url', e.target.value)} placeholder="https://ntfy.example.com/rubymik" /></Field>
      <Actions enabled={f.enabled} onToggle={(v) => up('enabled', v)} busy={c.busy} msg={c.msg} onSave={() => c.save({ webhook: f })} onTest={() => c.test('webhook')} canTest={cfg.enabled} />
    </Card>
  );
}

function DesktopCard() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem('rubymik_desktop') === '1');
  const [sound, setSound] = useState(() => localStorage.getItem('rubymik_desktop_sound') !== '0');
  const supported = typeof Notification !== 'undefined';
  const [perm, setPerm] = useState<NotificationPermission>(supported ? Notification.permission : 'denied');
  const toggle = async (v: boolean) => {
    if (v && supported && perm !== 'granted') { const p = await Notification.requestPermission(); setPerm(p); if (p !== 'granted') return; }
    setEnabled(v); localStorage.setItem('rubymik_desktop', v ? '1' : '0');
  };
  const toggleSound = (v: boolean) => { setSound(v); localStorage.setItem('rubymik_desktop_sound', v ? '1' : '0'); };
  const test = () => { if (supported && perm === 'granted') { new Notification('RubyMIK', { body: 'Desktop notifications are working.' }); if (sound) beep(); } };
  return (
    <Card icon={MonitorSmartphone} title="Desktop notifications" subtitle="A pop + sound in this browser when a new alert fires (only while RubyMIK is open).">
      {!supported ? <div className="rounded-lg bg-app px-3 py-2 text-xs text-fg-muted">This browser doesn't support notifications.</div> : (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm font-medium text-fg-body"><input type="checkbox" checked={enabled} onChange={(e) => void toggle(e.target.checked)} className="h-4 w-4 accent-accent" /> Enable pops</label>
            <label className="flex items-center gap-2 text-sm font-medium text-fg-body"><input type="checkbox" checked={sound} onChange={(e) => toggleSound(e.target.checked)} className="h-4 w-4 accent-accent" /> Play a sound</label>
            <button onClick={test} disabled={perm !== 'granted'} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:border-accent-border hover:text-accent-text disabled:opacity-50"><Send className="h-3.5 w-3.5" /> Test</button>
            {perm === 'denied' && <span className="text-xs text-danger-fg">Blocked in browser settings.</span>}
          </div>
        </>
      )}
    </Card>
  );
}

/** A short two-tone beep via WebAudio — no external sound file (CSP-safe). */
export function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.12;
    o.start(); o.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
    o.stop(ctx.currentTime + 0.24);
    o.onended = () => ctx.close();
  } catch { /* audio not available */ }
}
