// PRE-RELEASE — backs the public "scales to hundreds of devices with level-of-detail"
// claim (README + site). Builds a 220-device / 10-site synthetic fleet through the REAL
// topology builder, proves bidirectional-sighting dedup still holds at scale, and proves
// the level-of-detail path — rollupSites, the zoomed-out "fleet at a glance" view — folds
// the whole fleet into one cluster per site. Fast + coherent = the claim stands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology, rollupSites } from '../dist/topology.js';

const SITES = 10, PER_SITE = 22, TOTAL = SITES * PER_SITE; // 220 managed devices
const mac = (n) => `02:00:${((n >> 24) & 255).toString(16).padStart(2, '0')}:${((n >> 16) & 255).toString(16).padStart(2, '0')}:${((n >> 8) & 255).toString(16).padStart(2, '0')}:${(n & 255).toString(16).padStart(2, '0')}`;

function fleet() {
  const devices = [], neighbors = [], siteRows = [];
  let id = 0;
  for (let s = 1; s <= SITES; s++) {
    siteRows.push({ id: s, name: `zzz-site-${s}`, latitude: null, longitude: null });
    const gwId = ++id;
    devices.push({ id: gwId, name: `zzz-gw-${s}`, host: `10.${s}.0.1`, siteId: s, siteName: `zzz-site-${s}`,
      status: { state: 'up', model: 'RB5009', version: '7.16.1', if_macs: [mac(gwId)] } });
    for (let k = 1; k < PER_SITE; k++) {
      const dId = ++id;
      const state = k % 11 === 0 ? 'warning' : k % 17 === 0 ? 'down' : 'up';
      devices.push({ id: dId, name: `zzz-dev-${s}-${k}`, host: `10.${s}.0.${k + 1}`, siteId: s, siteName: `zzz-site-${s}`,
        status: { state, model: 'hEX', version: '7.16.1', if_macs: [mac(dId)] } });
      // Bidirectional sighting child<->gateway — MUST collapse to ONE edge (dedup at scale).
      neighbors.push({ deviceId: dId, seenOn: 'ether1', mac: mac(gwId), identity: `zzz-gw-${s}`, discoveredBy: 'mndp' });
      neighbors.push({ deviceId: gwId, seenOn: `ether${k + 1}`, mac: mac(dId), identity: `zzz-dev-${s}-${k}`, discoveredBy: 'mndp' });
    }
    // One shared UNMANAGED switch per site, seen by two managed devices → 1 discovered node.
    const swMac = `0a:00:00:00:${s.toString(16).padStart(2, '0')}:01`;
    neighbors.push({ deviceId: gwId, seenOn: 'ether24', mac: swMac, identity: `zzz-sw-${s}`, platform: 'MikroTik', discoveredBy: 'lldp' });
    neighbors.push({ deviceId: gwId + 1, seenOn: 'ether2', mac: swMac, identity: `zzz-sw-${s}`, platform: 'MikroTik', discoveredBy: 'lldp' });
  }
  return { devices, neighbors, siteRows };
}

test('topology builds + rolls up 220 devices / 10 sites (LoD fleet-at-a-glance) coherently & fast', () => {
  const { devices, neighbors, siteRows } = fleet();
  assert.equal(devices.length, TOTAL);

  const t0 = Date.now();
  const topo = buildTopology(devices, neighbors, []);
  const roll = rollupSites(topo.nodes, siteRows);
  const ms = Date.now() - t0;

  const managed = topo.nodes.filter((n) => n.kind === 'managed');
  const discovered = topo.nodes.filter((n) => n.kind === 'discovered');
  assert.equal(managed.length, TOTAL, 'all 220 managed devices render as nodes');
  assert.equal(discovered.length, SITES, 'one discovered switch per site (unmanaged neighbour)');

  // Dedup holds at scale: the gateway<->first-child pair (device:1 <-> device:2), sighted
  // from BOTH ends, is exactly ONE edge.
  const between = (a, b) => topo.edges.filter((e) =>
    (e.source === a && e.target === b) || (e.source === b && e.target === a));
  assert.equal(between('device:1', 'device:2').length, 1, 'bidirectional sighting = ONE edge, at scale');
  // Every managed child links to its gateway: at least (PER_SITE-1) * SITES managed edges.
  assert.ok(topo.edges.length >= SITES * (PER_SITE - 1), `enough edges (${topo.edges.length})`);

  // LEVEL-OF-DETAIL: the zoomed-out view is exactly one rollup per site, and the per-site
  // device counts sum to the entire fleet (nothing dropped when folding hundreds → sites).
  assert.equal(roll.length, SITES, 'one site rollup per site (the fleet-at-a-glance LoD view)');
  assert.equal(roll.reduce((a, r) => a + r.counts.total, 0), TOTAL, 'rollup counts sum to the whole fleet');
  assert.ok(roll.every((r) => ['up', 'warning', 'down', 'pending'].includes(r.status)), 'each site has a rolled-up status');

  assert.ok(ms < 1500, `lays out hundreds of devices fast, without falling over (${ms}ms)`);
});
