export interface AppStatus {
  needsSetup: boolean;
  authenticated: boolean;
}

export interface Device {
  id: number;
  name: string;
  host: string;
  port: number | null;
  transport: string;
  useTls: boolean | null;
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

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(Math.floor(Math.log2(n) / 10), units.length - 1);
  return `${(n / 2 ** (10 * i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
