import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BellRing, CheckCircle2, CircleCheck, History, Send, Settings2, ShieldAlert, TriangleAlert,
} from 'lucide-react';
import { api } from '../api';
import {
  fmtAgo, fmtDuration,
  type Alert, type AlertRule, type AlertSeverity, type NotificationSettings, type Site,
} from '../types';

const REFRESH_MS = 10_000;

const SEV: Record<AlertSeverity, { label: string; chip: string; Icon: typeof ShieldAlert }> = {
  critical: { label: 'Critical', chip: 'bg-red-50 text-red-700', Icon: ShieldAlert },
  warning: { label: 'Warning', chip: 'bg-amber-50 text-amber-700', Icon: TriangleAlert },
  info: { label: 'Info', chip: 'bg-sky-50 text-sky-700', Icon: BellRing },
};

type Tab = 'active' | 'history' | 'settings';

export default function Alerts() {
  const [tab, setTab] = useState<Tab>('active');
  const [active, setActive] = useState<Alert[] | null>(null);
  const [history, setHistory] = useState<Alert[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteFilter, setSiteFilter] = useState<'all' | number>('all');

  const load = useCallback(async () => {
    const qs = siteFilter === 'all' ? '' : `&siteId=${siteFilter}`;
    try {
      setActive(await api.get<Alert[]>(`/api/alerts?state=firing${qs}`));
      setHistory(await api.get<Alert[]>(`/api/alerts?state=resolved${qs}`));
    } catch {
      /* transient — next refresh retries */
    }
  }, [siteFilter]);

  useEffect(() => {
    void load();
    api.get<Site[]>('/api/sites').then(setSites).catch(() => {});
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Alerts</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Evaluated on every poll cycle with debounce + hysteresis — no flapping, no spam.
          </p>
        </div>
        <select
          value={String(siteFilter)}
          onChange={(e) => setSiteFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-ruby-500"
        >
          <option value="all">All sites</option>
          {sites.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
        </select>
      </div>

      <div className="mt-5 flex gap-1 border-b border-zinc-200">
        {([
          ['active', 'Active', BellRing, active?.length ?? 0],
          ['history', 'History', History, null],
          ['settings', 'Settings', Settings2, null],
        ] as Array<[Tab, string, typeof BellRing, number | null]>).map(([key, label, Icon, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 rounded-t-lg px-4 py-2.5 text-sm font-semibold transition ${
              tab === key
                ? 'border-b-2 border-ruby-600 text-ruby-700'
                : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
            {count !== null && count > 0 && (
              <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{count}</span>
            )}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === 'active' && <ActiveTab alerts={active} />}
        {tab === 'history' && <HistoryTab alerts={history} />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}

function ActiveTab({ alerts }: { alerts: Alert[] | null }) {
  if (!alerts) return <div className="h-32 animate-pulse rounded-2xl border border-zinc-200 bg-white" />;
  if (alerts.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-12 shadow-sm">
        <div className="mx-auto flex max-w-md flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50">
            <CircleCheck className="h-7 w-7 text-emerald-600" />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-zinc-900">All healthy</h2>
          <p className="mt-1.5 text-sm text-zinc-500">
            No active alerts — every monitored condition is within its thresholds.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {alerts.map((a) => {
        const sev = SEV[a.severity];
        return (
          <div key={a.id} className={`rounded-2xl border bg-white p-4 shadow-sm ${
            a.severity === 'critical' ? 'border-red-200' : a.severity === 'warning' ? 'border-amber-200' : 'border-zinc-200'
          }`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${sev.chip}`}>
                <sev.Icon className="h-3.5 w-3.5" /> {sev.label}
              </span>
              <span className="font-semibold text-zinc-900">{a.ruleLabel}{a.target ? ` — ${a.target}` : ''}</span>
              <Link to={`/devices/${a.deviceId}`} className="text-sm font-medium text-ruby-700 hover:underline">
                {a.deviceName}
              </Link>
              {a.siteName && (
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-600">{a.siteName}</span>
              )}
              <span className="ml-auto text-xs text-zinc-400">
                firing {fmtAgo(a.firedAt).replace(' ago', '')} · {a.cycles} cycle{a.cycles === 1 ? '' : 's'} · last seen {fmtAgo(a.lastSeenAt)}
              </span>
            </div>
            <div className="mt-2 text-sm text-zinc-600">{a.message}</div>
          </div>
        );
      })}
    </div>
  );
}

function HistoryTab({ alerts }: { alerts: Alert[] | null }) {
  if (!alerts) return <div className="h-32 animate-pulse rounded-2xl border border-zinc-200 bg-white" />;
  if (alerts.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-10 text-center text-sm text-zinc-500">
        No resolved alerts yet — history shows what fired, when, and how long it lasted (kept 30 days).
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-100 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            <th className="px-4 py-2.5">Severity</th>
            <th className="px-4 py-2.5">Alert</th>
            <th className="px-4 py-2.5">Device</th>
            <th className="px-4 py-2.5">Site</th>
            <th className="px-4 py-2.5">Fired</th>
            <th className="px-4 py-2.5">Resolved</th>
            <th className="px-4 py-2.5">Duration</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => {
            const sev = SEV[a.severity];
            const duration = a.resolvedAt ? (Date.parse(a.resolvedAt) - Date.parse(a.firedAt)) / 1000 : null;
            return (
              <tr key={a.id} className="border-b border-zinc-50 text-zinc-700">
                <td className="px-4 py-2">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${sev.chip}`}>
                    <sev.Icon className="h-3 w-3" /> {sev.label}
                  </span>
                </td>
                <td className="px-4 py-2 font-medium text-zinc-800" title={a.message}>
                  {a.ruleLabel}{a.target ? ` — ${a.target}` : ''}
                </td>
                <td className="px-4 py-2">
                  <Link to={`/devices/${a.deviceId}`} className="text-ruby-700 hover:underline">{a.deviceName}</Link>
                </td>
                <td className="px-4 py-2 text-zinc-500">{a.siteName ?? '—'}</td>
                <td className="px-4 py-2 text-zinc-500">{fmtAgo(a.firedAt)}</td>
                <td className="px-4 py-2 text-zinc-500">{a.resolvedAt ? fmtAgo(a.resolvedAt) : '—'}</td>
                <td className="px-4 py-2 tabular-nums text-zinc-500">{duration !== null ? fmtDuration(duration) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SettingsTab() {
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [notif, setNotif] = useState<NotificationSettings | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRules(await api.get<AlertRule[]>('/api/alerts/rules'));
      const n = await api.get<NotificationSettings>('/api/alerts/notifications');
      setNotif(n);
      setWebhookUrl(n.webhookUrl ?? '');
      setWebhookEnabled(n.webhookEnabled);
    } catch {
      /* shown as loading */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function patchRule(rule: AlertRule, patch: Partial<{ enabled: boolean; threshold: number | null; clearThreshold: number | null; fireCycles: number; resolveCycles: number }>) {
    try {
      await api.patch(`/api/alerts/rules/${rule.id}`, patch);
      setFlash(`"${rule.label}" updated`);
      setTimeout(() => setFlash(null), 2500);
      void load();
    } catch (err) {
      setFlash((err as Error).message);
      setTimeout(() => setFlash(null), 4000);
    }
  }

  async function saveNotifications() {
    setSaving(true);
    setTestResult(null);
    try {
      const saved = await api.put<NotificationSettings>('/api/alerts/notifications', { webhookUrl, webhookEnabled });
      setNotif(saved);
      setWebhookEnabled(saved.webhookEnabled);
      setFlash('Notification settings saved');
      setTimeout(() => setFlash(null), 2500);
    } catch (err) {
      setFlash((err as Error).message);
      setTimeout(() => setFlash(null), 4000);
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTestResult('sending…');
    try {
      await api.post('/api/alerts/notifications/test');
      setTestResult('Delivered — check your endpoint.');
    } catch (err) {
      setTestResult(`Failed: ${(err as Error).message}`);
    }
  }

  const inputCls =
    'w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-ruby-500 focus:ring-2 focus:ring-ruby-500/20';
  const numCls = 'w-20 rounded-lg border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900 outline-none transition focus:border-ruby-500';

  if (!rules) return <div className="h-40 animate-pulse rounded-2xl border border-zinc-200 bg-white" />;

  return (
    <div className="space-y-6">
      {flash && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
          {flash}
        </div>
      )}

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-700">Rules</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Global defaults — fire after N consecutive breach cycles, resolve after N consecutive clear
          cycles; the gap between threshold and clear-threshold is the anti-flap band. Per-site and
          per-device overrides are on the roadmap.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                <th className="pb-2">Rule</th>
                <th className="pb-2">Severity</th>
                <th className="pb-2">Threshold</th>
                <th className="pb-2">Clear at</th>
                <th className="pb-2">Fire after</th>
                <th className="pb-2">Resolve after</th>
                <th className="pb-2 text-right">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100">
                  <td className="py-2.5 font-medium text-zinc-800">{r.label}</td>
                  <td className="py-2.5">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${SEV[r.severity].chip}`}>
                      {SEV[r.severity].label}
                    </span>
                  </td>
                  <td className="py-2.5">
                    {r.threshold === null ? <span className="text-zinc-400">—</span> : (
                      <RuleNumber value={r.threshold} unit={r.unit} cls={numCls}
                        onCommit={(v) => void patchRule(r, { threshold: v })} />
                    )}
                  </td>
                  <td className="py-2.5">
                    {r.threshold === null ? <span className="text-zinc-400">—</span> : (
                      <RuleNumber value={r.clearThreshold} unit={r.unit} cls={numCls}
                        onCommit={(v) => void patchRule(r, { clearThreshold: v })} />
                    )}
                  </td>
                  <td className="py-2.5">
                    <RuleNumber value={r.fireCycles} unit=" cycles" cls={numCls}
                      onCommit={(v) => void patchRule(r, { fireCycles: v ?? undefined })} />
                  </td>
                  <td className="py-2.5">
                    <RuleNumber value={r.resolveCycles} unit=" cycles" cls={numCls}
                      onCommit={(v) => void patchRule(r, { resolveCycles: v ?? undefined })} />
                  </td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => void patchRule(r, { enabled: !r.enabled })}
                      className={`relative h-6 w-11 rounded-full transition ${r.enabled ? 'bg-ruby-600' : 'bg-zinc-300'}`}
                      title={r.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                    >
                      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${r.enabled ? 'left-[22px]' : 'left-0.5'}`} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-700">Notifications</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Off by default. RubyMIK sends alerts ONLY to endpoints you configure here — nothing phones
          home, ever. The webhook posts JSON on fire and resolve; it feeds ntfy, Gotify, Discord,
          Slack, Telegram bridges, Home Assistant, n8n… SMTP email is on the roadmap.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-72 flex-1">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">Webhook URL</span>
            <input className={inputCls} value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://ntfy.example.com/rubymik  ·  http://192.168.1.10:8123/api/webhook/…" />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm font-medium text-zinc-700">
            <input type="checkbox" checked={webhookEnabled} onChange={(e) => setWebhookEnabled(e.target.checked)}
              className="h-4 w-4 accent-ruby-600" />
            Enabled
          </label>
          <button onClick={() => void saveNotifications()} disabled={saving}
            className="rounded-lg bg-ruby-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ruby-500 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => void sendTest()} disabled={!notif?.webhookEnabled}
            title={notif?.webhookEnabled ? 'POST a test payload' : 'Save an enabled webhook first'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-ruby-400 hover:text-ruby-700 disabled:opacity-50">
            <Send className="h-3.5 w-3.5" /> Send test
          </button>
        </div>
        {testResult && (
          <div className={`mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${
            testResult.startsWith('Failed') ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
          }`}>
            {testResult.startsWith('Failed') ? <TriangleAlert className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            {testResult}
          </div>
        )}
      </section>
    </div>
  );
}

/** Number cell that commits on blur/Enter — avoids a PATCH per keystroke. */
function RuleNumber({ value, unit, cls, onCommit }: {
  value: number | null;
  unit: string | null;
  cls: string;
  onCommit: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  const commit = () => {
    const v = draft === '' ? null : Number(draft);
    if (v !== value && (v === null || Number.isFinite(v))) onCommit(v);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input
        className={cls}
        value={draft}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      {unit && <span className="text-xs text-zinc-400">{unit}</span>}
    </span>
  );
}
