export interface AppStatus {
  needsSetup: boolean;
  authenticated: boolean;
}

export interface Site {
  id: number;
  name: string;
  location: string | null;
  clientName: string | null;
  deviceCount: number;
  createdAt: string;
}

export interface Device {
  id: number;
  name: string;
  host: string;
  port: number | null;
  transport: string;
  useTls: boolean | null;
  siteId: number | null;
  siteName: string | null;
  notes: string | null;
  /** Latest poll state ('up' | 'down') or null if never polled. */
  status: string | null;
  createdAt: string;
}

export interface RouterSystemInfo {
  identity: string | null;
  model: string | null;
  boardName: string | null;
  serialNumber: string | null;
  firmware: string | null;
  version: string;
  architecture: string | null;
  uptime: string;
  cpuCount: number | null;
  cpuLoad: number;
  totalMemory: number;
  freeMemory: number;
  totalHdd: number | null;
  freeHdd: number | null;
}

export interface TestResult {
  ok: true;
  transport: string;
  scheme: 'https' | 'http';
  port: number;
  info: RouterSystemInfo;
}

export type HealthStatus = 'up' | 'warning' | 'down' | 'pending';

export interface HealthCounts {
  total: number;
  up: number;
  warning: number;
  down: number;
  pending: number;
}

export interface FleetDevice {
  id: number;
  name: string;
  host: string;
  port: number | null;
  useTls: boolean | null;
  siteId: number | null;
  notes: string | null;
  status: HealthStatus;
  reasons: string[];
  identity: string | null;
  model: string | null;
  version: string | null;
  uptime: string | null;
  cpuLoad: number | null;
  cpuCount: number | null;
  memTotal: number | null;
  memFree: number | null;
  memUsedPct: number | null;
  lastSeenAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Recent CPU readings, oldest→newest; null where the device was down. */
  history: Array<number | null>;
}

export interface FleetSite {
  id: number | null;
  name: string;
  location: string | null;
  clientName: string | null;
  counts: HealthCounts;
  devices: FleetDevice[];
}

export interface FleetPayload {
  generatedAt: string;
  pollIntervalSec: number;
  summary: HealthCounts;
  sites: FleetSite[];
}

// --- Device detail (P2) ---

export interface DetailInterface {
  name: string;
  type: string | null;
  running: boolean;
  disabled: boolean;
  mac: string | null;
  mtu: number | null;
  rxByte: number;
  txByte: number;
  rxRate: number | null;
  txRate: number | null;
  comment: string | null;
  lastLinkUp: string | null;
}

export interface DetailLive {
  fetchedAt: string;
  uptime: string | null;
  version: string | null;
  cpuLoad: number | null;
  cpuCount: number | null;
  memTotal: number;
  memFree: number;
  memUsedPct: number | null;
  health: Array<{ name: string | null; value: string | null; type: string | null }>;
  interfaces: DetailInterface[];
}

export type DetailSection<T> =
  | { ok: true; data: T }
  | { ok: false; na: true }
  | { ok: false; na?: false; error: string };

export interface DhcpData {
  servers: Array<{ name: string | null; interface: string | null; disabled: boolean }>;
  leases: Array<{
    address: string | null; mac: string | null; hostName: string | null; server: string | null;
    status: string | null; expiresAfter: string | null; dynamic: boolean; lastSeen: string | null;
  }>;
}

export interface ArpEntry {
  address: string | null; mac: string | null; interface: string | null; dynamic: boolean; complete: boolean;
}

export interface RoutesData {
  total: number;
  entries: Array<{
    dst: string | null; gateway: string | null; distance: number | null;
    active: boolean; dynamic: boolean; static: boolean;
  }>;
}

export interface WirelessData {
  stack: string;
  clients: Array<{
    mac: string | null; interface: string | null; ssid: string | null; signal: string | null;
    txRate: string | null; rxRate: string | null; uptime: string | null; bytes: string | null;
  }>;
}

export interface SwitchData {
  chips: Array<{ name: string | null; type: string | null }>;
  ports: Array<{ name: string | null; switch: string | null }>;
}

export type LogEntries = Array<{ time: string | null; topics: string | null; message: string | null }>;

export interface UpdateData {
  channel: string | null;
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean | null;
  status: string | null;
}

export interface DeviceDetailPayload {
  device: {
    id: number; name: string; host: string; port: number; scheme: string;
    siteId: number | null; siteName: string | null; notes: string | null;
    status: string | null; lastSeenAt: string | null; lastError: string | null;
    identity: string | null; boardName: string | null; model: string | null; version: string | null;
  };
  routerboard: DetailSection<{ model: string | null; serial: string | null; firmware: string | null }>;
  live: DetailLive | null;
  liveError: string | null;
  sections: {
    dhcp: DetailSection<DhcpData>;
    arp: DetailSection<ArpEntry[]>;
    routes: DetailSection<RoutesData>;
    wireless: DetailSection<WirelessData>;
    switch: DetailSection<SwitchData>;
    logs: DetailSection<LogEntries>;
    update: DetailSection<UpdateData>;
  };
}

export interface TrafficPoint {
  t: string;
  rx: number | null;
  tx: number | null;
}

export function fmtRate(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return '—';
  if (bps < 1000) return `${bps} bps`;
  if (bps < 1e6) return `${(bps / 1e3).toFixed(1)} Kbps`;
  if (bps < 1e9) return `${(bps / 1e6).toFixed(1)} Mbps`;
  return `${(bps / 1e9).toFixed(2)} Gbps`;
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(Math.floor(Math.log2(n) / 10), units.length - 1);
  return `${(n / 2 ** (10 * i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
