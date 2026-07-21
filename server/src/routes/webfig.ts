import express, { Router, type Express, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, getSessionUser, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import { allSites, scopeFilter, type AccessScope } from '../scope.js';
import { readTarget, resolveEndpoint, transportFor } from '../transport.js';
import {
  issueWebfigToken, verifyWebfigToken, webfigCookieHeader, proxyToDevice,
  WEBFIG_COOKIE, type ProxyRow,
} from '../webfig.js';
import { log } from '../log.js';

/**
 * WebFig proxy routes (P15). Two pieces:
 *   1. POST /api/devices/:id/webfig/session — auth+scope-gated. Confirms the
 *      device is in inventory and authorized, resolves + persists its transport,
 *      AUDITS the privileged open, and issues the short-lived signed cookie.
 *   2. webfigProxy() — an app-level handler mounted on WebFig's own absolute
 *      paths (/webfig, /jsproxy), before the SPA. Re-checks auth+scope on every
 *      request and streams to the device over the resolved transport.
 */

interface DeviceRow extends ProxyRow {
  site_id: number | null;
  use_tls: number | null;
  port: number | null;
}

/** Load a device by id, honoring the requester's scope (target-by-inventory only). */
function loadDevice(db: DatabaseSync, id: number, scope: AccessScope): DeviceRow | undefined {
  const filter = scopeFilter(scope, 'd.site_id');
  return db.prepare(`SELECT d.* FROM devices d WHERE d.id = ?${filter.sql}`)
    .get(id, ...filter.params) as unknown as DeviceRow | undefined;
}

// P1 is single-admin → allSites(). Per-user tenancy swaps this one line (see scope.ts).
function scopeFor(_user: SessionUser): AccessScope {
  return allSites();
}

function schemePort(row: DeviceRow): { scheme: 'http' | 'https'; port: number } {
  const scheme = row.use_tls === 1 ? 'https' : 'http';
  return { scheme, port: row.port ?? (scheme === 'https' ? 443 : 80) };
}

export function webfigSessionRoutes(db: DatabaseSync, box: SecretBox, webfigPort: number): Router {
  const router = Router();
  router.use(requireAuth(db));

  // Open (or refresh) a WebFig proxy session for a managed device.
  router.post('/:id/webfig/session', async (req, res) => {
    const user = (req as unknown as { user: SessionUser }).user;
    const id = Number(req.params.id);
    const row = loadDevice(db, id, scopeFor(user));
    if (!row) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }

    // Resolve transport server-side (direct LAN vs P9 tunnel overlay) and probe
    // scheme/port if never connected, persisting it for the proxy to reuse.
    const { host, net } = resolveEndpoint(row);
    try {
      const target = readTarget(box, row);
      const t = await transportFor(row, target);
      if (row.use_tls === null) {
        db.prepare('UPDATE devices SET use_tls = ?, port = ?, updated_at = ? WHERE id = ?')
          .run(t.scheme === 'https' ? 1 : 0, t.port, new Date().toISOString(), row.id);
        row.use_tls = t.scheme === 'https' ? 1 : 0;
        row.port = t.port;
      }
    } catch (err) {
      res.status(502).json({ error: `The router's web interface is unreachable right now: ${(err as Error).message}` });
      return;
    }

    // Audit the privileged open — who, when, which device, which transport.
    // No credential and no session content are recorded.
    db.prepare(`
      INSERT INTO config_audit (device_id, device_name, actor, action, target, summary, before_json, after_json, result, detail, created_at)
      VALUES (?, ?, ?, 'webfig.open', ?, ?, NULL, NULL, 'ok', NULL, ?)
    `).run(row.id, row.name, user.username, net,
      `Opened WebFig admin session over ${net} transport`, new Date().toISOString());
    log.info(`WebFig session opened by "${user.username}" for device #${row.id} "${row.name}" (${net})`);

    res.setHeader('Set-Cookie', webfigCookieHeader(issueWebfigToken(row.id, user.id)));
    // The browser reaches the router UI on the dedicated WebFig port (WebFig needs
    // web-root '/'). The client builds the absolute URL from its own hostname.
    res.json({ webfigPort, transport: net, host: net === 'tunnel' ? host : row.host });
  });

  return router;
}

/**
 * The WebFig reverse proxy as a STANDALONE express app, to run on its own port.
 * WebFig assumes it owns web-root '/' (its login form is served at '/'), so it
 * gets a dedicated listener where every path maps to the router — no collision
 * with RubyMIK's own SPA, no HTML/JS rewriting.
 *
 * Every request is independently authenticated (RubyMIK session cookie),
 * cookie-verified (the short-lived signed WebFig token → a device id), and
 * scope-checked. The target host is resolved from the inventory row, never from
 * the client, so this can only ever reach a managed device the user may access.
 * No body parser is attached, so /jsproxy POST bodies stream through untouched.
 */
export function webfigProxyApp(db: DatabaseSync, box: SecretBox): Express {
  void box; // Option A: no credential is used in the proxy path.
  const app = express();
  app.disable('x-powered-by');
  app.use((req: Request, res: Response) => {
    const user = getSessionUser(db, req);
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }

    const cookies = (req.headers.cookie ?? '').split(';').map((c) => c.trim());
    const token = cookies.find((c) => c.startsWith(`${WEBFIG_COOKIE}=`))?.slice(WEBFIG_COOKIE.length + 1);
    const deviceId = verifyWebfigToken(token, user.id);
    if (deviceId === null) {
      res.status(403).json({ error: 'No active WebFig session. Open Router Admin for a device first.' });
      return;
    }

    const row = loadDevice(db, deviceId, scopeFor(user));
    if (!row) { res.status(403).json({ error: 'Not authorized for this device.' }); return; }

    const { scheme, port } = schemePort(row);
    proxyToDevice(req, res, row, scheme, port);
  });
  return app;
}
