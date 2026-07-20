import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth } from '../auth.js';
import { allSites, scopeFilter } from '../scope.js';
import type { Poller } from '../poller.js';

/**
 * Fleet overview: every device with its latest poll state, grouped by site,
 * with per-site and global roll-ups.
 *
 * Health rules — simple and honest (documented in the README):
 *   down    → the most recent poll attempt failed
 *   warning → up, but CPU ≥ 85% or memory ≥ 90%
 *   up      → reachable, metrics under thresholds
 *   pending → added but not polled yet
 */

const CPU_WARN_PCT = 85;
const MEM_WARN_PCT = 90;
const HISTORY_POINTS = 20;

type Health = 'up' | 'warning' | 'down' | 'pending';

interface FleetRow {
  id: number;
  name: string;
  host: string;
  port: number | null;
  use_tls: number | null;
  site_id: number | null;
  notes: string | null;
  state: string | null;
  consecutive_failures: number | null;
  last_attempt_at: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  identity: string | null;
  board_name: string | null;
  model: string | null;
  version: string | null;
  uptime: string | null;
  cpu_load: number | null;
  cpu_count: number | null;
  mem_total: number | null;
  mem_free: number | null;
  updated_at: string | null;
}

function health(row: FleetRow): { status: Health; reasons: string[] } {
  if (row.state === null) return { status: 'pending', reasons: ['Not polled yet'] };
  if (row.state === 'down') {
    return { status: 'down', reasons: [row.last_error ?? 'Unreachable'] };
  }
  const reasons: string[] = [];
  if (row.cpu_load !== null && row.cpu_load >= CPU_WARN_PCT) reasons.push(`High CPU (${row.cpu_load}%)`);
  const memUsedPct = row.mem_total && row.mem_free !== null
    ? ((row.mem_total - row.mem_free) / row.mem_total) * 100
    : null;
  if (memUsedPct !== null && memUsedPct >= MEM_WARN_PCT) reasons.push(`High memory (${memUsedPct.toFixed(0)}%)`);
  return reasons.length > 0 ? { status: 'warning', reasons } : { status: 'up', reasons: [] };
}

export function fleetRoutes(db: DatabaseSync, poller: Poller, pollIntervalSec: number): Router {
  const router = Router();
  router.use(requireAuth(db));

  router.get('/', (_req, res) => {
    // P1: single admin → unrestricted scope (see scope.ts for the tenancy plan).
    const scope = allSites();
    const deviceFilter = scopeFilter(scope, 'd.site_id');
    const siteFilter = scopeFilter(scope, 's.id');

    const sites = db.prepare(`
      SELECT s.id, s.name, s.location, s.client_name FROM sites s
      WHERE 1 = 1${siteFilter.sql} ORDER BY s.name
    `).all(...siteFilter.params) as unknown as Array<{ id: number; name: string; location: string | null; client_name: string | null }>;

    const rows = db.prepare(`
      SELECT d.id, d.name, d.host, d.port, d.use_tls, d.site_id, d.notes,
             st.state, st.consecutive_failures, st.last_attempt_at, st.last_seen_at, st.last_error,
             st.identity, st.board_name, st.model, st.version, st.uptime,
             st.cpu_load, st.cpu_count, st.mem_total, st.mem_free, st.updated_at
      FROM devices d LEFT JOIN device_status st ON st.device_id = d.id
      WHERE 1 = 1${deviceFilter.sql}
      ORDER BY d.name
    `).all(...deviceFilter.params) as unknown as FleetRow[];

    // Recent CPU history per device, one query, capped in JS.
    const historyByDevice = new Map<number, Array<number | null>>();
    const histRows = db.prepare(`
      SELECT device_id, cpu_load, up FROM device_metrics ORDER BY device_id, ts
    `).all() as unknown as Array<{ device_id: number; cpu_load: number | null; up: number }>;
    for (const h of histRows) {
      let arr = historyByDevice.get(h.device_id);
      if (!arr) historyByDevice.set(h.device_id, (arr = []));
      arr.push(h.up === 1 ? h.cpu_load : null);
      if (arr.length > HISTORY_POINTS) arr.shift();
    }

    const emptyCounts = () => ({ total: 0, up: 0, warning: 0, down: 0, pending: 0 });
    const summary = emptyCounts();

    const devicesBySite = new Map<number | null, ReturnType<typeof toFleetDevice>[]>();
    function toFleetDevice(row: FleetRow) {
      const { status, reasons } = health(row);
      summary.total++;
      summary[status]++;
      const memUsedPct = row.mem_total && row.mem_free !== null
        ? Math.round(((row.mem_total - row.mem_free) / row.mem_total) * 1000) / 10
        : null;
      return {
        id: row.id,
        name: row.name,
        host: row.host,
        port: row.port,
        useTls: row.use_tls === null ? null : row.use_tls === 1,
        siteId: row.site_id,
        notes: row.notes,
        status,
        reasons,
        identity: row.identity,
        model: row.model ?? row.board_name,
        version: row.version,
        uptime: row.uptime,
        cpuLoad: row.cpu_load,
        cpuCount: row.cpu_count,
        memTotal: row.mem_total,
        memFree: row.mem_free,
        memUsedPct,
        lastSeenAt: row.last_seen_at,
        lastAttemptAt: row.last_attempt_at,
        lastError: row.state === 'down' ? row.last_error : null,
        consecutiveFailures: row.consecutive_failures ?? 0,
        history: historyByDevice.get(row.id) ?? [],
      };
    }
    for (const row of rows) {
      const d = toFleetDevice(row);
      const list = devicesBySite.get(row.site_id) ?? [];
      list.push(d);
      devicesBySite.set(row.site_id, list);
    }

    const siteEntries = sites.map((s) => {
      const devices = devicesBySite.get(s.id) ?? [];
      const counts = emptyCounts();
      for (const d of devices) {
        counts.total++;
        counts[d.status]++;
      }
      return { id: s.id, name: s.name, location: s.location, clientName: s.client_name, counts, devices };
    });
    const unassigned = devicesBySite.get(null) ?? [];
    if (unassigned.length > 0) {
      const counts = emptyCounts();
      for (const d of unassigned) {
        counts.total++;
        counts[d.status]++;
      }
      siteEntries.push({ id: null as unknown as number, name: 'Unassigned', location: null, clientName: null, counts, devices: unassigned });
    }

    res.json({
      generatedAt: new Date().toISOString(),
      pollIntervalSec,
      summary,
      sites: siteEntries,
    });
  });

  // Kick a poll cycle now (fire-and-forget); the UI's auto-refresh picks up results.
  router.post('/poll', (_req, res) => {
    void poller.runCycle('manual');
    res.status(202).json({ started: true });
  });

  return router;
}
