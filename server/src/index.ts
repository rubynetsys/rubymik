import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { log, setLogLevel } from './log.js';
import { openDb } from './db.js';
import { SecretBox } from './secretbox.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';

const config = loadConfig();
setLogLevel(config.logLevel);

const db = openDb(config.dataDir);
const box = SecretBox.load(config.dataDir, config.encryptionKeyHex);

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.use('/api', authRoutes(db));
app.use('/api/devices', deviceRoutes(db, box));

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
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
