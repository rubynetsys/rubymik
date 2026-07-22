import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import { readTarget, transportFor } from '../transport.js';
import { restGet } from '../routeros/rest.js';
import { parseUpdateState } from '../update.js';
import {
  planFleetUpdate, FleetUpdater, DEFAULT_FLEET_CONFIG,
  type FleetTarget, type FleetConfig, type PlanItem,
} from '../fleetupdate.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null; transport: string;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string; write_username_enc: string | null; write_password_enc: string | null;
  net_transport?: string | null; tunnel_ip?: string | null;
}

const now = () => new Date().toISOString();

export function fleetUpdateRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));
  const updater = new FleetUpdater(); // one orchestrator per app process

  const readState = async (row: DeviceRow) => {
    const read = readTarget(box, row);
    const transport = await transportFor(row, read);
    const [pkg, rb] = await Promise.all([
      restGet(read, transport.scheme, transport.port, '/system/package/update') as Promise<Record<string, unknown>>,
      restGet(read, transport.scheme, transport.port, '/system/routerboard').catch(() => null) as Promise<Record<string, unknown> | null>,
    ]);
    return parseUpdateState(pkg, rb);
  };

  async function gatherTargets(siteId?: number): Promise<FleetTarget[]> {
    const filter = scopeFilter(allSites(), 'd.site_id');
    const rows = db.prepare(`SELECT d.* FROM devices d WHERE 1=1${filter.sql}${siteId ? ' AND d.site_id = ?' : ''} ORDER BY d.name`)
      .all(...filter.params, ...(siteId ? [siteId] : [])) as unknown as DeviceRow[];
    return Promise.all(rows.map(async (row) => {
      const manageable = !!(row.write_username_enc && row.write_password_enc);
      let reachable = true;
      let state: ReturnType<typeof parseUpdateState> | null = null;
      try { state = await readState(row); } catch { reachable = false; }
      return {
        id: row.id, name: row.name, manageable, reachable,
        updateAvailable: state?.updateAvailable ?? null, installed: state?.installed ?? null, latest: state?.latest ?? null,
      };
    }));
  }

  const cfgFromBody = (b: Record<string, unknown>): FleetConfig => ({
    canaryCount: typeof b.canaryCount === 'number' ? b.canaryCount : DEFAULT_FLEET_CONFIG.canaryCount,
    batchSize: typeof b.batchSize === 'number' ? b.batchSize : DEFAULT_FLEET_CONFIG.batchSize,
    haltOnFailure: typeof b.haltOnFailure === 'boolean' ? b.haltOnFailure : DEFAULT_FLEET_CONFIG.haltOnFailure,
  });
  // Preview the plan (reads each device's last-known update state; never writes).
  router.post('/update/plan', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const siteId = typeof b.siteId === 'number' ? b.siteId : undefined;
    try {
      const targets = await gatherTargets(siteId);
      const plan = planFleetUpdate(targets, cfgFromBody(b));
      res.json({ plan, config: cfgFromBody(b), scanned: targets.length });
    } catch (err) { res.status(502).json({ error: (err as Error).message }); }
  });

  // Start a run. dryRun (default true) rehearses the orchestration against the real
  // plan without touching any router. Live orchestrated execution is attended-only
  // in this build — run the per-device update from each device's Router Admin panel.
  router.post('/update/run', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const dryRun = b.dryRun !== false; // default true
    if (!dryRun) {
      res.status(400).json({ error: 'Live fleet updates are attended-only in this build. Rehearse with a dry-run here, then install per-device from each device’s Router Admin panel.', attendedOnly: true });
      return;
    }
    const siteId = typeof b.siteId === 'number' ? b.siteId : undefined;
    const simFail = new Set<number>(Array.isArray(b.simFailIds) ? (b.simFailIds as unknown[]).filter((x): x is number => typeof x === 'number') : []);
    try {
      const config = cfgFromBody(b);
      const targets = await gatherTargets(siteId);
      const plan = planFleetUpdate(targets, config);
      if (plan.total === 0) { res.status(409).json({ error: 'Nothing to update — no reachable, manageable device has an available update.', plan }); return; }
      // dry-run processor: a short pause per device, then success unless flagged (proves halt/abort semantics live).
      const processOne = async (it: PlanItem) => { await sleep(400); return simFail.has(it.id) ? 'failed' as const : 'done' as const; };
      const runId = updater.start(plan, config, true, processOne, now);
      // No config_audit row for a dry-run: it contacts no device (and that table is
      // FK-bound to a real device). The run state itself is the record.
      res.status(202).json({ runId, dryRun: true, plan });
    } catch (err) { res.status(502).json({ error: (err as Error).message }); }
  });

  router.get('/update/run/:id', (req, res) => {
    const r = updater.status(req.params.id);
    if (!r) { res.status(404).json({ error: 'Run not found.' }); return; }
    res.json(r);
  });

  router.post('/update/run/:id/abort', (req, res) => {
    const ok = updater.abort(req.params.id);
    if (!ok) { res.status(409).json({ error: 'Run is not running (already finished or unknown).' }); return; }
    res.json({ aborted: true });
  });

  return router;
}
