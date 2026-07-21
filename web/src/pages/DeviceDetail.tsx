import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Activity, Archive, ArrowLeft, ChevronDown, Clock, Cpu, FileText, Gauge, Globe, Loader2,
  MemoryStick, Network, RefreshCw, Route as RouteIcon, Router as RouterIcon,
  ScrollText, Shield, Thermometer, Wifi,
} from 'lucide-react';
import { api } from '../api';
import {
  fmtAgo, fmtBytes, fmtRate,
  type DeviceDetailPayload, type DetailInterface, type DetailLive,
  type DetailSection, type TrafficPoint,
} from '../types';
import StatusBadge from '../components/StatusBadge';
import TrafficChart from '../components/TrafficChart';
import DhcpManager from '../components/DhcpManager';
import FirewallManager from '../components/FirewallManager';
import BackupManager from '../components/BackupManager';
import DnsNtpManager from '../components/DnsNtpManager';

const LIVE_REFRESH_MS = 7_000;
const TABLES_REFRESH_MS = 60_000;
const CHART_REFRESH_MS = 30_000;

export default function DeviceDetail() {
  const { id } = useParams();
  const deviceId = Number(id);
  const [detail, setDetail] = useState<DeviceDetailPayload | null>(null);
  const [live, setLive] = useState<DetailLive | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openIface, setOpenIface] = useState<string | null>(null);

  const loadFull = useCallback(async () => {
    try {
      const d = await api.get<DeviceDetailPayload>(`/api/devices/${deviceId}/detail`);
      setDetail(d);
      setLive(d.live);
      setLiveError(d.liveError);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [deviceId]);

  const loadLive = useCallback(async () => {
    try {
      const d = await api.get<{ live: DetailLive | null; liveError: string | null }>(
        `/api/devices/${deviceId}/detail?live=1`,
      );
      if (d.live) setLive(d.live);
      setLiveError(d.liveError);
    } catch {
      /* keep last known; full refresh handles hard errors */
    }
  }, [deviceId]);

  useEffect(() => {
    void loadFull();
    // Richer polling runs ONLY while this page is mounted; both timers are
    // cleared on unmount, dropping straight back to fleet cadence.
    const liveTimer = setInterval(() => {
      if (!document.hidden) void loadLive();
    }, LIVE_REFRESH_MS);
    const tablesTimer = setInterval(() => {
      if (!document.hidden) void loadFull();
    }, TABLES_REFRESH_MS);
    return () => {
      clearInterval(liveTimer);
      clearInterval(tablesTimer);
    };
  }, [loadFull, loadLive]);

  async function refreshNow() {
    setRefreshing(true);
    api.post(`/api/devices/${deviceId}/poll`).catch(() => {});
    await loadFull();
    setRefreshing(false);
  }

  if (error) {
    return (
      <Shell name={detail?.device.name}>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-800">{error}</div>
      </Shell>
    );
  }
  if (!detail) {
    return (
      <Shell>
        <div className="h-40 animate-pulse rounded-2xl border border-zinc-200 bg-white" />
      </Shell>
    );
  }

  const dev = detail.device;
  const rb = detail.routerboard.ok ? detail.routerboard.data : null;
  const status = liveError ? 'down' : (dev.status === 'down' ? 'down' : dev.status === null ? 'pending' : 'up');
  const temp = live?.health.find((h) => h.name?.includes('temperature'));

  return (
    <Shell name={dev.name}>
      {/* ===== Overview header ===== */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ruby-50">
              <RouterIcon className="h-6 w-6 text-ruby-600" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-bold tracking-tight text-zinc-900">{dev.name}</h1>
                <StatusBadge status={status as never} />
              </div>
              <div className="mt-0.5 text-sm text-zinc-500">
                {dev.scheme}://{dev.host}:{dev.port}
                {dev.identity ? ` · ${dev.identity}` : ''}
                {dev.siteName && (
                  <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">
                    {dev.siteName}
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={() => void refreshNow()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 transition hover:border-ruby-400 hover:text-ruby-700 disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Poll now
          </button>
        </div>

        {liveError && (
          <div className="mt-4 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800">
            Cannot reach the device right now: {liveError}
            {dev.lastSeenAt && <span className="text-red-400"> · last seen {fmtAgo(dev.lastSeenAt)}</span>}
            <span className="text-red-400"> — showing last-known information.</span>
          </div>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-zinc-100 pt-4 sm:grid-cols-4 lg:grid-cols-6">
          <Meta label="Model" value={rb?.model ?? dev.model ?? dev.boardName ?? '—'} />
          <Meta label="RouterOS" value={dev.version ?? '—'} />
          <Meta label="Serial" value={rb?.serial ?? '—'} />
          <Meta label="Firmware" value={rb?.firmware ?? '—'} />
          <Meta label="Uptime" value={live?.uptime ?? '—'} icon={Clock} />
          {temp?.value && <Meta label="Temp" value={`${temp.value}°${temp.type ?? 'C'}`} icon={Thermometer} />}
          <MetricMeter label="CPU" icon={Cpu}
            pct={live?.cpuLoad ?? null}
            detail={live?.cpuCount ? `${live.cpuCount} cores` : undefined} warnAt={85} />
          <MetricMeter label="Memory" icon={MemoryStick}
            pct={live?.memUsedPct ?? null}
            detail={live ? `${fmtBytes(live.memTotal - live.memFree)} / ${fmtBytes(live.memTotal)}` : undefined}
            warnAt={90} />
        </dl>
        {live && (
          <div className="mt-3 text-[11px] text-zinc-400">
            Live · updated {fmtAgo(live.fetchedAt)} · refreshes every {LIVE_REFRESH_MS / 1000}s while this page is open
          </div>
        )}
      </div>

      {/* ===== Interfaces ===== */}
      <Section title="Interfaces" icon={Network}
        subtitle={live ? `${live.interfaces.filter((i) => i.running).length} of ${live.interfaces.length} running · rates derived from counters (read-only)` : undefined}>
        {!live ? (
          <Unavailable text="Interface data unavailable while the device is unreachable." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                  <th className="pb-2 pl-2">Interface</th>
                  <th className="pb-2">Type</th>
                  <th className="pb-2">MAC</th>
                  <th className="pb-2">MTU</th>
                  <th className="pb-2 text-right">RX rate</th>
                  <th className="pb-2 text-right">TX rate</th>
                  <th className="pb-2 text-right">RX total</th>
                  <th className="pb-2 pr-2 text-right">TX total</th>
                </tr>
              </thead>
              <tbody>
                {[...live.interfaces]
                  .sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name))
                  .map((i) => (
                    <InterfaceRow key={i.name} iface={i} deviceId={deviceId}
                      open={openIface === i.name}
                      onToggle={() => setOpenIface(openIface === i.name ? null : i.name)} />
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ===== DHCP (manageable — reservations via safe-apply pipeline) ===== */}
      {detail.sections.dhcp.ok && detail.sections.dhcp.data.servers.length > 0 ? (
        <Section title="DHCP reservations" icon={Activity}
          subtitle="static leases + active dynamic leases · writes go through snapshot → verify → auto-rollback → audit">
          <DhcpManager deviceId={deviceId} />
        </Section>
      ) : (
        <SectionFor title="DHCP reservations" icon={Activity} section={detail.sections.dhcp}
          naText="No DHCP server on this device."
          render={() => <Unavailable text="No DHCP server configured on this device." />}
        />
      )}

      {/* ===== Firewall (managed — safe-apply with mgmt-lockout protection) ===== */}
      <Section title="Firewall" icon={Shield}
        subtitle="preset-driven, mgmt-accept always first · writes go through snapshot → verify → auto-rollback → audit">
        <FirewallManager deviceId={deviceId} />
      </Section>

      {/* ===== Config backups (read-safe) + restore (safe-apply, manageable) ===== */}
      <Section title="Config backups" icon={Archive}
        subtitle="full text export, diffable · backups are read-safe · restore runs through the audited dead-man pipeline">
        <BackupManager deviceId={deviceId} />
      </Section>

      {/* ===== DNS & NTP (read-safe) + set (safe-apply, manageable) ===== */}
      <Section title="DNS & NTP" icon={Globe}
        subtitle="resolver, static hosts & time sync · reads are safe · changes run through snapshot → verify → auto-rollback → audit">
        <DnsNtpManager deviceId={deviceId} />
      </Section>

      {/* ===== Wireless ===== */}
      <SectionFor title="Wireless" icon={Wifi} section={detail.sections.wireless}
        naText="Not applicable — this device has no wireless interface."
        render={(w) => (
          <>
            <div className="mb-3 text-xs text-zinc-500">
              Stack: {w.stack} · {w.clients.length} client{w.clients.length === 1 ? '' : 's'} connected
            </div>
            {w.clients.length === 0 ? (
              <Unavailable text="No wireless clients connected right now." />
            ) : (
              <SimpleTable
                headers={['MAC', 'Interface', 'SSID', 'Signal', 'TX rate', 'RX rate', 'Uptime']}
                rows={w.clients.map((c) => [
                  c.mac ?? '—', c.interface ?? '—', c.ssid ?? '—', c.signal ?? '—',
                  c.txRate ?? '—', c.rxRate ?? '—', c.uptime ?? '—',
                ])}
              />
            )}
          </>
        )}
      />

      {/* ===== Switch ===== */}
      <SectionFor title="Switch ports" icon={Gauge} section={detail.sections.switch}
        naText="Not applicable — no switch chip on this device."
        render={(sw) => (
          <>
            <div className="mb-3 text-xs text-zinc-500">
              {sw.chips.map((c) => `${c.name ?? 'switch'}${c.type ? ` (${c.type})` : ''}`).join(' · ')}
              {' '}· link speed needs the RouterOS monitor command (write-path) — not shown by design
            </div>
            {sw.ports.length === 0 ? (
              <Unavailable text="The switch chip exposes no per-port entries over REST." />
            ) : (
              <SimpleTable headers={['Port', 'Switch']} rows={sw.ports.map((p) => [p.name ?? '—', p.switch ?? '—'])} />
            )}
          </>
        )}
      />

      {/* ===== ARP ===== */}
      <SectionFor title="ARP table" icon={Network} section={detail.sections.arp}
        naText="ARP table not available."
        render={(arp) => (
          <SimpleTable
            headers={['IP address', 'MAC', 'Interface', 'Kind', 'State']}
            rows={arp.map((a) => [
              a.address ?? '—', a.mac ?? '—', a.interface ?? '—',
              a.dynamic ? 'dynamic' : 'static', a.complete ? 'complete' : 'incomplete',
            ])}
          />
        )}
      />

      {/* ===== Routes ===== */}
      <SectionFor title="Routes" icon={RouteIcon} section={detail.sections.routes}
        naText="Routing table not available."
        render={(r) => (
          <>
            {r.total > r.entries.length && (
              <div className="mb-3 text-xs text-zinc-500">
                Showing first {r.entries.length} of {r.total} routes.
              </div>
            )}
            <SimpleTable
              headers={['Destination', 'Gateway', 'Distance', 'Flags']}
              rows={r.entries.map((e) => [
                e.dst ?? '—', e.gateway ?? '—', e.distance === null ? '—' : String(e.distance),
                [e.active ? 'active' : 'inactive', e.static ? 'static' : e.dynamic ? 'dynamic' : null]
                  .filter(Boolean).join(' · '),
              ])}
            />
          </>
        )}
      />

      {/* ===== System / update + logs ===== */}
      <SectionFor title="System" icon={FileText} section={detail.sections.update}
        naText="Package update info not available."
        render={(u) => (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <Meta label="Installed" value={u.installed ?? '—'} />
            <Meta label="Channel" value={u.channel ?? '—'} />
            {u.updateAvailable === true && (
              <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">
                Update available: {u.latest}
              </span>
            )}
            {u.updateAvailable === false && (
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                Up to date ({u.latest})
              </span>
            )}
            {u.updateAvailable === null && (
              <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-500"
                title="RouterOS only knows the latest version after check-for-updates runs on the router; RubyMIK won't trigger it (write path) or guess.">
                Update status unknown — check not run on the router
              </span>
            )}
          </div>
        )}
      />

      <SectionFor title="Recent log" icon={ScrollText} section={detail.sections.logs}
        naText="Log not accessible via REST on this device."
        render={(logs) => (
          <div className="max-h-80 overflow-y-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs leading-5 text-zinc-700">
            {logs.length === 0 && <div className="text-zinc-400">Log buffer is empty.</div>}
            {logs.map((l, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 text-zinc-400">{l.time ?? ''}</span>
                <span className={`shrink-0 ${l.topics?.includes('error') || l.topics?.includes('critical') ? 'text-red-700' : 'text-zinc-400'}`}>
                  {l.topics ?? ''}
                </span>
                <span className="break-all">{l.message ?? ''}</span>
              </div>
            ))}
          </div>
        )}
      />
    </Shell>
  );
}

/* ================= building blocks ================= */

function Shell({ name, children }: { name?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 transition hover:text-ruby-700">
        <ArrowLeft className="h-4 w-4" /> Fleet
      </Link>
      <div className="mt-3 space-y-5">{children}</div>
      {name && <div className="h-8" />}
    </div>
  );
}

function Meta({ label, value, icon: Icon }: { label: string; value: string; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        {Icon && <Icon className="h-3 w-3" />} {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-zinc-800" title={value}>{value}</dd>
    </div>
  );
}

function MetricMeter({ label, icon: Icon, pct, detail, warnAt }: {
  label: string; icon: React.ComponentType<{ className?: string }>;
  pct: number | null; detail?: string; warnAt: number;
}) {
  return (
    <div>
      <dt className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        <span className="flex items-center gap-1"><Icon className="h-3 w-3" /> {label}</span>
        <span className="font-semibold normal-case text-zinc-700">{pct === null ? '—' : `${pct}%`}</span>
      </dt>
      <dd className="mt-1.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
          <div
            className={`h-full rounded-full ${pct !== null && pct >= warnAt ? 'bg-amber-500' : 'bg-zinc-400'}`}
            style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
          />
        </div>
        {detail && <div className="mt-0.5 text-[10px] text-zinc-400">{detail}</div>}
      </dd>
    </div>
  );
}

function Section({ title, icon: Icon, subtitle, children }: {
  title: string; icon: React.ComponentType<{ className?: string }>;
  subtitle?: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-baseline gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-zinc-700">
          <Icon className="h-4 w-4 text-zinc-400" /> {title}
        </h2>
        {subtitle && <span className="text-xs text-zinc-400">{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

/** Renders a capability section: real data, honest NA, or the fetch error. */
function SectionFor<T>({ title, icon, naText, section, render }: {
  title: string; icon: React.ComponentType<{ className?: string }>;
  naText: string; section: DetailSection<T>; render: (data: T) => React.ReactNode;
}) {
  return (
    <Section title={title} icon={icon}>
      {section.ok ? render(section.data)
        : section.na ? <Unavailable text={naText} muted />
        : <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800">Could not load: {section.error}</div>}
    </Section>
  );
}

function Unavailable({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <div className={`rounded-lg px-3 py-2.5 text-sm ${muted ? 'bg-zinc-50 text-zinc-500' : 'bg-zinc-50 text-zinc-600'}`}>
      {text}
    </div>
  );
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (rows.length === 0) {
    return <Unavailable text="No entries." />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            {headers.map((h) => <th key={h} className="pb-2 pr-4 first:pl-2">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-zinc-100 text-zinc-700">
              {r.map((c, j) => (
                <td key={j} className={`py-1.5 pr-4 first:pl-2 ${j === 0 ? 'font-medium text-zinc-800' : ''}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InterfaceRow({ iface: i, deviceId, open, onToggle }: {
  iface: DetailInterface; deviceId: number; open: boolean; onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-t border-zinc-100 transition hover:bg-zinc-50 ${open ? 'bg-zinc-50' : ''}`}
      >
        <td className="py-2 pl-2 font-medium text-zinc-800">
          <span className="flex items-center gap-2">
            <span
              title={i.disabled ? 'Disabled' : i.running ? 'Running' : 'Not running'}
              className={`h-2 w-2 rounded-full ${i.disabled ? 'bg-zinc-300' : i.running ? 'bg-emerald-500' : 'bg-red-600'}`}
            />
            {i.name}
            {i.comment && <span className="text-xs font-normal text-zinc-400">({i.comment})</span>}
            <ChevronDown className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`} />
          </span>
        </td>
        <td className="py-2 text-zinc-500">{i.type ?? '—'}</td>
        <td className="py-2 font-mono text-xs text-zinc-500">{i.mac ?? '—'}</td>
        <td className="py-2 text-zinc-500">{i.mtu ?? '—'}</td>
        <td className="py-2 text-right tabular-nums text-zinc-700">{fmtRate(i.rxRate)}</td>
        <td className="py-2 text-right tabular-nums text-zinc-700">{fmtRate(i.txRate)}</td>
        <td className="py-2 text-right tabular-nums text-zinc-500">{fmtBytes(i.rxByte)}</td>
        <td className="py-2 pr-2 text-right tabular-nums text-zinc-500">{fmtBytes(i.txByte)}</td>
      </tr>
      {open && (
        <tr className="border-t border-zinc-100 bg-zinc-50/60">
          <td colSpan={8} className="px-3 py-4">
            <IfaceChart deviceId={deviceId} iface={i.name} />
          </td>
        </tr>
      )}
    </>
  );
}

function IfaceChart({ deviceId, iface }: { deviceId: number; iface: string }) {
  const [points, setPoints] = useState<TrafficPoint[] | null>(null);
  const [windowSec, setWindowSec] = useState(3600);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.get<{ points: TrafficPoint[] }>(
        `/api/devices/${deviceId}/traffic?iface=${encodeURIComponent(iface)}&window=${windowSec}`,
      ).then((r) => {
        if (!cancelled) setPoints(r.points);
      }).catch(() => {});
    };
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, CHART_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [deviceId, iface, windowSec]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {iface} — traffic ({windowSec / 3600}h, {`30s`} samples)
        </span>
        <div className="flex gap-1">
          {[3600, 6 * 3600].map((w) => (
            <button
              key={w}
              onClick={() => setWindowSec(w)}
              className={`rounded-md px-2 py-1 text-xs font-semibold transition ${
                windowSec === w ? 'bg-ruby-600 text-white' : 'text-zinc-500 hover:bg-zinc-100'
              }`}
            >
              {w / 3600}h
            </button>
          ))}
        </div>
      </div>
      {points === null
        ? <div className="h-40 animate-pulse rounded-lg bg-zinc-100" />
        : <TrafficChart points={points} />}
    </div>
  );
}
