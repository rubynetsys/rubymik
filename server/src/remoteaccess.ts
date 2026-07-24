import type { DatabaseSync } from 'node:sqlite';
import type { WireguardHub } from './wireguard.js';

/**
 * Remote-site provisioning (P9): allocate an overlay IP, register a peer, and
 * generate the one-time RouterOS bootstrap script the operator applies on the
 * router. The router generates its OWN private key, so the bootstrap carries no
 * secret — only the hub's PUBLIC key + endpoint + the assigned overlay IP.
 */

export interface HubConfig {
  endpoint: string;
  listenPort: number;
  overlayCidr: string;
  hubAddress: string;
  publicKey: string;
}

export interface PeerRow {
  id: number;
  device_id: number | null;
  label: string;
  tunnel_ip: string;
  public_key: string | null;
  status: string;
  last_handshake_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Allocate the next free overlay host IP (skips the hub's own address). */
export function allocateTunnelIp(db: DatabaseSync, overlayCidr: string, hubAddress: string): string {
  const [base] = overlayCidr.split('/');
  const octets = base!.split('.');
  const prefix = `${octets[0]}.${octets[1]}.${octets[2]}.`;
  const used = new Set<number>();
  const hubHost = Number(hubAddress.split('.')[3]);
  if (Number.isInteger(hubHost)) used.add(hubHost);
  for (const r of db.prepare('SELECT tunnel_ip FROM wg_peers').all() as Array<{ tunnel_ip: string }>) {
    if (r.tunnel_ip.startsWith(prefix)) used.add(Number(r.tunnel_ip.split('.')[3]));
  }
  for (let host = 2; host <= 254; host++) {
    if (!used.has(host)) return `${prefix}${host}`;
  }
  throw new Error('Overlay subnet is full — no free tunnel IP.');
}

/** Create a pending peer (no router public key yet). */
export function createPeer(db: DatabaseSync, label: string, tunnelIp: string): PeerRow {
  const now = new Date().toISOString();
  const id = db.prepare(
    'INSERT INTO wg_peers (label, tunnel_ip, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(label, tunnelIp, 'pending', now, now).lastInsertRowid as number;
  return db.prepare('SELECT * FROM wg_peers WHERE id = ?').get(id) as unknown as PeerRow;
}

/**
 * Reserve a hub peer for a site (v1.1.8 root-cause fix). Re-running the provision
 * wizard for the SAME site name must NOT orphan a second overlay IP — so reuse an
 * existing unregistered, unadopted reservation with that label; only allocate a
 * fresh IP + create a peer when there isn't one. Two generates → one peer.
 */
export function reservePeer(db: DatabaseSync, hub: HubConfig, label: string): PeerRow {
  const existing = db.prepare(
    'SELECT * FROM wg_peers WHERE label = ? AND public_key IS NULL AND device_id IS NULL ORDER BY id LIMIT 1',
  ).get(label) as unknown as PeerRow | undefined;
  if (existing) return existing;
  const tunnelIp = allocateTunnelIp(db, hub.overlayCidr, hub.hubAddress);
  return createPeer(db, label, tunnelIp);
}

// ---- pending-setup selector + delete-guard (shared source for both feeds) ----

export interface PendingItem {
  id: number;
  label: string;
  tunnelIp: string;
  hasKey: boolean;
  /** awaiting-key = no router key yet; awaiting-adoption = key registered, not yet a device. */
  kind: 'awaiting-key' | 'awaiting-adoption';
}

/** Pure: the ONE source both the Dashboard and Devices pending feeds read. A
 *  pending item is a provisioned peer that is not yet a managed device
 *  (device_id null) — so it is NEVER a fleet device and never counted up/down. */
export function selectPending(
  peers: Array<{ id: number; label: string; tunnel_ip: string; public_key: string | null; device_id: number | null }>,
): PendingItem[] {
  return peers
    .filter((p) => p.device_id == null)
    .map((p) => ({
      id: p.id,
      label: p.label,
      tunnelIp: p.tunnel_ip,
      hasKey: !!p.public_key,
      kind: p.public_key ? 'awaiting-adoption' as const : 'awaiting-key' as const,
    }));
}

/** Pure: deleting a site is "dangerous" (needs a typed-name confirm) when it's a
 *  registered peer that is actually a live management path — a recent handshake OR
 *  an adopted device. An unregistered/awaiting-key reservation deletes freely. */
export function isDeleteDangerous(
  peer: { public_key: string | null; device_id: number | null },
  liveHandshake: boolean,
): boolean {
  return !!peer.public_key && (liveHandshake || peer.device_id != null);
}

/** A basic sanity check on a router-supplied WireGuard public key (base64, 44 chars). */
export function isValidWgKey(key: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(key.trim());
}

/**
 * The one-time RouterOS bootstrap. Contains NO secret: the router generates its
 * own private key on `/interface/wireguard/add`; we only embed the hub's public
 * key + endpoint. The final line prints the router's public key to register
 * back into RubyMIK.
 */
export function generateBootstrap(hub: HubConfig, peer: PeerRow): string {
  const prefix = hub.overlayCidr.split('/')[1] ?? '24';
  return `# ============================================================================
# RubyMIK remote-access bootstrap — "${peer.label}"
# Apply ONCE on this router (WinBox → New Terminal, or paste over SSH).
# The router generates its OWN private key; nothing in this script is secret.
# After it runs, copy the printed public key back into RubyMIK to finish.
# ============================================================================

/interface/wireguard/add name=rmik-wg comment="RubyMIK remote-access tunnel"

/ip/address/add address=${peer.tunnel_ip}/${prefix} interface=rmik-wg comment="RubyMIK overlay"

/interface/wireguard/peers/add \\
    interface=rmik-wg \\
    public-key="${hub.publicKey}" \\
    endpoint-address=${hub.endpoint} \\
    endpoint-port=${hub.listenPort} \\
    allowed-address=${hub.overlayCidr} \\
    persistent-keepalive=25s \\
    comment="RubyMIK hub"

# Minimal reachability: accept RubyMIK's management arriving over the tunnel.
# (This is intentionally permissive — full firewall hardening is a separate step.)
/ip/firewall/filter/add chain=input in-interface=rmik-wg action=accept \\
    comment="RUBYMIK: allow management over tunnel"

:put ("RUBYMIK_PUBKEY=" . [/interface/wireguard get [find name=rmik-wg] public-key])
`;
}
