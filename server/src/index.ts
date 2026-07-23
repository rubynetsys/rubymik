import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.js';
import { log, setLogLevel } from './log.js';
import { openDb, preMigratePlan, BootError, type MigrationStatus } from './db.js';
import { runSelfBackup, writeSelfBackupLog } from './selfbackup.js';
import { appUpdateRoutes } from './routes/appupdate.js';
import { startUpdateChecks } from './appupdate.js';
import { APP_VERSION } from './version.js';
import { securityHeaders, inlineScriptHashes } from './security.js';
import { SecretBox } from './secretbox.js';
import { Poller } from './poller.js';
import { BackupScheduler } from './backupscheduler.js';
import { installCaptureHook } from './snapshothook.js';
import { SnapshotScheduler } from './snapshotscheduler.js';
import { SelfBackupScheduler } from './selfbackupscheduler.js';
import { selfbackupRoutes } from './routes/selfbackup.js';
import { snapshotRoutes } from './routes/snapshots.js';
import { snaprestoreRoutes } from './routes/snaprestore.js';
import { AlertEngine } from './alerts.js';
import { WanEngine } from './wanengine.js';
import { Notifier } from './notify.js';
import { ResolverHealthMonitor } from './dnshealth.js';
import { ensureResolverConfig } from './resolver.js';
import { alertRoutes } from './routes/alerts.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { roleEnforcer } from './auth.js';
import { deviceRoutes } from './routes/devices.js';
import { detailRoutes } from './routes/detail.js';
import { dhcpRoutes, auditRoutes } from './routes/dhcp.js';
import { firewallRoutes } from './routes/firewall.js';
import { backupRoutes } from './routes/backup.js';
import { netconfigRoutes } from './routes/netconfig.js';
import { wirelessRoutes } from './routes/wireless.js';
import { netroutesRoutes } from './routes/netroutes.js';
import { netwireguardRoutes } from './routes/netwireguard.js';
import { netaddrRoutes } from './routes/netaddr.js';
import { netl2Routes } from './routes/netl2.js';
import { netnatRoutes } from './routes/netnat.js';
import { netqosRoutes } from './routes/netqos.js';
import { netpppoeRoutes } from './routes/netpppoe.js';
import { netwanRoutes } from './routes/netwan.js';
import { dnsFilterRoutes, dnsEnforceRoutes } from './routes/netdns.js';
import { netvpnRoutes } from './routes/netvpn.js';
import { remoteAccessRoutes } from './routes/remoteaccess.js';
import { provisionRoutes } from './routes/provision.js';
import { WireguardHub } from './wireguard.js';
import { siteRoutes } from './routes/sites.js';
import { fleetRoutes } from './routes/fleet.js';
import { fleetUpdateRoutes } from './routes/fleetupdate.js';
import { topologyRoutes } from './routes/topology.js';
import http from 'node:http';
import { webfigSessionRoutes, webfigProxyApp } from './routes/webfig.js';

const config = loadConfig();
setLogLevel(config.logLevel);

// P36: RubyMIK's OWN DB self-backup key (dedicated; disabled until RUBYMIK_BACKUP_KEY
// is set). P38 reuses it for the pre-migration backup below.
const backupKey = config.backupKeyHex ? Buffer.from(config.backupKeyHex, 'hex') : null;

// P38 boot upgrade-guard: when the schema OR the app version has moved, take a
// fail-closed pre-migration backup BEFORE any migration is applied. A REQUIRED
// backup that cannot be taken aborts startup — RubyMIK never migrates real data
// without a safety net. (Rollback = restore that backup + pin the old image tag.)
function preMigrateBackup(status: MigrationStatus, mdb: DatabaseSync): void {
  const plan = preMigratePlan(status, { backupConfigured: !!backupKey });
  if (plan.action === 'skip') { log.info(`Boot upgrade-guard: ${plan.reason}`); return; }
  if (plan.action === 'refuse') throw new BootError(plan.reason);
  try {
    const res = runSelfBackup(mdb, backupKey!, config.dataDir, 'pre-upgrade');
    try { writeSelfBackupLog(mdb, { kind: 'startup', status: 'ok', filename: res.name, manifest: res.manifest, detail: `pre-upgrade backup (schema ${status.prevSchema}→${status.targetSchema}, app ${status.prevAppVersion ?? '—'}→${status.appVersion})` }); } catch { /* log table predates this DB */ }
    log.info(`Boot upgrade-guard: pre-upgrade backup written (${res.file}).`);
  } catch (err) {
    const msg = (err as Error).message;
    try { writeSelfBackupLog(mdb, { kind: 'startup', status: 'failed', detail: `pre-upgrade backup FAILED: ${msg}` }); } catch { /* best-effort */ }
    if (plan.action === 'backup-required') {
      throw new BootError(`Pre-migration backup FAILED — refusing to migrate (fail-closed): ${msg}. Fix the backup key/destination and retry, or pin the previous image tag (see README-DEPLOY.md § Rollback).`);
    }
    log.warn(`Boot upgrade-guard: courtesy backup failed, continuing (schema unchanged): ${msg}`);
  }
}

let db: DatabaseSync;
try {
  db = openDb(config.dataDir, { beforeMigrate: preMigrateBackup });
} catch (err) {
  if (err instanceof BootError) { log.error(err.message); process.exit(1); }
  throw err;
}
const box = SecretBox.load(config.dataDir, config.encryptionKeyHex);
installCaptureHook(db, box); // P21: bracket every config write with pre/post snapshots (fail-closed)
const notifier = new Notifier(db, box);
const alertEngine = new AlertEngine(db, notifier);
const wanEngine = new WanEngine(db, notifier);
const poller = new Poller(db, box, config.pollIntervalSec * 1000, config.pollConcurrency, alertEngine, wanEngine);
const backupScheduler = new BackupScheduler(db, box, config.backupIntervalSec * 1000, config.backupKeep);
const snapshotScheduler = new SnapshotScheduler(db, box, config.snapshotIntervalSec * 1000);
const wgHub = new WireguardHub(db, box);
let updateChecker: { stop: () => void } = { stop: () => {} }; // P38: replaced once the server is listening
const SELFBACKUP_GAP_HOURS = 8;
const selfBackupScheduler = new SelfBackupScheduler(db, backupKey, config.dataDir, config.selfBackupIntervalSec * 1000, config.selfBackupKeep, notifier, SELFBACKUP_GAP_HOURS);
// P43: watch the (single, global) filtering resolver — a dead resolver on a fail-open site is
// silent no-filtering. Only when filtering is deployed. Boot writes a default config if none
// exists yet, so the resolver container has something to start from.
const resolverHealth = config.dnsFilter.enabled
  ? new ResolverHealthMonitor({ dnsHost: config.dnsFilter.dnsHost, dnsPort: config.dnsFilter.dnsPort }, notifier, config.pollIntervalSec > 0 ? config.pollIntervalSec : 30)
  : null;
if (config.dnsFilter.enabled) ensureResolverConfig(config.dnsFilter.configPath);

const app = express();
app.disable('x-powered-by');
// P39: behind a TLS-terminating reverse proxy, honour X-Forwarded-* so req.secure
// (→ Secure cookie) and req.ip (→ rate-limit key) are correct. Off by default
// (direct LAN HTTP). See RUBYMIK_TRUST_PROXY and the reverse-proxy section in the docs.
if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

// The built dashboard's location (Docker: /app/public; repo: web/dist). Resolved
// early so the CSP can hash the exact inline script that index.html actually serves.
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = [path.resolve(here, '..', 'public'), path.resolve(here, '..', '..', 'web', 'dist')]
  .find((dir) => fs.existsSync(path.join(dir, 'index.html')))
  ?? path.resolve(here, '..', 'public');
const indexHtml = path.join(publicDir, 'index.html');

// P39: security headers (CSP + hardening) on every response, before any route.
app.use(securityHeaders({ scriptHashes: inlineScriptHashes(indexHtml), webfigPort: config.webfigPort }));

// JSON body parsing is scoped to the API only — the WebFig proxy paths
// (/webfig, /jsproxy) must receive the RAW request stream to pipe upstream.
app.use('/api', express.json());

app.use('/api', authRoutes(db, { theme: config.defaultTheme, accent: config.defaultAccent, demoBanner: config.demoBanner, demoCredentials: config.demoCredentials }, notifier, config.publicUrl));
// P30: server-side role gate. Runs AFTER the self-service auth routes above (login,
// logout, /me, own theme/password/2FA) so those stay reachable by any role, and
// BEFORE every protected router below. Viewers are read-only; /api/users is admin-only.
app.use('/api', roleEnforcer(db));
app.use('/api/users', userRoutes(db));
app.use('/api/devices', webfigSessionRoutes(db, box, config.webfigPort));
app.use('/api/devices', deviceRoutes(db, box, poller));
app.use('/api/devices', detailRoutes(db, box, poller));
app.use('/api/devices', dhcpRoutes(db, box));
app.use('/api/devices', firewallRoutes(db, box));
app.use('/api/devices', backupRoutes(db, box, backupScheduler));
app.use('/api/devices', netconfigRoutes(db, box));
app.use('/api/devices', wirelessRoutes(db, box));
app.use('/api/devices', netroutesRoutes(db, box));
app.use('/api/devices', netwireguardRoutes(db, box));
app.use('/api/devices', netaddrRoutes(db, box));
app.use('/api/devices', netl2Routes(db, box));
app.use('/api/devices', netnatRoutes(db, box));
app.use('/api/devices', netqosRoutes(db, box));
app.use('/api/devices', netpppoeRoutes(db, box));
app.use('/api/devices', netwanRoutes(db, box));
app.use('/api/dns-filter', dnsFilterRoutes(db, config));
app.use('/api/devices', dnsEnforceRoutes(db, box));
app.use('/api/devices', netvpnRoutes(db, box));
app.use('/api/backup', selfbackupRoutes(db, backupKey, config.dataDir, box, selfBackupScheduler, SELFBACKUP_GAP_HOURS));
app.use('/api/devices', snapshotRoutes(db, box, snapshotScheduler));
app.use('/api/devices', snaprestoreRoutes(db, box));
app.use('/api/remote-access', remoteAccessRoutes(db, box, wgHub));
app.use('/api/provision', provisionRoutes(db));
app.use('/api/sites', siteRoutes(db));
app.use('/api/fleet', fleetRoutes(db, poller, config.pollIntervalSec));
app.use('/api/fleet', fleetUpdateRoutes(db, box));
app.use('/api/topology', topologyRoutes(db));
app.use('/api/alerts', alertRoutes(db, notifier));
app.use('/api/audit', auditRoutes(db));
app.use('/api/update', appUpdateRoutes(db, config.updateUrl)); // P38: in-app update check (read/manual/config; never applies)

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// P21 backstop: a fail-closed write refusal (SnapshotRequiredError) that reaches
// here becomes 409 {snapshotRequired}. Write routes already surface this via
// writeErr; this covers any handler that lets it propagate.
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const e = err as { snapshotRequired?: boolean; message?: string };
  if (e && e.snapshotRequired) { if (!res.headersSent) res.status(409).json({ error: e.message, snapshotRequired: true }); return; }
  next(err as Error);
});

// Serve the built dashboard (publicDir/indexHtml resolved above for the CSP).
// In development the Vite dev server handles the UI and proxies /api here.
if (fs.existsSync(indexHtml)) {
  app.use(express.static(publicDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(indexHtml);
  });
} else {
  log.warn(`No web build found at ${publicDir} — API only (run "npm run dev:web" for the UI in development)`);
}

const server = app.listen(config.port, '0.0.0.0', () => {
  log.info(`RubyMIK listening on http://0.0.0.0:${config.port} (data: ${config.dataDir}, log: ${config.logLevel})`);
  if (config.pollIntervalSec > 0) poller.start();
  else log.warn('Polling disabled (RUBYMIK_POLL_INTERVAL=0) — serving stored status/topology only');
  backupScheduler.start();
  snapshotScheduler.start();
  selfBackupScheduler.start();
  updateChecker = startUpdateChecks(db, { currentVersion: APP_VERSION, defaultUrl: config.updateUrl }); // P38: daily update check (opt-out honored, offline-safe)
  void wgHub.startup(); // no-op unless remote access was enabled; never fatal
  resolverHealth?.start(); // P43: only when filtering is deployed
});

// The WebFig reverse proxy runs on its own port (router admin UIs need web-root
// '/'). Every request is auth+scope-gated and resolved by device id — see
// routes/webfig.ts. Set RUBYMIK_WEBFIG_PORT=0 to disable the feature entirely.
let webfigServer: http.Server | undefined;
if (config.webfigPort > 0) {
  webfigServer = http.createServer(webfigProxyApp(db, box));
  webfigServer.listen(config.webfigPort, '0.0.0.0', () => {
    log.info(`WebFig proxy listening on http://0.0.0.0:${config.webfigPort} (router admin UIs, auth+scope-gated by RubyMIK session)`);
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    poller.stop();
    backupScheduler.stop();
    selfBackupScheduler.stop();
    updateChecker.stop();
    resolverHealth?.stop();
    webfigServer?.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
