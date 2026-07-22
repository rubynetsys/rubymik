import { computeHealth, type Health } from './health.js';
import { vendorFromMac } from './oui.js';

/**
 * Pure topology builder — no I/O, unit-testable.
 *
 * Link-inference approach (documented honestly in the README):
 * - An edge is a DIRECT neighbor sighting: managed device A reports neighbor
 *   N on local interface X (MNDP/LLDP/CDP via /ip/neighbor).
 * - Neighbors are matched to managed devices by interface MAC, then by
 *   address == managed host. Identity is NOT used for matching (too many
 *   routers are literally named "MikroTik").
 * - Bidirectional sightings (A sees B, B sees A) collapse into ONE edge,
 *   keyed on the unordered node pair; each side's local interface is kept.
 * - No transitive/guessed links: if RubyMIK didn't see it in a neighbor
 *   table, it isn't drawn. Fewer, higher-confidence links beat a hairball.
 */

export interface TopoDeviceInput {
  id: number;
  name: string;
  host: string;
  siteId: number | null;
  siteName: string | null;
  status: {
    state: string | null;
    last_error: string | null;
    cpu_load: number | null;
    mem_total: number | null;
    mem_free: number | null;
    identity: string | null;
    model: string | null;
    board_name: string | null;
    version: string | null;
    if_macs: string[] | null;
  } | null;
}

export interface TopoNeighborInput {
  deviceId: number;
  seenOn: string | null;
  mac: string | null;
  identity: string | null;
  platform: string | null;
  board: string | null;
  version: string | null;
  address: string | null;
  remoteInterface: string | null;
  discoveredBy: string | null;
}

export interface TopoDiscoveryInput {
  deviceId: number;
  protocol: string | null;
  interfaceList: string | null;
}

export interface TopoNode {
  key: string;
  kind: 'managed' | 'discovered';
  name: string;
  deviceId?: number;
  siteId?: number | null;
  siteName?: string | null;
  status?: Health;
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
  /** Local interface per node key (whichever ends reported the sighting). */
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

export function buildTopology(
  devices: TopoDeviceInput[],
  neighbors: TopoNeighborInput[],
  discovery: TopoDiscoveryInput[],
): { nodes: TopoNode[]; edges: TopoEdge[]; notes: DiscoveryNote[] } {
  const deviceKey = (id: number) => `device:${id}`;

  // Matching indexes
  const macToDevice = new Map<string, number>();
  const hostToDevice = new Map<string, number>();
  const nodes = new Map<string, TopoNode>();

  for (const d of devices) {
    for (const mac of d.status?.if_macs ?? []) macToDevice.set(mac.toLowerCase(), d.id);
    hostToDevice.set(d.host, d.id);
    const health = computeHealth(d.status ?? {
      state: null, last_error: null, cpu_load: null, mem_total: null, mem_free: null,
    });
    nodes.set(deviceKey(d.id), {
      key: deviceKey(d.id),
      kind: 'managed',
      name: d.name,
      deviceId: d.id,
      siteId: d.siteId,
      siteName: d.siteName,
      status: health.status,
      model: d.status?.model ?? d.status?.board_name ?? null,
      version: d.status?.version ?? null,
      identity: d.status?.identity ?? null,
      address: d.host,
    });
  }

  const managedIds = new Set(devices.map((d) => d.id));
  const deviceName = new Map(devices.map((d) => [d.id, d.name]));
  const edges = new Map<string, TopoEdge>();

  for (const n of neighbors) {
    if (!managedIds.has(n.deviceId)) continue;
    const sourceKey = deviceKey(n.deviceId);

    // Resolve the neighbor to a managed device (MAC first, then address)…
    const matchedId =
      (n.mac ? macToDevice.get(n.mac.toLowerCase()) : undefined) ??
      (n.address ? hostToDevice.get(n.address) : undefined);

    let targetKey: string;
    if (matchedId !== undefined) {
      if (matchedId === n.deviceId) continue; // self-sighting — never draw
      targetKey = deviceKey(matchedId);
    } else {
      // …else it's a discovered (unmanaged) node, keyed stably by MAC when
      // known, otherwise identity+address.
      targetKey = n.mac
        ? `mac:${n.mac.toLowerCase()}`
        : `id:${n.identity ?? '?'}@${n.address ?? '?'}`;
      const existing = nodes.get(targetKey);
      const vendor = n.platform ?? vendorFromMac(n.mac);
      if (!existing) {
        nodes.set(targetKey, {
          key: targetKey,
          kind: 'discovered',
          name: n.identity ?? vendor ?? n.mac ?? n.address ?? 'Unknown device',
          identity: n.identity,
          platform: n.platform,
          board: n.board,
          version: n.version,
          mac: n.mac,
          address: n.address,
          vendor,
          discoveredBy: n.discoveredBy,
          seenBy: [{ deviceId: n.deviceId, deviceName: deviceName.get(n.deviceId) ?? '?', iface: n.seenOn }],
        });
      } else {
        existing.seenBy!.push({ deviceId: n.deviceId, deviceName: deviceName.get(n.deviceId) ?? '?', iface: n.seenOn });
        existing.identity ??= n.identity;
        existing.board ??= n.board;
        existing.address ??= n.address;
      }
    }

    // ONE edge per unordered node pair — a bidirectional sighting lands on
    // the same key and only contributes its side's local interface.
    const a = sourceKey < targetKey ? sourceKey : targetKey;
    const b = sourceKey < targetKey ? targetKey : sourceKey;
    const edgeKey = `${a}~${b}`;
    const edge = edges.get(edgeKey);
    if (edge) {
      if (edge.ifaces[sourceKey] === undefined || edge.ifaces[sourceKey] === null) {
        edge.ifaces[sourceKey] = n.seenOn;
      }
      // Sighting from the far side also tells us the remote port of this one.
      if (edge.ifaces[targetKey] == null && n.remoteInterface) {
        edge.ifaces[targetKey] = n.remoteInterface;
      }
    } else {
      edges.set(edgeKey, {
        source: a,
        target: b,
        ifaces: { [sourceKey]: n.seenOn, [targetKey]: n.remoteInterface ?? null },
        discoveredBy: n.discoveredBy,
      });
    }
  }

  // Discovery-settings honesty notes
  const neighborCount = new Map<number, number>();
  for (const n of neighbors) neighborCount.set(n.deviceId, (neighborCount.get(n.deviceId) ?? 0) + 1);
  const discoveryByDevice = new Map(discovery.map((d) => [d.deviceId, d]));
  const notes: DiscoveryNote[] = devices.map((d) => {
    const ds = discoveryByDevice.get(d.id);
    const count = neighborCount.get(d.id) ?? 0;
    if (!ds) {
      return {
        deviceId: d.id, deviceName: d.name, protocol: null, interfaceList: null, neighborCount: count,
        level: 'unknown',
        message: `Discovery settings for "${d.name}" have not been read yet.`,
      };
    }
    const protocols = (ds.protocol ?? '').split(',').filter(Boolean);
    if (protocols.length === 0 || ds.interfaceList === 'none' || !ds.interfaceList) {
      return {
        deviceId: d.id, deviceName: d.name, protocol: ds.protocol, interfaceList: ds.interfaceList, neighborCount: count,
        level: 'disabled',
        message: `Neighbor discovery is disabled on "${d.name}" — enable MNDP/LLDP in RouterOS (IP → Neighbors → Discovery Settings) to see its links. RubyMIK will not change this for you (read-only).`,
      };
    }
    if (ds.interfaceList !== 'all' && ds.interfaceList !== 'dynamic') {
      return {
        deviceId: d.id, deviceName: d.name, protocol: ds.protocol, interfaceList: ds.interfaceList, neighborCount: count,
        level: 'restricted',
        message: `Neighbor discovery on "${d.name}" is limited to interface list "${ds.interfaceList}" — neighbors on other interfaces will not appear. Widen the list in RouterOS (IP → Neighbors → Discovery Settings) if you want more of the map.`,
      };
    }
    return {
      deviceId: d.id, deviceName: d.name, protocol: ds.protocol, interfaceList: ds.interfaceList, neighborCount: count,
      level: 'ok',
      message: `Discovery active (${ds.protocol}) on interface list "${ds.interfaceList}".`,
    };
  });

  return { nodes: [...nodes.values()], edges: [...edges.values()], notes };
}

// ---------------- per-site geographic rollup (P33 map view) ----------------

export interface SiteGeo { id: number; name: string; latitude: number | null; longitude: number | null }
export interface TopoSiteRollup extends SiteGeo {
  status: Health | 'pending';
  counts: { total: number; up: number; warning: number; down: number; pending: number };
}
const SITE_STATUS_RANK: Record<string, number> = { down: 4, rebooting: 3, warning: 2, up: 1, pending: 0 };

/** Fold the managed nodes into one worst-status + counts per site, keyed by siteId,
 *  and stitch the geographic columns back on. Pure — unit-tested. Discovered
 *  (unmanaged) nodes never influence a site's health. */
export function rollupSites(nodes: TopoNode[], siteRows: SiteGeo[]): TopoSiteRollup[] {
  const roll = new Map<number, { total: number; up: number; warning: number; down: number; pending: number; worst: string }>();
  for (const n of nodes) {
    if (n.kind !== 'managed' || n.siteId == null || !n.status) continue;
    const r = roll.get(n.siteId) ?? { total: 0, up: 0, warning: 0, down: 0, pending: 0, worst: 'pending' };
    r.total++;
    if (n.status === 'up') r.up++; else if (n.status === 'warning') r.warning++; else if (n.status === 'down') r.down++; else r.pending++;
    if ((SITE_STATUS_RANK[n.status] ?? 0) > (SITE_STATUS_RANK[r.worst] ?? 0)) r.worst = n.status;
    roll.set(n.siteId, r);
  }
  return siteRows.map((s) => {
    const r = roll.get(s.id);
    return { ...s, status: (r?.worst ?? 'pending') as Health | 'pending', counts: { total: r?.total ?? 0, up: r?.up ?? 0, warning: r?.warning ?? 0, down: r?.down ?? 0, pending: r?.pending ?? 0 } };
  });
}
