import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth } from '../auth.js';
import { allSites, siteScope, scopeFilter, type AccessScope } from '../scope.js';
import { buildTopology, rollupSites, type TopoDeviceInput, type TopoNeighborInput, type TopoDiscoveryInput } from '../topology.js';

/**
 * Topology endpoint. Reads ONLY tables the poller maintains (devices,
 * device_status, device_neighbors, device_discovery) — it never talks to a
 * device, so the map adds zero polling load and no second poll loop.
 *
 * Scope: the base scope is the requester's (single admin → allSites), and
 * the optional ?siteId filter narrows it via the same siteScope/scopeFilter
 * seam used everywhere else.
 */
export function topologyRoutes(db: DatabaseSync): Router {
  const router = Router();
  router.use(requireAuth(db));

  router.get('/', (req, res) => {
    // P1: single admin → unrestricted base scope; per-user tenancy later
    // swaps this line only.
    let scope: AccessScope = allSites();
    const siteParam = req.query.siteId;
    if (typeof siteParam === 'string' && siteParam !== '' && siteParam !== 'all') {
      const siteId = Number(siteParam);
      if (!Number.isInteger(siteId)) {
        res.status(400).json({ error: 'Invalid siteId.' });
        return;
      }
      scope = siteScope([siteId]);
    }
    const filter = scopeFilter(scope, 'd.site_id');

    const deviceRows = db.prepare(`
      SELECT d.id, d.name, d.host, d.site_id, s.name AS site_name,
             st.state, st.last_error, st.cpu_load, st.mem_total, st.mem_free,
             st.identity, st.model, st.board_name, st.version, st.if_macs
      FROM devices d
      LEFT JOIN sites s ON s.id = d.site_id
      LEFT JOIN device_status st ON st.device_id = d.id
      WHERE 1 = 1${filter.sql}
      ORDER BY d.name
    `).all(...filter.params) as unknown as Array<Record<string, unknown>>;

    const devices: TopoDeviceInput[] = deviceRows.map((r) => ({
      id: r.id as number,
      name: r.name as string,
      host: r.host as string,
      siteId: (r.site_id as number | null) ?? null,
      siteName: (r.site_name as string | null) ?? null,
      status: r.state === null && r.version === null && r.if_macs === null ? {
        state: null, last_error: null, cpu_load: null, mem_total: null, mem_free: null,
        identity: null, model: null, board_name: null, version: null, if_macs: null,
      } : {
        state: r.state as string | null,
        last_error: r.last_error as string | null,
        cpu_load: r.cpu_load as number | null,
        mem_total: r.mem_total as number | null,
        mem_free: r.mem_free as number | null,
        identity: r.identity as string | null,
        model: r.model as string | null,
        board_name: r.board_name as string | null,
        version: r.version as string | null,
        if_macs: r.if_macs ? JSON.parse(r.if_macs as string) as string[] : null,
      },
    }));

    const neighborRows = db.prepare(`
      SELECT n.device_id, n.seen_on, n.mac, n.identity, n.platform, n.board,
             n.version, n.address, n.remote_interface, n.discovered_by
      FROM device_neighbors n JOIN devices d ON d.id = n.device_id
      WHERE 1 = 1${filter.sql}
    `).all(...filter.params) as unknown as Array<Record<string, unknown>>;

    const neighbors: TopoNeighborInput[] = neighborRows.map((r) => ({
      deviceId: r.device_id as number,
      seenOn: r.seen_on as string | null,
      mac: r.mac as string | null,
      identity: r.identity as string | null,
      platform: r.platform as string | null,
      board: r.board as string | null,
      version: r.version as string | null,
      address: r.address as string | null,
      remoteInterface: r.remote_interface as string | null,
      discoveredBy: r.discovered_by as string | null,
    }));

    const discoveryRows = db.prepare(`
      SELECT dd.device_id, dd.protocol, dd.interface_list
      FROM device_discovery dd JOIN devices d ON d.id = dd.device_id
      WHERE 1 = 1${filter.sql}
    `).all(...filter.params) as unknown as Array<Record<string, unknown>>;

    const discovery: TopoDiscoveryInput[] = discoveryRows.map((r) => ({
      deviceId: r.device_id as number,
      protocol: r.protocol as string | null,
      interfaceList: r.interface_list as string | null,
    }));

    const topo = buildTopology(devices, neighbors, discovery);
    const siteRows = db.prepare('SELECT id, name, latitude, longitude FROM sites ORDER BY name')
      .all() as unknown as Array<{ id: number; name: string; latitude: number | null; longitude: number | null }>;
    const sites = rollupSites(topo.nodes, siteRows);   // P33: worst-status + counts per site

    res.json({
      generatedAt: new Date().toISOString(),
      sites,
      ...topo,
    });
  });

  return router;
}
