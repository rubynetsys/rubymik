import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth } from '../auth.js';
import { allSites, siteScope, scopeFilter, type AccessScope } from '../scope.js';
import { RULE_META } from '../alerts.js';
import type { Notifier } from '../notify.js';
import { log } from '../log.js';

interface AlertRow {
  id: number;
  device_id: number;
  device_name: string;
  host: string;
  site_id: number | null;
  site_name: string | null;
  rule: string;
  target: string | null;
  severity: string;
  state: string;
  message: string;
  value: string | null;
  fired_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  cycles: number;
}

function toPublic(row: AlertRow) {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    host: row.host,
    siteId: row.site_id,
    siteName: row.site_name,
    rule: row.rule,
    ruleLabel: RULE_META[row.rule]?.label ?? row.rule,
    target: row.target,
    severity: row.severity,
    state: row.state,
    message: row.message,
    value: row.value,
    firedAt: row.fired_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    cycles: row.cycles,
  };
}

function scopeFromQuery(siteParam: unknown): AccessScope | { error: string } {
  // P1: single admin → unrestricted base scope; ?siteId narrows via siteScope.
  if (typeof siteParam === 'string' && siteParam !== '' && siteParam !== 'all') {
    const siteId = Number(siteParam);
    if (!Number.isInteger(siteId)) return { error: 'Invalid siteId.' };
    return siteScope([siteId]);
  }
  return allSites();
}

export function alertRoutes(db: DatabaseSync, notifier: Notifier): Router {
  const router = Router();
  router.use(requireAuth(db));

  const baseSelect = `
    SELECT a.*, d.name AS device_name, d.host, d.site_id, s.name AS site_name
    FROM alerts a
    JOIN devices d ON d.id = a.device_id
    LEFT JOIN sites s ON s.id = d.site_id
  `;

  router.get('/', (req, res) => {
    const scope = scopeFromQuery(req.query.siteId);
    if ('error' in scope) {
      res.status(400).json({ error: scope.error });
      return;
    }
    const filter = scopeFilter(scope, 'd.site_id');
    const state = req.query.state === 'resolved' ? 'resolved' : 'firing';
    const order = state === 'firing'
      ? `ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.fired_at DESC`
      : 'ORDER BY a.resolved_at DESC';
    const rows = db.prepare(`${baseSelect} WHERE a.state = ?${filter.sql} ${order} LIMIT 200`)
      .all(state, ...filter.params) as unknown as AlertRow[];
    res.json(rows.map(toPublic));
  });

  router.get('/summary', (req, res) => {
    const scope = scopeFromQuery(req.query.siteId);
    if ('error' in scope) {
      res.status(400).json({ error: scope.error });
      return;
    }
    const filter = scopeFilter(scope, 'd.site_id');
    const row = db.prepare(`
      SELECT COUNT(*) AS firing,
             COALESCE(SUM(a.severity = 'critical'), 0) AS critical,
             COALESCE(SUM(a.severity = 'warning'), 0) AS warning,
             COALESCE(SUM(a.severity = 'info'), 0) AS info
      FROM alerts a JOIN devices d ON d.id = a.device_id
      WHERE a.state = 'firing'${filter.sql}
    `).get(...filter.params) as { firing: number; critical: number; warning: number; info: number };
    res.json(row);
  });

  router.get('/rules', (_req, res) => {
    const rows = db.prepare(`
      SELECT id, rule, scope_kind, enabled, threshold, clear_threshold, fire_cycles, resolve_cycles
      FROM alert_rules WHERE scope_kind = 'global' ORDER BY id
    `).all() as unknown as Array<Record<string, unknown>>;
    res.json(rows.map((r) => ({
      id: r.id,
      rule: r.rule,
      label: RULE_META[r.rule as string]?.label ?? r.rule,
      severity: RULE_META[r.rule as string]?.severity ?? 'warning',
      unit: RULE_META[r.rule as string]?.unit ?? null,
      enabled: r.enabled === 1,
      threshold: r.threshold,
      clearThreshold: r.clear_threshold,
      fireCycles: r.fire_cycles,
      resolveCycles: r.resolve_cycles,
    })));
  });

  router.patch('/rules/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id, threshold FROM alert_rules WHERE id = ?').get(id) as { id: number; threshold: number | null } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Rule not found.' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const enabled = typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : undefined;
    const numOrNull = (v: unknown): number | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const threshold = numOrNull(b.threshold);
    const clearThreshold = numOrNull(b.clearThreshold);
    const intIn = (v: unknown, min: number, max: number): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
    };
    const fireCycles = intIn(b.fireCycles, 1, 60);
    const resolveCycles = intIn(b.resolveCycles, 1, 60);
    if (threshold !== undefined && clearThreshold !== undefined
        && threshold !== null && clearThreshold !== null && clearThreshold > threshold) {
      res.status(400).json({ error: 'Clear threshold must not exceed the fire threshold.' });
      return;
    }
    db.prepare(`
      UPDATE alert_rules SET
        enabled = COALESCE(?, enabled),
        threshold = CASE WHEN ? THEN threshold ELSE ? END,
        clear_threshold = CASE WHEN ? THEN clear_threshold ELSE ? END,
        fire_cycles = COALESCE(?, fire_cycles),
        resolve_cycles = COALESCE(?, resolve_cycles),
        updated_at = ?
      WHERE id = ?
    `).run(
      enabled ?? null,
      threshold === undefined ? 1 : 0, threshold ?? null,
      clearThreshold === undefined ? 1 : 0, clearThreshold ?? null,
      fireCycles ?? null, resolveCycles ?? null,
      new Date().toISOString(), id,
    );
    log.info(`Alert rule ${id} updated`);
    res.json({ ok: true });
  });

  router.get('/notifications', (_req, res) => {
    const s = notifier.getSettings();
    res.json({ webhookEnabled: s.webhookEnabled, webhookUrl: s.webhookUrl });
  });

  router.put('/notifications', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const url = typeof b.webhookUrl === 'string' ? b.webhookUrl.trim() : '';
    if (url && !/^https?:\/\//.test(url)) {
      res.status(400).json({ error: 'Webhook URL must start with http:// or https://.' });
      return;
    }
    const enabled = b.webhookEnabled === true && url !== '';
    db.prepare('UPDATE notification_settings SET webhook_enabled = ?, webhook_url = ?, updated_at = ? WHERE id = 1')
      .run(enabled ? 1 : 0, url || null, new Date().toISOString());
    log.info(`Notification settings updated (webhook ${enabled ? 'enabled' : 'disabled'})`);
    res.json({ webhookEnabled: enabled, webhookUrl: url || null });
  });

  router.post('/notifications/test', async (_req, res) => {
    const result = await notifier.sendTest();
    res.status(result.ok ? 200 : 502).json(result);
  });

  return router;
}
