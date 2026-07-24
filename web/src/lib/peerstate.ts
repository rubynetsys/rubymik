// Remote-site (WireGuard peer) state + hub-side diagnostics (v1.1.7). Pure, so
// the "no handshake yet" reasoning is unit-tested. A provisioned-but-not-adopted
// router must never look like it vanished: it's an `awaiting-key` peer until its
// public key is registered, and a `no-handshake` peer once registered but not yet
// connected — each with the concrete cause.

export type PeerState = 'awaiting-key' | 'connected' | 'stale' | 'no-handshake';

/** hasKey = the router's public key has been registered on the hub.
 *  liveState = the hub-side handshake state (undefined when the peer isn't on the
 *  live interface, e.g. not registered yet). */
export function peerState(hasKey: boolean, liveState: string | undefined): PeerState {
  if (!hasKey) return 'awaiting-key';
  if (liveState === 'recent') return 'connected';
  if (liveState === 'stale') return 'stale';
  return 'no-handshake'; // registered, but the hub has never seen a handshake
}

export const PEER_STATE_LABEL: Record<PeerState, string> = {
  'awaiting-key': 'awaiting key',
  connected: 'connected',
  stale: 'stale',
  'no-handshake': 'no handshake',
};

/** The actionable hint for a peer that isn't connected — the TWO real causes
 *  Ray hit: (1) the key was never registered, or (2) the host firewall / published
 *  UDP port doesn't match the hub port. Returns null when connected (no hint). */
export function peerHint(state: PeerState, hubListenPort: number): string | null {
  switch (state) {
    case 'awaiting-key':
      return `Awaiting the router's public key. Paste the RUBYMIK_PUBKEY the script printed (here or via Bootstrap) to register it — until then the router's handshakes are silently dropped as an unknown peer (Tx climbs, Rx stays 0).`;
    case 'no-handshake':
      return `Key registered, but no handshake yet. The two usual causes: the router hasn't applied the script yet, or the host firewall / published UDP port doesn't match the hub port (UDP ${hubListenPort}) — remote routers must be able to reach it inbound.`;
    case 'stale':
      return `Handshaked before, but not recently — the router may be offline or the path dropped.`;
    default:
      return null;
  }
}
