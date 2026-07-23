import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  port: number;
  dataDir: string;
  logLevel: LogLevel;
  encryptionKeyHex: string | undefined;
  /** P36: DEDICATED key for RubyMIK's own DB self-backup (NOT the field key).
   *  When unset, self-backups are DISABLED and the UI prompts to set one up. */
  backupKeyHex: string | undefined;
  /** Seconds between RubyMIK DB self-backups (P36). */
  selfBackupIntervalSec: number;
  /** How many DB self-backups to retain locally (P36). */
  selfBackupKeep: number;
  /** Seconds between device poll cycles. */
  pollIntervalSec: number;
  /** Max devices polled in parallel within a cycle. */
  pollConcurrency: number;
  /** Dedicated port for the WebFig reverse proxy (router admin UIs need web-root
   *  '/', so they get their own listener). 0 disables the WebFig feature. */
  webfigPort: number;
  /** Seconds between scheduled config-backup runs (all devices). */
  backupIntervalSec: number;
  /** How many backups to retain per device. */
  backupKeep: number;
  /** Seconds between scheduled config-SNAPSHOT runs (P21; all devices, read-only). */
  snapshotIntervalSec: number;
  /** Instance default theme (a user's own choice overrides it). */
  defaultTheme: string;
  defaultAccent: string | null;
  /** P41: when set, a persistent banner is shown on every screen (incl. login) —
   *  used by the public demo ("resets nightly — do not enter real credentials"). */
  demoBanner: string | null;
  /** P41: in demo mode, the read-only VIEWER credentials the login page advertises on a
   *  "Try the demo" card. MUST match what the demo seed (scripts/reset-demo.sh) creates —
   *  both read RUBYMIK_DEMO_VIEWER_EMAIL / RUBYMIK_DEMO_VIEWER_PASS. Null when not demo. */
  demoCredentials: { email: string; password: string } | null;
  /** P38: override the version.json URL the update check fetches (else the built-in
   *  default). The DB config row can also override it per-instance. */
  updateUrl: string | undefined;
  /** P39: Express `trust proxy` setting. Enable when running behind a TLS-terminating
   *  reverse proxy so X-Forwarded-Proto/For are honoured (Secure cookie, real client
   *  IP for rate-limiting). false | true | <hops> | a subnet/keyword string. */
  trustProxy: boolean | number | string;
  /** P40: the externally-reachable base URL (e.g. https://rubymik.example.com), used
   *  to build password-reset links. Falls back to the request's own host. */
  publicUrl: string | undefined;
  /** P43: DNS content filtering. Enabled only by the opt-in docker-compose.filtering.yml,
   *  which also mounts the Blocky config volume + the Docker socket RubyMIK uses to restart
   *  the resolver on "Save & apply". When disabled the filtering UI is read-only/off. */
  dnsFilter: {
    enabled: boolean;
    configPath: string;       // where RubyMIK writes the Blocky config (shared volume)
    blockyContainer: string;  // container name RubyMIK restarts via the Docker socket
    dnsHost: string;          // host:port RubyMIK probes to verify the resolver after reload
    dnsPort: number;
    dockerSock: string;
  };
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

export function loadConfig(): Config {
  const port = Number(process.env.RUBYMIK_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`RUBYMIK_PORT must be a port number, got "${process.env.RUBYMIK_PORT}"`);
  }

  const dataDir = path.resolve(process.env.RUBYMIK_DATA_DIR ?? './data');
  fs.mkdirSync(dataDir, { recursive: true });

  const rawLevel = (process.env.RUBYMIK_LOG_LEVEL ?? 'info').toLowerCase();
  const logLevel = (LOG_LEVELS as string[]).includes(rawLevel) ? (rawLevel as LogLevel) : 'info';

  const encryptionKeyHex = process.env.RUBYMIK_ENCRYPTION_KEY || undefined;
  if (encryptionKeyHex !== undefined && !/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
    throw new Error('RUBYMIK_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  }

  // P36: a SEPARATE key for the DB self-backup. Deliberately no file fallback
  // (unlike the field key) — a backup encrypted with the field key would defeat
  // the point, so this must be set explicitly or self-backups stay disabled.
  const backupKeyHex = process.env.RUBYMIK_BACKUP_KEY || undefined;
  if (backupKeyHex !== undefined && !/^[0-9a-fA-F]{64}$/.test(backupKeyHex)) {
    throw new Error('RUBYMIK_BACKUP_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  }
  if (backupKeyHex !== undefined && backupKeyHex === encryptionKeyHex) {
    throw new Error('RUBYMIK_BACKUP_KEY must differ from RUBYMIK_ENCRYPTION_KEY — the backup key protects the whole DB (which already contains field-encrypted secrets).');
  }
  const selfBackupIntervalSec = intEnv('RUBYMIK_SELFBACKUP_INTERVAL', 21600, 300, 2592000); // 6h default
  const selfBackupKeep = intEnv('RUBYMIK_SELFBACKUP_KEEP', 28, 2, 500);                      // 7 days @ 6h

  // 0 = polling disabled (serve stored status/topology only — useful for a
  // frozen/demo/read-only instance); otherwise 5..3600s.
  const pollIntervalSec = process.env.RUBYMIK_POLL_INTERVAL === '0'
    ? 0
    : intEnv('RUBYMIK_POLL_INTERVAL', 30, 5, 3600);
  const pollConcurrency = intEnv('RUBYMIK_POLL_CONCURRENCY', 4, 1, 16);
  // WebFig proxy gets its own port (default main+1) because WebFig assumes it is
  // served from web-root '/'. 0 turns the feature off.
  const webfigPort = process.env.RUBYMIK_WEBFIG_PORT === '0'
    ? 0
    : intEnv('RUBYMIK_WEBFIG_PORT', port + 1, 1, 65535);
  const backupIntervalSec = intEnv('RUBYMIK_BACKUP_INTERVAL', 86400, 60, 2592000);
  const backupKeep = intEnv('RUBYMIK_BACKUP_KEEP', 10, 1, 500);
  const snapshotIntervalSec = intEnv('RUBYMIK_SNAPSHOT_INTERVAL', 86400, 60, 2592000);

  const defaultTheme = (process.env.RUBYMIK_DEFAULT_THEME || 'ruby-light').trim();
  const defaultAccent = process.env.RUBYMIK_DEFAULT_ACCENT ? process.env.RUBYMIK_DEFAULT_ACCENT.trim() : null;
  // P41: RUBYMIK_DEMO_MODE=1 turns on demo mode (the resets-nightly banner AND the login
  // "Try the demo" credentials card). RUBYMIK_DEMO_BANNER only customizes the banner text.
  const demoMode = /^(1|true|on|yes)$/i.test(process.env.RUBYMIK_DEMO_MODE ?? '');
  const demoBanner = process.env.RUBYMIK_DEMO_BANNER
    ? process.env.RUBYMIK_DEMO_BANNER.trim()
    : (demoMode ? 'Demo instance — resets nightly — do not enter real credentials.' : null);
  // The login card advertises the VIEWER login. These MUST match what the demo seed
  // (scripts/reset-demo.sh) creates — both default to demo@rubymik.com / rubymik-demo and
  // both read RUBYMIK_DEMO_VIEWER_EMAIL / RUBYMIK_DEMO_VIEWER_PASS (single source: .env).
  const demoCredentials = demoMode
    ? {
        email: (process.env.RUBYMIK_DEMO_VIEWER_EMAIL || 'demo@rubymik.com').trim(),
        password: process.env.RUBYMIK_DEMO_VIEWER_PASS || 'rubymik-demo',
      }
    : null;

  const updateUrl = process.env.RUBYMIK_UPDATE_URL ? process.env.RUBYMIK_UPDATE_URL.trim() : undefined;
  if (updateUrl !== undefined && !/^https?:\/\//i.test(updateUrl)) {
    throw new Error('RUBYMIK_UPDATE_URL must be an http(s) URL.');
  }

  const trustProxy = parseTrustProxy(process.env.RUBYMIK_TRUST_PROXY);

  const publicUrl = process.env.RUBYMIK_PUBLIC_URL ? process.env.RUBYMIK_PUBLIC_URL.trim().replace(/\/$/, '') : undefined;
  if (publicUrl !== undefined && !/^https?:\/\//i.test(publicUrl)) {
    throw new Error('RUBYMIK_PUBLIC_URL must be an http(s) URL.');
  }

  const dnsFilter = {
    enabled: /^(1|true|on|yes)$/i.test(process.env.RUBYMIK_DNSFILTER_ENABLED ?? ''),
    configPath: process.env.RUBYMIK_DNSFILTER_CONFIG || '/dnsfilter/config.yml',
    blockyContainer: process.env.RUBYMIK_BLOCKY_CONTAINER || 'rubymik-blocky',
    dnsHost: process.env.RUBYMIK_BLOCKY_DNS_HOST || 'rubymik-blocky',
    dnsPort: intEnv('RUBYMIK_BLOCKY_DNS_PORT', 53, 1, 65535),
    dockerSock: process.env.RUBYMIK_DOCKER_SOCK || '/var/run/docker.sock',
  };

  return { port, dataDir, logLevel, encryptionKeyHex, backupKeyHex, selfBackupIntervalSec, selfBackupKeep, pollIntervalSec, pollConcurrency, webfigPort, backupIntervalSec, backupKeep, snapshotIntervalSec, defaultTheme, defaultAccent, demoBanner, demoCredentials, updateUrl, trustProxy, publicUrl, dnsFilter };
}

/** RUBYMIK_TRUST_PROXY: unset/false/0 → off; true/1 → trust the immediate proxy;
 *  a number → that many hops; anything else (e.g. "loopback", "10.0.0.0/8") is
 *  passed to Express verbatim. */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === '' || /^(false|0|off|no)$/i.test(raw)) return false;
  if (/^(true|1|on|yes)$/i.test(raw)) return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw.trim();
}
