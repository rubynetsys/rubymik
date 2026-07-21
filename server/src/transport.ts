import type { SecretBox } from './secretbox.js';
import type { DeviceTarget } from './routeros/types.js';
import type { WriteTransport } from './routeros/write.js';
import { restConnect, type Scheme } from './routeros/rest.js';

/**
 * ============================================================================
 *  THE TRANSPORT ABSTRACTION (P9)
 *
 *  A device is reached over one of two transports:
 *    - DIRECT  — its LAN address (`host`). This is the default and the ONLY
 *                thing the zero-config same-LAN experience ever uses.
 *    - TUNNEL  — a WireGuard overlay IP (`tunnel_ip`), for a router that lives
 *                behind NAT and dials OUTBOUND into RubyMIK's hub.
 *
 *  Everything that talks to a device — the monitoring GET client and the write
 *  module alike — builds its DeviceTarget HERE, so no feature knows or cares
 *  which path a device uses. Adding TUNNEL support was one central change, not
 *  a fork in every feature. `net_transport` defaults to 'direct', so a device
 *  that never opts into WireGuard behaves exactly as it did before P9.
 * ============================================================================
 */

export type NetTransport = 'direct' | 'tunnel';

/** The device-row columns the transport layer reads. Routes/pollers `SELECT *`
 *  (or add these to their column list) and pass the row straight through. */
export interface AddressableRow {
  host: string;
  port: number | null;
  use_tls: number | null;
  verify_tls: number;
  username_enc: string;
  password_enc: string;
  write_username_enc?: string | null;
  write_password_enc?: string | null;
  net_transport?: string | null;
  tunnel_ip?: string | null;
}

/** Resolve the effective address a device is reached at, honoring its transport. */
export function resolveEndpoint(row: AddressableRow): { host: string; net: NetTransport } {
  if (row.net_transport === 'tunnel' && row.tunnel_ip) {
    return { host: row.tunnel_ip, net: 'tunnel' };
  }
  return { host: row.host, net: 'direct' };
}

function base(row: AddressableRow, timeoutMs?: number): Omit<DeviceTarget, 'username' | 'password'> {
  return {
    host: resolveEndpoint(row).host,
    port: row.port ?? undefined,
    useTls: row.use_tls === null ? undefined : row.use_tls === 1,
    verifyTls: row.verify_tls === 1,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** DeviceTarget using the READ (monitoring) credential, address resolved by transport. */
export function readTarget(box: SecretBox, row: AddressableRow, timeoutMs?: number): DeviceTarget {
  return { ...base(row, timeoutMs), username: box.decrypt(row.username_enc), password: box.decrypt(row.password_enc) };
}

/** DeviceTarget using the WRITE credential. Caller must have confirmed the
 *  device is manageable (write creds present) — never a silent escalation. */
export function writeTarget(box: SecretBox, row: AddressableRow, timeoutMs?: number): DeviceTarget {
  if (!row.write_username_enc || !row.write_password_enc) {
    throw new Error('writeTarget called on a monitor-only device (no write credential)');
  }
  return { ...base(row, timeoutMs), username: box.decrypt(row.write_username_enc), password: box.decrypt(row.write_password_enc) };
}

/**
 * Resolve {scheme, port} for a device. When use_tls is known, it's deterministic;
 * when unknown (never polled), probe once. Works identically for direct and
 * tunnel devices — the target's host has already been resolved by transport.
 */
export async function transportFor(row: AddressableRow, target: DeviceTarget): Promise<WriteTransport> {
  if (row.use_tls !== null) {
    return { scheme: row.use_tls === 1 ? 'https' : 'http', port: row.port ?? (row.use_tls === 1 ? 443 : 80) };
  }
  const probed = await restConnect(target);
  return { scheme: probed.scheme as Scheme, port: probed.port };
}
