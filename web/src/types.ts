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
