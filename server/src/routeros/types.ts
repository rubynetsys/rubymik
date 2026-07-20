/** Connection details for a RouterOS device (decrypted, in-memory only). */
export interface DeviceTarget {
  host: string;
  /** Explicit port. Defaults to 443 (https) / 80 (http). */
  port?: number;
  /**
   * true → HTTPS only, false → HTTP only,
   * undefined → auto-probe: try HTTPS first, fall back to HTTP.
   */
  useTls?: boolean;
  /** Verify the device's TLS certificate. Default false — RouterOS ships self-signed. */
  verifyTls?: boolean;
  username: string;
  password: string;
  timeoutMs?: number;
}

/** Normalized system snapshot pulled from /system/resource, /system/identity, /system/routerboard. */
export interface RouterSystemInfo {
  identity: string | null;
  /** Hardware model, e.g. "RB4011iGS+" (routerboard) — null on CHR/x86. */
  model: string | null;
  /** Board name from /system/resource, e.g. "hAP ac^2". */
  boardName: string | null;
  serialNumber: string | null;
  firmware: string | null;
  /** RouterOS version, e.g. "7.16.1 (stable)". */
  version: string;
  architecture: string | null;
  uptime: string;
  cpuCount: number | null;
  /** CPU load percentage 0–100. */
  cpuLoad: number;
  totalMemory: number;
  freeMemory: number;
  totalHdd: number | null;
  freeHdd: number | null;
}

export interface ConnectResult {
  transport: 'rest';
  scheme: 'https' | 'http';
  port: number;
  info: RouterSystemInfo;
}
