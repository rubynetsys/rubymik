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
  /** True when the device has an explicit write credential. */
  manageable: boolean;
  createdAt: string;
}

// --- DHCP management + audit (P5) ---

export interface DhcpLease {
  '.id': string;
  address?: string;
  'mac-address'?: string;
  server?: string;
  comment?: string;
  dynamic?: string;
  status?: string;
  'host-name'?: string;
  'expires-after'?: string;
}

export interface DhcpManagement {
  manageable: boolean;
  servers: Array<{ name: string; interface: string; disabled: boolean }>;
  reservations: DhcpLease[];
  dynamic: DhcpLease[];
}

export type ApplyResultCode = 'applied' | 'rolled_back' | 'rollback_failed' | 'failed';

export interface ApplyOutcome {
  result: ApplyResultCode;
  auditId: number;
  detail: string;
  before: unknown;
  after: unknown;
}

// --- Managed firewall (P6) ---

export type FirewallPreset = 'off' | 'basic' | 'standard';

export interface FirewallCustomRule {
  chain: 'input' | 'forward';
  action: 'accept' | 'drop' | 'reject';
  protocol?: string | null;
  dstPort?: string | null;
  srcAddress?: string | null;
  comment?: string | null;
}

export interface FirewallView {
  manageable: boolean;
  config: {
    preset: FirewallPreset;
    wanInterface: string | null;
    trustedInterface: string | null;
    mgmtSources: string[];
    custom: FirewallCustomRule[];
  };
  interfaces: Array<{ name: string; type: string; running: boolean }>;
  suggestedMgmt: string | null;
  managedRules: Array<Record<string, unknown> & { id: string; chain?: string; action?: string; comment?: string }>;
}

export interface LockoutTestResult {
  result: 'rolled_back' | 'rollback_failed' | 'failed';
  detail: string;
  lostForSec: number | null;
  auditId: number;
}

// --- Config backup & restore (P7) ---

export interface Backup {
  id: number;
  deviceId: number | null;
  deviceName: string;
  identity: string | null;
  model: string | null;
  serial: string | null;
  version: string | null;
  source: string;
  format: 'export' | 'snapshot';
  rawBytes: number;
  gzBytes: number;
  createdAt: string;
}

export interface BackupsView {
  manageable: boolean;
  backups: Backup[];
}

export interface DiffResult {
  from: { id: number; createdAt: string };
  to: { id: number; createdAt: string };
  added: number;
  removed: number;
  lines: Array<{ t: ' ' | '+' | '-'; s: string }>;
}

export interface RestoreOutcome {
  result: 'applied' | 'rolled_back' | 'rollback_failed' | 'failed';
  auditId: number;
  detail: string;
}

// --- DNS & NTP config (P8) ---

export interface NetConfigView {
  manageable: boolean;
  dns: {
    servers: string[];
    dynamicServers: string[];
    allowRemoteRequests: boolean;
    cacheSize: number;
    cacheUsed: number;
    static: Array<{ id: string; name: string | null; address: string | null; type: string | null; comment: string | null; disabled: boolean }>;
  };
  ntp: NtpState;
}

export interface NtpState {
  enabled: boolean;
  servers: string[];
  status: string;
  synced: boolean;
  freqDrift: string | null;
  time: string | null;
  timeZone: string | null;
}

export interface AuditEntry {
  id: number;
  deviceId: number | null;
  deviceName: string;
  actor: string;
  action: string;
  target: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  result: 'applied' | 'rolled_back' | 'rollback_failed' | 'failed' | 'rejected';
  detail: string | null;
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
  /** Active alert flags, null when none firing. */
  alerts: { count: number; severity: 'critical' | 'warning' | 'info' } | null;
  /** ISO timestamp of the most recent config backup, or null. */
  lastBackupAt: string | null;
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

// --- Topology (P3) ---

export interface TopoNode {
  key: string;
  kind: 'managed' | 'discovered';
  name: string;
  deviceId?: number;
  siteId?: number | null;
  siteName?: string | null;
  status?: HealthStatus;
  model?: string | null;
  version?: string | null;
  identity?: string | null;
  platform?: string | null;
  board?: string | null;
  mac?: string | null;
  address?: string | null;
  vendor?: string | null;
  discoveredBy?: string | null;
  seenBy?: Array<{ deviceId: number; deviceName: string; iface: string | null }>;
}

export interface TopoEdge {
  source: string;
  target: string;
  ifaces: Record<string, string | null>;
  discoveredBy: string | null;
}

export interface DiscoveryNote {
  deviceId: number;
  deviceName: string;
  protocol: string | null;
  interfaceList: string | null;
  neighborCount: number;
  level: 'ok' | 'restricted' | 'disabled' | 'unknown';
  message: string;
}

export interface TopologyPayload {
  generatedAt: string;
  sites: Array<{ id: number; name: string }>;
  nodes: TopoNode[];
  edges: TopoEdge[];
  notes: DiscoveryNote[];
}

// --- Alerts (P4) ---

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: number;
  deviceId: number;
  deviceName: string;
  host: string;
  siteId: number | null;
  siteName: string | null;
  rule: string;
  ruleLabel: string;
  target: string | null;
  severity: AlertSeverity;
  state: 'firing' | 'resolved';
  message: string;
  value: string | null;
  firedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  cycles: number;
}

export interface AlertSummary {
  firing: number;
  critical: number;
  warning: number;
  info: number;
}

export interface AlertRule {
  id: number;
  rule: string;
  label: string;
  severity: AlertSeverity;
  unit: string | null;
  enabled: boolean;
  threshold: number | null;
  clearThreshold: number | null;
  fireCycles: number;
  resolveCycles: number;
}

export interface NotificationSettings {
  webhookEnabled: boolean;
  webhookUrl: string | null;
}

export function fmtDuration(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 129600) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
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
