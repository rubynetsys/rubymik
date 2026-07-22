import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter } from '../scope.js';
import type { WriteTransport } from '../routeros/write.js';
import { readTarget, writeTarget, transportFor, resolveEndpoint } from '../transport.js';
import { auditRejected } from '../safeapply.js';
import {
  readWireless, applySsid, applySecurity, applyChannel,
  validateSsid, validatePassphrase, validateChannel,
  type WirelessContext, type WirelessInterface, type WirelessStack,
} from '../wireless.js';
import { writeErr } from '../snapshothook.js';

interface DeviceRow {
  id: number; name: string; host: string; port: number | null;
  use_tls: number | null; verify_tls: number; site_id: number | null;
  username_enc: string; password_enc: string;
  write_username_enc: string | null; write_password_enc: string | null;
  net_transport?: string | null; tunnel_ip?: string | null;
}

export function wirelessRoutes(db: DatabaseSync, box: SecretBox): Router {
  const router = Router();
  router.use(requireAuth(db));

  const loadDevice = (id: number): DeviceRow | undefined => {
    const filter = scopeFilter(allSites(), 'd.site_id');
    return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`).get(id, ...filter.params) as unknown as DeviceRow | undefined;
  };
  const actorOf = (req: Request) => (req as unknown as { user: SessionUser }).user.username;
  const sac = (row: DeviceRow, actor: string, action: string, target: string | null) =>
    ({ db, actor, deviceId: row.id, deviceName: row.name, action, targetLabel: target });

  async function makeCtx(row: DeviceRow): Promise<WirelessContext> {
    const read = readTarget(box, row);
    const transport: WriteTransport = await transportFor(row, read);
    const write = (row.write_username_enc && row.write_password_enc) ? writeTarget(box, row) : read;
    return { read, write, transport, mgmtHost: resolveEndpoint(row).host };
  }

  // ---- READ (allowed on any device — reads are safe; monitor-only devices included) ----
  router.get('/:id/wireless', async (req, res) => {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return; }
    try {
      const ctx = await makeCtx(row);
      const view = await readWireless(ctx);
      res.json({ manageable: !!(row.write_username_enc && row.write_password_enc), ...view });
    } catch (err) { writeErr(res, err); }
  });

  // ---- write prep: manageable-gate + stack + target interface + lockout guard ----
  async function prepWrite(req: Request, res: Response): Promise<
    { row: DeviceRow; ctx: WirelessContext; actor: string; stack: WirelessStack; iface: WirelessInterface } | null
  > {
    const row = loadDevice(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Device not found.' }); return null; }
    if (!row.write_username_enc || !row.write_password_enc) {
      res.status(403).json({ error: 'This device is monitor-only. Add a write credential to configure wireless.' });
      return null;
    }
    let ctx: WirelessContext;
    let view;
    try { ctx = await makeCtx(row); view = await readWireless(ctx); }
    catch (err) { writeErr(res, err); return null; }
    if (view.stack === 'none') { res.status(400).json({ error: 'This device has no wireless hardware.' }); return null; }
    const iface = view.interfaces.find((i) => i.id === req.params.ifaceId || i.name === req.params.ifaceId);
    if (!iface) { res.status(404).json({ error: 'Wireless interface not found.' }); return null; }
    // Wireless-lockout guard: if RubyMIK manages this device OVER the very
    // wireless interface being changed, refuse unless explicitly forced.
    if (iface.carriesManagement && (req.body ?? {}).force !== true) {
      res.status(409).json({
        error: `"${iface.name}" appears to carry this device's management connection. Changing its SSID/security/channel could sever RubyMIK's access to the router. Re-send with force:true only if you are sure.`,
        wirelessLockoutWarning: true,
      });
      return null;
    }
    return { row, ctx, actor: actorOf(req), stack: view.stack, iface };
  }

  // ---- SSID + enable/disable ----
  router.put('/:id/wireless/:ifaceId/ssid', async (req, res) => {
    const m = await prepWrite(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ssid = typeof b.ssid === 'string' ? b.ssid : '';
    const enabled = b.enabled !== false;
    const errs = validateSsid(ssid);
    if (errs.length) {
      auditRejected(sac(m.row, m.actor, 'wireless.ssid', m.iface.name), `Set SSID on ${m.iface.name}`, `Rejected: ${errs.join(' ')}`);
      res.status(400).json({ error: errs.join(' ') }); return;
    }
    try {
      const outcome = await applySsid(m.ctx, m.stack, sac(m.row, m.actor, 'wireless.ssid', m.iface.name), m.iface.id, { ssid, enabled });
      res.status(outcome.result === 'applied' ? 200 : 502).json(outcome);
    } catch (err) { writeErr(res, err); }
  });

  // ---- Security (WPA2/WPA3 passphrase) — passphrase never logged/audited ----
  router.put('/:id/wireless/:ifaceId/security', async (req, res) => {
    const m = await prepWrite(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const passphrase = typeof b.passphrase === 'string' ? b.passphrase : '';
    const authTypes = Array.isArray(b.authTypes) && b.authTypes.length
      ? (b.authTypes as unknown[]).map(String)
      : (m.stack === 'wifi' ? ['wpa2-psk', 'wpa3-psk'] : ['wpa2-psk']);
    const errs = validatePassphrase(passphrase);          // length only — value never echoed
    if (errs.length) {
      auditRejected(sac(m.row, m.actor, 'wireless.security', m.iface.name), `Set Wi-Fi security on ${m.iface.name}`, `Rejected: ${errs.join(' ')}`);
      res.status(400).json({ error: errs.join(' ') }); return;
    }
    try {
      const outcome = await applySecurity(m.ctx, m.stack, sac(m.row, m.actor, 'wireless.security', m.iface.name), m.iface.id, { authTypes, passphrase });
      res.status(outcome.result === 'applied' ? 200 : 502).json(outcome);
    } catch (err) { writeErr(res, err); }
  });

  // ---- Band / channel / width ----
  router.put('/:id/wireless/:ifaceId/channel', async (req, res) => {
    const m = await prepWrite(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const band = typeof b.band === 'string' && b.band ? b.band : undefined;
    const frequency = b.frequency == null || b.frequency === '' ? null : Number(b.frequency);
    const width = typeof b.width === 'string' && b.width ? b.width : undefined;
    const errs = validateChannel(m.stack, { band, frequency, width });
    if (errs.length) {
      auditRejected(sac(m.row, m.actor, 'wireless.channel', m.iface.name), `Set Wi-Fi channel on ${m.iface.name}`, `Rejected: ${errs.join(' ')}`);
      res.status(400).json({ error: errs.join(' ') }); return;
    }
    try {
      const outcome = await applyChannel(m.ctx, m.stack, sac(m.row, m.actor, 'wireless.channel', m.iface.name), m.iface.id, { band, frequency, width });
      res.status(outcome.result === 'applied' ? 200 : 502).json(outcome);
    } catch (err) { writeErr(res, err); }
  });

  return router;
}
