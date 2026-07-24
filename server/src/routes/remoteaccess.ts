import { Router, type Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type SessionUser } from '../auth.js';
import type { SecretBox } from '../secretbox.js';
import type { WireguardHub } from '../wireguard.js';
import { writeAudit } from '../safeapply.js';
import {
  allocateTunnelIp, createPeer, generateBootstrap, isValidWgKey,
  type HubConfig, type PeerRow,
} from '../remoteaccess.js';
import { generateHubCompose, hubComposeCli, parseHostPort, isMounted, type RunningConfig } from '../hubcapability.js';
import { APP_VERSION } from '../version.js';
import { log } from '../log.js';

/**
 * Remote-access (WireGuard) management API. Every provisioning action is audited.
 * Reads never expose key material; the hub private key never leaves the server.
 */
export function remoteAccessRoutes(db: DatabaseSync, box: SecretBox, hub: WireguardHub): Router {
  const router = Router();
  router.use(requireAuth(db));
  const actorOf = (req: Request) => (req as Request & { user: SessionUser }).user.username;
  const audit = (actor: string, action: string, target: string | null, summary: string, detail: string, result = 'applied') =>
    writeAudit({ db, actor, deviceId: null as unknown as number, deviceName: 'remote-access', action, targetLabel: target }, result as never, summary, null, null, detail);

  function hubConfig(): HubConfig | null {
    const r = db.prepare('SELECT endpoint, listen_port, overlay_cidr, hub_address, public_key FROM wg_hub WHERE id = 1').get() as
      | { endpoint: string | null; listen_port: number; overlay_cidr: string; hub_address: string; public_key: string | null } | undefined;
    if (!r || !r.endpoint || !r.public_key) return null;
    return { endpoint: r.endpoint, listenPort: r.listen_port, overlayCidr: r.overlay_cidr, hubAddress: r.hub_address, publicKey: r.public_key };
  }

  function peersView() {
    const rows = db.prepare(`
      SELECT p.*, d.name AS device_name FROM wg_peers p
      LEFT JOIN devices d ON d.id = p.device_id ORDER BY p.tunnel_ip
    `).all() as unknown as Array<PeerRow & { device_name: string | null }>;
    return rows.map((p) => ({
      id: p.id, label: p.label, tunnelIp: p.tunnel_ip,
      hasKey: !!p.public_key, status: p.status,
      deviceId: p.device_id, deviceName: p.device_name,
      lastHandshakeAt: p.last_handshake_at, createdAt: p.created_at,
    }));
  }

  // Hub status + peers (live handshake state merged in). No key material.
  router.get('/', async (_req, res) => {
    const status = await hub.status();
    // Merge live per-peer handshake state onto the registered peers by pubkey.
    const live = new Map(status.peers.map((p) => [p.publicKey, p]));
    const peers = db.prepare('SELECT id, public_key FROM wg_peers').all() as Array<{ id: number; public_key: string | null }>;
    const liveById: Record<number, { state: string; latestHandshakeUnix: number; rxBytes: number; txBytes: number } | null> = {};
    for (const p of peers) liveById[p.id] = p.public_key && live.has(p.public_key)
      ? (() => { const l = live.get(p.public_key!)!; return { state: l.state, latestHandshakeUnix: l.latestHandshakeUnix, rxBytes: l.rxBytes, txBytes: l.txBytes }; })()
      : null;
    res.json({ hub: status, peers: peersView(), live: liveById });
  });

  // Capability pre-check (P45). Called at page load BEFORE the Enable button is
  // offered — so a click can never produce a raw RTNETLINK. Also returns the
  // ready-to-paste setup (per deployment method) for the not-capable case.
  router.get('/capability', async (req, res) => {
    const cap = await hub.capability();
    const hubRow = db.prepare('SELECT listen_port FROM wg_hub WHERE id = 1').get() as { listen_port: number } | undefined;
    const listenPort = hubRow?.listen_port ?? 51820;
    // The generated compose must reproduce the ACTUAL running config, not assume
    // 8080. The one thing the container can observe about its host publish is the
    // port the admin reached it on — the request Host header.
    const hdr = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
    const mainHostPort = parseHostPort({
      host: hdr(req.headers.host),
      forwardedHost: hdr(req.headers['x-forwarded-host']),
      forwardedPort: hdr(req.headers['x-forwarded-port']),
    });
    const cfg: RunningConfig = { version: APP_VERSION, mainHostPort, offhost: isMounted('/offhost'), listenPort };
    res.json({
      ...cap,
      listenPort,
      mainHostPort,
      compose: { portainer: generateHubCompose(cfg), cli: hubComposeCli() },
    });
  });

  // Configure the hub (operator supplies RubyMIK's reachable endpoint).
  router.post('/hub', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const endpoint = typeof b.endpoint === 'string' ? b.endpoint.trim() : '';
    const listenPort = Number(b.listenPort ?? 51820);
    const overlayCidr = typeof b.overlayCidr === 'string' && b.overlayCidr.trim() ? b.overlayCidr.trim() : undefined;
    if (!endpoint) { res.status(400).json({ error: 'A reachable endpoint (public IP or hostname) is required — the routers dial it.' }); return; }
    if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) { res.status(400).json({ error: 'listenPort must be a valid UDP port.' }); return; }
    try {
      await hub.configure({ endpoint, listenPort, overlayCidr });
      audit(actorOf(req), 'wg.hub.configure', endpoint, `Configured WireGuard hub endpoint ${endpoint}:${listenPort}`, 'Hub configured.');
      res.json(await hub.status());
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Enable / disable the hub (brings the interface up/down).
  router.post('/hub/enable', async (req, res) => {
    const enabled = (req.body ?? {}).enabled === true;
    if (enabled && !hub.isConfigured()) { res.status(400).json({ error: 'Configure the hub endpoint before enabling remote access.' }); return; }
    // Belt-and-suspenders: even if a stale page offers Enable, refuse with the
    // honest capability reason rather than letting up() fail on a raw RTNETLINK.
    if (enabled) {
      const cap = await hub.capability();
      if (!cap.capable) { res.status(409).json({ error: cap.reason, capability: cap }); return; }
    }
    try {
      await hub.setEnabled(enabled);
      const status = await hub.status();
      audit(actorOf(req), enabled ? 'wg.hub.enable' : 'wg.hub.disable', null,
        `${enabled ? 'Enabled' : 'Disabled'} WireGuard remote access`,
        enabled ? (status.running ? 'Hub interface is up.' : `Hub enabled but not running: ${status.runtimeError ?? 'unknown'}`) : 'Hub interface down.',
        enabled && !status.running ? 'failed' : 'applied');
      res.json(status);
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Add a remote site → allocate an overlay IP + return the one-time bootstrap.
  router.post('/sites', (req, res) => {
    const cfg = hubConfig();
    if (!cfg) { res.status(400).json({ error: 'Configure the hub endpoint first — the bootstrap needs the hub public key and endpoint.' }); return; }
    const label = typeof (req.body ?? {}).label === 'string' ? (req.body.label as string).trim() : '';
    if (!label) { res.status(400).json({ error: 'A site label is required.' }); return; }
    try {
      const tunnelIp = allocateTunnelIp(db, cfg.overlayCidr, cfg.hubAddress);
      const peer = createPeer(db, label, tunnelIp);
      audit(actorOf(req), 'wg.peer.add', `${label} (${tunnelIp})`, `Provisioned remote site "${label}" at ${tunnelIp}`, 'Peer created (pending key registration).');
      res.status(201).json({ peer: peersView().find((p) => p.id === peer.id), bootstrap: generateBootstrap(cfg, peer) });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Re-fetch a site's bootstrap (e.g. to copy it again). No secrets in it.
  router.get('/sites/:id/bootstrap', (req, res) => {
    const cfg = hubConfig();
    if (!cfg) { res.status(400).json({ error: 'Hub not configured.' }); return; }
    const peer = db.prepare('SELECT * FROM wg_peers WHERE id = ?').get(Number(req.params.id)) as unknown as PeerRow | undefined;
    if (!peer) { res.status(404).json({ error: 'Site not found.' }); return; }
    res.json({ bootstrap: generateBootstrap(cfg, peer) });
  });

  // Register the router's public key (printed by the bootstrap) → hub adds the peer.
  router.post('/sites/:id/register', async (req, res) => {
    const peer = db.prepare('SELECT * FROM wg_peers WHERE id = ?').get(Number(req.params.id)) as unknown as PeerRow | undefined;
    if (!peer) { res.status(404).json({ error: 'Site not found.' }); return; }
    const publicKey = typeof (req.body ?? {}).publicKey === 'string' ? (req.body.publicKey as string).trim() : '';
    if (!isValidWgKey(publicKey)) { res.status(400).json({ error: 'That does not look like a WireGuard public key (44-char base64).' }); return; }
    try {
      db.prepare('UPDATE wg_peers SET public_key = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(publicKey, 'registered', new Date().toISOString(), peer.id);
      await hub.syncPeers();
      audit(actorOf(req), 'wg.peer.register', `${peer.label} (${peer.tunnel_ip})`, `Registered router public key for "${peer.label}"`, 'Peer key registered; hub reconciled.');
      res.json({ ok: true, peer: peersView().find((p) => p.id === peer.id) });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Adopt the remote router as a managed device reached over the tunnel.
  router.post('/sites/:id/device', (req, res) => {
    const peer = db.prepare('SELECT * FROM wg_peers WHERE id = ?').get(Number(req.params.id)) as unknown as PeerRow | undefined;
    if (!peer) { res.status(404).json({ error: 'Site not found.' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : peer.label;
    const username = typeof b.username === 'string' ? b.username : '';
    const password = typeof b.password === 'string' ? b.password : '';
    // Require a username; password may be blank (RouterOS permits blank-password
    // users) — consistent with the direct add path (POST /devices).
    if (!username) { res.status(400).json({ error: 'A monitoring username is required to adopt the device.' }); return; }
    const wu = typeof b.writeUsername === 'string' && b.writeUsername ? b.writeUsername : null;
    const wp = typeof b.writePassword === 'string' && b.writePassword ? b.writePassword : null;
    let siteId: number | null = null;
    if (b.siteId !== undefined && b.siteId !== null && b.siteId !== '') {
      siteId = Number(b.siteId);
      if (!Number.isInteger(siteId) || !db.prepare('SELECT id FROM sites WHERE id = ?').get(siteId)) { res.status(400).json({ error: 'Invalid site.' }); return; }
    }
    const backupsEnabled = b.backupsEnabled === false ? 0 : 1;
    const now = new Date().toISOString();
    try {
      // Reached over the tunnel: net_transport='tunnel', tunnel_ip set; http:80 over the encrypted overlay.
      const id = db.prepare(`INSERT INTO devices
        (name, host, port, transport, use_tls, verify_tls, site_id, net_transport, tunnel_ip, username_enc, password_enc, write_username_enc, write_password_enc, backups_enabled, created_at, updated_at)
        VALUES (?, ?, 80, 'rest', 0, 0, ?, 'tunnel', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        name, peer.tunnel_ip, siteId, peer.tunnel_ip, box.encrypt(username), box.encrypt(password),
        wu ? box.encrypt(wu) : null, wp ? box.encrypt(wp) : null, backupsEnabled, now, now,
      ).lastInsertRowid as number;
      db.prepare('UPDATE wg_peers SET device_id = ?, updated_at = ? WHERE id = ?').run(id, now, peer.id);
      audit(actorOf(req), 'wg.peer.adopt', `${peer.label} → device #${id}`, `Adopted "${name}" as a tunnel device at ${peer.tunnel_ip}`, 'Device created with tunnel transport.');
      log.info(`Adopted remote device #${id} "${name}" over tunnel ${peer.tunnel_ip}`);
      res.status(201).json({ deviceId: id, tunnelIp: peer.tunnel_ip });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  return router;
}
