import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, Bell, CheckCircle2, Clock, Cpu, MonitorPlay,
  Server, ShieldAlert, XCircle,
} from 'lucide-react';
import { api } from '../api';
import type { Alert, AuditEntry, FleetPayload, FleetSite, HealthStatus } from '../types';
import Sparkline from '../components/Sparkline';

const REFRESH_MS = 10_000;
const RANK: Record<HealthStatus, number> = { down: 3, warning: 2, rebooting: 2, pending: 1, up: 0 };

export default function Dashboard() {
  const [fleet, setFleet] = useState<FleetPayload | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  const load = useCallback(() => {
    api.get<FleetPayload>('/api/fleet').then(setFleet).catch(() => {});
    api.get<Alert[]>('/api/alerts?state=firing').then(setAlerts).catch(() => {});
    api.get<AuditEntry[]>('/api/audit').then(setAudit).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!fleet) return <div className="mx-auto max-w-7xl"><div className="h-40 animate-pulse rounded-2xl border border-border bg-surface" /></div>;

  const s = fleet.summary;
  const sites = [...fleet.sites].sort((a, b) => worst(b) - worst(a) || a.name.localeCompare(b.name));
  const events = mergeEvents(alerts, audit);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-fg-strong">Dashboard</h1>
          <p className="mt-0.5 text-sm text-fg-dim">Fleet health at a glance · auto-refreshes every {REFRESH_MS / 1000}s.</p>
        </div>
        <Link to="/wallboard"
          className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body transition hover:border-accent-border hover:text-accent-text">
          <MonitorPlay className="h-4 w-4" /> Open wallboard
        </Link>
      </div>

      {/* health strip (counts already deduped by host:port, P27) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Devices" value={s.total} Icon={Server} tone="neutral" />
        <Kpi label="Up" value={s.up} Icon={CheckCircle2} tone="good" />
        <Kpi label="Warning" value={s.warning} Icon={AlertTriangle} tone="warn" />
        <Kpi label="Down" value={s.down} Icon={XCircle} tone="bad" />
        <Kpi label="Pending" value={s.pending} Icon={Clock} tone="neutral" />
        <Kpi label="Open alerts" value={alerts.length} Icon={Bell} tone={alerts.length ? 'warn' : 'neutral'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* sites, worst-first */}
        <div className="lg:col-span-2">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-dim">Sites</h2>
          <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
            {sites.length === 0 && <Empty text="No devices yet." />}
            {sites.map((site) => <SiteCard key={String(site.id)} site={site} />)}
          </div>
        </div>

        {/* recent activity */}
        <div>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-dim">Recent activity</h2>
          <div className="max-h-[62vh] overflow-y-auto rounded-2xl border border-border bg-surface">
            {events.length === 0 && <Empty text="Nothing recent." />}
            <ul className="divide-y divide-border-subtle">
              {events.map((e) => (
                <li key={e.id} className="flex items-start gap-2.5 px-4 py-2.5">
                  <EventIcon kind={e.kind} sev={e.sev} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-fg-body">{e.text}</div>
                    <div className="mt-0.5 text-[11px] text-fg-faint">{e.device} · {fmtAgo(e.at)}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function worst(site: FleetSite): number {
  if (site.counts.down) return 3;
  if (site.counts.warning) return 2;
  if (site.counts.pending) return 1;
  return 0;
}

function SiteCard({ site }: { site: FleetSite }) {
  const devices = [...site.devices].sort((a, b) => RANK[b.status] - RANK[a.status] || a.name.localeCompare(b.name));
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold text-fg-strong">{site.name}</h3>
        {site.clientName && <span className="rounded-full bg-app px-2 py-0.5 text-[10px] font-semibold text-fg-muted">{site.clientName}</span>}
        <div className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold">
          {site.counts.up > 0 && <Pill tone="good">{site.counts.up} up</Pill>}
          {site.counts.warning > 0 && <Pill tone="warn">{site.counts.warning} warn</Pill>}
          {site.counts.down > 0 && <Pill tone="bad">{site.counts.down} down</Pill>}
          {site.counts.pending > 0 && <Pill tone="neutral">{site.counts.pending} pending</Pill>}
        </div>
      </div>
      <div className="space-y-1.5">
        {devices.map((d) => (
          <Link key={d.id} to={`/devices/${d.id}`}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-sunken">
            <span title={d.status} className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotFor(d.status)}`} />
            <span className="w-40 shrink-0 truncate text-sm font-medium text-fg">{d.name}</span>
            <span className="hidden w-28 shrink-0 truncate text-xs text-fg-faint sm:block">{d.model ?? '—'}</span>
            <span className="w-16 shrink-0 tabular-nums text-xs text-fg-dim">
              <Cpu className="mr-1 inline h-3 w-3 text-fg-faint" />{d.cpuLoad === null ? '—' : `${d.cpuLoad}%`}
            </span>
            <span className="ml-auto"><Sparkline points={d.history} /></span>
            {d.alerts && <ShieldAlert className={`h-4 w-4 ${d.alerts.severity === 'critical' ? 'text-danger-fg' : 'text-warning-fg'}`} />}
          </Link>
        ))}
      </div>
    </section>
  );
}

type Ev = { id: string; at: string; kind: 'alert' | 'audit'; sev?: string; text: string; device: string };
function mergeEvents(alerts: Alert[], audit: AuditEntry[]): Ev[] {
  const a: Ev[] = alerts.map((x) => ({ id: `al${x.id}`, at: x.firedAt, kind: 'alert', sev: x.severity, text: x.message || x.ruleLabel, device: x.deviceName }));
  const u: Ev[] = audit.map((x) => ({ id: `au${x.id}`, at: x.createdAt, kind: 'audit', text: x.summary || x.action, device: x.deviceName }));
  return [...a, ...u].sort((p, q) => q.at.localeCompare(p.at)).slice(0, 16);
}

function EventIcon({ kind, sev }: { kind: 'alert' | 'audit'; sev?: string }) {
  if (kind === 'alert') return <ShieldAlert className={`mt-0.5 h-4 w-4 shrink-0 ${sev === 'critical' ? 'text-danger-fg' : sev === 'warning' ? 'text-warning-fg' : 'text-info-fg'}`} />;
  return <Activity className="mt-0.5 h-4 w-4 shrink-0 text-fg-faint" />;
}

function Kpi({ label, value, Icon, tone }: { label: string; value: number; Icon: React.ComponentType<{ className?: string }>; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const ring = tone === 'good' ? 'text-success-fg' : tone === 'warn' ? 'text-warning-fg' : tone === 'bad' ? 'text-danger-fg' : 'text-fg-dim';
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label}</span>
        <Icon className={`h-4 w-4 ${ring}`} />
      </div>
      <div className={`mt-1 text-3xl font-bold tabular-nums ${tone === 'bad' && value > 0 ? 'text-danger-fg' : 'text-fg-strong'}`}>{value}</div>
    </div>
  );
}

function Pill({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'neutral'; children: React.ReactNode }) {
  const cls = tone === 'good' ? 'bg-success-bg text-success-fg' : tone === 'warn' ? 'bg-warning-bg text-warning-fg' : tone === 'bad' ? 'bg-danger-bg text-danger-fg' : 'bg-app text-fg-muted';
  return <span className={`rounded-full px-2 py-0.5 ${cls}`}>{children}</span>;
}

function dotFor(status: HealthStatus): string {
  return status === 'up' ? 'bg-success-strong' : status === 'warning' ? 'bg-warning'
    : status === 'down' ? 'bg-danger' : status === 'rebooting' ? 'bg-info-fg animate-pulse' : 'bg-border-strong';
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-border-strong bg-surface/60 p-6 text-center text-sm text-fg-dim">{text}</div>;
}

function fmtAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
