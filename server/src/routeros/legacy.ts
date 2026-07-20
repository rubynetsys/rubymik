import type { ConnectResult, DeviceTarget } from './types.js';

/**
 * Legacy RouterOS binary API (TCP 8728 / 8729-TLS) — the fallback path for
 * RouterOS 6.x devices that have no REST API.
 *
 * P0 stub: the transport is registered so devices can select it, but the wire
 * protocol (length-prefixed words, /login) is not implemented yet. REST
 * (RouterOS 7.1+) is the primary and only working transport today.
 */
export const LEGACY_DEFAULT_PORT = 8728;

export async function legacyConnect(_target: DeviceTarget): Promise<ConnectResult> {
  throw new Error(
    'The legacy RouterOS API (port 8728) is not supported yet — it is planned for a future release. ' +
    'RouterOS 7.1+ devices can use the REST API (enable the www or www-ssl service).'
  );
}
