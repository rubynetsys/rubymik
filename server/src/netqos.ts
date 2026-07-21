import { restGet } from './routeros/rest.js';
import { restAdd, restSet, restRemove, restCommand, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { type AddressableRow } from './transport.js';
import { runSafeApply, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import { readL2, type L2Context } from './netl2.js';

/**
 * Native QoS — simple queues (P23). /queue/simple CRUD + reorder + enable/disable.
 *
 * A queue is additive and IP-layer-recoverable, so writes ride the EXISTING P5
 * dead-man + P21 snapshot hook. The NEW hazard is that a queue can't sever the
 * mgmt path but it can STRANGLE it (max-limit=8k over the mgmt flow leaves the
 * router pingable yet operationally partitioned). So P23 adds:
 *   (1) queueMgmtGuard — refuses PROVABLE strangles (target = the mgmt IP/iface, or
 *       0.0.0.0/0, below a bandwidth floor). Broad targets that merely INCLUDE the
 *       mgmt IP are NOT refused — they go to the dead-man.
 *   (2) a latency dimension on the dead-man verify (see safeapply.ts) so a strangle
 *       that keeps the router reachable but slow is caught and rolled back.
 */

export const TAG = 'RUBYMIK-QOS';

const numEnv = (k: string, d: number): number => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
/** Bandwidth floor (bps): a mgmt-targeting queue below this is a provable strangle. */
export const QOS_FLOOR_BPS = numEnv('RUBYMIK_QOS_FLOOR_BPS', 1_000_000);
/** Latency dead-man budget for queue writes. */
export const QOS_LATENCY = { samples: numEnv('RUBYMIK_QOS_LATENCY_SAMPLES', 5), multiplier: numEnv('RUBYMIK_QOS_LATENCY_MULT', 10), ceilingMs: numEnv('RUBYMIK_QOS_LATENCY_CEIL', 2000) };

type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export type QosContext = L2Context; // { read, write, transport, row }
const g = (ctx: QosContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

export class QosProtected extends Error {}

export interface SimpleQueue {
  id: string; order: number; name: string; target: string | null;
  maxLimit: string | null; limitAt: string | null;
  burstLimit: string | null; burstThreshold: string | null; burstTime: string | null;
  priority: string | null; parent: string | null; queueType: string | null; timeSchedule: string | null;
  disabled: boolean; dynamic: boolean; invalid: boolean; comment: string | null; managed: boolean;
  rate: string | null; bytes: string | null; packets: string | null; totalBytes: string | null;
}
export interface QosMgmtInfo { mgmtIp: string; mgmtInterface: string | null; mgmtPort: number; mgmtScheme: string }
export interface QosView { queues: SimpleQueue[]; mgmt: QosMgmtInfo }

const isManaged = (comment: string | null): boolean => !!comment && comment.startsWith(TAG);

function toQueue(r: Dict, order: number): SimpleQueue {
  const comment = s(r['comment']);
  return {
    id: s(r['.id']) ?? String(order), order, name: s(r['name']) ?? '?', target: s(r['target']),
    maxLimit: s(r['max-limit']), limitAt: s(r['limit-at']),
    burstLimit: s(r['burst-limit']), burstThreshold: s(r['burst-threshold']), burstTime: s(r['burst-time']),
    priority: s(r['priority']), parent: s(r['parent']), queueType: s(r['queue']), timeSchedule: s(r['time']),
    disabled: r['disabled'] === 'true', dynamic: r['dynamic'] === 'true', invalid: r['invalid'] === 'true',
    comment, managed: isManaged(comment),
    rate: s(r['rate']), bytes: s(r['bytes']), packets: s(r['packets']), totalBytes: s(r['total-bytes']),
  };
}

export async function readQos(ctx: QosContext): Promise<QosView> {
  const rows = await g(ctx, '/queue/simple') as Dict[];
  return { queues: rows.map((r, i) => toQueue(r, i)), mgmt: await mgmtInfo(ctx) };
}

export async function mgmtInfo(ctx: QosContext): Promise<QosMgmtInfo> {
  const l2 = await readL2(ctx);
  return { mgmtIp: l2.path.mgmtIp, mgmtInterface: l2.path.mgmtInterface, mgmtPort: ctx.transport.port, mgmtScheme: ctx.transport.scheme };
}

// ---------------- validation + bandwidth parsing (pure) ----------------

export interface QueueSpec {
  name: string; target?: string | null;
  maxLimitUp?: string | null; maxLimitDown?: string | null; limitAtUp?: string | null; limitAtDown?: string | null;
  burstLimit?: string | null; burstThreshold?: string | null; burstTime?: string | null;
  priority?: string | null; parent?: string | null; queueType?: string | null; timeSchedule?: string | null;
  comment?: string | null; disabled?: boolean;
}

/** Parse a RouterOS bandwidth token ("8k", "10M", "8000000", "0") to bps. 0 = unlimited. */
export function parseBps(v: string | null | undefined): number {
  if (!v) return 0;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([kMG])?$/i);
  if (!m) return NaN;
  const mult = { k: 1e3, m: 1e6, g: 1e9 }[(m[2] ?? '').toLowerCase()] ?? 1;
  return Number(m[1]) * mult;
}
export function fmtBps(bps: number): string {
  if (bps >= 1e9) return `${bps / 1e9}G`; if (bps >= 1e6) return `${bps / 1e6}M`; if (bps >= 1e3) return `${bps / 1e3}k`; return String(bps);
}
const isBwOk = (v: string | null | undefined): boolean => !v || Number.isFinite(parseBps(v));
const isTargetish = (t: string): boolean => /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(t) || /^[A-Za-z][\w.\-]*$/.test(t);

export function validateQueueInput(q: QueueSpec): string[] {
  const e: string[] = [];
  if (!q.name || !q.name.trim()) e.push('A queue name is required.');
  if (!q.target || !q.target.trim()) e.push('A target (address/CIDR or interface) is required.');
  else if (!isTargetish(q.target.trim())) e.push(`Target "${q.target}" is not a valid address/CIDR or interface name.`);
  for (const [k, v] of [['max-limit up', q.maxLimitUp], ['max-limit down', q.maxLimitDown], ['limit-at up', q.limitAtUp], ['limit-at down', q.limitAtDown], ['burst-limit', q.burstLimit], ['burst-threshold', q.burstThreshold]] as const)
    if (!isBwOk(v)) e.push(`${k} "${v}" is not a valid rate (e.g. 512k, 10M).`);
  if (q.priority && !/^[1-8](\/[1-8])?$/.test(q.priority.trim())) e.push('priority must be 1–8.');
  return e;
}

// ---------------- the QoS management guard ----------------

const belowFloor = (v: string | null | undefined, floor: number): boolean => { const b = parseBps(v); return Number.isFinite(b) && b > 0 && b < floor; };

/** Refuse a PROVABLE strangle of the management flow, else null. Broad targets that
 *  merely include the mgmt IP are allowed through (the latency dead-man catches a
 *  real strangle). A disabled queue is never refused (class 4). */
export function queueMgmtGuard(mgmt: QosMgmtInfo, q: QueueSpec, floorBps = QOS_FLOOR_BPS): string | null {
  if (q.disabled) return null;
  const below = belowFloor(q.maxLimitUp, floorBps) || belowFloor(q.maxLimitDown, floorBps);
  if (!below) return null; // unlimited or at/above the floor → not a strangle
  const t = (q.target ?? '').trim();
  const isMgmtIp = t === mgmt.mgmtIp || t === `${mgmt.mgmtIp}/32`;
  const isMgmtIface = !!mgmt.mgmtInterface && t === mgmt.mgmtInterface;
  if (isMgmtIp || isMgmtIface) {
    return `This queue targets the management ${isMgmtIface ? `interface "${t}"` : `IP ${mgmt.mgmtIp}`} with a max-limit below ${fmtBps(floorBps)} — it would strangle RubyMIK's management flow (the router would still answer but be operationally partitioned). Refused.`;
  }
  if (t === '0.0.0.0/0') {
    return `This queue targets 0.0.0.0/0 with a max-limit below ${fmtBps(floorBps)} — it would strangle all traffic including management. Refused.`;
  }
  return null; // broad target that merely INCLUDES the mgmt IP → dead-man + latency
}

// ---------------- writes via runSafeApply (dead-man + latency) ----------------

type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: QosContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport, latency: QOS_LATENCY });
const Q = '/queue/simple';

export function taggedComment(c: string | null | undefined): string {
  const u = (c ?? '').replace(/^RUBYMIK-QOS:?\s*/i, '').trim();
  return u ? `${TAG}: ${u}` : TAG;
}

function bw(up: string | null | undefined, down: string | null | undefined): string | undefined {
  if (!up && !down) return undefined;
  return `${(up ?? '0').trim() || '0'}/${(down ?? '0').trim() || '0'}`;
}
function specToBody(q: QueueSpec): Record<string, unknown> {
  const b: Record<string, unknown> = { name: q.name.trim(), target: (q.target ?? '').trim() };
  const ml = bw(q.maxLimitUp, q.maxLimitDown); if (ml) b['max-limit'] = ml;
  const la = bw(q.limitAtUp, q.limitAtDown); if (la) b['limit-at'] = la;
  const rec = q as unknown as Record<string, unknown>;
  for (const [k, ros] of [['burstLimit', 'burst-limit'], ['burstThreshold', 'burst-threshold'], ['burstTime', 'burst-time'], ['priority', 'priority'], ['parent', 'parent'], ['queueType', 'queue'], ['timeSchedule', 'time']] as const) {
    const v = rec[k]; if (v != null && v !== '') b[ros] = v;
  }
  if (q.disabled) b.disabled = 'yes';
  b.comment = taggedComment(q.comment);
  return b;
}
const EDITABLE = ['name', 'target', 'max-limit', 'limit-at', 'burst-limit', 'burst-threshold', 'burst-time', 'priority', 'parent', 'queue', 'time', 'comment', 'disabled'];
function restoreBody(before: Dict): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  for (const f of EDITABLE) b[f] = f in before && before[f] != null ? before[f] : '';
  return b;
}

const readIds = async (ctx: QosContext): Promise<string[]> => ((await g(ctx, Q)) as Dict[]).map((r) => s(r['.id']) ?? '');
const findQ = async (ctx: QosContext, id: string): Promise<Dict | undefined> => ((await g(ctx, Q)) as Dict[]).find((r) => s(r['.id']) === id);

export async function createQueue(ctx: QosContext, sac: Sac, q: QueueSpec): Promise<SafeApplyOutcome> {
  let beforeIds: string[] = [];
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => { beforeIds = await readIds(ctx); return { ids: beforeIds }; },
    summary: () => `Add simple queue "${q.name}" (target ${q.target})`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, Q, specToBody(q)); },
    verifyTook: async () => ({ ok: (await readIds(ctx)).some((id) => !beforeIds.includes(id)), after: { name: q.name } }),
    rollback: async (b) => { for (const id of (await readIds(ctx)).filter((x) => !b.ids.includes(x))) await restRemove(ctx.write, ctx.transport, Q, id); },
  });
}

export async function editQueue(ctx: QosContext, sac: Sac, id: string, q: QueueSpec): Promise<SafeApplyOutcome> {
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => findQ(ctx, id),
    summary: () => `Edit simple queue "${q.name}"`,
    apply: async () => { await restSet(ctx.write, ctx.transport, Q, id, specToBody(q)); },
    verifyTook: async () => ({ ok: !!(await findQ(ctx, id)) }),
    rollback: async (b) => { if (b) await restSet(ctx.write, ctx.transport, Q, id, restoreBody(b)); },
  });
}

export async function setQueueEnabled(ctx: QosContext, sac: Sac, id: string, disabled: boolean): Promise<SafeApplyOutcome> {
  return runSafeApply<{ was: boolean }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ was: (await findQ(ctx, id))?.['disabled'] === 'true' }),
    summary: () => `${disabled ? 'Disable' : 'Enable'} simple queue ${id}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, Q, id, { disabled: disabled ? 'yes' : 'no' }); },
    verifyTook: async () => ({ ok: ((await findQ(ctx, id))?.['disabled'] === 'true') === disabled }),
    rollback: async (b) => { await restSet(ctx.write, ctx.transport, Q, id, { disabled: b.was ? 'yes' : 'no' }); },
  });
}

export async function removeQueue(ctx: QosContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => findQ(ctx, id),
    summary: () => `Remove simple queue ${id}`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, Q, id); },
    verifyTook: async () => ({ ok: !(await findQ(ctx, id)) }),
    rollback: async (b) => {
      if (!b) return;
      const body: Dict = { ...b };
      for (const k of ['.id', '.nextid', 'dynamic', 'invalid', 'bytes', 'packets', 'rate', 'total-bytes', 'total-packets', 'queued-bytes', 'queued-packets']) delete body[k];
      await restAdd(ctx.write, ctx.transport, Q, body as Record<string, unknown>);
    },
  });
}

export async function takeOwnershipQueue(ctx: QosContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => findQ(ctx, id),
    summary: () => `Take ownership of simple queue ${id}`,
    apply: async () => { const r = await findQ(ctx, id); await restSet(ctx.write, ctx.transport, Q, id, { comment: taggedComment(s(r?.['comment'])) }); },
    verifyTook: async () => ({ ok: isManaged(s((await findQ(ctx, id))?.['comment'])) }),
    rollback: async (b) => { if (b) await restSet(ctx.write, ctx.transport, Q, id, { comment: s(b['comment']) ?? '' }); },
  });
}

export async function moveQueue(ctx: QosContext, sac: Sac, id: string, destId: string | null): Promise<SafeApplyOutcome> {
  return runSafeApply<{ order: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ order: await readIds(ctx) }),
    summary: () => `Move simple queue ${id} ${destId ? `before ${destId}` : 'to end'}`,
    apply: async () => { await restCommand(ctx.write, ctx.transport, `${Q}/move`, destId ? { numbers: id, destination: destId } : { numbers: id }); },
    verifyTook: async () => {
      const order = await readIds(ctx); const i = order.indexOf(id);
      if (i < 0) return { ok: false, detail: 'queue not found after move' };
      if (destId === null) return { ok: i === order.length - 1 };
      const j = order.indexOf(destId);
      return { ok: j >= 0 && i === j - 1 };
    },
    rollback: async (b) => {
      const idx = b.order.indexOf(id);
      const successor = idx >= 0 && idx + 1 < b.order.length ? b.order[idx + 1] : null;
      if (successor === id) return;
      await restCommand(ctx.write, ctx.transport, `${Q}/move`, successor ? { numbers: id, destination: successor } : { numbers: id });
    },
  });
}

/** Convert an existing queue row into an edit spec (for enable-guard checks). */
export function queueToSpec(qz: SimpleQueue): QueueSpec {
  const [mu, md] = (qz.maxLimit ?? '').split('/');
  const [lu, ld] = (qz.limitAt ?? '').split('/');
  return {
    name: qz.name, target: qz.target, maxLimitUp: mu || null, maxLimitDown: md || null, limitAtUp: lu || null, limitAtDown: ld || null,
    burstLimit: qz.burstLimit, burstThreshold: qz.burstThreshold, burstTime: qz.burstTime, priority: qz.priority,
    parent: qz.parent, queueType: qz.queueType, timeSchedule: qz.timeSchedule, comment: qz.comment, disabled: qz.disabled,
  };
}
