import http from 'node:http';

/**
 * SYNTHETIC ROUTEROS RESPONDER — DEMO ONLY (public demo at demo.rubymik.com).
 *
 * A tiny read-only HTTP server that answers the RouterOS 7 REST API (`/rest/*`)
 * with a coherent, fabricated "zzz-*" router so the demo instance has ONE live
 * device to display — dashboard, traffic graphs, topology and the device-detail
 * pages all populate — WITHOUT a real router, a qemu CHR, KVM or /dev/net/tun.
 * This is what lets a live device sit on the demo's `internal: true` network
 * (the qemu CHR image cannot: it needs a default route the internal net denies).
 *
 * It only ever answers GET (the poller is read-only), returns synthetic data,
 * touches no real device, and holds no secrets. Counters advance with wall-clock
 * time so the traffic/CPU/memory graphs animate. Auth is accepted as-is — the
 * demo device's credentials are themselves synthetic.
 *
 * Run:  node dist/devtools/demo-router.js      (PORT env, default 8080)
 */

const PORT = Number(process.env.PORT ?? 8080);
const IDENTITY = process.env.DEMO_ROUTER_IDENTITY ?? 'zzz-demo-gw';
const START = Date.now();

const sec = () => Math.floor((Date.now() - START) / 1000);
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** RouterOS-style uptime string, e.g. "3w2d04h11m09s", from a base + elapsed. */
function uptime(baseSec: number): string {
  let s = baseSec + sec();
  const w = Math.floor(s / 604800); s -= w * 604800;
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return `${w ? w + 'w' : ''}${d ? d + 'd' : ''}${pad(h)}h${pad(m)}m${pad(s)}s`;
}

/** A monotonic byte counter: base + rate·elapsed, with a gentle wobble. */
function counter(base: number, ratePerSec: number): string {
  const t = sec();
  return String(Math.floor(base + ratePerSec * t + Math.abs(Math.sin(t / 30)) * ratePerSec * 5));
}

/** CPU load 1–40%, memory ~free, wobbling around a mean so graphs move. */
const cpuLoad = () => String(Math.max(1, Math.round(7 + 5 * Math.sin(sec() / 47) + (sec() % 5))));
const freeMem = () => String(Math.round(612_000_000 + 40_000_000 * Math.sin(sec() / 90)));

// ---- interfaces (the poller reads name / rx-byte / tx-byte / running / mac) ----
const IFACES = [
  { name: 'ether1',      type: 'ether', mac: 'DC:2C:6E:00:AA:01', comment: 'WAN uplink (zzz-isp)', base: 84_000_000_000, rate: 1_450_000 },
  { name: 'ether2',      type: 'ether', mac: 'DC:2C:6E:00:AA:02', comment: 'zzz-lan trunk',        base: 51_000_000_000, rate: 900_000 },
  { name: 'ether3',      type: 'ether', mac: 'DC:2C:6E:00:AA:03', comment: '',                     base: 8_400_000_000,  rate: 120_000 },
  { name: 'ether4',      type: 'ether', mac: 'DC:2C:6E:00:AA:04', comment: 'zzz-cctv',             base: 22_000_000_000, rate: 310_000 },
  { name: 'zzz-lan',     type: 'bridge', mac: 'DC:2C:6E:00:AA:10', comment: 'LAN bridge',          base: 73_000_000_000, rate: 1_180_000 },
  { name: 'zzz-vlan10',  type: 'vlan',  mac: 'DC:2C:6E:00:AA:10', comment: 'mgmt VLAN 10',         base: 3_100_000_000,  rate: 40_000 },
  { name: 'zzz-wg0',     type: 'wg',    mac: '',                  comment: 'site-to-site VPN',     base: 9_900_000_000,  rate: 60_000 },
];

function interfaces() {
  return IFACES.map((f, i) => ({
    '.id': `*${(i + 1).toString(16).toUpperCase()}`,
    name: f.name,
    type: f.type,
    mtu: '1500',
    'actual-mtu': '1500',
    'mac-address': f.mac,
    running: 'true',
    disabled: 'false',
    comment: f.comment,
    'rx-byte': counter(f.base, f.rate),
    'tx-byte': counter(Math.floor(f.base * 0.62), Math.floor(f.rate * 0.7)),
    'rx-packet': counter(Math.floor(f.base / 900), Math.floor(f.rate / 900)),
    'tx-packet': counter(Math.floor(f.base / 1100), Math.floor(f.rate / 1100)),
  }));
}

// ---- the response map. Objects for single-value menus, arrays for lists. ----
const OBJECT_PATHS = new Set([
  '/system/resource', '/system/identity', '/system/routerboard', '/system/clock',
  '/system/ntp/client', '/system/package/update', '/ip/dns', '/ip/neighbor/discovery-settings',
]);

function body(path: string): unknown {
  switch (path) {
    case '/system/resource':
      return {
        uptime: uptime(1_900_000), version: '7.16.1 (stable)', 'build-time': '2024-11-27 10:11:12',
        'factory-software': '7.11', 'free-memory': freeMem(), 'total-memory': '1073741824',
        cpu: 'ARM64', 'cpu-count': '4', 'cpu-frequency': '1400', 'cpu-load': cpuLoad(),
        'free-hdd-space': '1015119872', 'total-hdd-space': '1073741824',
        'architecture-name': 'arm64', 'board-name': 'RB5009UG+S+IN', platform: 'MikroTik',
      };
    case '/system/identity':
      return { name: IDENTITY };
    case '/system/routerboard':
      return {
        routerboard: 'true', model: 'RB5009UG+S+IN', 'serial-number': 'HG509ZZZ0001',
        'firmware-type': 'ipq6000L', 'factory-firmware': '7.11', 'current-firmware': '7.16.1',
        'upgrade-firmware': '7.16.1',
      };
    case '/system/health':
      return [
        { '.id': '*1', name: 'temperature', type: 'C', value: String(40 + (sec() % 4)) },
        { '.id': '*2', name: 'cpu-temperature', type: 'C', value: String(43 + (sec() % 5)) },
        { '.id': '*3', name: 'voltage', type: 'V', value: '24.1' },
      ];
    case '/system/clock':
      return { time: new Date().toISOString().slice(11, 19), date: new Date().toISOString().slice(0, 10),
        'time-zone-name': 'Africa/Johannesburg', 'gmt-offset': '+02:00' };
    case '/system/ntp/client':
      return { enabled: 'true', servers: '196.10.54.57,za.pool.ntp.org', 'server-dns-names': 'za.pool.ntp.org', status: 'synchronized' };
    case '/system/package/update':
      return { channel: 'stable', 'installed-version': '7.16.1', 'latest-version': '7.16.1', status: 'System is already up to date' };
    case '/interface':
      return interfaces();
    case '/ip/neighbor':
      return [
        { '.id': '*1', interface: 'zzz-lan', 'interface-name': 'ether2', address4: '10.20.0.2', 'mac-address': 'CC:2D:E0:11:00:21',
          identity: 'zzz-access-sw', platform: 'MikroTik', board: 'CRS328-24P-4S+', version: '7.16.1 (stable)', 'discovered-by': 'lldp,mndp' },
        { '.id': '*2', interface: 'zzz-lan', 'interface-name': 'ether4', address4: '10.20.0.9', 'mac-address': '48:8F:5A:22:00:0A',
          identity: 'zzz-cap-ax-01', platform: 'MikroTik', board: 'cAP ax', version: '7.16.1 (stable)', 'discovered-by': 'lldp,mndp' },
        { '.id': '*3', interface: 'ether1', 'interface-name': 'ether1', address4: '196.44.10.1', 'mac-address': '00:1B:0D:63:00:01',
          identity: 'isp-bng-01', platform: 'Cisco', board: 'ASR-920', version: 'IOS-XE 17.9', 'discovered-by': 'cdp' },
      ];
    case '/ip/neighbor/discovery-settings':
      return { 'discover-interface-list': '!dynamic', protocol: 'cdp,lldp,mndp', mode: 'tx-and-rx', 'lldp-med-net-policy-vlan': 'disabled' };
    case '/ip/address':
      return [
        { '.id': '*1', address: '196.44.10.42/30', network: '196.44.10.40', interface: 'ether1', 'actual-interface': 'ether1', disabled: 'false', dynamic: 'false', comment: 'WAN' },
        { '.id': '*2', address: '10.20.0.1/24', network: '10.20.0.0', interface: 'zzz-lan', 'actual-interface': 'zzz-lan', disabled: 'false', dynamic: 'false', comment: 'LAN gw' },
        { '.id': '*3', address: '10.20.10.1/24', network: '10.20.10.0', interface: 'zzz-vlan10', 'actual-interface': 'zzz-vlan10', disabled: 'false', dynamic: 'false', comment: 'mgmt' },
      ];
    case '/ip/route':
      return [
        { '.id': '*1', 'dst-address': '0.0.0.0/0', gateway: '196.44.10.41', 'immediate-gw': '196.44.10.41%ether1', distance: '1', active: 'true', static: 'true', comment: 'default via zzz-isp' },
        { '.id': '*2', 'dst-address': '10.20.0.0/24', gateway: 'zzz-lan', distance: '0', active: 'true', dynamic: 'true', connect: 'true' },
        { '.id': '*3', 'dst-address': '10.20.10.0/24', gateway: 'zzz-vlan10', distance: '0', active: 'true', dynamic: 'true', connect: 'true' },
        { '.id': '*4', 'dst-address': '10.80.0.0/24', gateway: 'zzz-wg0', distance: '1', active: 'true', static: 'true', comment: 'remote site via VPN' },
      ];
    case '/ip/dhcp-server':
      return [{ '.id': '*1', name: 'zzz-dhcp-lan', interface: 'zzz-lan', 'address-pool': 'zzz-pool-lan', 'lease-time': '1d', disabled: 'false', invalid: 'false' }];
    case '/ip/dhcp-server/lease':
      return [
        { '.id': '*1', address: '10.20.0.20', 'mac-address': 'A4:83:E7:10:00:20', 'host-name': 'zzz-reception-pc', status: 'bound', 'expires-after': '22h51m', 'active-address': '10.20.0.20', dynamic: 'true' },
        { '.id': '*2', address: '10.20.0.31', 'mac-address': '48:8F:5A:22:00:0A', 'host-name': 'zzz-cap-ax-01', status: 'bound', 'expires-after': '23h05m', 'active-address': '10.20.0.31', dynamic: 'true' },
        { '.id': '*3', address: '10.20.0.40', 'mac-address': 'DC:A6:32:00:00:40', 'host-name': 'zzz-nvr', status: 'bound', 'expires-after': '23h40m', 'active-address': '10.20.0.40', dynamic: 'false', comment: 'CCTV NVR (static)' },
      ];
    case '/ip/dhcp-server/network':
      return [{ '.id': '*1', address: '10.20.0.0/24', gateway: '10.20.0.1', 'dns-server': '10.20.0.1', 'domain': 'zzz.demo' }];
    case '/ip/pool':
      return [{ '.id': '*1', name: 'zzz-pool-lan', ranges: '10.20.0.20-10.20.0.240' }];
    case '/ip/dns':
      return { servers: '1.1.1.1,8.8.8.8', 'dynamic-servers': '', 'allow-remote-requests': 'true', 'cache-size': '2048KiB', 'cache-used': '412' };
    case '/ip/dns/static':
      return [{ '.id': '*1', name: 'zzz-gw.zzz.demo', address: '10.20.0.1', 'type': 'A', ttl: '1d' }];
    case '/ip/firewall/filter':
      return [
        { '.id': '*1', chain: 'input', action: 'accept', 'connection-state': 'established,related', comment: 'accept established', disabled: 'false' },
        { '.id': '*2', chain: 'input', action: 'drop', 'in-interface': 'ether1', comment: 'drop WAN input', disabled: 'false' },
        { '.id': '*3', chain: 'forward', action: 'fasttrack-connection', 'connection-state': 'established,related', comment: 'fasttrack', disabled: 'false' },
        { '.id': '*4', chain: 'forward', action: 'accept', 'connection-state': 'established,related', disabled: 'false' },
      ];
    case '/ip/firewall/nat':
      return [{ '.id': '*1', chain: 'srcnat', action: 'masquerade', 'out-interface': 'ether1', comment: 'zzz masquerade', disabled: 'false' }];
    case '/ip/firewall/address-list':
      return [{ '.id': '*1', list: 'zzz-blocklist', address: '203.0.113.66', 'creation-time': '2024-11-01 08:12:00', dynamic: 'false' }];
    case '/ip/service':
      return [
        { '.id': '*1', name: 'www', port: '80', disabled: 'true' },
        { '.id': '*2', name: 'api', port: '8728', disabled: 'true' },
        { '.id': '*3', name: 'ssh', port: '22', disabled: 'false' },
        { '.id': '*4', name: 'winbox', port: '8291', disabled: 'false' },
      ];
    case '/ip/arp':
      return [
        { '.id': '*1', address: '10.20.0.20', 'mac-address': 'A4:83:E7:10:00:20', interface: 'zzz-lan', complete: 'true', dynamic: 'true' },
        { '.id': '*2', address: '196.44.10.41', 'mac-address': '00:1B:0D:63:00:01', interface: 'ether1', complete: 'true', dynamic: 'true' },
      ];
    case '/queue/simple':
      return [
        { '.id': '*1', name: 'zzz-guest-wifi', target: '10.20.20.0/24', 'max-limit': '20M/20M', disabled: 'false', comment: 'guest cap' },
        { '.id': '*2', name: 'zzz-voip', target: '10.20.10.0/24', 'max-limit': '10M/10M', priority: '1/1', disabled: 'false', comment: 'VoIP priority' },
      ];
    case '/interface/bridge':
      return [{ '.id': '*1', name: 'zzz-lan', 'mac-address': 'DC:2C:6E:00:AA:10', 'vlan-filtering': 'true', 'protocol-mode': 'rstp', running: 'true', disabled: 'false' }];
    case '/interface/bridge/port':
      return [
        { '.id': '*1', interface: 'ether2', bridge: 'zzz-lan', pvid: '1', disabled: 'false' },
        { '.id': '*2', interface: 'ether3', bridge: 'zzz-lan', pvid: '1', disabled: 'false' },
        { '.id': '*3', interface: 'ether4', bridge: 'zzz-lan', pvid: '10', disabled: 'false' },
      ];
    case '/interface/bridge/vlan':
      return [{ '.id': '*1', bridge: 'zzz-lan', 'vlan-ids': '10', tagged: 'zzz-lan,ether2', untagged: 'ether4' }];
    case '/interface/vlan':
      return [{ '.id': '*1', name: 'zzz-vlan10', 'vlan-id': '10', interface: 'zzz-lan', running: 'true', disabled: 'false' }];
    case '/interface/wireguard':
      return [{ '.id': '*1', name: 'zzz-wg0', 'listen-port': '13231', 'public-key': 'kZ9x…demo…Qy0=', mtu: '1420', running: 'true', disabled: 'false' }];
    case '/interface/wireguard/peers':
      return [{ '.id': '*1', interface: 'zzz-wg0', 'public-key': 'aB3d…remote…9Fk=', 'endpoint-address': '41.72.10.7', 'endpoint-port': '13231',
        'allowed-address': '10.80.0.0/24', 'current-endpoint-address': '41.72.10.7', 'last-handshake': '48s', 'rx': counter(2_100_000_000, 9000), 'tx': counter(1_400_000_000, 7000) }];
    case '/log':
      return [
        { '.id': '*1', time: 'nov/27 04:00:01', topics: 'system,info', message: 'zzz-demo-gw scheduled backup completed' },
        { '.id': '*2', time: 'nov/27 06:14:22', topics: 'dhcp,info', message: 'dhcp-lan assigned 10.20.0.20 to A4:83:E7:10:00:20' },
        { '.id': '*3', time: 'nov/27 07:41:09', topics: 'interface,info', message: 'zzz-wg0 handshake with 41.72.10.7 ok' },
      ];
    case '/file':
      return [{ '.id': '*1', name: 'zzz-demo-gw-20241127.backup', type: 'backup', size: '184320', 'creation-time': '2024-11-27 04:00:01' }];
    default:
      return []; // any menu we don't populate = empty list (valid RouterOS)
  }
}

export function createDemoRouter(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    // Only the REST API, only GET (the poller is read-only).
    if (!url.pathname.startsWith('/rest')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: true, message: 'not found' }));
      return;
    }
    if (req.method !== 'GET') {
      // RouterOS uses POST for commands; this synthetic device is read-only.
      res.writeHead(200, { 'content-type': 'application/json', 'x-demo-router': 'read-only' });
      res.end('[]');
      return;
    }
    const path = url.pathname.replace(/^\/rest/, '') || '/';
    const out = body(path);
    const payload = out === undefined ? (OBJECT_PATHS.has(path) ? {} : []) : out;
    res.writeHead(200, { 'content-type': 'application/json', server: 'RouterOS/7.16.1', 'x-demo-router': '1' });
    res.end(JSON.stringify(payload));
  });
}

// Run directly (node dist/devtools/demo-router.js)
if (process.argv[1] && process.argv[1].endsWith('demo-router.js')) {
  const server = createDemoRouter();
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[demo-router] synthetic RouterOS REST on :${PORT} — identity="${IDENTITY}" (GET /rest/* only, read-only)`);
  });
}
