import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SecretBox } from './secretbox.js';
import { readTarget, writeTarget, transportFor, type AddressableRow } from './transport.js';
import { exportCanonical, snapshotReadonly } from './backup.js';
import { log } from './log.js';

/**
 * Automatic config snapshots (P21) — CAPTURE + VIEW + DIFF only (no restore).
 *
 * A snapshot is a point-in-time config export, captured pre/post every write plus
 * manually and on a daily schedule. Capture is READ-ONLY on the router and runs
 * through the read/transport path, never the mutating write functions:
 *   - manageable device  → canonical `/export show-sensitive` (true restore
 *     reference; carries secrets → encrypted at rest, never logged);
 *   - monitor-only device → read-only GET reconstruction (works with a plain read
 *     credential; diffable, no privileged export). Home Lab uses this path.
 * Either way the plaintext is AES-256-GCM encrypted (the SecretBox that protects
 * device credentials) before it touches the database.
 */

export type SnapshotTrigger = 'pre_write' | 'post_write' | 'manual' | 'scheduled';
export type SnapshotFormat = 'export' | 'snapshot';

const SNAPSHOT_FILE = 'rubymik-snapshot'; // distinct from P7's backup export file
const KEEP_PER_ROUTER = 100;
const PROTECT_RECENT_OPS = 10;

export interface SnapshotMeta {
  id: number;
  routerId: number | null;
  routerName: string;
  capturedAt: string;
  trigger: SnapshotTrigger;
  operation: string | null;
  opGroup: string | null;
  outcome: string | null;
  format: SnapshotFormat;
  identity: string | null;
  model: string | null;
  serial: string | null;
  version: string | null;
  sizeBytes: number;
  sha256: string;
  isDuplicate: boolean;
}

interface DeviceRow extends AddressableRow { id: number; name: string }

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function rowToMeta(r: Record<string, unknown>): SnapshotMeta {
  return {
    id: r.id as number,
    routerId: (r.router_id as number | null) ?? null,
    routerName: r.router_name as string,
    capturedAt: r.captured_at as string,
    trigger: r.trigger as SnapshotTrigger,
    operation: (r.operation as string | null) ?? null,
    opGroup: (r.op_group as string | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
    format: r.format as SnapshotFormat,
    identity: (r.identity as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    serial: (r.serial as string | null) ?? null,
    version: (r.version as string | null) ?? null,
    sizeBytes: r.size_bytes as number,
    sha256: r.sha256 as string,
    isDuplicate: (r.duplicate_of as number | null) != null,
  };
}

export function loadDeviceRow(db: DatabaseSync, deviceId: number): DeviceRow | undefined {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as unknown as DeviceRow | undefined;
}

export function isManageable(row: DeviceRow): boolean {
  return !!(row.write_username_enc && row.write_password_enc);
}

/**
 * Produce the raw snapshot text over the read path. Manageable → canonical
 * show-sensitive export; monitor-only → read-only GET reconstruction. Neither
 * path touches restAdd/restSet/restRemove, so no config is modified.
 */
export async function produceSnapshotText(
  db: DatabaseSync, box: SecretBox, row: DeviceRow,
): Promise<{ text: string; format: SnapshotFormat; identity: string | null; model: string | null; serial: string | null; version: string | null }> {
  const read = readTarget(box, row);
  const transport = await transportFor(row, read);
  if (isManageable(row)) {
    const write = writeTarget(box, row);
    const { text, meta } = await exportCanonical(write, transport, { sensitive: true, file: SNAPSHOT_FILE });
    return { text, format: 'export', identity: meta.identity, model: meta.model, serial: meta.serial, version: meta.version };
  }
  const { text, meta } = await snapshotReadonly(read, transport);
  return { text, format: 'snapshot', identity: meta.identity, model: meta.model, serial: meta.serial, version: meta.version };
}

/**
 * Store snapshot text for a router: dedup vs the router's most recent snapshot
 * (identical sha256 → a lightweight duplicate_of pointer, no second blob),
 * encrypt otherwise, then prune. Returns the stored row's metadata. Content is
 * NEVER logged.
 */
export function storeSnapshotText(
  db: DatabaseSync, box: SecretBox, routerId: number, routerName: string,
  opts: {
    trigger: SnapshotTrigger; operation?: string | null; opGroup?: string | null; outcome?: string | null;
    text: string; format: SnapshotFormat; identity?: string | null; model?: string | null; serial?: string | null; version?: string | null;
  },
): SnapshotMeta {
  const sha = sha256(opts.text);
  const size = Buffer.byteLength(opts.text, 'utf8');
  const now = new Date().toISOString();

  const recent = db.prepare(
    'SELECT id, sha256, content_encrypted, duplicate_of FROM snapshots WHERE router_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1',
  ).get(routerId) as { id: number; sha256: string; content_encrypted: string | null; duplicate_of: number | null } | undefined;

  let contentEncrypted: string | null = null;
  let duplicateOf: number | null = null;
  if (recent && recent.sha256 === sha) {
    // point at a content-bearing row (follow the chain if the most-recent is itself a dup)
    duplicateOf = recent.duplicate_of ?? recent.id;
  } else {
    contentEncrypted = box.encrypt(opts.text);
  }

  const res = db.prepare(`
    INSERT INTO snapshots (router_id, router_name, captured_at, trigger, operation, op_group, outcome, format,
      identity, model, serial, version, size_bytes, sha256, content_encrypted, duplicate_of, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    routerId, routerName, now, opts.trigger, opts.operation ?? null, opts.opGroup ?? null, opts.outcome ?? null, opts.format,
    opts.identity ?? null, opts.model ?? null, opts.serial ?? null, opts.version ?? null, size, sha, contentEncrypted, duplicateOf, now,
  );
  pruneRouter(db, routerId);
  const stored = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(res.lastInsertRowid as number) as Record<string, unknown>;
  log.info(`Snapshot #${stored.id} of "${routerName}" (${opts.trigger}/${opts.format}${opts.operation ? ` ${opts.operation}` : ''}) — ${size}B${duplicateOf ? ` [dup of #${duplicateOf}]` : ''}`);
  return rowToMeta(stored);
}

/**
 * Retention: keep the most recent KEEP_PER_ROUTER snapshots per router, EXCEPT
 * never prune any snapshot belonging to the PROTECT_RECENT_OPS most recent write
 * operations (their pre/post pairs). A content-bearing row still referenced by a
 * surviving duplicate is also protected, so no survivor is orphaned.
 */
export function pruneRouter(db: DatabaseSync, routerId: number, keepN = KEEP_PER_ROUTER, protectOps = PROTECT_RECENT_OPS): number {
  const rows = db.prepare(
    'SELECT id, op_group, duplicate_of FROM snapshots WHERE router_id = ? ORDER BY captured_at DESC, id DESC',
  ).all(routerId) as Array<{ id: number; op_group: string | null; duplicate_of: number | null }>;

  // The protectOps most recent DISTINCT write op_groups (by recency).
  const opOrder: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.op_group && !seen.has(r.op_group)) { seen.add(r.op_group); opOrder.push(r.op_group); }
  }
  const protectedGroups = new Set(opOrder.slice(0, protectOps));
  const keepIds = new Set(rows.slice(0, keepN).map((r) => r.id));

  const deletable = new Set(
    rows.filter((r) => !keepIds.has(r.id) && !(r.op_group && protectedGroups.has(r.op_group))).map((r) => r.id),
  );
  // Don't orphan a surviving duplicate: protect any content row a survivor points at.
  for (const r of rows) {
    if (!deletable.has(r.id) && r.duplicate_of != null) deletable.delete(r.duplicate_of);
  }
  for (const id of deletable) db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  return deletable.size;
}

export function listSnapshots(db: DatabaseSync, routerId: number): SnapshotMeta[] {
  return (db.prepare('SELECT * FROM snapshots WHERE router_id = ? ORDER BY captured_at DESC, id DESC').all(routerId) as Record<string, unknown>[])
    .map(rowToMeta);
}

/** Decrypt a snapshot's content, resolving a duplicate_of pointer to its original. */
export function getSnapshotContent(db: DatabaseSync, box: SecretBox, id: number): { meta: SnapshotMeta; text: string } | null {
  const r = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  let contentEnc = r.content_encrypted as string | null;
  if (!contentEnc && r.duplicate_of != null) {
    const orig = db.prepare('SELECT content_encrypted FROM snapshots WHERE id = ?').get(r.duplicate_of as number) as { content_encrypted: string | null } | undefined;
    contentEnc = orig?.content_encrypted ?? null;
  }
  if (!contentEnc) return null;
  return { meta: rowToMeta(r), text: box.decrypt(contentEnc) };
}

export function lastSnapshotAt(db: DatabaseSync, routerId: number): string | null {
  const r = db.prepare('SELECT captured_at FROM snapshots WHERE router_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1').get(routerId) as { captured_at: string } | undefined;
  return r?.captured_at ?? null;
}

// ---- capture-failure log (post-write / scheduled failures → warning badge) ----

export function recordSnapshotFailure(db: DatabaseSync, routerId: number, trigger: SnapshotTrigger, operation: string | null, reason: string): void {
  db.prepare('INSERT INTO snapshot_failures (router_id, trigger, operation, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(routerId, trigger, operation ?? null, reason, new Date().toISOString());
}

export interface SnapshotFailure { id: number; trigger: string; operation: string | null; reason: string; createdAt: string }

/** Most recent capture failure for a router (for the UI warning badge), if any. */
export function lastSnapshotFailure(db: DatabaseSync, routerId: number): SnapshotFailure | null {
  const r = db.prepare('SELECT * FROM snapshot_failures WHERE router_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(routerId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return { id: r.id as number, trigger: r.trigger as string, operation: (r.operation as string | null) ?? null, reason: r.reason as string, createdAt: r.created_at as string };
}

/**
 * Capture a snapshot for a device end-to-end: produce text over the read path,
 * store (dedup + encrypt + prune). Throws if capture fails (callers decide: pre =
 * fail-closed, post/manual/scheduled = best-effort). Content is never logged.
 */
export async function captureForDevice(
  db: DatabaseSync, box: SecretBox, deviceId: number,
  opts: { trigger: SnapshotTrigger; operation?: string | null; opGroup?: string | null; outcome?: string | null },
): Promise<SnapshotMeta> {
  const row = loadDeviceRow(db, deviceId);
  if (!row) throw new Error(`device ${deviceId} not found`);
  const produced = await produceSnapshotText(db, box, row);
  return storeSnapshotText(db, box, row.id, row.name, {
    trigger: opts.trigger, operation: opts.operation, opGroup: opts.opGroup, outcome: opts.outcome,
    text: produced.text, format: produced.format,
    identity: produced.identity, model: produced.model, serial: produced.serial, version: produced.version,
  });
}
