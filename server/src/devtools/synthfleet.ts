import type { DatabaseSync } from 'node:sqlite';

/**
 * SYNTHETIC FLEET GENERATOR — TEST / DEMO ONLY. NOT wired into the app (index.ts
 * never imports this); it is reached only through the `gen-synth` CLI, which
 * refuses to touch a DB that already has real devices. It writes the same tables
 * the poller maintains (sites, devices, device_status, device_neighbors,
 * device_discovery) so the REAL topology endpoint + builder + renderer lay it
 * out with genuine hierarchy and cross-site structure — letting us prove the map
 * at hundreds of devices without hundreds of real routers.
 *
 * It fabricates ZERO RouterOS traffic and stores placeholder (non-decryptable)
 * credentials — these devices are never polled (run the instance with
 * RUBYMIK_POLL_INTERVAL=0). Nothing here ships enabled.
 */

export interface SynthOptions {
  /** Total managed device rows to create (the "N devices" target). */
  devices: number;
  /** Number of sites to spread them across. */
  sites: number;
  /** Overwrite an existing synthetic DB (refuses if real devices exist). */
  force?: boolean;
}

// Tiny seeded PRNG so a given (devices, sites) is reproducible run-to-run.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const SA_CITIES = [
  'Durban', 'Johannesburg', 'Cape Town', 'Pretoria', 'Gqeberha', 'Bloemfontein',
  'Polokwane', 'Nelspruit', 'Kimberley', 'East London', 'Rustenburg', 'Pietermaritzburg',
  'George', 'Witbank', 'Newcastle', 'Vereeniging', 'Centurion', 'Sandton', 'Umhlanga',
  'Ballito', 'Richards Bay', 'Stellenbosch', 'Paarl', 'Midrand', 'Roodepoort', 'Benoni',
  'Boksburg', 'Krugersdorp', 'Soweto', 'Tembisa',
];

const MODELS = ['CCR2004-1G-12S+2XS', 'CCR2116-12G-4S+', 'RB5009UG+S+IN', 'CRS328-24P-4S+', 'CRS354-48G-4S+2Q+', 'hEX S', 'RB4011iGS+', 'cAP ax', 'wAP ac'];
const EDGE_VENDORS = ['Ubiquiti', 'Cisco', 'HPE Aruba', 'Dell', 'Hikvision', 'Grandstream', 'Yealink', 'Apple', 'Intel', 'Samsung'];
const EDGE_KINDS = ['AP', 'IP camera', 'VoIP phone', 'Workstation', 'Printer', 'NVR', 'Access controller'];

function mac(rng: () => number): string {
  const h = () => Math.floor(rng() * 256).toString(16).padStart(2, '0');
  return `${h()}:${h()}:${h()}:${h()}:${h()}:${h()}`;
}

interface DevPlan {
  id: number;
  siteId: number;
  name: string;
  host: string;
  layer: number;          // 0=gateway,1=core,2=access,3=managed-edge
  parent: number | null;  // parent managed device id (tree within site)
  mac: string;            // primary interface MAC (for neighbor matching)
  health: 'up' | 'warning' | 'down';
  model: string;
}

/**
 * Builds a realistic per-site tree: gateway → core switches → access switches →
 * (managed edge). Layer sizes cascade so the hierarchy is visible. Returns the
 * managed device plan; discovered leaves are emitted separately as neighbors.
 */
function planSite(siteId: number, siteName: string, count: number, startId: number, rng: () => number): DevPlan[] {
  const plans: DevPlan[] = [];
  const octet = ((siteId * 3) % 254) + 1;
  const mk = (i: number, layer: number, parent: number | null, role: string): DevPlan => {
    const id = startId + i;
    const roll = rng();
    const health: DevPlan['health'] = roll > 0.94 ? 'down' : roll > 0.82 ? 'warning' : 'up';
    return {
      id, siteId, parent, layer, mac: mac(rng), health,
      name: `${siteName.slice(0, 3).toUpperCase()}-${role}${String(i + 1).padStart(2, '0')}`,
      host: `10.${octet}.${Math.floor(i / 254)}.${(i % 254) + 1}`,
      model: MODELS[Math.floor(rng() * MODELS.length)]!,
    };
  };

  // Layer 0: one gateway.
  plans.push(mk(0, 0, null, 'GW'));
  if (count === 1) return plans;

  // Build cascading layers. Fanout widens toward the edge.
  let i = 1;
  const cores = Math.max(1, Math.round(count * 0.08));
  const access = Math.max(1, Math.round(count * 0.28));
  for (let c = 0; c < cores && i < count; c++, i++) plans.push(mk(i, 1, plans[0]!.id, 'CORE'));
  const coreIds = plans.filter((p) => p.layer === 1).map((p) => p.id);
  for (let a = 0; a < access && i < count; a++, i++) {
    const parent = coreIds.length ? coreIds[Math.floor(rng() * coreIds.length)]! : plans[0]!.id;
    plans.push(mk(i, 2, parent, 'ACC'));
  }
  const accessIds = plans.filter((p) => p.layer === 2).map((p) => p.id);
  for (; i < count; i++) {
    const pool = accessIds.length ? accessIds : coreIds.length ? coreIds : [plans[0]!.id];
    const parent = pool[Math.floor(rng() * pool.length)]!;
    plans.push(mk(i, 3, parent, 'SW'));
  }
  return plans;
}

export function generateSyntheticFleet(db: DatabaseSync, opts: SynthOptions): { sites: number; managed: number; discovered: number; edges: number } {
  const devices = Math.max(1, Math.min(opts.devices, 5000));
  const siteCount = Math.max(1, Math.min(opts.sites, devices));
  const rng = makeRng(devices * 1000 + siteCount);

  const existing = db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number };
  if (existing.n > 0 && !opts.force) {
    throw new Error(`Refusing to generate: ${existing.n} device(s) already exist in this DB. This is a fresh-DB-only tool.`);
  }
  if (opts.force) {
    for (const t of ['device_neighbors', 'device_discovery', 'device_status', 'device_metrics', 'interface_traffic', 'devices', 'sites']) {
      db.exec(`DELETE FROM ${t}`);
    }
  }

  const now = new Date().toISOString();

  // Distribute devices across sites with varied sizes (some big HQs, many small branches).
  const weights = Array.from({ length: siteCount }, () => 0.4 + rng() * rng() * 3);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const perSite = weights.map((w) => Math.max(1, Math.round((w / wsum) * devices)));
  // trim/pad to hit the exact target
  let total = perSite.reduce((a, b) => a + b, 0);
  for (let k = 0; total > devices && k < perSite.length; k = (k + 1) % perSite.length) { if (perSite[k]! > 1) { perSite[k]!--; total--; } }
  for (let k = 0; total < devices; k = (k + 1) % perSite.length) { perSite[k]!++; total++; }

  const insSite = db.prepare('INSERT INTO sites (name, location, client_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const insDev = db.prepare(`INSERT INTO devices (name, host, use_tls, verify_tls, username_enc, password_enc, site_id, created_at, updated_at)
    VALUES (?, ?, 0, 0, 'synthetic', 'synthetic', ?, ?, ?)`);
  const insStatus = db.prepare(`INSERT INTO device_status
    (device_id, state, consecutive_failures, last_attempt_at, last_seen_at, identity, board_name, model, version, uptime, cpu_load, cpu_count, mem_total, mem_free, temp_c, if_macs, updated_at)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insNbr = db.prepare(`INSERT INTO device_neighbors
    (device_id, seen_on, mac, identity, platform, board, version, address, remote_interface, discovered_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insDisc = db.prepare('INSERT INTO device_discovery (device_id, protocol, interface_list, updated_at) VALUES (?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    let managed = 0, discovered = 0, edges = 0;
    let nextId = 1;
    const gateways: DevPlan[] = [];

    for (let sIdx = 0; sIdx < siteCount; sIdx++) {
      const city = SA_CITIES[sIdx % SA_CITIES.length]!;
      const siteName = sIdx < SA_CITIES.length ? `${city} Office` : `${city} Office ${Math.floor(sIdx / SA_CITIES.length) + 1}`;
      insSite.run(siteName, city, sIdx % 4 === 0 ? 'RubyNet' : `Client ${String.fromCharCode(65 + (sIdx % 20))}`, now, now);
      const siteId = sIdx + 1;

      const plans = planSite(siteId, siteName, perSite[sIdx]!, nextId, rng);
      nextId += plans.length;

      // devices + status
      for (const p of plans) {
        insDev.run(p.name, p.host, siteId, now, now);
        managed++;
        const memTotal = 256 * 1024 * 1024 * (1 + Math.floor(rng() * 8));
        const cpu = p.health === 'warning' ? 88 + Math.floor(rng() * 10) : Math.floor(rng() * 45);
        const memFree = p.health === 'warning' ? Math.floor(memTotal * 0.04) : Math.floor(memTotal * (0.4 + rng() * 0.4));
        const state = p.health === 'down' ? 'down' : 'up';
        insStatus.run(p.id, state, now, p.health === 'down' ? null : now,
          p.name, p.model, p.model, `7.${14 + Math.floor(rng() * 5)}.${Math.floor(rng() * 6)}`,
          `${Math.floor(rng() * 40)}d${Math.floor(rng() * 24)}h`, cpu, 1 + Math.floor(rng() * 4),
          memTotal, memFree, 30 + Math.floor(rng() * 20), JSON.stringify([p.mac]), now);
      }

      // discovery settings (mostly ok; a few restricted/disabled for honesty banners)
      for (const p of plans) {
        const r = rng();
        const [proto, list] = r > 0.9 ? ['', 'none'] : r > 0.8 ? ['lldp,cdp,mndp', 'LAN'] : ['lldp,cdp,mndp', 'all'];
        insDisc.run(p.id, proto || null, list, now);
      }

      const byId = new Map(plans.map((p) => [p.id, p]));

      // tree edges: parent reports child as a managed neighbor (matched by child mac)
      for (const p of plans) {
        if (p.parent === null) continue;
        const parent = byId.get(p.parent)!;
        insNbr.run(parent.id, `ether${1 + (p.id % 12)}`, p.mac, p.name, 'MikroTik', p.model, null,
          p.host, 'ether1', 'lldp,mndp', now);
        edges++;
      }

      // ISP uplink: gateway sees a discovered upstream (unique mac → unmatched → discovered node)
      const gw = plans[0]!;
      insNbr.run(gw.id, 'ether1', mac(rng), `ISP-EDGE-${city.slice(0, 3).toUpperCase()}`, 'Cisco', 'ASR1001', null,
        `196.${siteId}.0.1`, 'Gi0/0', 'cdp,lldp', now);
      discovered++;

      // a handful of discovered edge devices hang off access-layer nodes
      const accessNodes = plans.filter((p) => p.layer >= 2);
      const leaves = Math.round(accessNodes.length * (0.3 + rng() * 0.5));
      for (let l = 0; l < leaves; l++) {
        const host = accessNodes.length ? accessNodes[Math.floor(rng() * accessNodes.length)]! : gw;
        const vendor = EDGE_VENDORS[Math.floor(rng() * EDGE_VENDORS.length)]!;
        const kind = EDGE_KINDS[Math.floor(rng() * EDGE_KINDS.length)]!;
        insNbr.run(host.id, `ether${2 + (l % 10)}`, mac(rng), `${vendor}-${kind}-${l}`.replace(/\s/g, ''),
          vendor, kind, null, `10.${octetOf(host.host)}.9.${(l % 250) + 1}`, null, 'lldp', now);
        discovered++;
      }

      gateways.push(gw);
    }

    // Cross-site WAN: hub-and-spoke — every site gateway peers with site 0's
    // gateway (a genuine managed↔managed cross-site edge, matched by MAC).
    const hub = gateways[0]!;
    for (let g = 1; g < gateways.length; g++) {
      const spoke = gateways[g]!;
      insNbr.run(spoke.id, 'wan', hub.mac, hub.name, 'MikroTik', hub.model, null, hub.host, 'wan', 'mndp', now);
      edges++;
    }

    db.exec('COMMIT');
    return { sites: siteCount, managed, discovered, edges };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function octetOf(host: string): number {
  const parts = host.split('.');
  return Number(parts[1] ?? 0);
}
