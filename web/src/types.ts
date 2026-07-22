export interface AppStatus {
  needsSetup: boolean;
  authenticated: boolean;
  installDefault?: { theme: string; accent: string | null };
}

export interface Site {
  id: number;
  name: string;
  location: string | null;
  clientName: string | null;
  latitude: number | null;
  longitude: number | null;
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
  /** Stored category override (P27); null = derive from the polled model. */
  category: string | null;
  /** Last polled RouterOS model, for deriving the effective category. */
  model: string | null;
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

// --- Wireless (P16) ---
export type WirelessStack = 'wifi' | 'wireless' | 'none';
export interface WirelessIface {
  id: string; name: string; ssid: string | null; mode: string | null;
  disabled: boolean; running: boolean;
  band: string | null; frequency: string | null; width: string | null;
  authTypes: string[]; hasPassphrase: boolean; securityProfile: string | null;
  carriesManagement: boolean;
}
export interface WirelessView {
  manageable: boolean;
  stack: WirelessStack;
  capsmanManaged: boolean;
  interfaces: WirelessIface[];
  clients: Array<Record<string, string | null>>;
}

// --- Routes (P17) ---
export type RouteKind = 'connected' | 'dynamic' | 'static';
export interface RouteEntry {
  id: string; dst: string | null; gateway: string | null; distance: number | null;
  active: boolean; kind: RouteKind; managed: boolean; comment: string | null;
}
export interface RoutesView {
  manageable: boolean;
  routes: RouteEntry[];
  mgmtPrefixes: string[];
  mgmtHost: string;
  mgmtNet: string;   // 'direct' | 'tunnel'
}

// --- WireGuard VPN (P18) ---
export type WgRole = 'mgmt' | 'user-managed' | 'user';
export interface WgPeerView {
  id: string; publicKey: string | null; endpoint: string | null; allowedAddress: string | null;
  keepalive: string | null; hasPresharedKey: boolean; lastHandshake: string | null; rx: string | null; tx: string | null;
}
export interface WgInterfaceView {
  id: string; name: string; role: WgRole; comment: string | null;
  publicKey: string | null; listenPort: string | null; running: boolean; disabled: boolean;
  addresses: string[]; peers: WgPeerView[];
}
export interface WireguardView {
  manageable: boolean; supported: boolean; interfaces: WgInterfaceView[];
}
export interface SiteToSiteResult {
  localPeer: Record<string, string>; remotePeer: Record<string, string>; remoteScript: string;
}

// --- VPN breadth: L2TP/IPsec · SSTP · OVPN · PPP accounts · certs (P32) ---
export type TunnelProto = 'l2tp' | 'sstp' | 'ovpn';
export interface TunnelClientView {
  proto: TunnelProto; id: string; name: string; connectTo: string | null; user: string | null; hasPassword: boolean;
  profile: string | null; disabled: boolean; running: boolean; status: string; uptime: string | null;
  comment: string | null; managed: boolean; isMgmtPath: boolean; dynamic: boolean;
  useIpsec: boolean; hasIpsecSecret: boolean; certificate: string | null; verifyServerCert: boolean;
}
export interface PppSecretView {
  id: string; name: string; service: string | null; profile: string | null; hasPassword: boolean;
  localAddress: string | null; remoteAddress: string | null; disabled: boolean; comment: string | null; managed: boolean;
}
export interface CertView {
  id: string; name: string; commonName: string | null; keyType: string | null; hasPrivateKey: boolean;
  invalidBefore: string | null; invalidAfter: string | null; fingerprint: string | null; ca: boolean; trusted: boolean; expired: boolean;
}
export interface VpnServerView { proto: TunnelProto; enabled: boolean; defaultProfile: string | null; certificate: string | null; supported: boolean }
export interface VpnView {
  manageable: boolean; clients: TunnelClientView[]; supported: Record<TunnelProto, boolean>;
  servers: VpnServerView[]; secrets: PppSecretView[]; certs: CertView[];
  mgmt: { mgmtIp: string; mgmtInterface: string | null; mgmtPort: number; mgmtScheme: string };
}

// --- Interface / address config (P19) ---
export interface AddrEntry {
  id: string; address: string | null; network: string | null; interface: string | null;
  dynamic: boolean; disabled: boolean; comment: string | null; managed: boolean; isMgmt: boolean;
}
export interface IfaceEntry {
  id: string; name: string; type: string | null; disabled: boolean; running: boolean;
  mtu: string | null; comment: string | null; isMgmtInterface: boolean; addresses: AddrEntry[];
}
export interface AddrView {
  manageable: boolean; interfaces: IfaceEntry[];
  mgmtHost: string; mgmtNet: string; mgmtAddress: string | null; mgmtInterface: string | null;
}
export interface MgmtIpResult {
  result: 'applied' | 'failed' | 'rejected'; detail: string; auditId: number; newHost?: string; sequence: string[];
}

// --- L2: bridges + VLANs (P20) ---
export interface L2PortView { id: string; interface: string | null; pvid: string | null; isMgmtPort: boolean }
export interface L2BridgeView { id: string; name: string; vlanFiltering: boolean; pvid: string | null; disabled: boolean; comment: string | null; managed: boolean; isMgmt: boolean; ports: L2PortView[] }
export interface L2VlanView { id: string; name: string; vlanId: string | null; interface: string | null; disabled: boolean; comment: string | null; managed: boolean; isMgmt: boolean }
export interface L2BridgeVlan { id: string; bridge: string | null; vlanIds: string | null; tagged: string | null; untagged: string | null }
export interface L2PathView { mgmtIp: string; mgmtInterface: string | null; mgmtInterfaceType: string; mgmtBridge: string | null; mgmtVlan: string | null; mgmtVlanId: string | null; mgmtPorts: string[]; mgmtNet: string }
export interface L2View { manageable: boolean; bridges: L2BridgeView[]; vlans: L2VlanView[]; bridgeVlans: L2BridgeVlan[]; path: L2PathView }
export interface L2MoveResult { result: 'applied' | 'failed' | 'rejected'; detail: string; auditId: number; newHost?: string; sequence: string[] }

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

// --- native PPPoE client (P24) ---
export interface PppoeClient {
  id: string; name: string; interface: string | null; user: string | null; hasPassword: boolean;
  serviceName: string | null; acName: string | null;
  addDefaultRoute: boolean; defaultRouteDistance: string | null; usePeerDns: boolean; allow: string | null;
  disabled: boolean; dynamic: boolean; invalid: boolean; comment: string | null; managed: boolean;
  running: boolean; status: string; uptime: string | null; localAddress: string | null; remoteAddress: string | null; actualMtu: string | null; lastError: string | null;
  isMgmtPath: boolean;
}
export interface PppoeMgmtInfo { mgmtIp: string; mgmtInterface: string | null; mgmtPorts: string[]; mgmtPort: number; mgmtScheme: string }
export interface PppoeView { manageable: boolean; clients: PppoeClient[]; mgmt: PppoeMgmtInfo }

// --- native QoS simple queues (P23) ---
export interface SimpleQueue {
  id: string; order: number; name: string; target: string | null;
  maxLimit: string | null; limitAt: string | null; burstLimit: string | null; burstThreshold: string | null; burstTime: string | null;
  priority: string | null; parent: string | null; queueType: string | null; timeSchedule: string | null;
  disabled: boolean; dynamic: boolean; invalid: boolean; comment: string | null; managed: boolean;
  rate: string | null; bytes: string | null; packets: string | null; totalBytes: string | null;
}
export interface QosMgmtInfo { mgmtIp: string; mgmtInterface: string | null; mgmtPort: number; mgmtScheme: string }
export interface QosView { manageable: boolean; queues: SimpleQueue[]; mgmt: QosMgmtInfo }

// --- native NAT rules (P22) ---
export interface NatRule {
  id: string; order: number; chain: string; action: string;
  inInterface: string | null; outInterface: string | null; inInterfaceList: string | null; outInterfaceList: string | null;
  srcAddress: string | null; dstAddress: string | null; srcAddressList: string | null; dstAddressList: string | null;
  protocol: string | null; srcPort: string | null; dstPort: string | null; toAddresses: string | null; toPorts: string | null;
  comment: string | null; disabled: boolean; dynamic: boolean; invalid: boolean;
  bytes: number | null; packets: number | null; managed: boolean;
}
export interface NatMgmtInfo { mgmtIp: string; mgmtInterface: string | null; mgmtPorts: string[]; mgmtPort: number; mgmtScheme: string }
export interface NatView { manageable: boolean; rules: NatRule[]; mgmt: NatMgmtInfo }
export interface NatMoveResult { result: 'applied' | 'rolled_back' | 'rollback_failed' | 'failed'; auditId: number; detail: string }

// --- automatic config snapshots (P21) — capture + view + diff (no restore) ---
export type SnapshotTrigger = 'pre_write' | 'post_write' | 'manual' | 'scheduled';
export interface SnapshotMeta {
  id: number; routerId: number | null; routerName: string; capturedAt: string;
  trigger: SnapshotTrigger; operation: string | null; opGroup: string | null; outcome: string | null;
  format: 'export' | 'snapshot'; identity: string | null; model: string | null; serial: string | null; version: string | null;
  sizeBytes: number; sha256: string; isDuplicate: boolean;
}
export interface SnapshotFailure { id: number; trigger: string; operation: string | null; reason: string; createdAt: string }
export interface SnapshotsView { snapshots: SnapshotMeta[]; lastFailure: SnapshotFailure | null }
export interface SnapshotDiff { a: SnapshotMeta; b: SnapshotMeta; diff: { added: number; removed: number; lines: Array<{ t: ' ' | '+' | '-'; s: string }> } }
export interface SnapshotContent { meta: SnapshotMeta; content: string }

export interface RestoreOutcome {
  result: 'applied' | 'rolled_back' | 'rollback_failed' | 'failed';
  auditId: number;
  detail: string;
}

// --- Remote access / WireGuard (P9) ---

export interface HubLivePeer {
  publicKey: string;
  endpoint: string | null;
  latestHandshakeUnix: number;
  rxBytes: number;
  txBytes: number;
  state: 'never' | 'recent' | 'stale';
}

export interface HubStatus {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  endpoint: string | null;
  listenPort: number;
  overlayCidr: string;
  hubAddress: string;
  publicKey: string | null;
  runtimeError: string | null;
  peers: HubLivePeer[];
}

export interface PeerView {
  id: number;
  label: string;
  tunnelIp: string;
  hasKey: boolean;
  status: string;
  deviceId: number | null;
  deviceName: string | null;
  lastHandshakeAt: string | null;
  createdAt: string;
}

export interface RemoteAccessView {
  hub: HubStatus;
  peers: PeerView[];
  live: Record<number, { state: 'never' | 'recent' | 'stale'; latestHandshakeUnix: number; rxBytes: number; txBytes: number } | null>;
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
  // Server-defined: the safe-apply outcomes plus non-write events like 'ok'
  // (webfig.open). Keep this a string so a new value never crashes the Audit page.
  result: string;
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

export type HealthStatus = 'up' | 'warning' | 'down' | 'pending' | 'rebooting';

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
    status: string | null; manageable: boolean; lastSeenAt: string | null; lastError: string | null;
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

export interface TopoSite {
  id: number; name: string; latitude: number | null; longitude: number | null;
  status: HealthStatus; counts: { total: number; up: number; warning: number; down: number; pending: number };
}
export interface TopologyPayload {
  generatedAt: string;
  sites: TopoSite[];
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
  webhook: { enabled: boolean; url: string };
  smtp: { enabled: boolean; host: string; port: number; secure: string; user: string; from: string; to: string; passSet: boolean };
  telegram: { enabled: boolean; chatId: string; tokenSet: boolean };
  whatsapp: { enabled: boolean; provider: string; to: string; wabaBaseUrl: string; wabaPhoneId: string; configSet: boolean };
}

export interface NotificationLogEntry {
  id: number; ts: string; channel: string; event: string; target: string | null; status: string; detail: string | null;
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
