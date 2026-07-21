import { gzipSync, gunzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import { restGet } from './routeros/rest.js';
import { restCommand } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import type { WriteTransport } from './routeros/write.js';
import { log } from './log.js';

/**
 * Config backup. Two capture paths, chosen by credential:
 *  - 'export':   canonical RouterOS /export text — faithful + IMPORTABLE
 *                (restorable), but /export needs the `ftp` policy, so it uses
 *                a device's write/management credential.
 *  - 'snapshot': a read-only GET reconstruction of the key config menus —
 *                works with a plain read credential (nothing is written to the
 *                device, not even a temp file), diffable, but not importable.
 * Either way the result is gzip-compressed into a SQLite BLOB with metadata.
 */

export type BackupFormat = 'export' | 'snapshot';

const EXPORT_FILE = 'rubymik-export'; // reused + overwritten (RouterOS file DELETE is unreliable)

export interface BackupMeta {
  identity: string | null;
  model: string | null;
  serial: string | null;
  version: string | null;
}

const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Parse the self-describing header RouterOS puts atop every /export. */
export function parseExportHeader(text: string): BackupMeta {
  const grab = (re: RegExp) => { const m = re.exec(text); return m ? m[1]!.trim() : null; };
  return {
    version: grab(/by RouterOS ([^\n]+)/),
    model: grab(/#\s*model\s*=\s*([^\n]+)/),
    serial: grab(/#\s*serial number\s*=\s*([^\n]+)/),
    identity: null,
  };
}

async function identityOf(t: DeviceTarget, tr: WriteTransport): Promise<string | null> {
  try {
    const id = await restGet(t, tr.scheme, tr.port, '/system/identity') as { name?: string };
    return id.name ?? null;
  } catch { return null; }
}

/**
 * Canonical export via `POST /rest/export {file}` (writes an .rsc, reusing one
 * filename), then read its contents. Needs an ftp-capable (write/mgmt) cred.
 */
export async function exportCanonical(write: DeviceTarget, transport: WriteTransport): Promise<{ text: string; meta: BackupMeta }> {
  await restCommand(write, transport, '/export', { file: EXPORT_FILE });
  await new Promise((r) => setTimeout(r, 400));
  const files = await restGet(write, transport.scheme, transport.port, '/file') as Array<Record<string, unknown>>;
  const f = files.find((x) => (x.name as string | undefined) === `${EXPORT_FILE}.rsc`);
  const raw = (f?.contents as string | undefined) ?? '';
  if (!raw) throw new Error('Export produced no readable content.');
  const text = raw.replace(/\r\n/g, '\n'); // RouterOS exports CRLF — normalize to LF
  const meta = parseExportHeader(text);
  meta.identity = await identityOf(write, transport);
  return { text, meta };
}

/** Config menus captured by the read-only snapshot (all safe GETs). */
const SNAPSHOT_MENUS: Array<{ path: string; drop?: string[] }> = [
  { path: '/interface', drop: ['running', 'rx-byte', 'tx-byte', 'actual-mtu', 'last-link-up-time', 'link-downs', 'fp-rx-byte', 'fp-tx-byte'] },
  { path: '/interface/bridge' }, { path: '/interface/bridge/port' }, { path: '/interface/vlan' },
  { path: '/ip/address', drop: ['dynamic'] },
  { path: '/ip/pool' },
  { path: '/ip/dhcp-server' }, { path: '/ip/dhcp-server/network' },
  { path: '/ip/dhcp-server/lease', drop: ['active-address', 'active-mac-address', 'active-server', 'last-seen', 'expires-after', 'status', 'age'] },
  { path: '/ip/route', drop: ['active', 'hw-offloaded', 'immediate-gw', 'gateway-status'] },
  { path: '/ip/firewall/filter', drop: ['bytes', 'packets'] },
  { path: '/ip/firewall/nat', drop: ['bytes', 'packets'] },
  { path: '/ip/firewall/address-list', drop: ['creation-time'] },
  { path: '/ip/dns' }, { path: '/ip/service' },
  { path: '/system/clock', drop: ['time', 'date', 'gmt-offset'] },
  { path: '/user' }, // group + name only (passwords never exposed by RouterOS)
];

const VOLATILE = new Set(['.id', 'dynamic', 'invalid', 'inactive', 'disabled', 'default', 'uptime']);

/**
 * Read-only config snapshot — GET each menu, strip volatile/counter fields,
 * emit stable sorted lines. Nothing is written to the device.
 */
export async function snapshotReadonly(read: DeviceTarget, transport: WriteTransport): Promise<{ text: string; meta: BackupMeta }> {
  const meta: BackupMeta = { identity: null, model: null, serial: null, version: null };
  try {
    const rb = await restGet(read, transport.scheme, transport.port, '/system/routerboard') as Record<string, unknown>;
    meta.model = s(rb.model); meta.serial = s(rb['serial-number']);
  } catch { /* CHR/x86 */ }
  try {
    const res = await restGet(read, transport.scheme, transport.port, '/system/resource') as Record<string, unknown>;
    meta.version = s(res.version);
  } catch { /* ignore */ }
  meta.identity = await identityOf(read, transport);

  const lines: string[] = [
    `# RubyMIK read-only config snapshot`,
    `# identity = ${meta.identity ?? '?'}`,
    `# model = ${meta.model ?? '?'}`,
    `# serial number = ${meta.serial ?? '?'}`,
    `# RouterOS ${meta.version ?? '?'}`,
  ];
  for (const menu of SNAPSHOT_MENUS) {
    let rows: Array<Record<string, unknown>>;
    try {
      const got = await restGet(read, transport.scheme, transport.port, menu.path);
      rows = Array.isArray(got) ? got as Array<Record<string, unknown>> : [got as Record<string, unknown>];
    } catch { continue; }
    const drop = new Set([...VOLATILE, ...(menu.drop ?? [])]);
    const entries = rows.map((r) => {
      const kv = Object.entries(r)
        .filter(([k, v]) => !drop.has(k) && v !== undefined && v !== '' && !k.startsWith('.'))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ');
      return kv;
    }).filter(Boolean).sort();
    if (entries.length > 0) {
      lines.push(`${menu.path}`);
      for (const e of entries) lines.push(`  ${e}`);
    }
  }
  return { text: lines.join('\n') + '\n', meta };
}

// ---------- storage ----------

export interface StoredBackup {
  id: number; deviceId: number | null; deviceName: string;
  identity: string | null; model: string | null; serial: string | null; version: string | null;
  source: string; format: BackupFormat; rawBytes: number; gzBytes: number; createdAt: string;
}

function rowToMeta(r: Record<string, unknown>): StoredBackup {
  return {
    id: r.id as number, deviceId: r.device_id as number | null, deviceName: r.device_name as string,
    identity: r.identity as string | null, model: r.model as string | null, serial: r.serial as string | null,
    version: r.version as string | null, source: r.source as string, format: (r.format as BackupFormat) ?? 'export',
    rawBytes: r.raw_bytes as number, gzBytes: (r.gz_bytes as number) ?? 0, createdAt: r.created_at as string,
  };
}

export function storeBackup(
  db: DatabaseSync, deviceId: number, deviceName: string, source: string, format: BackupFormat,
  text: string, meta: BackupMeta, keepN: number,
): StoredBackup {
  const gz = gzipSync(Buffer.from(text, 'utf8'));
  const now = new Date().toISOString();
  const res = db.prepare(`
    INSERT INTO device_backup (device_id, device_name, identity, model, serial, version, source, format, raw_bytes, gz, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(deviceId, deviceName, meta.identity, meta.model, meta.serial, meta.version, source, format, Buffer.byteLength(text), gz, now);
  db.prepare(`
    DELETE FROM device_backup WHERE device_id = ? AND id NOT IN (
      SELECT id FROM device_backup WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    )
  `).run(deviceId, deviceId, keepN);
  const row = db.prepare('SELECT *, length(gz) AS gz_bytes FROM device_backup WHERE id = ?').get(res.lastInsertRowid as number) as Record<string, unknown>;
  log.info(`Backup #${row.id} of "${deviceName}" (${source}/${format}) — ${text.length}B raw, ${gz.length}B gz`);
  return rowToMeta(row);
}

export function listBackups(db: DatabaseSync, deviceId: number): StoredBackup[] {
  return (db.prepare('SELECT *, length(gz) AS gz_bytes FROM device_backup WHERE device_id = ? ORDER BY created_at DESC, id DESC')
    .all(deviceId) as Record<string, unknown>[]).map(rowToMeta);
}

export function getBackupRow(db: DatabaseSync, id: number): (StoredBackup & { text: string }) | null {
  const r = db.prepare('SELECT *, length(gz) AS gz_bytes FROM device_backup WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return { ...rowToMeta(r), text: gunzipSync(r.gz as Buffer).toString('utf8') };
}

export interface ParsedLease { address: string; mac: string; server: string; comment: string | null }

/**
 * Parse the `/ip dhcp-server lease` static entries out of an export/snapshot.
 * Handles RouterOS line-continuations (`\`) and quoted values. This is the
 * reconcilable slice restore applies (see restore.ts).
 */
export function parseDhcpLeases(text: string): ParsedLease[] {
  // normalize CRLF, then join backslash continuations: RouterOS breaks
  // mid-token (e.g. `mac-address=\` then `    AA:BB...`), so drop the `\`,
  // newline and the continuation-line indentation — keeping what preceded `\`.
  const joined = text.replace(/\r\n/g, '\n').replace(/\\\n\s*/g, '');
  const lines = joined.split('\n');
  const leases: ParsedLease[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('/ip dhcp-server lease') || line === '/ip/dhcp-server/lease') { inSection = true; continue; }
    if (line.startsWith('/')) { inSection = false; continue; }
    if (!inSection || !line) continue;
    const body = line.startsWith('add ') ? line.slice(4) : line; // snapshot lines have no "add"
    const kv: Record<string, string> = {};
    for (const m of body.matchAll(/([a-z-]+)=("([^"]*)"|(\S+))/g)) {
      kv[m[1]!] = m[3] ?? m[4] ?? '';
    }
    // skip dynamic leases in snapshot lines
    if (kv.dynamic === 'true') continue;
    if (kv.address && kv['mac-address'] && kv.server) {
      leases.push({ address: kv.address, mac: kv['mac-address'], server: kv.server, comment: kv.comment ?? null });
    }
  }
  return leases;
}

/** LCS line diff, ignoring the volatile header timestamp line. */
export function diffExports(aText: string, bText: string): { added: number; removed: number; lines: Array<{ t: ' ' | '+' | '-'; s: string }> } {
  const strip = (t: string) => t.split('\n').filter((l) => !/^# \d{4}-\d\d-\d\d \d\d:\d\d:\d\d by RouterOS/.test(l));
  const a = strip(aText), b = strip(bText);
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const lines: Array<{ t: ' ' | '+' | '-'; s: string }> = [];
  let added = 0, removed = 0, i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push({ t: ' ', s: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { lines.push({ t: '-', s: a[i]! }); removed++; i++; }
    else { lines.push({ t: '+', s: b[j]! }); added++; j++; }
  }
  while (i < n) { lines.push({ t: '-', s: a[i]! }); removed++; i++; }
  while (j < m) { lines.push({ t: '+', s: b[j]! }); added++; j++; }
  return { added, removed, lines };
}
