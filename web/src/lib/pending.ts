// Pending-setup items (v1.1.8): provisioned routers not yet fully set up. This is
// the SHARED source both feeds (Dashboard card + Devices section) read via
// <PendingSetup/> and GET /api/remote-access/pending — one implementation, not two.
// A pending item is never a fleet device, so it's never in up/down/warning counts.

export interface PendingItem {
  id: number;
  label: string;
  tunnelIp: string;
  hasKey: boolean;
  kind: 'awaiting-key' | 'awaiting-adoption';
}

/** Pure copy for a pending row — the chip + the one-line "what's left" hint. */
export function pendingCopy(item: PendingItem): { chip: string; sub: string } {
  return item.kind === 'awaiting-key'
    ? { chip: 'awaiting key', sub: `Overlay ${item.tunnelIp} reserved — paste the router's key to finish` }
    : { chip: 'awaiting adoption', sub: `Key registered at ${item.tunnelIp} — adopt it as a managed device` };
}
