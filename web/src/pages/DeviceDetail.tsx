import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Activity, AppWindow, Archive, ArrowLeft, ArrowLeftRight, Camera, ChevronDown, Clock, Cpu, FileText, Gauge, Globe, KeyRound, LayoutGrid, Loader2,
  MemoryStick, Network, RefreshCw, Route as RouteIcon, Router as RouterIcon,
  ScrollText, Shield, Thermometer, Waypoints, Wifi,
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
import SnapshotManager from '../components/SnapshotManager';
import NatManager from '../components/NatManager';
import QosManager from '../components/QosManager';
import DnsNtpManager from '../components/DnsNtpManager';
import WirelessManager from '../components/WirelessManager';
import RoutesManager from '../components/RoutesManager';
import WireguardManager from '../components/WireguardManager';
import AddressManager from '../components/AddressManager';
import L2Manager from '../components/L2Manager';
import WebfigPanel from '../components/WebfigPanel';

const LIVE_REFRESH_MS = 7_000;
const TABLES_REFRESH_MS = 60_000;
const CHART_REFRESH_MS = 30_000;

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'interfaces', label: 'Interfaces', icon: Network },
  { id: 'network', label: 'Network', icon: RouteIcon },
  { id: 'dhcp', label: 'DHCP', icon: Activity },
  { id: 'firewall', label: 'Firewall', icon: Shield },
  { id: 'nat', label: 'NAT', icon: ArrowLeftRight },
  { id: 'qos', label: 'QoS', icon: Gauge },
  { id: 'dns', label: 'DNS & NTP', icon: Globe },
  { id: 'wireless', label: 'Wireless', icon: Wifi },
  { id: 'vpn', label: 'VPN', icon: KeyRound },
  { id: 'backups', label: 'Backups', icon: Archive },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'admin', label: 'Router Admin', icon: AppWindow },
] as const;
type TabId = (typeof TABS)[number]['id'];
const TAB_IDS = TABS.map((t) => t.id) as readonly string[];

/** Tab state mirrored to the URL hash, so refresh/back keep the tab. */
function useTabHash(): [TabId, (t: TabId) => void] {
  const read = (): TabId => {
    const h = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '';
    return (TAB_IDS.includes(h) ? h : 'overview') as TabId;
  };
  const [tab, setTabState] = useState<TabId>(read);
  useEffect(() => {
    const onHash = () => setTabState(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const setTab = (t: TabId) => { window.location.hash = t; setTabState(t); };
  return [tab, setTab];
}

export default function DeviceDetail() {
  const { id } = useParams();
  const deviceId = Number(id);
  const [detail, setDetail] = useState<DeviceDetailPayload | null>(null);
  const [live, setLive] = useState<DetailLive | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openIface, setOpenIface] = useState<string | null>(null);
  const [tab, setTab] = useTabHash();

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
        <div className="rounded-2xl border border-danger-line bg-danger-bg p-6 text-sm text-danger-fg-strong">{error}</div>
      </Shell>
    );
  }
  if (!detail) {
    return (
      <Shell>
        <div className="h-40 animate-pulse rounded-2xl border border-border bg-surface" />
      </Shell>
    );
  }

  const dev = detail.device;
  const rb = detail.routerboard.ok ? detail.routerboard.data : null;
  const status = liveError ? 'down' : (dev.status === 'down' ? 'down' : dev.status === null ? 'pending' : 'up');
  const temp = live?.health.find((h) => h.name?.includes('temperature'));

  return (
    <Shell name={dev.name}>
      {/* ===== Persistent device header (visible on every tab) ===== */}
      <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-subtle">
              <RouterIcon className="h-6 w-6 text-accent" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-bold tracking-tight text-fg-strong">{dev.name}</h1>
                <StatusBadge status={status as never} />
              </div>
              <div className="mt-0.5 text-sm text-fg-dim">
                {dev.scheme}://{dev.host}:{dev.port}
                {dev.identity ? ` · ${dev.identity}` : ''}
                {dev.siteName && (
                  <span className="ml-2 rounded-full bg-app px-2 py-0.5 text-xs font-semibold text-fg-muted">
                    {dev.siteName}
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={() => void refreshNow()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-fg-body transition hover:border-accent-border hover:text-accent-text disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Poll now
          </button>
        </div>

        {liveError && (
          <div className="mt-4 rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">
            Cannot reach the device right now: {liveError}
            {dev.lastSeenAt && <span className="text-danger"> · last seen {fmtAgo(dev.lastSeenAt)}</span>}
            <span className="text-danger"> — showing last-known information.</span>
          </div>
        )}
      </div>

      {/* ===== Tabs ===== */}
      <TabBar active={tab} onSelect={setTab} />

      {/* ===== Overview tab: at-a-glance metrics ===== */}
      {tab === 'overview' && (
        <Section title="At a glance" icon={LayoutGrid}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 lg:grid-cols-6">
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
            <div className="mt-3 text-[11px] text-fg-faint">
              Live · updated {fmtAgo(live.fetchedAt)} · refreshes every {LIVE_REFRESH_MS / 1000}s while this page is open
            </div>
          )}
        </Section>
      )}

      {/* ===== Interfaces tab ===== */}
      {tab === 'interfaces' && (
      <>
      <Section title="IP addresses" icon={RouteIcon}
        subtitle="per-interface addresses · the management address/interface are protected · changing the mgmt IP is done safely via add-before-remove (never an unreachable moment)">
        <AddressManager deviceId={deviceId} />
      </Section>
      <Section title="Interfaces" icon={Network}
        subtitle={live ? `${live.interfaces.filter((i) => i.running).length} of ${live.interfaces.length} running · rates derived from counters (read-only)` : undefined}>
        {!live ? (
          <Unavailable text="Interface data unavailable while the device is unreachable." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
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
      </>
      )}

      {/* ===== DHCP tab ===== */}
      {tab === 'dhcp' && (detail.sections.dhcp.ok && detail.sections.dhcp.data.servers.length > 0 ? (
        <Section title="DHCP reservations" icon={Activity}
          subtitle="static leases + active dynamic leases · writes go through snapshot → verify → auto-rollback → audit">
          <DhcpManager deviceId={deviceId} />
        </Section>
      ) : (
        <SectionFor title="DHCP reservations" icon={Activity} section={detail.sections.dhcp}
          naText="No DHCP server on this device."
          render={() => <Unavailable text="No DHCP server configured on this device." />}
        />
      ))}

      {/* ===== Firewall tab ===== */}
      {tab === 'firewall' && (
      <Section title="Firewall" icon={Shield}
        subtitle="preset-driven, mgmt-accept always first · writes go through snapshot → verify → auto-rollback → audit">
        <FirewallManager deviceId={deviceId} />
      </Section>
      )}

      {/* ===== NAT tab ===== */}
      {tab === 'nat' && (
      <Section title="NAT" icon={ArrowLeftRight}
        subtitle="src-nat / dst-nat rules · order-sensitive · a rule that would steal the management socket is refused; everything else rides the dead-man + is snapshotted pre/post">
        <NatManager deviceId={deviceId} />
      </Section>
      )}

      {/* ===== QoS tab ===== */}
      {tab === 'qos' && (
      <Section title="QoS — simple queues" icon={Gauge}
        subtitle="per-target rate limits · a queue that would strangle the management flow is refused; broader shaping rides a dead-man that checks latency (not just reachability) + is snapshotted pre/post">
        <QosManager deviceId={deviceId} />
      </Section>
      )}

      {/* ===== Backups tab ===== */}
      {tab === 'backups' && (
      <>
      <Section title="Config backups" icon={Archive}
        subtitle="full text export, diffable · backups are read-safe · restore runs through the audited dead-man pipeline">
        <BackupManager deviceId={deviceId} />
      </Section>
      <Section title="Config snapshots" icon={Camera}
        subtitle="auto-captured pre/post every write + manual + daily · /export show-sensitive, AES-256-GCM encrypted at rest · capture is read-only (all devices) · view / diff / download only — no restore">
        <SnapshotManager deviceId={deviceId} />
      </Section>
      </>
      )}

      {/* ===== DNS & NTP tab ===== */}
      {tab === 'dns' && (
      <Section title="DNS & NTP" icon={Globe}
        subtitle="resolver, static hosts & time sync · reads are safe · changes run through snapshot → verify → auto-rollback → audit">
        <DnsNtpManager deviceId={deviceId} />
      </Section>
      )}

      {/* ===== Wireless tab (capability-gated, stack-aware) ===== */}
      {tab === 'wireless' && (
      <Section title="Wireless" icon={Wifi}
        subtitle="SSID · security · band/channel · stack auto-detected (modern wifi vs legacy) · changes run through snapshot → verify → auto-rollback → audit; passphrases are never shown or logged">
        <WirelessManager deviceId={deviceId} />
      </Section>
      )}

      {/* ===== VPN tab (WireGuard — user VPNs; the P9 mgmt tunnel is protected) ===== */}
      {tab === 'vpn' && (
      <Section title="WireGuard VPN" icon={KeyRound}
        subtitle="site-to-site & client tunnels · the router generates its own private key (RubyMIK never holds it) · the management tunnel is protected · VPN routing rides the P17 mgmt-path guard + dead-man">
        <WireguardManager deviceId={deviceId} />
      </Section>
      )}

      {/* ===== Network tab: wireless, switch, ARP, routes ===== */}
      {tab === 'network' && (
      <>
      <SectionFor title="Wireless" icon={Wifi} section={detail.sections.wireless}
        naText="Not applicable — this device has no wireless interface."
        render={(w) => (
          <>
            <div className="mb-3 text-xs text-fg-dim">
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
            <div className="mb-3 text-xs text-fg-dim">
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

      {/* ===== Bridges & VLANs (L2 config) ===== */}
      <Section title="Bridges & VLANs" icon={Waypoints}
        subtitle="L2 config · the full mgmt path (port→bridge→VLAN→mgmt-IP) is traced & protected · the classic vlan-filtering lock is refused · mgmt-path restructures use add-before-remove at L2">
        <L2Manager deviceId={deviceId} />
      </Section>

      {/* ===== Routes (read + static-route config via safe-apply) ===== */}
      <Section title="Routes" icon={RouteIcon}
        subtitle="static routes only · RUBYMIK-tagged, reversible · management-path guarded · changes run reachable-then-commit with auto-revert on lockout">
        <RoutesManager deviceId={deviceId} />
      </Section>
      </>
      )}

      {/* ===== System info (shown in Overview) ===== */}
      {tab === 'overview' && (
      <SectionFor title="System" icon={FileText} section={detail.sections.update}
        naText="Package update info not available."
        render={(u) => (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <Meta label="Installed" value={u.installed ?? '—'} />
            <Meta label="Channel" value={u.channel ?? '—'} />
            {u.updateAvailable === true && (
              <span className="rounded-full bg-warning-bg px-2.5 py-1 text-xs font-semibold text-warning-fg">
                Update available: {u.latest}
              </span>
            )}
            {u.updateAvailable === false && (
              <span className="rounded-full bg-success-bg px-2.5 py-1 text-xs font-semibold text-success-fg">
                Up to date ({u.latest})
              </span>
            )}
            {u.updateAvailable === null && (
              <span className="rounded-full bg-app px-2.5 py-1 text-xs font-semibold text-fg-dim"
                title="RouterOS only knows the latest version after check-for-updates runs on the router; RubyMIK won't trigger it (write path) or guess.">
                Update status unknown — check not run on the router
              </span>
            )}
          </div>
        )}
      />
      )}

      {/* ===== Logs tab ===== */}
      {tab === 'logs' && (
      <SectionFor title="Recent log" icon={ScrollText} section={detail.sections.logs}
        naText="Log not accessible via REST on this device."
        render={(logs) => (
          <div className="max-h-80 overflow-y-auto rounded-lg bg-sunken p-3 font-mono text-xs leading-5 text-fg-body">
            {logs.length === 0 && <div className="text-fg-faint">Log buffer is empty.</div>}
            {logs.map((l, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 text-fg-faint">{l.time ?? ''}</span>
                <span className={`shrink-0 ${l.topics?.includes('error') || l.topics?.includes('critical') ? 'text-danger-fg' : 'text-fg-faint'}`}>
                  {l.topics ?? ''}
                </span>
                <span className="break-all">{l.message ?? ''}</span>
              </div>
            ))}
          </div>
        )}
      />
      )}

      {/* ===== Router Admin tab (WebFig proxy) ===== */}
      {tab === 'admin' && (
        <WebfigPanel deviceId={deviceId} />
      )}
    </Shell>
  );
}

/* ================= building blocks ================= */

function Shell({ name, children }: { name?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-dim transition hover:text-accent-text">
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
      <dt className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
        {Icon && <Icon className="h-3 w-3" />} {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-fg" title={value}>{value}</dd>
    </div>
  );
}

function MetricMeter({ label, icon: Icon, pct, detail, warnAt }: {
  label: string; icon: React.ComponentType<{ className?: string }>;
  pct: number | null; detail?: string; warnAt: number;
}) {
  return (
    <div>
      <dt className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
        <span className="flex items-center gap-1"><Icon className="h-3 w-3" /> {label}</span>
        <span className="font-semibold normal-case text-fg-body">{pct === null ? '—' : `${pct}%`}</span>
      </dt>
      <dd className="mt-1.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-app">
          <div
            className={`h-full rounded-full ${pct !== null && pct >= warnAt ? 'bg-warning' : 'bg-fg-faint'}`}
            style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
          />
        </div>
        {detail && <div className="mt-0.5 text-[10px] text-fg-faint">{detail}</div>}
      </dd>
    </div>
  );
}

/** Themed, horizontally-scrollable tab bar (underline style). Works in every P12 theme. */
function TabBar({ active, onSelect }: { active: TabId; onSelect: (t: TabId) => void }) {
  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-max gap-1 border-b border-border">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onSelect(id)}
            aria-current={active === id ? 'page' : undefined}
            className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-sm font-semibold transition-colors ${
              active === id
                ? 'border-accent text-accent-text'
                : 'border-transparent text-fg-dim hover:border-border-strong hover:text-fg'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Section({ title, icon: Icon, subtitle, children }: {
  title: string; icon: React.ComponentType<{ className?: string }>;
  subtitle?: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="mb-4 flex items-baseline gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body">
          <Icon className="h-4 w-4 text-fg-faint" /> {title}
        </h2>
        {subtitle && <span className="text-xs text-fg-faint">{subtitle}</span>}
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
        : <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load: {section.error}</div>}
    </Section>
  );
}

function Unavailable({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <div className={`rounded-lg px-3 py-2.5 text-sm ${muted ? 'bg-sunken text-fg-dim' : 'bg-sunken text-fg-muted'}`}>
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
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
            {headers.map((h) => <th key={h} className="pb-2 pr-4 first:pl-2">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border-subtle text-fg-body">
              {r.map((c, j) => (
                <td key={j} className={`py-1.5 pr-4 first:pl-2 ${j === 0 ? 'font-medium text-fg' : ''}`}>{c}</td>
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
        className={`cursor-pointer border-t border-border-subtle transition hover:bg-sunken ${open ? 'bg-sunken' : ''}`}
      >
        <td className="py-2 pl-2 font-medium text-fg">
          <span className="flex items-center gap-2">
            <span
              title={i.disabled ? 'Disabled' : i.running ? 'Running' : 'Not running'}
              className={`h-2 w-2 rounded-full ${i.disabled ? 'bg-border-strong' : i.running ? 'bg-success-strong' : 'bg-danger'}`}
            />
            {i.name}
            {i.comment && <span className="text-xs font-normal text-fg-faint">({i.comment})</span>}
            <ChevronDown className={`h-3.5 w-3.5 text-fg-faint transition-transform ${open ? 'rotate-180' : ''}`} />
          </span>
        </td>
        <td className="py-2 text-fg-dim">{i.type ?? '—'}</td>
        <td className="py-2 font-mono text-xs text-fg-dim">{i.mac ?? '—'}</td>
        <td className="py-2 text-fg-dim">{i.mtu ?? '—'}</td>
        <td className="py-2 text-right tabular-nums text-fg-body">{fmtRate(i.rxRate)}</td>
        <td className="py-2 text-right tabular-nums text-fg-body">{fmtRate(i.txRate)}</td>
        <td className="py-2 text-right tabular-nums text-fg-dim">{fmtBytes(i.rxByte)}</td>
        <td className="py-2 pr-2 text-right tabular-nums text-fg-dim">{fmtBytes(i.txByte)}</td>
      </tr>
      {open && (
        <tr className="border-t border-border-subtle bg-sunken/60">
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
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-dim">
          {iface} — traffic ({windowSec / 3600}h, {`30s`} samples)
        </span>
        <div className="flex gap-1">
          {[3600, 6 * 3600].map((w) => (
            <button
              key={w}
              onClick={() => setWindowSec(w)}
              className={`rounded-md px-2 py-1 text-xs font-semibold transition ${
                windowSec === w ? 'bg-accent text-inverse' : 'text-fg-dim hover:bg-app'
              }`}
            >
              {w / 3600}h
            </button>
          ))}
        </div>
      </div>
      {points === null
        ? <div className="h-40 animate-pulse rounded-lg bg-app" />
        : <TrafficChart points={points} />}
    </div>
  );
}
