import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import { readTarget, writeTarget, transportFor } from '../transport.js';
import { getSnapshotContent } from '../snapshots.js';
import { planRestore, executeRestore, SECTIONS, type RestoreCtx, type RestoreMode, type SacFactory } from '../snaprestore.js';

/**
 * P37 — section-scoped snapshot restore + drift. `/plan` (drift) is READ-ONLY and
 * allowed on any device incl. monitor-only Home Lab. `/restore` is a WRITE — it
 * runs the delta through the guarded write modules and so is refused (403) on a
 * monitor-only device, requires a typed confirm, and never pushes a whole .rsc.
 */
interface DeviceRow {
  id: number; name: string; host: string; port: number | null; use_tls: number | null; verify_tls: number;
  site_id: number | null; username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null; net_transport?: string | null; tunnel_ip?: string | null;
}

export function snaprestoreRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  async function makeCtx(row: DeviceRow): Promise<RestoreCtx> {
    const read = readTarget(box, row);
    const transport = await transportFor(row, read);
    const write = (row.write_username_enc && row.write_password_enc) ? writeTarget(box, row) : read;
    return { read, write, transport, row } as RestoreCtx;
  }
  const sacFactory = (row: DeviceRow, actor: string): SacFactory => (action, target) => ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });

  const parseSections = (q: unknown): string[] => {
    const ids = typeof q === 'string' ? q.split(',').map((s) => s.trim()).filter(Boolean) : SECTIONS.map((s) => s.id);
    return ids.filter((id) => SECTIONS.some((s) => s.id === id));
  };
  const parseMode = (q: unknown): RestoreMode => (q === 'exact' ? 'exact' : 'additive');

  function loadSnapshot(row: DeviceRow, sid: number): { text: string } | { error: string; code: number } {
    const meta = db.prepare('SELECT id, router_id FROM snapshots WHERE id = ?').get(sid) as { id: number; router_id: number | null } | undefined;
    if (!meta || meta.router_id !== row.id) return { error: 'Snapshot not found for this device.', code: 404 };
    const got = getSnapshotContent(db, box, sid);
    if (!got) return { error: 'Snapshot content unavailable.', code: 404 };
    return { text: got.text };
  }

  // The restorable-section catalogue (for the UI). Per-device path to avoid any
  // shadowing by the '/:id/...' routes mounted alongside.
  router.get('/:id/restore/sections', (_req, res) => {
    res.json({ sections: SECTIONS.map((s) => ({ id: s.id, label: s.label, singleton: !!s.singleton, order: s.order })) });
  });

  // DRIFT / PLAN — read-only. Allowed on monitor-only devices (drift inspection).
  router.get('/:id/snapshots/:sid/plan', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    const snap = loadSnapshot(row, Number(req.params.sid));
    if ('error' in snap) { res.status(snap.code).json({ error: snap.error }); return; }
    const sections = parseSections(req.query.sections);
    const mode = parseMode(req.query.mode);
    try {
      const ctx = await makeCtx(row);
      const plan = await planRestore(ctx, snap.text, sections, mode);
      const total = plan.reduce((n, s) => n + s.ops.filter((o) => !o.blockedNote).length, 0);
      res.json({ manageable: !!(row.write_username_enc && row.write_password_enc), mode, plan, total });
    } catch (err) { res.status(502).json({ error: (err as Error).message }); }
  });

  // RESTORE — WRITE. Monitor-only → 403. Typed confirm required. Delta through the
  // guarded write modules; halts on the first non-applied outcome.
  router.post('/:id/snapshots/:sid/restore', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    if (!row.write_username_enc || !row.write_password_enc) { res.status(403).json({ error: 'This device is monitor-only. Restore is a write — it is refused. (Drift preview is still available.)' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const confirm = typeof b.confirm === 'string' ? b.confirm.trim() : '';
    if (confirm !== `RESTORE ${row.name}`) { res.status(400).json({ error: `Type exactly "RESTORE ${row.name}" to confirm.` }); return; }
    const sections = parseSections(b.sections);
    const mode = parseMode(b.mode);
    if (sections.length === 0) { res.status(400).json({ error: 'No restorable section selected.' }); return; }
    const snap = loadSnapshot(row, Number(req.params.sid));
    if ('error' in snap) { res.status(snap.code).json({ error: snap.error }); return; }
    try {
      const ctx = await makeCtx(row);
      const report = await executeRestore(ctx, sacFactory(row, actorOf(req)), snap.text, sections, mode);
      res.status(report.halted ? 409 : 200).json(report);
    } catch (err) { res.status(502).json({ error: (err as Error).message }); }
  });

  // FULL restore is MANUAL only — download the decrypted .rsc + a generated
  // recovery procedure. RubyMIK never pushes it (grep-provable: no /import here).
  router.get('/:id/snapshots/:sid/rsc', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    const meta = db.prepare('SELECT id, router_id, format, captured_at, version, model, identity FROM snapshots WHERE id = ?').get(Number(req.params.sid)) as { id: number; router_id: number | null; format: string; captured_at: string; version: string | null; model: string | null; identity: string | null } | undefined;
    if (!meta || meta.router_id !== row.id) { res.status(404).json({ error: 'Snapshot not found for this device.' }); return; }
    const got = getSnapshotContent(db, box, Number(req.params.sid));
    if (!got) { res.status(404).json({ error: 'Snapshot content unavailable.' }); return; }
    const proc = generateRecoveryProcedure(row.name, meta);
    if (req.query.procedure === '1') { res.type('text/plain').send(proc); return; }
    res.type('text/plain').attachment(`${row.name.replace(/[^A-Za-z0-9_.-]/g, '_')}-${meta.captured_at.replace(/[:.]/g, '-')}.rsc`);
    res.send(`# ${proc.split('\n').map((l) => '# ' + l).join('\n# ')}\n\n${got.text}`);
  });

  return router;
}

function generateRecoveryProcedure(deviceName: string, meta: { format: string; captured_at: string; version: string | null; model: string | null }): string {
  const canonical = meta.format === 'export';
  return [
    `RubyMIK — MANUAL full-restore procedure for "${deviceName}"`,
    `Snapshot: ${meta.captured_at}  ·  RouterOS ${meta.version ?? '?'}  ·  model ${meta.model ?? '?'}  ·  format: ${meta.format}`,
    ``,
    `RubyMIK deliberately does NOT push a full config. A whole-file /import is`,
    `non-idempotent, fails mid-way, and can sever the management path below every`,
    `safety guard. Use the section-by-section restore in the app for a safe,`,
    `guarded, reversible delta. This document is for a from-scratch rebuild only.`,
    ``,
    canonical
      ? `This .rsc is a CANONICAL export (importable). To rebuild a blank/reset router:`
      : `NOTE: this snapshot is a READ-ONLY reconstruction, NOT an importable .rsc. Use`
        + `\nit as a REFERENCE to re-enter config by hand; do not feed it to /import.`,
    ``,
    `1. Console/serial or Winbox (NOT the network path you're restoring) — netinstall`,
    `   or /system reset-configuration if starting clean. Have out-of-band access first.`,
    `2. Restore in dependency order: interfaces/L2 → IP addresses → routes →`,
    `   DNS/NTP/DHCP → firewall/NAT last. Verify management reachability after EACH step.`,
    `3. ${canonical ? 'You may `/import file=<this>.rsc` on a CONSOLE session only (never remotely).' : 'Re-enter each section by hand from the reference above.'}`,
    `4. After each section, confirm you can still reach the router before continuing.`,
    `5. Re-check: management IP/route present, firewall mgmt-accept rule first, DHCP`,
    `   serving, and RubyMIK can poll the device again.`,
    ``,
    `Generated by RubyMIK. Keep this with the .rsc.`,
  ].join('\n');
}
