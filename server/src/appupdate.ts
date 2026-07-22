import type { DatabaseSync } from 'node:sqlite';
import { log } from './log.js';

/**
 * P38 — in-app UPDATE CHECK.
 *
 * A newer RubyMIK image may exist. This module fetches a small version.json from a
 * rubynet-controlled static URL, compares its semver against the running build, and
 * caches the answer so the UI can show a "vX is available — here's the pull command"
 * banner. That is ALL it does:
 *
 *   - There is NO auto-update path. RubyMIK never pulls, never restarts, never runs
 *     docker. Updating is always an operator action (see README-DEPLOY.md).
 *   - The check sends NOTHING but the HTTP GET — no telemetry, no instance id, no
 *     version-of-mine, no metrics. version.json is a plain static file; opt-in
 *     metrics, if ever, are a separate decision.
 *   - It is opt-out (a DB toggle) and fails silently offline (keeps the last cached
 *     result; the banner just goes stale, never errors).
 */

// The default location. Rubynet controls this host; the file is served statically.
// Overridable per-instance (env or the config row) for testing / air-gapped mirrors.
export const DEFAULT_UPDATE_URL = 'https://get.rubymik.com/version.json';

// ---------------- semver (small, dependency-free) ----------------

/** Parse "v1.2.3", "1.2.3", "1.2.3-rc1+build" → [1,2,3] (pre-release/build ignored). */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
/** -1 if a<b, 0 if equal, 1 if a>b. Unparseable sorts as 0.0.0. */
export function cmpSemver(a: string, b: string): number {
  const [a0, a1, a2] = parseSemver(a) ?? [0, 0, 0];
  const [b0, b1, b2] = parseSemver(b) ?? [0, 0, 0];
  if (a0 !== b0) return a0 < b0 ? -1 : 1;
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  return 0;
}

// ---------------- the version.json contract ----------------

export interface VersionDoc {
  latest: string;
  minimum_supported?: string;
  changelog_url?: string;
  breaking?: string[];
  notes?: string;
}

export interface UpdateReport {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** running a build older than the doc's minimum_supported. */
  belowMinimum: boolean;
  minimumSupported: string | null;
  /** breaking versions strictly newer than `current` and ≤ `latest` — the ones an
   *  operator would cross by updating now. */
  breakingAhead: string[];
  changelogUrl: string | null;
  notes: string | null;
  /** the exact command an operator runs to update — NOT executed, just shown. */
  pullCommand: string;
}

const PULL_COMMAND = 'docker compose pull && docker compose up -d';

/** Pure: given the running version and a parsed doc, decide what to show. */
export function evaluateUpdate(current: string, doc: VersionDoc): UpdateReport {
  const latest = typeof doc.latest === 'string' ? doc.latest : null;
  const minimumSupported = typeof doc.minimum_supported === 'string' ? doc.minimum_supported : null;
  const updateAvailable = latest !== null && cmpSemver(current, latest) < 0;
  const belowMinimum = minimumSupported !== null && cmpSemver(current, minimumSupported) < 0;
  const breaking = Array.isArray(doc.breaking) ? doc.breaking.filter((v): v is string => typeof v === 'string') : [];
  const breakingAhead = latest === null ? [] : breaking.filter((v) => cmpSemver(current, v) < 0 && cmpSemver(v, latest) <= 0)
    .sort(cmpSemver);
  return {
    current, latest, updateAvailable, belowMinimum, minimumSupported, breakingAhead,
    changelogUrl: typeof doc.changelog_url === 'string' ? doc.changelog_url : null,
    notes: typeof doc.notes === 'string' ? doc.notes : null,
    pullCommand: PULL_COMMAND,
  };
}

// ---------------- config row (opt-out toggle + URL override + cache) ----------------

export interface UpdateConfig { enabled: boolean; url: string | null; lastCheckAt: string | null; lastStatus: string | null; lastResult: UpdateReport | null }

export function readUpdateConfig(db: DatabaseSync): UpdateConfig {
  const r = db.prepare('SELECT enabled, url, last_check_at, last_status, last_result FROM app_update_config WHERE id = 1').get() as
    { enabled: number; url: string | null; last_check_at: string | null; last_status: string | null; last_result: string | null } | undefined;
  let lastResult: UpdateReport | null = null;
  if (r?.last_result) { try { lastResult = JSON.parse(r.last_result) as UpdateReport; } catch { lastResult = null; } }
  return { enabled: r ? !!r.enabled : true, url: r?.url ?? null, lastCheckAt: r?.last_check_at ?? null, lastStatus: r?.last_status ?? null, lastResult };
}

export function writeUpdateConfig(db: DatabaseSync, patch: { enabled?: boolean; url?: string | null }): UpdateConfig {
  const cur = readUpdateConfig(db);
  const enabled = patch.enabled ?? cur.enabled;
  const url = patch.url !== undefined ? patch.url : cur.url;
  db.prepare('UPDATE app_update_config SET enabled = ?, url = ?, updated_at = ? WHERE id = 1')
    .run(enabled ? 1 : 0, url, new Date().toISOString());
  return readUpdateConfig(db);
}

function saveCheckResult(db: DatabaseSync, status: string, report: UpdateReport | null): void {
  db.prepare('UPDATE app_update_config SET last_check_at = ?, last_status = ?, last_result = COALESCE(?, last_result), updated_at = ? WHERE id = 1')
    .run(new Date().toISOString(), status, report ? JSON.stringify(report) : null, new Date().toISOString());
}

// ---------------- the network fetch (GET only, nothing sent) ----------------

/** Fetch + parse version.json. GET only; a short timeout; no body, no id headers.
 *  Throws on any network/parse error so the caller can mark the check "offline". */
export async function fetchVersionDoc(url: string, opts: { timeoutMs?: number } = {}): Promise<VersionDoc> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = (await res.json()) as VersionDoc;
    if (!doc || typeof doc.latest !== 'string') throw new Error('version.json missing "latest"');
    return doc;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- one check run ----------------

export interface CheckOutcome { enabled: boolean; status: 'ok' | 'offline' | 'disabled'; report: UpdateReport | null; url: string }

/** Run one update check and cache the result. Never throws — offline is a normal,
 *  non-fatal outcome that leaves the previous cached report in place. */
export async function performUpdateCheck(db: DatabaseSync, opts: { currentVersion: string; defaultUrl?: string; timeoutMs?: number }): Promise<CheckOutcome> {
  const cfg = readUpdateConfig(db);
  const url = cfg.url || opts.defaultUrl || DEFAULT_UPDATE_URL;
  if (!cfg.enabled) return { enabled: false, status: 'disabled', report: cfg.lastResult, url };
  try {
    const doc = await fetchVersionDoc(url, { timeoutMs: opts.timeoutMs });
    const report = evaluateUpdate(opts.currentVersion, doc);
    saveCheckResult(db, 'ok', report);
    if (report.updateAvailable) log.info(`Update check: ${report.latest} is available (running ${report.current}).`);
    return { enabled: true, status: 'ok', report, url };
  } catch (err) {
    saveCheckResult(db, 'offline', null); // keep the last good report cached
    log.debug(`Update check offline (${url}): ${(err as Error).message}`);
    return { enabled: true, status: 'offline', report: cfg.lastResult, url };
  }
}

// ---------------- daily scheduler (opt-out honored; offline-safe) ----------------

/** Kick an initial check a few seconds after boot, then every 24h. Returns a stop
 *  handle. Honors the opt-out toggle at each tick (a live setting change takes
 *  effect on the next run). Never blocks boot; never throws. */
export function startUpdateChecks(db: DatabaseSync, opts: { currentVersion: string; defaultUrl?: string; firstDelayMs?: number; intervalMs?: number }): { stop: () => void } {
  const interval = opts.intervalMs ?? 24 * 60 * 60 * 1000;
  const first = opts.firstDelayMs ?? 15_000;
  const run = () => { void performUpdateCheck(db, { currentVersion: opts.currentVersion, defaultUrl: opts.defaultUrl }); };
  const t0 = setTimeout(run, first);
  const t1 = setInterval(run, interval);
  if (typeof t0.unref === 'function') t0.unref();
  if (typeof t1.unref === 'function') t1.unref();
  return { stop: () => { clearTimeout(t0); clearInterval(t1); } };
}
