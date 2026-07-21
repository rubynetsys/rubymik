import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import type { Poller } from '../poller.js';
import { allSites, scopeFilter } from '../scope.js';
import { restConnect, restGet, RouterOsError, type Scheme } from '../routeros/rest.js';
import type { DeviceTarget } from '../routeros/types.js';
import { readTarget } from '../transport.js';
import { log } from '../log.js';

/**
 * Per-device deep view. Everything here READS from RouterOS via restGet
 * (GET-only by construction) and never writes device state.
 *
 * Polling coordination: the browser drives richer polling only while the
 * detail page is open (GET …/detail?live=1 every few seconds). There is no
 * server-side loop for it — closing the page stops it by construction. A
 * short per-device response cache stops a misbehaving client from hammering
 * a device. The persisted time-series stays at the fleet poll cadence.
 */

const LIVE_CACHE_MS = 2500;
const ROUTE_CAP = 200;
const LOG_CAP = 50;
const RATE_MAX_GAP_MS = 120_000;

interface DeviceRow {
  id: number;
  name: string;
  host: string;
  port: number | null;
  use_tls: number | null;
  verify_tls: number;
  site_id: number | null;
  notes: string | null;
  username_enc: string;
  password_enc: string;
  site_name: string | null;
}

interface StatusRow {
  state: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  identity: string | null;
  board_name: string | null;
  model: string | null;
  version: string | null;
  cpu_count: number | null;
}

type Dict = Record<string, unknown>;

type Section<T> =
  | { ok: true; data: T }
  | { ok: false; na: true }
  | { ok: false; na?: false; error: string };

function asNa(err: unknown): boolean {
  if (err instanceof RouterOsError) {
    if (err.statusCode === 404 || err.statusCode === 400) return true;
    if (/no such command|unknown command/i.test(err.message)) return true;
  }
  return false;
}

async function section<T>(fetcher: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fetcher() };
  } catch (err) {
    if (asNa(err)) return { ok: false, na: true };
    return { ok: false, error: (err as Error).message };
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const bool = (v: unknown): boolean => v === 'true' || v === true;
const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// In-memory previous live sample per device, for instant rate derivation.
const liveRateCache = new Map<number, { at: number; counters: Record<string, [number, number]> }>();
const liveResponseCache = new Map<number, { at: number; payload: unknown }>();

export function detailRoutes(db: DatabaseSync, box: SecretBox, poller: Poller): Router {
  const router = Router();
  router.use(requireAuth(db));

  function loadDevice(id: number): DeviceRow | undefined {
    // Threaded scope like every other query — see scope.ts.
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`
      SELECT d.*, s.name AS site_name FROM devices d
      LEFT JOIN sites s ON s.id = d.site_id
      WHERE d.id = ?${filter.sql}
    `).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  }

  /** Resolve scheme/port — auto-probing (and persisting) if never connected. */
  async function transportFor(row: DeviceRow, target: DeviceTarget): Promise<{ scheme: Scheme; port: number }> {
    if (row.use_tls !== null) {
      return { scheme: row.use_tls === 1 ? 'https' : 'http', port: row.port ?? (row.use_tls === 1 ? 443 : 80) };
    }
    const probed = await restConnect(target);
    db.prepare('UPDATE devices SET use_tls = ?, port = ?, updated_at = ? WHERE id = ?')
      .run(probed.scheme === 'https' ? 1 : 0, probed.port, new Date().toISOString(), row.id);
    return { scheme: probed.scheme, port: probed.port };
  }

  function mapInterfaces(raw: Dict[], deviceId: number) {
    const now = Date.now();
    const counters: Record<string, [number, number]> = {};
    const prev = liveRateCache.get(deviceId) ?? lastDbSample(deviceId);
    const dt = prev ? (now - prev.at) / 1000 : 0;
    const usable = prev !== undefined && dt >= 1 && dt * 1000 <= RATE_MAX_GAP_MS;

    const interfaces = raw.map((i) => {
      const name = str(i['name']) ?? '?';
      const rxByte = Number(i['rx-byte']) || 0;
      const txByte = Number(i['tx-byte']) || 0;
      counters[name] = [rxByte, txByte];
      let rxRate: number | null = null;
      let txRate: number | null = null;
      if (usable && prev.counters[name]) {
        const [pr, pt] = prev.counters[name];
        if (rxByte >= pr && txByte >= pt) {
          rxRate = Math.round(((rxByte - pr) * 8) / dt);
          txRate = Math.round(((txByte - pt) * 8) / dt);
        }
      }
      return {
        name,
        type: str(i['type']),
        running: bool(i['running']),
        disabled: bool(i['disabled']),
        mac: str(i['mac-address']),
        mtu: num(i['actual-mtu']) ?? num(i['mtu']),
        rxByte,
        txByte,
        rxRate,
        txRate,
        comment: str(i['comment']),
        lastLinkUp: str(i['last-link-up-time']),
      };
    });
    liveRateCache.set(deviceId, { at: now, counters });
    return interfaces;
  }

  function lastDbSample(deviceId: number): { at: number; counters: Record<string, [number, number]> } | undefined {
    const row = db.prepare('SELECT ts, data FROM interface_traffic WHERE device_id = ? ORDER BY ts DESC LIMIT 1')
      .get(deviceId) as { ts: string; data: string } | undefined;
    if (!row) return undefined;
    try {
      return { at: Date.parse(row.ts), counters: JSON.parse(row.data) as Record<string, [number, number]> };
    } catch {
      return undefined;
    }
  }

  async function fetchLive(row: DeviceRow, target: DeviceTarget, scheme: Scheme, port: number) {
    const [resource, health, ifaceRaw] = await Promise.all([
      restGet(target, scheme, port, '/system/resource') as Promise<Dict>,
      restGet(target, scheme, port, '/system/health').catch(() => null) as Promise<Dict[] | null>,
      restGet(target, scheme, port, '/interface') as Promise<Dict[]>,
    ]);
    const memTotal = Number(resource['total-memory']) || 0;
    const memFree = Number(resource['free-memory']) || 0;
    return {
      fetchedAt: new Date().toISOString(),
      uptime: str(resource['uptime']),
      version: str(resource['version']),
      cpuLoad: num(resource['cpu-load']),
      cpuCount: num(resource['cpu-count']),
      memTotal,
      memFree,
      memUsedPct: memTotal > 0 ? Math.round(((memTotal - memFree) / memTotal) * 1000) / 10 : null,
      health: Array.isArray(health)
        ? health.map((h) => ({ name: str(h['name']), value: str(h['value']), type: str(h['type']) }))
            .filter((h) => h.name && h.value)
        : [],
      interfaces: mapInterfaces(ifaceRaw, row.id),
    };
  }

  // --- GET /api/devices/:id/detail (?live=1) ---
  router.get('/:id/detail', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }
    const liveOnly = req.query.live === '1';

    if (liveOnly) {
      const cached = liveResponseCache.get(row.id);
      if (cached && Date.now() - cached.at < LIVE_CACHE_MS) {
        res.json(cached.payload);
        return;
      }
    }

    const target = readTarget(box, row);
    let scheme: Scheme;
    let port: number;
    try {
      ({ scheme, port } = await transportFor(row, target));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
      return;
    }

    log.debug(`detail fetch (${liveOnly ? 'live' : 'full'}) for "${row.name}" (${row.host})`);

    let live: Awaited<ReturnType<typeof fetchLive>> | null = null;
    let liveError: string | null = null;
    try {
      live = await fetchLive(row, target, scheme, port);
    } catch (err) {
      liveError = (err as Error).message;
    }

    if (liveOnly) {
      const payload = { live, liveError };
      liveResponseCache.set(row.id, { at: Date.now(), payload });
      res.json(payload);
      return;
    }

    const status = db.prepare(`
      SELECT state, last_seen_at, last_error, identity, board_name, model, version, cpu_count
      FROM device_status WHERE device_id = ?
    `).get(row.id) as unknown as StatusRow | undefined;

    // Serial lives in routerboard; re-read it here (cheap, and CHR-safe).
    const g = (path: string) => restGet(target, scheme, port, path);

    const [routerboard, dhcp, arp, routes, wireless, switchSec, logs, update] = await Promise.all([
      section(async () => {
        const rb = await g('/system/routerboard') as Dict;
        return { model: str(rb['model']), serial: str(rb['serial-number']), firmware: str(rb['current-firmware']) };
      }),
      section(async () => {
        const servers = await g('/ip/dhcp-server') as Dict[];
        const leases = servers.length > 0 ? await g('/ip/dhcp-server/lease') as Dict[] : [];
        return {
          servers: servers.map((s) => ({ name: str(s['name']), interface: str(s['interface']), disabled: bool(s['disabled']) })),
          leases: leases.map((l) => ({
            address: str(l['address']),
            mac: str(l['mac-address']),
            hostName: str(l['host-name']),
            server: str(l['server']),
            status: str(l['status']),
            expiresAfter: str(l['expires-after']),
            dynamic: bool(l['dynamic']),
            lastSeen: str(l['last-seen']),
          })),
        };
      }),
      section(async () => {
        const entries = await g('/ip/arp') as Dict[];
        return entries.map((a) => ({
          address: str(a['address']),
          mac: str(a['mac-address']),
          interface: str(a['interface']),
          dynamic: bool(a['dynamic']),
          complete: bool(a['complete']),
        }));
      }),
      section(async () => {
        const entries = await g('/ip/route') as Dict[];
        return {
          total: entries.length,
          entries: entries.slice(0, ROUTE_CAP).map((r) => ({
            dst: str(r['dst-address']),
            gateway: str(r['gateway']) ?? str(r['immediate-gw']),
            distance: num(r['distance']),
            active: bool(r['active']),
            dynamic: bool(r['dynamic']),
            static: bool(r['static']),
          })),
        };
      }),
      section(async () => {
        // Capability order: modern wifi (7.13+), legacy wireless, legacy CAPsMAN.
        const stacks: Array<{ stack: string; path: string }> = [
          { stack: 'wifi', path: '/interface/wifi/registration-table' },
          { stack: 'wireless', path: '/interface/wireless/registration-table' },
          { stack: 'capsman', path: '/caps-man/registration-table' },
        ];
        for (const { stack, path } of stacks) {
          try {
            const regs = await g(path) as Dict[];
            return {
              stack,
              clients: regs.map((c) => ({
                mac: str(c['mac-address']),
                interface: str(c['interface']),
                ssid: str(c['ssid']),
                signal: str(c['signal']) ?? str(c['signal-strength']),
                txRate: str(c['tx-rate']),
                rxRate: str(c['rx-rate']),
                uptime: str(c['uptime']),
                bytes: str(c['bytes']),
              })),
            };
          } catch (err) {
            if (!asNa(err)) throw err;
          }
        }
        throw new RouterOsError('no wireless stack', 404);
      }),
      section(async () => {
        const chips = await g('/interface/ethernet/switch') as Dict[];
        if (chips.length === 0) throw new RouterOsError('no switch chip', 404);
        const ports = await g('/interface/ethernet/switch/port').catch(() => []) as Dict[];
        return {
          chips: chips.map((c) => ({ name: str(c['name']), type: str(c['type']) })),
          ports: ports
            .filter((p) => str(p['name']) !== null)
            .map((p) => ({
              name: str(p['name']),
              switch: str(p['switch']),
              // Only fields RouterOS exposes over GET — link speed needs the
              // (POST-only) monitor command, so it is deliberately absent.
            })),
        };
      }),
      section(async () => {
        const entries = await g('/log') as Dict[];
        return entries.slice(-LOG_CAP).reverse().map((l) => ({
          time: str(l['time']),
          topics: str(l['topics']),
          message: str(l['message']),
        }));
      }),
      section(async () => {
        const u = await g('/system/package/update') as Dict;
        const installed = str(u['installed-version']);
        const latest = str(u['latest-version']);
        return {
          channel: str(u['channel']),
          installed,
          latest,
          // Honest tri-state: true / false only when both versions are known.
          updateAvailable: installed && latest ? installed !== latest : null,
          status: str(u['status']),
        };
      }),
    ]);

    res.json({
      device: {
        id: row.id,
        name: row.name,
        host: row.host,
        port,
        scheme,
        siteId: row.site_id,
        siteName: row.site_name,
        notes: row.notes,
        status: status?.state ?? null,
        lastSeenAt: status?.last_seen_at ?? null,
        lastError: status?.last_error ?? null,
        identity: status?.identity ?? null,
        boardName: status?.board_name ?? null,
        model: status?.model ?? null,
        version: (live?.version ?? status?.version) ?? null,
      },
      routerboard,
      live,
      liveError,
      sections: { dhcp, arp, routes, wireless, switch: switchSec, logs, update },
    });
  });

  // --- GET /api/devices/:id/traffic?iface=NAME&window=3600 ---
  router.get('/:id/traffic', (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }
    const iface = typeof req.query.iface === 'string' ? req.query.iface : '';
    if (!iface) {
      res.status(400).json({ error: 'iface query parameter is required.' });
      return;
    }
    const windowSec = Math.min(Math.max(Number(req.query.window) || 3600, 300), 6 * 3600);
    const cutoff = new Date(Date.now() - windowSec * 1000).toISOString();
    const rows = db.prepare(
      'SELECT ts, data FROM interface_traffic WHERE device_id = ? AND ts >= ? ORDER BY ts',
    ).all(row.id, cutoff) as unknown as Array<{ ts: string; data: string }>;

    const points: Array<{ t: string; rx: number | null; tx: number | null }> = [];
    let prev: { at: number; rx: number; tx: number } | null = null;
    for (const r of rows) {
      let counters: Record<string, [number, number]>;
      try {
        counters = JSON.parse(r.data) as Record<string, [number, number]>;
      } catch {
        continue;
      }
      const pair = counters[iface];
      const at = Date.parse(r.ts);
      if (!pair) {
        prev = null;
        points.push({ t: r.ts, rx: null, tx: null });
        continue;
      }
      const [rx, tx] = pair;
      if (prev && at > prev.at && rx >= prev.rx && tx >= prev.tx && at - prev.at <= RATE_MAX_GAP_MS) {
        const dt = (at - prev.at) / 1000;
        points.push({ t: r.ts, rx: Math.round(((rx - prev.rx) * 8) / dt), tx: Math.round(((tx - prev.tx) * 8) / dt) });
      } else {
        points.push({ t: r.ts, rx: null, tx: null });
      }
      prev = { at, rx, tx };
    }
    res.json({ iface, windowSec, points });
  });

  // --- POST /api/devices/:id/poll — immediate health poll of OUR database
  // record (read-only toward the device, like every poll).
  router.post('/:id/poll', (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }
    poller.pollDeviceById(row.id);
    res.status(202).json({ started: true });
  });

  return router;
}
