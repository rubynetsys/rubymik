import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { log, setLogLevel } from './log.js';
import { openDb } from './db.js';
import { SecretBox } from './secretbox.js';
import { Poller } from './poller.js';
import { BackupScheduler } from './backupscheduler.js';
import { AlertEngine } from './alerts.js';
import { Notifier } from './notify.js';
import { alertRoutes } from './routes/alerts.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { detailRoutes } from './routes/detail.js';
import { dhcpRoutes, auditRoutes } from './routes/dhcp.js';
import { firewallRoutes } from './routes/firewall.js';
import { backupRoutes } from './routes/backup.js';
import { netconfigRoutes } from './routes/netconfig.js';
import { remoteAccessRoutes } from './routes/remoteaccess.js';
import { provisionRoutes } from './routes/provision.js';
import { WireguardHub } from './wireguard.js';
import { siteRoutes } from './routes/sites.js';
import { fleetRoutes } from './routes/fleet.js';
import { topologyRoutes } from './routes/topology.js';

const config = loadConfig();
setLogLevel(config.logLevel);

const db = openDb(config.dataDir);
const box = SecretBox.load(config.dataDir, config.encryptionKeyHex);
const notifier = new Notifier(db);
const alertEngine = new AlertEngine(db, notifier);
const poller = new Poller(db, box, config.pollIntervalSec * 1000, config.pollConcurrency, alertEngine);
const backupScheduler = new BackupScheduler(db, box, config.backupIntervalSec * 1000, config.backupKeep);
const wgHub = new WireguardHub(db, box);

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.use('/api', authRoutes(db, { theme: config.defaultTheme, accent: config.defaultAccent }));
app.use('/api/devices', deviceRoutes(db, box, poller));
app.use('/api/devices', detailRoutes(db, box, poller));
app.use('/api/devices', dhcpRoutes(db, box));
app.use('/api/devices', firewallRoutes(db, box));
app.use('/api/devices', backupRoutes(db, box, backupScheduler));
app.use('/api/devices', netconfigRoutes(db, box));
app.use('/api/remote-access', remoteAccessRoutes(db, box, wgHub));
app.use('/api/provision', provisionRoutes(db));
app.use('/api/sites', siteRoutes(db));
app.use('/api/fleet', fleetRoutes(db, poller, config.pollIntervalSec));
app.use('/api/topology', topologyRoutes(db));
app.use('/api/alerts', alertRoutes(db, notifier));
app.use('/api/audit', auditRoutes(db));

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve the built dashboard. Docker image layout: /app/public (baked in);
// repo layout (`npm run build && npm start`): web/dist.
// In development the Vite dev server handles the UI and proxies /api here.
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = [path.resolve(here, '..', 'public'), path.resolve(here, '..', '..', 'web', 'dist')]
  .find((dir) => fs.existsSync(path.join(dir, 'index.html')))
  ?? path.resolve(here, '..', 'public');
const indexHtml = path.join(publicDir, 'index.html');
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
  void wgHub.startup(); // no-op unless remote access was enabled; never fatal
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    poller.stop();
    backupScheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
