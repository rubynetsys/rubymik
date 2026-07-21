import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Archive, Bell, Building2, Clock, Cpu, Loader2, MemoryStick, Plus, RefreshCw,
  Router as RouterIcon, Search, Server,
} from 'lucide-react';
import { api } from '../api';
import Select from '../components/Select';
import {
  fmtAgo, fmtBytes,
  type FleetDevice, type FleetPayload, type FleetSite, type HealthStatus,
} from '../types';
import StatusBadge, { STATUS_META } from '../components/StatusBadge';
import Sparkline from '../components/Sparkline';

const REFRESH_MS = 10_000;

type StatusFilter = 'all' | HealthStatus;
type SiteFilter = 'all' | 'unassigned' | number;

export default function Fleet() {
  const [fleet, setFleet] = useState<FleetPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [siteFilter, setSiteFilter] = useState<SiteFilter>('all');
  const [search, setSearch] = useState('');
  const [polling, setPolling] = useState(false);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      setFleet(await api.get<FleetPayload>('/api/fleet'));
      setFetchedAt(Date.now());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    const secondly = setInterval(() => tick((n) => n + 1), 1000);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(refresh);
      clearInterval(secondly);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  async function pollNow() {
    setPolling(true);
    try {
      await api.post('/api/fleet/poll');
      setTimeout(() => {
        void load().finally(() => setPolling(false));
      }, 2500);
    } catch {
      setPolling(false);
    }
  }

  const matches = (d: FleetDevice): boolean => {
    if (statusFilter !== 'all' && d.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = [d.name, d.host, d.model, d.identity, d.version].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };

  const visibleSites: FleetSite[] = (fleet?.sites ?? [])
    .filter((s) =>
      siteFilter === 'all' ? true
      : siteFilter === 'unassigned' ? s.id === null
      : s.id === siteFilter)
    .map((s) => ({ ...s, devices: s.devices.filter(matches) }))
    .filter((s) => s.devices.length > 0);

  const filtersActive = statusFilter !== 'all' || siteFilter !== 'all' || search !== '';

  if (error) {
    return (
      <PageChrome>
        <div className="rounded-2xl border border-danger-line bg-danger-bg p-6 text-sm text-danger-fg-strong">
          Cannot load the fleet: {error}
        </div>
      </PageChrome>
    );
  }

  if (!fleet) {
    return (
      <PageChrome>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-44 animate-pulse rounded-2xl border border-border bg-surface" />
          ))}
        </div>
      </PageChrome>
    );
  }

  if (fleet.summary.total === 0) {
    return (
      <PageChrome>
        <div className="rounded-2xl border border-border bg-surface p-12 shadow-sm">
          <div className="mx-auto flex max-w-md flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-subtle">
              <RouterIcon className="h-7 w-7 text-accent" />
            </div>
            <h2 className="mt-4 text-lg font-semibold text-fg-strong">No devices yet</h2>
            <p className="mt-1.5 text-sm text-fg-dim">
              Add your first MikroTik device and RubyMIK will start polling its health automatically.
            </p>
            <Link to="/devices" className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover">
              <Plus className="h-4 w-4" /> Add your first device
            </Link>
          </div>
        </div>
      </PageChrome>
    );
  }

  return (
    <PageChrome
      right={
        <div className="flex items-center gap-3">
          <span className="text-xs text-fg-faint">
          {fetchedAt ? `Updated ${fmtAgo(new Date(fetchedAt).toISOString())}` : ''} · auto-refresh {REFRESH_MS / 1000}s · poll {fleet.pollIntervalSec}s
          </span>
          <button
            onClick={() => void pollNow()}
            disabled={polling}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-fg-body transition hover:border-accent-border hover:text-accent-text disabled:opacity-50"
          >
            {polling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Poll now
          </button>
        </div>
      }
    >
      {/* Summary tiles — click to filter by status */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <SummaryTile
          label="Devices" count={fleet.summary.total} Icon={Server} iconCls="bg-sidebar text-sidebar-hover"
          active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}
        />
        {(['up', 'warning', 'down', 'pending'] as const).map((s) => (
          <SummaryTile
            key={s}
            label={STATUS_META[s].label} count={fleet.summary[s]} Icon={STATUS_META[s].Icon}
            iconCls={STATUS_META[s].chip}
            active={statusFilter === s}
            onClick={() => setStatusFilter(statusFilter === s ? 'all' : s)}
          />
        ))}
      </div>

      {/* Filter row */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, host, model…"
            className="w-64 rounded-lg border border-border-strong bg-surface py-2 pl-8 pr-3 text-sm outline-none transition focus:border-accent-border-strong focus:ring-2 focus:ring-accent-border-strong/20"
          />
        </div>
        <Select
          value={String(siteFilter)}
          onChange={(v) => setSiteFilter(v === 'all' ? 'all' : v === 'unassigned' ? 'unassigned' : Number(v))}
          ariaLabel="Filter by site"
          className="w-44"
          options={[
            { value: 'all', label: 'All sites' },
            ...fleet.sites.filter((s) => s.id !== null).map((s) => ({ value: String(s.id), label: s.name })),
            ...(fleet.sites.some((s) => s.id === null) ? [{ value: 'unassigned', label: 'Unassigned' }] : []),
          ]}
        />
        {filtersActive && (
          <button
            onClick={() => { setStatusFilter('all'); setSiteFilter('all'); setSearch(''); }}
            className="text-xs font-semibold text-fg-dim hover:text-accent-text"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Sites */}
      {visibleSites.length === 0 && (
        <div className="mt-6 rounded-2xl border border-dashed border-border-strong bg-surface/60 p-10 text-center text-sm text-fg-dim">
          No devices match the current filters.
        </div>
      )}
      {visibleSites.map((site) => (
        <section key={site.id ?? 'unassigned'} className="mt-7">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-fg-faint" />
              <h2 className="text-sm font-bold uppercase tracking-wide text-fg-body">{site.name}</h2>
            </div>
            {site.location && <span className="text-xs text-fg-faint">{site.location}</span>}
            {site.clientName && (
              <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[11px] font-semibold text-accent-text">
                {site.clientName}
              </span>
            )}
            <span className="ml-auto flex items-center gap-2 text-xs text-fg-dim">
              {site.counts.total} device{site.counts.total === 1 ? '' : 's'}
              {(['up', 'warning', 'down', 'pending'] as const)
                .filter((s) => site.counts[s] > 0)
                .map((s) => {
                  const { Icon, chip, label } = STATUS_META[s];
                  return (
                    <span key={s} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${chip}`} title={label}>
                      <Icon className="h-3 w-3" /> {site.counts[s]} {label.toLowerCase()}
                    </span>
                  );
                })}
            </span>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {site.devices.map((d) => <DeviceCard key={d.id} device={d} />)}
          </div>
        </section>
      ))}
    </PageChrome>
  );
}

function PageChrome({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-fg-strong">Fleet</h1>
          <p className="mt-1 text-sm text-fg-dim">All devices, all sites — health at a glance.</p>
        </div>
        {right}
      </div>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function SummaryTile({ label, count, Icon, iconCls, active, onClick }: {
  label: string;
  count: number;
  Icon: React.ComponentType<{ className?: string }>;
  iconCls: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl border bg-surface p-4 text-left shadow-sm transition hover:border-accent-border ${
        active ? 'border-accent-border ring-2 ring-accent-border-strong/15' : 'border-border'
      }`}
    >
      <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${iconCls}`}>
        <Icon className="h-4.5 w-4.5" />
      </span>
      <span>
        <span className="block text-xl font-bold leading-6 text-fg-strong">{count}</span>
        <span className="block text-xs font-medium text-fg-dim">{label}</span>
      </span>
    </button>
  );
}

function Meter({ pct, warnAt }: { pct: number; warnAt: number }) {
  const clamped = Math.min(Math.max(pct, 0), 100);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-app">
      <div
        className={`h-full rounded-full ${clamped >= warnAt ? 'bg-warning' : 'bg-fg-faint'}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function DeviceCard({ device: d }: { device: FleetDevice }) {
  const navigate = useNavigate();
  const edge =
    d.status === 'down' ? 'border-l-red-600'
    : d.status === 'warning' ? 'border-l-amber-500'
    : d.status === 'pending' ? 'border-l-zinc-300'
    : 'border-l-emerald-500';
  return (
    <div
      onClick={() => void navigate(`/devices/${d.id}`)}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') void navigate(`/devices/${d.id}`); }}
      className={`cursor-pointer rounded-xl border border-border border-l-4 ${edge} bg-surface p-4 shadow-sm transition hover:border-accent-border hover:shadow-md`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold text-fg-strong">{d.name}</div>
          <div className="truncate text-xs text-fg-dim">
            {d.host}{d.port ? `:${d.port}` : ''}{d.identity ? ` · ${d.identity}` : ''}
          </div>
        </div>
        <span className="flex items-center gap-1.5">
          {d.alerts && (
            <span
              title={`${d.alerts.count} active alert${d.alerts.count === 1 ? '' : 's'}`}
              className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-bold text-inverse ${
                d.alerts.severity === 'critical' ? 'bg-danger' : d.alerts.severity === 'warning' ? 'bg-warning' : 'bg-info'
              }`}
            >
              <Bell className="h-3 w-3" /> {d.alerts.count}
            </span>
          )}
          <StatusBadge status={d.status} />
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-medium text-fg-muted">
        {d.model && <span className="rounded-md bg-app px-1.5 py-0.5">{d.model}</span>}
        {d.version && <span className="rounded-md bg-app px-1.5 py-0.5">RouterOS {d.version}</span>}
      </div>

      {d.status === 'down' && (
        <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">
          {d.lastError ?? 'Unreachable'}
          <div className="mt-0.5 text-danger">
            {d.consecutiveFailures} failed poll{d.consecutiveFailures === 1 ? '' : 's'} · last seen {fmtAgo(d.lastSeenAt)}
          </div>
        </div>
      )}
      {d.status === 'warning' && d.reasons.length > 0 && (
        <div className="mt-3 rounded-lg bg-warning-bg px-3 py-2 text-xs font-medium text-warning-fg">
          {d.reasons.join(' · ')}
        </div>
      )}
      {d.status === 'pending' && (
        <div className="mt-3 rounded-lg bg-sunken px-3 py-2 text-xs text-fg-dim">
          Awaiting first poll…
        </div>
      )}

      {(d.status === 'up' || d.status === 'warning') && (
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
          <div>
            <div className="flex items-center justify-between text-[11px] text-fg-dim">
              <span className="flex items-center gap-1 font-semibold uppercase tracking-wide">
                <Cpu className="h-3 w-3" /> CPU
              </span>
              <span className="font-semibold text-fg-body">{d.cpuLoad ?? '—'}%</span>
            </div>
            <div className="mt-1"><Meter pct={d.cpuLoad ?? 0} warnAt={85} /></div>
          </div>
          <div>
            <div className="flex items-center justify-between text-[11px] text-fg-dim">
              <span className="flex items-center gap-1 font-semibold uppercase tracking-wide">
                <MemoryStick className="h-3 w-3" /> Memory
              </span>
              <span className="font-semibold text-fg-body">
                {d.memUsedPct !== null ? `${d.memUsedPct.toFixed(0)}%` : '—'}
              </span>
            </div>
            <div className="mt-1"><Meter pct={d.memUsedPct ?? 0} warnAt={90} /></div>
            {d.memTotal !== null && d.memFree !== null && (
              <div className="mt-0.5 text-right text-[10px] text-fg-faint">
                {fmtBytes(d.memTotal - d.memFree)} / {fmtBytes(d.memTotal)}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-fg-muted">
            <Clock className="h-3.5 w-3.5 text-fg-faint" />
            <span className="truncate" title={d.uptime ?? undefined}>up {d.uptime ?? '—'}</span>
          </div>
          <div className="flex items-center justify-end">
            <Sparkline points={d.history} />
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-border-subtle pt-2 text-[11px] text-fg-faint">
        <span>Polled {fmtAgo(d.lastAttemptAt)}</span>
        <span title={d.lastBackupAt ? `Last config backup ${new Date(d.lastBackupAt).toLocaleString()}` : 'No config backup yet'}
          className={`inline-flex items-center gap-1 ${!d.lastBackupAt || Date.now() - Date.parse(d.lastBackupAt) > 8 * 864e5 ? 'text-warning' : ''}`}>
          <Archive className="h-3 w-3" /> {d.lastBackupAt ? `backed up ${fmtAgo(d.lastBackupAt)}` : 'no backup'}
        </span>
      </div>
    </div>
  );
}
