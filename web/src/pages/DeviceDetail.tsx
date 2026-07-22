import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Activity, AppWindow, Archive, ArrowLeft, ArrowLeftRight, ChevronDown, Clock, Cpu, FileText, Gauge, Globe, KeyRound, LayoutGrid, Loader2,
  MemoryStick, Network, RefreshCw, Route as RouteIcon, Router as RouterIcon,
  Plug, ScrollText, Shield, Thermometer, Waypoints, Wifi,
} from 'lucide-react';
import { api } from '../api';
import {
  fmtAgo, fmtBytes, fmtRate,
  type DeviceDetailPayload, type DetailInterface, type DetailLive,
  type DetailSection, type TrafficPoint,
} from '../types';
import StatusBadge from '../components/StatusBadge';
import TrafficChart from '../components/TrafficChart';
import MetricChart, { type MetricPoint } from '../components/MetricChart';
import DhcpManager from '../components/DhcpManager';
import FirewallManager from '../components/FirewallManager';
import BackupManager from '../components/BackupManager';
import SnapshotManager from '../components/SnapshotManager';
import NatManager from '../components/NatManager';
import QosManager from '../components/QosManager';
import PppoeManager from '../components/PppoeManager';
import DnsNtpManager from '../components/DnsNtpManager';
import WirelessManager from '../components/WirelessManager';
import RoutesManager from '../components/RoutesManager';
import WireguardManager from '../components/WireguardManager';
import AddressManager from '../components/AddressManager';
import L2Manager from '../components/L2Manager';
import WebfigPanel from '../components/WebfigPanel';
import RebootPanel from '../components/RebootPanel';
import LogsManager from '../components/LogsManager';

const LIVE_REFRESH_MS = 7_000;
const TABLES_REFRESH_MS = 60_000;
const CHART_REFRESH_MS = 30_000;

/* =====================================================================
 * P26 — grouped device sub-nav (kills the horizontal tab scrollbar).
 * Two-row nav: row 1 = 5 groups, row 2 = the active group's sections.
 * Each section is a collapsible card; heavy/diagnostic ones start closed
 * so no group page needs more than ~2 screens of scroll. Section bodies
 * mount only when open (lazy). Every section carries a plain-language
 * helper line in addition to the technical term.
 * ===================================================================== */

type GroupId = 'overview' | 'network' | 'security' | 'services' | 'system';
type SectionId =
  | 'glance' | 'sysinfo'
  | 'interfaces' | 'addresses' | 'routes' | 'wireless' | 'switch' | 'arp'
  | 'firewall' | 'nat'
  | 'dhcp' | 'dns' | 'qos' | 'pppoe' | 'vpn'
  | 'backups' | 'logs' | 'admin';

interface Sub { id: SectionId; label: string; icon: React.ComponentType<{ className?: string }> }
interface Group { id: GroupId; label: string; icon: React.ComponentType<{ className?: string }>; subs: Sub[] }

const GROUPS: Group[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid, subs: [
    { id: 'glance', label: 'At a glance', icon: LayoutGrid },
    { id: 'sysinfo', label: 'System', icon: FileText },
  ] },
  { id: 'network', label: 'Network', icon: Network, subs: [
    { id: 'interfaces', label: 'Interfaces', icon: Network },
    { id: 'addresses', label: 'Addresses & L2', icon: RouteIcon },
    { id: 'routes', label: 'Routes', icon: Waypoints },
    { id: 'wireless', label: 'Wireless', icon: Wifi },
    { id: 'switch', label: 'Switch ports', icon: Gauge },
    { id: 'arp', label: 'ARP', icon: Network },
  ] },
  { id: 'security', label: 'Security', icon: Shield, subs: [
    { id: 'firewall', label: 'Firewall', icon: Shield },
    { id: 'nat', label: 'NAT', icon: ArrowLeftRight },
  ] },
  { id: 'services', label: 'Services', icon: Waypoints, subs: [
    { id: 'dhcp', label: 'DHCP', icon: Activity },
    { id: 'dns', label: 'DNS & NTP', icon: Globe },
    { id: 'qos', label: 'QoS', icon: Gauge },
    { id: 'pppoe', label: 'PPPoE', icon: Plug },
    { id: 'vpn', label: 'VPN', icon: KeyRound },
  ] },
  { id: 'system', label: 'System', icon: Cpu, subs: [
    { id: 'backups', label: 'Backups & Snapshots', icon: Archive },
    { id: 'logs', label: 'Logs', icon: ScrollText },
    { id: 'admin', label: 'Router Admin', icon: AppWindow },
  ] },
];

/** Which group each section belongs to (derived from GROUPS). */
const SECTION_GROUP: Record<SectionId, GroupId> = Object.fromEntries(
  GROUPS.flatMap((g) => g.subs.map((s) => [s.id, g.id])),
) as Record<SectionId, GroupId>;

/** Sections open by default when a group is entered (keeps each page short). */
const GROUP_DEFAULT_OPEN: Record<GroupId, SectionId[]> = {
  overview: ['glance', 'sysinfo'],
  network: ['interfaces', 'addresses'],
  security: ['firewall'],
  services: ['dhcp'],
  system: ['backups'],
};

/** Back-compat: old single-tab hashes (P16–P24 deep links) → a section id. */
const OLD_HASH: Record<string, SectionId> = {
  overview: 'glance', interfaces: 'interfaces', network: 'interfaces',
  dhcp: 'dhcp', firewall: 'firewall', nat: 'nat', qos: 'qos', pppoe: 'pppoe',
  dns: 'dns', wireless: 'wireless', vpn: 'vpn', backups: 'backups',
  logs: 'logs', admin: 'admin',
};

const ALL_SECTION_IDS = Object.keys(SECTION_GROUP) as SectionId[];

/** Plain-language helper line (P26.4) — kept alongside the technical term. */
const SECTION_HELP: Record<SectionId, string> = {
  glance: 'A quick health snapshot — model, uptime, and how hard the router is working.',
  sysinfo: "Which RouterOS version is installed, and whether an update is waiting.",
  interfaces: 'The ports and links on this router, and how much traffic each is carrying.',
  addresses: "The router's IP addresses, plus its bridges and VLANs — how the ports are grouped together.",
  routes: 'Static routes — telling the router which path to send traffic down to reach other networks.',
  wireless: "Your Wi-Fi network name, password and radio settings — and who's connected.",
  switch: 'The built-in switch chip and its ports (view only).',
  arp: 'The address book that maps IP addresses to the devices on your network (view only).',
  firewall: 'The rules that decide what traffic is allowed in and out — like a bouncer for your network.',
  nat: 'Port forwarding — send traffic coming from the internet to a specific device inside your network.',
  dhcp: 'Hand out IP addresses automatically, and reserve a fixed one for a specific device.',
  dns: "Turn website names into addresses, and keep the router's clock in sync.",
  qos: 'Limit how much of your internet speed a device or service is allowed to use.',
  pppoe: 'The fibre/DSL login your internet provider gave you.',
  vpn: 'A private, encrypted tunnel to another site or device (WireGuard).',
  backups: "Save and download the router's full settings, and browse the automatic snapshots.",
  logs: "The router's recent activity log.",
  admin: "The router's own admin page (WebFig), embedded here for advanced tasks.",
};

/** Technical detail line (unchanged wording from the previous per-tab subtitles). */
const SECTION_TECH: Partial<Record<SectionId, string>> = {
  interfaces: 'Physical & virtual interfaces · rates derived from counters (read-only)',
  addresses: 'Per-interface addresses + bridges/VLANs · the mgmt address/interface are protected · mgmt-IP changes use add-before-remove (never an unreachable moment)',
  routes: 'Static routes only · RUBYMIK-tagged, reversible · management-path guarded · reachable-then-commit with auto-revert on lockout',
  wireless: 'SSID · security · band/channel · stack auto-detected (modern wifi vs legacy) · snapshot → verify → auto-rollback → audit; passphrases are never shown or logged',
  switch: 'Read-only · switch-chip ports over REST · link speed needs the RouterOS monitor command (write-path) — not shown by design',
  arp: 'Read-only · IP↔MAC neighbour table',
  firewall: 'Preset-driven, mgmt-accept always first · writes go through snapshot → verify → auto-rollback → audit',
  nat: 'src-nat / dst-nat rules · order-sensitive · a rule that would steal the management socket is refused; everything else rides the dead-man + is snapshotted pre/post',
  dhcp: 'Static leases + active dynamic leases · writes go through snapshot → verify → auto-rollback → audit',
  dns: 'Resolver, static hosts & time sync · reads are safe · changes run through snapshot → verify → auto-rollback → audit',
  qos: 'Per-target rate limits · a queue that would strangle the management flow is refused; broader shaping rides a dead-man that checks latency (not just reachability) + is snapshotted pre/post',
  pppoe: 'WAN dial-up sessions · credentials write-only (never shown/logged) · a client on the mgmt port is refused; a mgmt-path WAN swap uses add-before-remove · snapshotted pre/post',
  vpn: 'Site-to-site & client tunnels · the router generates its own private key (RubyMIK never holds it) · the management tunnel is protected · VPN routing rides the P17 mgmt-path guard + dead-man',
  backups: 'Full-text export (diffable) + auto pre/post snapshots (AES-256-GCM at rest) · restore rides the audited dead-man; snapshots are view / diff / download only',
  logs: 'Read-only · recent RouterOS log buffer',
  admin: "The router's own WebFig, proxied · advanced / rarely-needed tasks",
};

function resolveHash(): SectionId {
  const h = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '';
  if ((ALL_SECTION_IDS as string[]).includes(h)) return h as SectionId;
  if (OLD_HASH[h]) return OLD_HASH[h];
  return 'glance';
}

/** Grouped nav state, mirrored to the URL hash so refresh/back keep your place. */
function useDeviceNav() {
  const init = resolveHash();
  const [group, setGroup] = useState<GroupId>(SECTION_GROUP[init]);
  const [openSecs, setOpenSecs] = useState<Set<SectionId>>(
    () => new Set([...GROUP_DEFAULT_OPEN[SECTION_GROUP[init]], init]),
  );

  useEffect(() => {
    const onHash = () => {
      const s = resolveHash();
      const g = SECTION_GROUP[s];
      setGroup(g);
      setOpenSecs(new Set([...GROUP_DEFAULT_OPEN[g], s]));
      requestAnimationFrame(() =>
        document.getElementById(`sec-${s}`)?.scrollIntoView({ block: 'start' }));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const selectGroup = (g: GroupId) => { window.location.hash = GROUP_DEFAULT_OPEN[g][0]; };
  const openSection = (s: SectionId) => {
    if (window.location.hash.replace('#', '') === s) {
      setOpenSecs((prev) => new Set(prev).add(s));
      document.getElementById(`sec-${s}`)?.scrollIntoView({ block: 'start' });
    } else {
      window.location.hash = s;
    }
  };
  const toggleSection = (s: SectionId) => setOpenSecs((prev) => {
    const n = new Set(prev);
    if (n.has(s)) n.delete(s); else n.add(s);
    return n;
  });

  return { group, openSecs, selectGroup, openSection, toggleSection };
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
  const { group, openSecs, selectGroup, openSection, toggleSection } = useDeviceNav();

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

  const d = detail; // non-null past the guard above; keeps narrowing inside bodyFor's closure
  const dev = d.device;
  const rb = d.routerboard.ok ? d.routerboard.data : null;
  // A reboot is a deliberate outage: show 'rebooting' even though the live poll
  // is failing (liveError), so the header never flashes a false "down".
  const status = dev.status === 'rebooting'
    ? 'rebooting'
    : liveError ? 'down' : (dev.status === 'down' ? 'down' : dev.status === null ? 'pending' : 'up');
  const temp = live?.health.find((h) => h.name?.includes('temperature'));
  const activeGroup = GROUPS.find((g) => g.id === group) ?? GROUPS[0];
  // Live-populated interface names for the dropdowns in Nat/Pppoe/L2 (P26.3).
  // Sourced from the page's live poll — no extra server call, refreshed every 7s.
  const ifaceNames = live?.interfaces.map((i) => i.name) ?? [];

  /** The inner content of a section — evaluated only when the section is open. */
  function bodyFor(sid: SectionId): React.ReactNode {
    switch (sid) {
      case 'glance':
        return (
          <>
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
            <div className="mt-5 border-t border-border-subtle pt-4">
              <MetricsChart deviceId={deviceId} />
            </div>
          </>
        );

      case 'sysinfo':
        return (
          <CapabilityBody section={d.sections.update} naText="Package update info not available."
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
        );

      case 'interfaces':
        return !live ? (
          <Unavailable text="Interface data unavailable while the device is unreachable." />
        ) : (
          <>
            <div className="mb-3 text-xs text-fg-dim">
              {live.interfaces.filter((i) => i.running).length} of {live.interfaces.length} running
            </div>
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
          </>
        );

      case 'addresses':
        return (
          <>
            <SubBlock title="IP addresses" help="The addresses this router answers to, one per interface.">
              <AddressManager deviceId={deviceId} />
            </SubBlock>
            <SubBlock title="Bridges & VLANs" help="How the physical ports are grouped and tagged. The management path is traced and protected.">
              <L2Manager deviceId={deviceId} interfaces={ifaceNames} />
            </SubBlock>
          </>
        );

      case 'routes':
        return <RoutesManager deviceId={deviceId} />;

      case 'wireless':
        return (
          <>
            <SubBlock title="Wi-Fi configuration" help="Network name, password, band and channel.">
              <WirelessManager deviceId={deviceId} />
            </SubBlock>
            <SubBlock title="Connected clients" help="Devices currently joined to this router's Wi-Fi.">
              <CapabilityBody section={d.sections.wireless}
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
            </SubBlock>
          </>
        );

      case 'switch':
        return (
          <CapabilityBody section={d.sections.switch} naText="Not applicable — no switch chip on this device."
            render={(sw) => (
              <>
                <div className="mb-3 text-xs text-fg-dim">
                  {sw.chips.map((c) => `${c.name ?? 'switch'}${c.type ? ` (${c.type})` : ''}`).join(' · ')}
                </div>
                {sw.ports.length === 0 ? (
                  <Unavailable text="The switch chip exposes no per-port entries over REST." />
                ) : (
                  <SimpleTable headers={['Port', 'Switch']} rows={sw.ports.map((p) => [p.name ?? '—', p.switch ?? '—'])} />
                )}
              </>
            )}
          />
        );

      case 'arp':
        return (
          <CapabilityBody section={d.sections.arp} naText="ARP table not available."
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
        );

      case 'firewall':
        return <FirewallManager deviceId={deviceId} />;

      case 'nat':
        return <NatManager deviceId={deviceId} interfaces={ifaceNames} />;

      case 'dhcp':
        return d.sections.dhcp.ok && d.sections.dhcp.data.servers.length > 0
          ? <DhcpManager deviceId={deviceId} />
          : (
            <CapabilityBody section={d.sections.dhcp} naText="No DHCP server on this device."
              render={() => <Unavailable text="No DHCP server configured on this device." />}
            />
          );

      case 'dns':
        return <DnsNtpManager deviceId={deviceId} />;

      case 'qos':
        return <QosManager deviceId={deviceId} />;

      case 'pppoe':
        return <PppoeManager deviceId={deviceId} interfaces={ifaceNames} />;

      case 'vpn':
        return <WireguardManager deviceId={deviceId} />;

      case 'backups':
        return (
          <>
            <SubBlock title="Config backups" help="A full text export of the router's settings — download it or compare two.">
              <BackupManager deviceId={deviceId} />
            </SubBlock>
            <SubBlock title="Config snapshots" help="Automatic saves taken before and after every change — view, diff and download (no restore).">
              <SnapshotManager deviceId={deviceId} />
            </SubBlock>
          </>
        );

      case 'logs':
        return <LogsManager deviceId={deviceId} />;

      case 'admin':
        return (
          <>
            <RebootPanel deviceId={deviceId} deviceName={dev.name} manageable={dev.manageable} />
            <WebfigPanel deviceId={deviceId} />
          </>
        );
    }
  }

  return (
    <Shell name={dev.name}>
      {/* ===== Persistent device header (visible on every group) ===== */}
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

      {/* ===== Left sub-rail nav (Option B) + the active group's sections ===== */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <SideRail group={group} openSecs={openSecs} onGroup={selectGroup} onSub={openSection} />
        <div className="min-w-0 flex-1 space-y-4">
          {activeGroup.subs.map((sub) => {
            const isOpen = openSecs.has(sub.id);
            return (
              <CollapsibleSection key={sub.id} id={sub.id} title={sub.label} icon={sub.icon}
                help={SECTION_HELP[sub.id]} tech={SECTION_TECH[sub.id]}
                open={isOpen} onToggle={() => toggleSection(sub.id)}>
                {isOpen ? bodyFor(sub.id) : null}
              </CollapsibleSection>
            );
          })}
        </div>
      </div>
    </Shell>
  );
}

/* ================= navigation ================= */

/** Left sub-rail (Option B): a vertical settings-style tree — every group with its
 *  sections beneath it. Selecting a group jumps to it; selecting a section opens +
 *  scrolls to it. Sticks alongside the content on desktop; stacks above on narrow. */
function SideRail({ group, openSecs, onGroup, onSub }: {
  group: GroupId; openSecs: Set<SectionId>;
  onGroup: (g: GroupId) => void; onSub: (s: SectionId) => void;
}) {
  return (
    <nav aria-label="Device sections"
      className="rounded-2xl border border-border bg-surface p-2 lg:sticky lg:top-4 lg:w-56 lg:shrink-0 lg:self-start">
      {GROUPS.map((g) => {
        const Icon = g.icon;
        const isCurrentGroup = g.id === group;
        return (
          <div key={g.id} className="mb-1.5 last:mb-0">
            <button
              onClick={() => onGroup(g.id)}
              aria-current={isCurrentGroup ? 'true' : undefined}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide transition ${
                isCurrentGroup ? 'text-accent-text' : 'text-fg-faint hover:text-fg-dim'
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" /> {g.label}
            </button>
            <div className="mt-0.5 space-y-0.5">
              {g.subs.map((sub) => {
                const active = isCurrentGroup && openSecs.has(sub.id);
                return (
                  <button
                    key={sub.id}
                    onClick={() => onSub(sub.id)}
                    aria-current={active ? 'page' : undefined}
                    className={`block w-full rounded-lg py-1.5 pl-8 pr-2.5 text-left text-sm transition ${
                      active ? 'bg-accent font-semibold text-inverse' : 'text-fg-dim hover:bg-app hover:text-fg'
                    }`}
                  >
                    {sub.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/* ================= building blocks ================= */

function Shell({ name, children }: { name?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/fleet" className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-dim transition hover:text-accent-text">
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

/** A collapsible section card. Header carries the technical term + a plain-language
 *  helper line; the body (and its manager) mounts only while open. */
function CollapsibleSection({ id, title, icon: Icon, help, tech, open, onToggle, children }: {
  id: SectionId; title: string; icon: React.ComponentType<{ className?: string }>;
  help: string; tech?: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <section id={`sec-${id}`} className="scroll-mt-24 rounded-2xl border border-border bg-surface shadow-sm">
      <button
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`body-${id}`}
        className="flex w-full items-start justify-between gap-3 p-5 text-left"
      >
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body">
            <Icon className="h-4 w-4 shrink-0 text-fg-faint" /> {title}
          </h2>
          <p className="mt-1 text-sm text-fg-dim">{help}</p>
          {tech && <p className="mt-0.5 text-xs text-fg-faint">{tech}</p>}
        </div>
        <ChevronDown className={`mt-0.5 h-5 w-5 shrink-0 text-fg-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div id={`body-${id}`} className="border-t border-border-subtle p-5">{children}</div>}
    </section>
  );
}

/** A labelled sub-block inside a section that hosts more than one manager. */
function SubBlock({ title, help, children }: { title: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="mb-8 last:mb-0">
      <h3 className="text-xs font-bold uppercase tracking-wide text-fg-body">{title}</h3>
      {help && <p className="mb-3 mt-0.5 text-xs text-fg-dim">{help}</p>}
      {children}
    </div>
  );
}

/** Renders a capability's body: real data, honest NA, or the fetch error.
 *  (No card wrapper — the CollapsibleSection is the card.) */
function CapabilityBody<T>({ section, naText, render }: {
  section: DetailSection<T>; naText: string; render: (data: T) => React.ReactNode;
}) {
  if (section.ok) return <>{render(section.data)}</>;
  if (section.na) return <Unavailable text={naText} muted />;
  return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load: {section.error}</div>;
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

/** Device CPU + memory over time (from the persisted metrics ring buffer). */
function MetricsChart({ deviceId }: { deviceId: number }) {
  const [points, setPoints] = useState<MetricPoint[] | null>(null);
  const [windowSec, setWindowSec] = useState(3600);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.get<{ points: MetricPoint[] }>(`/api/devices/${deviceId}/metrics?window=${windowSec}`)
        .then((r) => { if (!cancelled) setPoints(r.points); }).catch(() => {});
    };
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, CHART_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [deviceId, windowSec]);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-dim">CPU &amp; memory ({windowSec / 3600}h)</span>
        <div className="flex gap-1">
          {[3600, 24 * 3600].map((w) => (
            <button key={w} onClick={() => setWindowSec(w)}
              className={`rounded-md px-2 py-1 text-xs font-semibold transition ${windowSec === w ? 'bg-accent text-inverse' : 'text-fg-dim hover:bg-app'}`}>
              {w / 3600}h
            </button>
          ))}
        </div>
      </div>
      {points === null ? <div className="h-40 animate-pulse rounded-lg bg-app" /> : <MetricChart points={points} />}
    </div>
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
          {[3600, 24 * 3600].map((w) => (
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
