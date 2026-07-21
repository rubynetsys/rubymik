import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import { restGet } from '../routeros/rest.js';
import type { DeviceTarget } from '../routeros/types.js';
import type { WriteTransport } from '../routeros/write.js';
import { readTarget, writeTarget, transportFor } from '../transport.js';
import { auditRejected } from '../safeapply.js';
import {
  applyFirewall, removeFirewall, readManagedRules, lockoutTest,
  validateCustomRule, type FirewallContext, type CustomRule, type Preset, type FirewallConfig,
} from '../firewall.js';
import { log } from '../log.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
}

const LOCKOUT_TIMEOUT_SEC = 20;

export function firewallRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`)
      .get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };

  function fwContext(row: DeviceRow, read: DeviceTarget, transport: WriteTransport): FirewallContext | null {
    if (!row.write_username_enc || !row.write_password_enc) return null;
    return { read, write: writeTarget(box, row), transport };
  }

  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });

  function loadStoredConfig(id: number) {
    const r = db.prepare('SELECT * FROM device_firewall WHERE device_id = ?').get(id) as Record<string, unknown> | undefined;
    return {
      preset: (r?.preset as Preset) ?? 'off',
      wanInterface: (r?.wan_interface as string) ?? null,
      trustedInterface: (r?.trusted_interface as string) ?? null,
      mgmtSources: r?.mgmt_sources_json ? JSON.parse(r.mgmt_sources_json as string) as string[] : [],
      custom: r?.custom_rules_json ? JSON.parse(r.custom_rules_json as string) as CustomRule[] : [],
    };
  }

  function saveConfig(id: number, preset: Preset, cfg: FirewallConfig, custom: CustomRule[]) {
    db.prepare(`
      INSERT INTO device_firewall (device_id, preset, wan_interface, trusted_interface, mgmt_sources_json, custom_rules_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET preset=excluded.preset, wan_interface=excluded.wan_interface,
        trusted_interface=excluded.trusted_interface, mgmt_sources_json=excluded.mgmt_sources_json,
        custom_rules_json=excluded.custom_rules_json, updated_at=excluded.updated_at
    `).run(id, preset, cfg.wanInterface, cfg.trustedInterface, JSON.stringify(cfg.mgmtSources), JSON.stringify(custom), new Date().toISOString());
  }

  // GET current firewall view (works read-only for monitor-only devices too).
  router.get('/:id/firewall', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    const read = readTarget(box, row);
    let transport: WriteTransport;
    try { transport = await transportFor(row, read); }
    catch (err) { res.status(502).json({ error: (err as Error).message }); return; }
    const ctx: FirewallContext = { read, write: read, transport };
    try {
      const managed = await readManagedRules(ctx);
      const interfaces = (await restGet(read, transport.scheme, transport.port, '/interface') as Array<Record<string, unknown>>)
        .filter((i) => i.type !== 'loopback')
        .map((i) => ({ name: i.name as string, type: i.type as string, running: i.running === 'true' }));
      // Suggest the mgmt source the device currently sees us from.
      let suggestedMgmt: string | null = null;
      try {
        const svc = await restGet(read, transport.scheme, transport.port, '/ip/service') as Array<Record<string, unknown>>;
        const active = svc.find((s) => s.dynamic === 'true' && typeof s.remote === 'string');
        if (active) suggestedMgmt = (active.remote as string).split(':')[0] ?? null;
      } catch { /* best-effort */ }
      res.json({
        manageable: !!(row.write_username_enc && row.write_password_enc),
        config: loadStoredConfig(row.id),
        interfaces,
        suggestedMgmt,
        managedRules: managed.map((r) => ({ id: r['.id'], chain: r.chain, action: r.action, comment: r.comment, ...r })),
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  async function requireManageable(req: Request, res: Response): Promise<{ row: DeviceRow; ctx: FirewallContext; actor: string } | null> {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    const read = readTarget(box, row);
    let transport: WriteTransport;
    try { transport = await transportFor(row, read); }
    catch (err) { res.status(502).json({ error: (err as Error).message }); return null; }
    const ctx = fwContext(row, read, transport);
    if (!ctx) { res.status(403).json({ error: 'This device is monitor-only. Add a write credential to manage its firewall.' }); return null; }
    const actor = (req as Request & { user: SessionUser }).user.username;
    return { row, ctx, actor };
  }

  function parseConfig(b: Record<string, unknown>): { preset: Preset; cfg: FirewallConfig; custom: CustomRule[] } | string {
    const preset = b.preset as Preset;
    if (!['off', 'basic', 'standard'].includes(preset)) return 'Preset must be off, basic or standard.';
    const wanInterface = typeof b.wanInterface === 'string' ? b.wanInterface : '';
    const trustedInterface = typeof b.trustedInterface === 'string' && b.trustedInterface ? b.trustedInterface : null;
    const mgmtSources = Array.isArray(b.mgmtSources) ? b.mgmtSources.filter((x) => typeof x === 'string') as string[] : [];
    const custom = Array.isArray(b.custom) ? b.custom as CustomRule[] : [];
    if (preset !== 'off') {
      if (!wanInterface) return 'A WAN / untrusted interface must be selected.';
      if (mgmtSources.length === 0) return 'At least one management source is required (so the mgmt-accept guard can protect your access).';
    }
    return { preset, cfg: { wanInterface, trustedInterface, mgmtSources }, custom };
  }

  // Apply preset + config through the pipeline.
  router.put('/:id/firewall', async (req, res) => {
    const m = await requireManageable(req, res);
    if (!m) return;
    const parsed = parseConfig((req.body ?? {}) as Record<string, unknown>);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    // Validate every custom rule before touching the device.
    for (const [i, cr] of parsed.custom.entries()) {
      const errs = validateCustomRule(cr);
      if (errs.length > 0) {
        const msg = `Custom rule #${i + 1}: ${errs.join(' ')}`;
        auditRejected(sac(m.row, m.actor, 'firewall.apply', parsed.preset), `Apply firewall "${parsed.preset}"`, `Rejected: ${msg}`);
        res.status(400).json({ error: msg });
        return;
      }
    }
    try {
      const outcome = parsed.preset === 'off'
        ? await removeFirewall(m.ctx, sac(m.row, m.actor, 'firewall.apply', 'off'))
        : await applyFirewall(m.ctx, sac(m.row, m.actor, 'firewall.apply', parsed.preset), parsed.preset, parsed.cfg, parsed.custom);
      if (outcome.result === 'applied') saveConfig(m.row.id, parsed.preset, parsed.cfg, parsed.custom);
      res.status(outcome.result === 'applied' ? 200 : 502).json(outcome);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Remove all RUBYMIK firewall rules.
  router.delete('/:id/firewall', async (req, res) => {
    const m = await requireManageable(req, res);
    if (!m) return;
    try {
      const outcome = await removeFirewall(m.ctx, sac(m.row, m.actor, 'firewall.remove', null));
      if (outcome.result === 'applied') {
        const cur = loadStoredConfig(m.row.id);
        saveConfig(m.row.id, 'off', { wanInterface: cur.wanInterface ?? '', trustedInterface: cur.trustedInterface, mgmtSources: cur.mgmtSources }, []);
      }
      res.json(outcome);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ACCEPTANCE C — deliberate self-lockout auto-recovery test (bench only).
  router.post('/:id/firewall/lockout-test', async (req, res) => {
    const m = await requireManageable(req, res);
    if (!m) return;
    const cur = loadStoredConfig(m.row.id);
    const mgmtSources = cur.mgmtSources.length > 0 ? cur.mgmtSources
      : (typeof (req.body?.mgmtSource) === 'string' ? [req.body.mgmtSource] : []);
    if (mgmtSources.length === 0) {
      res.status(400).json({ error: 'No management source known — apply a firewall config first (so we know which source to sever).' });
      return;
    }
    log.warn(`Firewall lockout-test requested for "${m.row.name}" by ${m.actor}`);
    try {
      const result = await lockoutTest(m.ctx, sac(m.row, m.actor, 'firewall.lockout-test', mgmtSources.join(',')), mgmtSources, LOCKOUT_TIMEOUT_SEC);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  return router;
}
