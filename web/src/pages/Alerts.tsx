import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BellRing, CircleCheck, History, ScrollText, Settings2, ShieldAlert, TriangleAlert,
} from 'lucide-react';
import { api } from '../api';
import Select from '../components/Select';
import {
  fmtAgo, fmtDuration,
  type Alert, type AlertRule, type AlertSeverity, type NotificationLogEntry, type Site,
} from '../types';

const REFRESH_MS = 10_000;

const SEV: Record<AlertSeverity, { label: string; chip: string; Icon: typeof ShieldAlert }> = {
  critical: { label: 'Critical', chip: 'bg-danger-bg text-danger-fg', Icon: ShieldAlert },
  warning: { label: 'Warning', chip: 'bg-warning-bg text-warning-fg', Icon: TriangleAlert },
  info: { label: 'Info', chip: 'bg-info-bg text-info-fg', Icon: BellRing },
};

type Tab = 'active' | 'history' | 'log' | 'settings';

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
          <h1 className="text-2xl font-bold tracking-tight text-fg-strong">Alerts</h1>
          <p className="mt-1 text-sm text-fg-dim">
            Evaluated on every poll cycle with debounce + hysteresis — no flapping, no spam.
          </p>
        </div>
        <Select
          value={String(siteFilter)}
          onChange={(v) => setSiteFilter(v === 'all' ? 'all' : Number(v))}
          ariaLabel="Filter by site"
          className="w-44"
          options={[{ value: 'all', label: 'All sites' }, ...sites.map((s) => ({ value: String(s.id), label: s.name }))]}
        />
      </div>

      <div className="mt-5 flex gap-1 border-b border-border">
        {([
          ['active', 'Active', BellRing, active?.length ?? 0],
          ['history', 'History', History, null],
          ['log', 'Notification log', ScrollText, null],
          ['settings', 'Settings', Settings2, null],
        ] as Array<[Tab, string, typeof BellRing, number | null]>).map(([key, label, Icon, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 rounded-t-lg px-4 py-2.5 text-sm font-semibold transition ${
              tab === key
                ? 'border-b-2 border-accent text-accent-text'
                : 'text-fg-dim hover:text-fg'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
            {count !== null && count > 0 && (
              <span className="rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-bold text-inverse">{count}</span>
            )}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === 'active' && <ActiveTab alerts={active} />}
        {tab === 'history' && <HistoryTab alerts={history} />}
        {tab === 'log' && <LogTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}

function ActiveTab({ alerts }: { alerts: Alert[] | null }) {
  if (!alerts) return <div className="h-32 animate-pulse rounded-2xl border border-border bg-surface" />;
  if (alerts.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-12 shadow-sm">
        <div className="mx-auto flex max-w-md flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-success-bg">
            <CircleCheck className="h-7 w-7 text-success" />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-fg-strong">All healthy</h2>
          <p className="mt-1.5 text-sm text-fg-dim">
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
          <div key={a.id} className={`rounded-2xl border bg-surface p-4 shadow-sm ${
            a.severity === 'critical' ? 'border-danger-line' : a.severity === 'warning' ? 'border-warning-line' : 'border-border'
          }`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${sev.chip}`}>
                <sev.Icon className="h-3.5 w-3.5" /> {sev.label}
              </span>
              <span className="font-semibold text-fg-strong">{a.ruleLabel}{a.target ? ` — ${a.target}` : ''}</span>
              <Link to={`/devices/${a.deviceId}`} className="text-sm font-medium text-accent-text hover:underline">
                {a.deviceName}
              </Link>
              {a.siteName && (
                <span className="rounded-full bg-app px-2 py-0.5 text-[11px] font-semibold text-fg-muted">{a.siteName}</span>
              )}
              <span className="ml-auto text-xs text-fg-faint">
                firing {fmtAgo(a.firedAt).replace(' ago', '')} · {a.cycles} cycle{a.cycles === 1 ? '' : 's'} · last seen {fmtAgo(a.lastSeenAt)}
              </span>
            </div>
            <div className="mt-2 text-sm text-fg-muted">{a.message}</div>
          </div>
        );
      })}
    </div>
  );
}

function HistoryTab({ alerts }: { alerts: Alert[] | null }) {
  if (!alerts) return <div className="h-32 animate-pulse rounded-2xl border border-border bg-surface" />;
  if (alerts.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border-strong bg-surface/60 p-10 text-center text-sm text-fg-dim">
        No resolved alerts yet — history shows what fired, when, and how long it lasted (kept 30 days).
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-subtle text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
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
              <tr key={a.id} className="border-b border-border-subtle text-fg-body">
                <td className="px-4 py-2">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${sev.chip}`}>
                    <sev.Icon className="h-3 w-3" /> {sev.label}
                  </span>
                </td>
                <td className="px-4 py-2 font-medium text-fg" title={a.message}>
                  {a.ruleLabel}{a.target ? ` — ${a.target}` : ''}
                </td>
                <td className="px-4 py-2">
                  <Link to={`/devices/${a.deviceId}`} className="text-accent-text hover:underline">{a.deviceName}</Link>
                </td>
                <td className="px-4 py-2 text-fg-dim">{a.siteName ?? '—'}</td>
                <td className="px-4 py-2 text-fg-dim">{fmtAgo(a.firedAt)}</td>
                <td className="px-4 py-2 text-fg-dim">{a.resolvedAt ? fmtAgo(a.resolvedAt) : '—'}</td>
                <td className="px-4 py-2 tabular-nums text-fg-dim">{duration !== null ? fmtDuration(duration) : '—'}</td>
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
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRules(await api.get<AlertRule[]>('/api/alerts/rules')); } catch { /* shown as loading */ }
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

  const numCls = 'w-20 rounded-lg border border-border-strong px-2 py-1.5 text-sm text-fg-strong outline-none transition focus:border-accent-border-strong';

  if (!rules) return <div className="h-40 animate-pulse rounded-2xl border border-border bg-surface" />;

  return (
    <div className="space-y-6">
      {flash && (
        <div className="rounded-lg border border-success-line bg-success-bg px-3 py-2 text-sm font-medium text-success-fg">
          {flash}
        </div>
      )}

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="text-sm font-bold uppercase tracking-wide text-fg-body">Rules</h2>
        <p className="mt-1 text-xs text-fg-dim">
          Global defaults — fire after N consecutive breach cycles, resolve after N consecutive clear
          cycles; the gap between threshold and clear-threshold is the anti-flap band. Per-site and
          per-device overrides are on the roadmap.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
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
                <tr key={r.id} className="border-t border-border-subtle">
                  <td className="py-2.5 font-medium text-fg">{r.label}</td>
                  <td className="py-2.5">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${SEV[r.severity].chip}`}>
                      {SEV[r.severity].label}
                    </span>
                  </td>
                  <td className="py-2.5">
                    {r.threshold === null ? <span className="text-fg-faint">—</span> : (
                      <RuleNumber value={r.threshold} unit={r.unit} cls={numCls}
                        onCommit={(v) => void patchRule(r, { threshold: v })} />
                    )}
                  </td>
                  <td className="py-2.5">
                    {r.threshold === null ? <span className="text-fg-faint">—</span> : (
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
                      className={`relative h-6 w-11 rounded-full transition ${r.enabled ? 'bg-accent' : 'bg-border-strong'}`}
                      title={r.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                    >
                      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-all ${r.enabled ? 'left-[22px]' : 'left-0.5'}`} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function LogTab() {
  const [rows, setRows] = useState<NotificationLogEntry[] | null>(null);
  useEffect(() => {
    const load = () => api.get<NotificationLogEntry[]>('/api/alerts/notifications/log').then(setRows).catch(() => {});
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  if (!rows) return <div className="h-32 animate-pulse rounded-2xl border border-border bg-surface" />;
  const chip = (s: string) => s === 'sent' ? 'bg-success-bg text-success-fg' : s === 'failed' ? 'bg-danger-bg text-danger-fg' : s === 'mocked' ? 'bg-info-bg text-info-fg' : 'bg-app text-fg-muted';
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface">
      <p className="border-b border-border-subtle px-5 py-3 text-xs text-fg-dim">Every delivery attempt across all channels — a failure here never blocks polling or writes.</p>
      {rows.length === 0 ? <div className="p-8 text-center text-sm text-fg-dim">No notifications sent yet.</div> : (
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border-subtle bg-sunken text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
            <th className="px-4 py-2.5">When</th><th className="px-3 py-2.5">Channel</th><th className="px-3 py-2.5">Event</th><th className="px-3 py-2.5">Target</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5">Detail</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border-subtle text-fg-body">
                <td className="px-4 py-2 whitespace-nowrap text-fg-dim">{fmtAgo(r.ts)}</td>
                <td className="px-3 py-2 font-medium capitalize text-fg">{r.channel}</td>
                <td className="px-3 py-2 text-fg-dim">{r.event}</td>
                <td className="px-3 py-2 text-fg-dim">{r.target ?? '—'}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${chip(r.status)}`}>{r.status}</span></td>
                <td className="px-3 py-2 text-xs text-fg-faint">{r.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
      {unit && <span className="text-xs text-fg-faint">{unit}</span>}
    </span>
  );
}
