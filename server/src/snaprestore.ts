import type { SafeApplyContext, SafeApplyOutcome } from './safeapply.js';
import type { L2Context } from './netl2.js';
import { readNat, createNat, removeNat, type NatRule } from './netnat.js';
import { readQos, createQueue, editQueue, removeQueue, type SimpleQueue } from './netqos.js';
import { readDns, applyDns, readNtp, applyNtp, type NetConfigContext } from './netconfig.js';
import { readRoutes, addRoute, editRoute, removeRoute } from './netroutes.js';
import { readInterfaces, addAddress, removeAddress } from './netaddr.js';
import { readReservations, addReservation, editReservation, removeReservation } from './dhcp.js';
import { readPppoe, createPppoe, editPppoe, removePppoe } from './netpppoe.js';

/**
 * P37 — SECTION-SCOPED SNAPSHOT RESTORE.
 *
 * RESTORE IS NOT A FILE PUSH. A full /import of a .rsc is non-idempotent, fails
 * mid-way, and can sever the mgmt path below every guard — so RubyMIK never does
 * it (grep-provable: nothing here calls /import, /system/backup/load or script/run).
 *
 * Instead a restore is a per-SECTION DELTA computed from a snapshot's /export
 * text and executed THROUGH the existing per-section write modules. That means
 * every restore op automatically inherits that module's guard (mgmt-path / NAT /
 * DHCP / VPN / L2 / queue-strangle), the dead-man (reachability + latency), and
 * the P21 pre/post snapshot bracket — none of it is re-implemented here.
 */

// A restore context is structurally a superset of every module's context.
export type RestoreCtx = L2Context & NetConfigContext;
export type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe' | 'latency' | 'latencyProbe'>;
export type SacFactory = (action: string, target: string | null) => Sac;
export type RestoreMode = 'additive' | 'exact';

// ---------------- /export tokenizer (handles canonical export AND the read-only snapshot format) ----------------

export interface ParsedRecord { cmd: 'add' | 'set' | 'remove' | 'row'; fields: Record<string, string> }

// Secret fields: the read masks them (present/absent only), so they can't be
// compared; the plan masks their value; apply uses the real value from .raw.
const SECRET_KEYS = new Set(['password', 'ipsec-secret', 'preshared-key', 'key', 'wpa2-pre-shared-key', 'wpa-pre-shared-key', 'passphrase']);

/** Parse a `key=value ...` body (quoted values, comma lists) into a field map. */
function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i >= body.length) break;
    let key = '';
    while (i < body.length && body[i] !== '=' && !/\s/.test(body[i]!)) key += body[i++];
    if (body[i] !== '=') { if (key) fields[key] = 'true'; continue; }
    i++;
    let val = '';
    if (body[i] === '"') { i++; while (i < body.length && body[i] !== '"') { if (body[i] === '\\' && i + 1 < body.length) { val += body[i + 1]; i += 2; } else val += body[i++]; } i++; }
    else while (i < body.length && !/\s/.test(body[i]!)) val += body[i++];
    if (key) fields[key] = val;
  }
  return fields;
}

/** Normalize a section header path to slash-form: "/ip firewall nat" → "/ip/firewall/nat". */
const canonPath = (header: string) => header.trim().replace(/\s+/g, '/');

/** Slice the records of one canonical section out of an /export or read-only snapshot. */
export function sliceSection(text: string, paths: string[]): ParsedRecord[] {
  const want = new Set(paths);
  const joined = text.replace(/\r\n/g, '\n').replace(/\\\n\s*/g, ' '); // join line-continuations
  const recs: ParsedRecord[] = [];
  let inSection = false;
  for (const raw of joined.split('\n')) {
    if (raw.startsWith('#')) continue;
    if (/^\//.test(raw.trim())) { inSection = want.has(canonPath(raw)); continue; }
    const line = raw.trim();
    if (!inSection || !line) continue;
    const m = /^(add|set|remove)\b\s*(.*)$/.exec(line);
    if (m) recs.push({ cmd: m[1] as ParsedRecord['cmd'], fields: parseFields(m[2] ?? '') });
    else recs.push({ cmd: 'row', fields: parseFields(line) }); // snapshot indented line (no add/set)
  }
  return recs;
}

// ---------------- comparable records + delta ----------------

export interface SecRec {
  key: string;                        // identity for matching current↔snapshot
  fields: Record<string, string>;     // DEFINING fields only (volatile dropped)
  id?: string;                        // live .id (current only) — for edit/delete
  managed?: boolean;                  // owned by RubyMIK (current only)
  hasSecret?: boolean;                // carries a masked secret
  raw?: Record<string, string>;       // full parsed fields (snapshot only) — carries real secret values for apply
}
export type DeltaKind = 'create' | 'edit' | 'delete';
export interface DeltaOp { kind: DeltaKind; key: string; before?: SecRec; after?: SecRec; secretChanged?: boolean; blockedNote?: string }

/** Does `current` already have every field the snapshot RECORDS (at the same value)?
 *  Asymmetric on purpose: RouterOS /export OMITS default-valued fields but the REST
 *  read returns them, so a symmetric compare would see phantom drift on defaults.
 *  The snapshot is the reference — restore only reconciles the fields it records. */
const covers = (current: Record<string, string>, snapshot: Record<string, string>): boolean => {
  for (const k of Object.keys(snapshot)) { if (SECRET_KEYS.has(k)) continue; if ((current[k] ?? '') !== snapshot[k]) return false; }
  return true;
};

/** PURE delta: make `current` match `snapshot`. Deletes only in exact mode, only
 *  managed items, never guard-protected (belt+suspenders — the write module's
 *  guard is the real enforcer and will 409 anything unsafe at apply time). */
export function planSection(snapshot: SecRec[], current: SecRec[], mode: RestoreMode, opts: { singleton?: boolean; canEdit?: boolean } = {}): DeltaOp[] {
  const curByKey = new Map(current.map((r) => [r.key, r]));
  const snapByKey = new Map(snapshot.map((r) => [r.key, r]));
  const ops: DeltaOp[] = [];
  for (const snap of snapshot) {
    const cur = curByKey.get(snap.key);
    if (!cur) { ops.push({ kind: 'create', key: snap.key, after: snap, secretChanged: snap.hasSecret }); continue; }
    if (!covers(cur.fields, snap.fields) || (snap.hasSecret && opts.canEdit)) {
      if (opts.canEdit) ops.push({ kind: 'edit', key: snap.key, before: cur, after: snap, secretChanged: snap.hasSecret });
      else { ops.push({ kind: 'delete', key: snap.key, before: cur }); ops.push({ kind: 'create', key: snap.key, after: snap, secretChanged: snap.hasSecret }); }
    }
  }
  if (mode === 'exact' && !opts.singleton) {
    for (const cur of current) {
      if (snapByKey.has(cur.key)) continue;
      if (cur.managed === false) { ops.push({ kind: 'delete', key: cur.key, before: cur, blockedNote: 'unmanaged — take ownership first (not deleted)' }); continue; }
      ops.push({ kind: 'delete', key: cur.key, before: cur });
    }
  }
  return ops;
}

// ---------------- section adapters ----------------

const num = (v: unknown) => (v == null ? '' : String(v));
const nn = (v: string | null | undefined) => (v && v !== '' ? v : undefined);
/** Keep only defining fields present + non-empty; drop volatile. */
function keep(fields: Record<string, unknown>, defining: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of defining) { const v = num(fields[k]); if (v !== '') out[k] = v; }
  return out;
}
const sig = (f: Record<string, string>) => Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join(' ');

/** RouterOS reports rates expanded ("5000000") but /export abbreviates ("5M").
 *  Normalize both to the expanded number so equal values compare equal. */
const MULT: Record<string, number> = { '': 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6, g: 1e9, G: 1e9 };
function normRate(v: string): string {
  return v.split('/').map((p) => { const m = /^(\d+(?:\.\d+)?)([kKmMgG]?)$/.exec(p.trim()); return m ? String(Math.round(Number(m[1]) * MULT[m[2]!]!)) : p; }).join('/');
}
const RATE_FIELDS = new Set(['max-limit', 'limit-at', 'burst-limit', 'burst-threshold']);
/** Normalize known unit fields in-place so representation differences aren't false drift. */
function normFields(f: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) out[k] = RATE_FIELDS.has(k) ? normRate(v) : v;
  return out;
}

export interface SectionAdapter {
  id: string; label: string; paths: string[]; order: number;
  singleton?: boolean; canEdit?: boolean; secretFields?: string[];
  /** snapshot text → comparable records (real values in .raw for apply) */
  fromSnapshot(text: string): SecRec[];
  /** live state → comparable records (with .id / .managed) */
  readCurrent(ctx: RestoreCtx): Promise<SecRec[]>;
  /** route ONE op through the module's guarded write function */
  apply(ctx: RestoreCtx, sac: SacFactory, op: DeltaOp): Promise<SafeApplyOutcome>;
}

// ---- DNS (singleton) ----
const dnsFields = (f: Record<string, unknown>): Record<string, string> => keep(f, ['servers', 'allow-remote-requests']);
const dnsAdapter: SectionAdapter = {
  id: 'dns', label: 'DNS servers', paths: ['/ip/dns'], order: 50, singleton: true, canEdit: true,
  fromSnapshot(text) {
    const r = sliceSection(text, ['/ip/dns'])[0];
    if (!r) return [];
    return [{ key: 'dns', fields: dnsFields(r.fields), raw: r.fields }];
  },
  async readCurrent(ctx) {
    const d = await readDns(ctx);
    return [{ key: 'dns', id: 'dns', managed: true, fields: dnsFields({ servers: d.servers.join(','), 'allow-remote-requests': d.allowRemoteRequests ? 'true' : 'false' }) }];
  },
  async apply(ctx, sac, op) {
    const f = (op.after ?? op.before)!.raw ?? (op.after ?? op.before)!.fields;
    return applyDns(ctx, sac('restore.dns', 'dns'), { servers: (f.servers ?? '').split(',').filter(Boolean), allowRemoteRequests: f['allow-remote-requests'] === 'yes' || f['allow-remote-requests'] === 'true', cacheSize: 2048 });
  },
};

// ---- NTP (singleton) ----
const ntpAdapter: SectionAdapter = {
  id: 'ntp', label: 'NTP client', paths: ['/system/ntp/client'], order: 51, singleton: true, canEdit: true,
  fromSnapshot(text) {
    const r = sliceSection(text, ['/system/ntp/client'])[0];
    if (!r) return [];
    return [{ key: 'ntp', fields: keep(r.fields, ['enabled', 'servers']), raw: r.fields }];
  },
  async readCurrent(ctx) {
    const n = await readNtp(ctx);
    return [{ key: 'ntp', id: 'ntp', managed: true, fields: keep({ enabled: n.enabled ? 'yes' : 'no', servers: n.servers.join(',') }, ['enabled', 'servers']) }];
  },
  async apply(ctx, sac, op) {
    const f = (op.after ?? op.before)!.raw ?? (op.after ?? op.before)!.fields;
    return applyNtp(ctx, sac('restore.ntp', 'ntp'), { enabled: f.enabled === 'yes' || f.enabled === 'true', servers: (f.servers ?? '').split(',').filter(Boolean) });
  },
};

// ---- simple queues (keyed by name; create/edit/delete) ----
const QUEUE_DEF = ['name', 'target', 'max-limit', 'limit-at', 'priority', 'parent', 'queue-type', 'burst-limit', 'burst-threshold', 'burst-time', 'comment'];
const queueSpec = (f: Record<string, string>) => {
  const [mu, md] = (f['max-limit'] ?? '').split('/');
  const [lu, ld] = (f['limit-at'] ?? '').split('/');
  return { name: f.name!, target: nn(f.target), maxLimitUp: nn(mu), maxLimitDown: nn(md), limitAtUp: nn(lu), limitAtDown: nn(ld), priority: nn(f.priority), parent: nn(f.parent), queueType: nn(f['queue-type']), burstLimit: nn(f['burst-limit']), burstThreshold: nn(f['burst-threshold']), burstTime: nn(f['burst-time']), comment: nn(f.comment) };
};
const queueAdapter: SectionAdapter = {
  id: 'queue', label: 'Simple queues', paths: ['/queue/simple'], order: 60, canEdit: true,
  fromSnapshot(text) {
    return sliceSection(text, ['/queue/simple']).filter((r) => r.fields.name).map((r) => ({ key: r.fields.name!, fields: normFields(keep(r.fields, QUEUE_DEF)), raw: r.fields }));
  },
  async readCurrent(ctx) {
    const v = await readQos(ctx);
    return v.queues.filter((q: SimpleQueue) => !q.dynamic).map((q) => ({ key: q.name, id: q.id, managed: q.managed, fields: normFields(keep({ name: q.name, target: q.target, 'max-limit': q.maxLimit, 'limit-at': q.limitAt, priority: q.priority, parent: q.parent, 'queue-type': q.queueType, 'burst-limit': q.burstLimit, 'burst-threshold': q.burstThreshold, 'burst-time': q.burstTime, comment: q.comment }, QUEUE_DEF)) }));
  },
  async apply(ctx, sac, op) {
    if (op.kind === 'delete') return removeQueue(ctx, sac('restore.queue', op.key), op.before!.id!);
    if (op.kind === 'edit') return editQueue(ctx, sac('restore.queue', op.key), op.before!.id!, queueSpec(op.after!.raw ?? op.after!.fields));
    return createQueue(ctx, sac('restore.queue', op.key), queueSpec(op.after!.raw ?? op.after!.fields));
  },
};

// ---- NAT rules (keyed by signature; create/delete) ----
const NAT_DEF = ['chain', 'action', 'in-interface', 'out-interface', 'in-interface-list', 'out-interface-list', 'src-address', 'dst-address', 'src-address-list', 'dst-address-list', 'protocol', 'src-port', 'dst-port', 'to-addresses', 'to-ports', 'comment'];
const natSpec = (f: Record<string, string>) => ({ chain: f.chain!, action: f.action!, inInterface: nn(f['in-interface']), outInterface: nn(f['out-interface']), inInterfaceList: nn(f['in-interface-list']), outInterfaceList: nn(f['out-interface-list']), srcAddress: nn(f['src-address']), dstAddress: nn(f['dst-address']), srcAddressList: nn(f['src-address-list']), dstAddressList: nn(f['dst-address-list']), protocol: nn(f.protocol), srcPort: nn(f['src-port']), dstPort: nn(f['dst-port']), toAddresses: nn(f['to-addresses']), toPorts: nn(f['to-ports']), comment: nn(f.comment) });
const natAdapter: SectionAdapter = {
  id: 'nat', label: 'NAT rules', paths: ['/ip/firewall/nat'], order: 90,
  fromSnapshot(text) {
    return sliceSection(text, ['/ip/firewall/nat']).filter((r) => r.fields.chain).map((r) => { const kf = keep(r.fields, NAT_DEF); return { key: sig(kf), fields: kf, raw: r.fields }; });
  },
  async readCurrent(ctx) {
    const v = await readNat(ctx);
    return v.rules.filter((n: NatRule) => !n.dynamic).map((n) => { const kf = keep({ chain: n.chain, action: n.action, 'in-interface': n.inInterface, 'out-interface': n.outInterface, 'in-interface-list': n.inInterfaceList, 'out-interface-list': n.outInterfaceList, 'src-address': n.srcAddress, 'dst-address': n.dstAddress, 'src-address-list': n.srcAddressList, 'dst-address-list': n.dstAddressList, protocol: n.protocol, 'src-port': n.srcPort, 'dst-port': n.dstPort, 'to-addresses': n.toAddresses, 'to-ports': n.toPorts, comment: n.comment }, NAT_DEF); return { key: sig(kf), id: n.id, managed: n.managed, fields: kf }; });
  },
  async apply(ctx, sac, op) {
    if (op.kind === 'delete') return removeNat(ctx, sac('restore.nat', op.key), op.before!.id!);
    return createNat(ctx, sac('restore.nat', op.key), natSpec(op.after!.raw ?? op.after!.fields));
  },
};

// ---- IP addresses (keyed by address+interface; add/remove) ----
const addrAdapter: SectionAdapter = {
  id: 'address', label: 'IP addresses', paths: ['/ip/address'], order: 20,
  fromSnapshot(text) {
    return sliceSection(text, ['/ip/address']).filter((r) => r.fields.address && r.fields.interface).map((r) => { const kf = keep(r.fields, ['address', 'interface']); return { key: `${kf.address}@${kf.interface}`, fields: kf, raw: r.fields }; });
  },
  async readCurrent(ctx) {
    const v = await readInterfaces(ctx);
    const out: SecRec[] = [];
    for (const iface of v.interfaces) for (const a of iface.addresses) { if (a.dynamic) continue; const kf = keep({ address: a.address, interface: a.interface }, ['address', 'interface']); out.push({ key: `${kf.address}@${kf.interface}`, id: a.id, managed: a.managed, fields: kf }); }
    return out;
  },
  async apply(ctx, sac, op) {
    if (op.kind === 'delete') return removeAddress(ctx, sac('restore.address', op.key), op.before!.id!);
    const f = op.after!.raw ?? op.after!.fields;
    return addAddress(ctx, sac('restore.address', op.key), f.interface!, f.address!);
  },
};

// ---- static routes (keyed by dst+gateway; add/edit/remove) ----
const ROUTE_DEF = ['dst-address', 'gateway', 'distance', 'comment'];
const routeAdapter: SectionAdapter = {
  id: 'route', label: 'Static routes', paths: ['/ip/route'], order: 30, canEdit: true,
  fromSnapshot(text) {
    return sliceSection(text, ['/ip/route']).filter((r) => r.fields['dst-address'] && r.fields.gateway).map((r) => { const kf = keep(r.fields, ROUTE_DEF); return { key: `${kf['dst-address']}>${kf.gateway}`, fields: kf, raw: r.fields }; });
  },
  async readCurrent(ctx) {
    const v = await readRoutes(ctx);
    return v.routes.filter((r) => r.kind === 'static').map((r) => { const kf = keep({ 'dst-address': r.dst, gateway: r.gateway, distance: r.distance, comment: r.comment }, ROUTE_DEF); return { key: `${kf['dst-address']}>${kf.gateway}`, id: r.id, managed: r.managed, fields: kf }; });
  },
  async apply(ctx, sac, op) {
    if (op.kind === 'delete') return removeRoute(ctx, sac('restore.route', op.key), op.before!.id!);
    const f = (op.after!.raw ?? op.after!.fields);
    if (op.kind === 'edit') return editRoute(ctx, sac('restore.route', op.key), op.before!.id!, { gateway: nn(f.gateway), distance: f.distance ? Number(f.distance) : undefined, comment: nn(f.comment) });
    return addRoute(ctx, sac('restore.route', op.key), { dst: f['dst-address']!, gateway: f.gateway!, distance: f.distance ? Number(f.distance) : 1, comment: nn(f.comment) ?? undefined });
  },
};

// ---- DHCP static reservations (keyed by mac; add/edit/remove) ----
const dhcpResAdapter: SectionAdapter = {
  id: 'dhcp-lease', label: 'DHCP reservations', paths: ['/ip/dhcp-server/lease'], order: 55, canEdit: true,
  fromSnapshot(text) {
    return sliceSection(text, ['/ip/dhcp-server/lease']).filter((r) => r.fields['mac-address'] && r.fields.address && r.fields.dynamic !== 'true').map((r) => { const kf = keep(r.fields, ['address', 'mac-address', 'server', 'comment']); return { key: (kf['mac-address'] ?? '').toLowerCase(), fields: kf, raw: r.fields }; });
  },
  async readCurrent(ctx) {
    const { reservations } = await readReservations(ctx);
    return reservations.map((l) => { const kf = keep({ address: l.address, 'mac-address': l['mac-address'], server: l.server, comment: l.comment }, ['address', 'mac-address', 'server', 'comment']); return { key: (kf['mac-address'] ?? '').toLowerCase(), id: l['.id'], managed: true, fields: kf }; });
  },
  async apply(ctx, sac, op) {
    if (op.kind === 'delete') return removeReservation(ctx, sac('restore.dhcp-lease', op.key), op.before!.id!);
    const f = op.after!.raw ?? op.after!.fields;
    if (op.kind === 'edit') return editReservation(ctx, sac('restore.dhcp-lease', op.key), op.before!.id!, { address: f.address, comment: nn(f.comment) ?? null });
    return addReservation(ctx, sac('restore.dhcp-lease', op.key), f.server!, { mac: f['mac-address']!, address: f.address!, comment: nn(f.comment) ?? null });
  },
};

// ---- PPPoE clients (keyed by name; create/edit/delete; carries a secret) ----
const PPPOE_DEF = ['name', 'interface', 'user', 'service-name', 'ac-name', 'comment'];
const pppoeSpec = (f: Record<string, string>) => ({ name: f.name!, interface: nn(f.interface), user: nn(f.user), password: nn(f.password), serviceName: nn(f['service-name']), acName: nn(f['ac-name']), comment: nn(f.comment) });
const pppoeAdapter: SectionAdapter = {
  id: 'pppoe', label: 'PPPoE clients', paths: ['/interface/pppoe-client'], order: 65, canEdit: true, secretFields: ['password'],
  fromSnapshot(text) {
    return sliceSection(text, ['/interface/pppoe-client']).filter((r) => r.fields.name).map((r) => ({ key: r.fields.name!, fields: keep(r.fields, [...PPPOE_DEF, 'password']), raw: r.fields, hasSecret: !!r.fields.password }));
  },
  async readCurrent(ctx) {
    const v = await readPppoe(ctx);
    return v.clients.filter((c) => !c.dynamic).map((c) => ({ key: c.name, id: c.id, managed: c.managed, hasSecret: c.hasPassword, fields: keep({ name: c.name, interface: c.interface, user: c.user, 'service-name': c.serviceName, 'ac-name': c.acName, comment: c.comment }, PPPOE_DEF) }));
  },
  async apply(ctx, sac, op) {
    if (op.kind === 'delete') return removePppoe(ctx, sac('restore.pppoe', op.key), op.before!.id!);
    if (op.kind === 'edit') return editPppoe(ctx, sac('restore.pppoe', op.key), op.before!.id!, pppoeSpec(op.after!.raw ?? op.after!.fields));
    return createPppoe(ctx, sac('restore.pppoe', op.key), pppoeSpec(op.after!.raw ?? op.after!.fields));
  },
};

/** Dependency-safe order: L2 → addresses → routes → services → firewall/NAT last. */
export const SECTIONS: SectionAdapter[] = [addrAdapter, routeAdapter, dnsAdapter, ntpAdapter, dhcpResAdapter, pppoeAdapter, queueAdapter, natAdapter].sort((a, b) => a.order - b.order);
export const sectionById = (id: string): SectionAdapter | undefined => SECTIONS.find((s) => s.id === id);

// ---------------- plan + execute ----------------

/** Mask secret values in a record for the human-readable PLAN (never log the value). */
export function maskRec(rec: SecRec | undefined): (SecRec & { masked?: string[] }) | undefined {
  if (!rec) return undefined;
  const masked: string[] = [];
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec.fields)) { if (SECRET_KEYS.has(k)) { fields[k] = '••••••'; masked.push(k); } else fields[k] = v; }
  return { ...rec, fields, raw: undefined, masked };
}

export interface SectionPlan { section: string; label: string; ops: Array<Omit<DeltaOp, 'before' | 'after'> & { before?: ReturnType<typeof maskRec>; after?: ReturnType<typeof maskRec> }>; error?: string }

export async function planRestore(ctx: RestoreCtx, text: string, sectionIds: string[], mode: RestoreMode, registry: SectionAdapter[] = SECTIONS): Promise<SectionPlan[]> {
  const byId = (id: string) => registry.find((s) => s.id === id);
  const out: SectionPlan[] = [];
  for (const id of sectionIds) {
    const def = byId(id);
    if (!def) { out.push({ section: id, label: id, ops: [], error: 'unknown section' }); continue; }
    try {
      const snap = def.fromSnapshot(text);
      const cur = await def.readCurrent(ctx);
      const ops = planSection(snap, cur, mode, { singleton: def.singleton, canEdit: def.canEdit });
      out.push({ section: id, label: def.label, ops: ops.map((o) => ({ ...o, before: maskRec(o.before), after: maskRec(o.after) })) });
    } catch (err) { out.push({ section: id, label: def.label, ops: [], error: `plan failed: ${(err as Error).message}` }); }
  }
  return out;
}

export interface RestoreOpResult { section: string; kind: DeltaKind; key: string; result: string; detail: string; auditId?: number }
export interface RestoreReport { applied: number; halted: boolean; haltReason: string | null; results: RestoreOpResult[]; remaining: Array<{ section: string; kind: DeltaKind; key: string }> }

/** Execute a plan through the guarded write modules, dep-safe order, HALTING on
 *  the first non-applied outcome (guard 409 / dead-man rollback) — no force flag,
 *  no silent skip. Reports applied vs remaining. */
export async function executeRestore(ctx: RestoreCtx, sac: SacFactory, text: string, sectionIds: string[], mode: RestoreMode, registry: SectionAdapter[] = SECTIONS): Promise<RestoreReport> {
  const byId = (id: string) => registry.find((s) => s.id === id);
  const ordered = [...sectionIds].map(byId).filter((d): d is SectionAdapter => !!d).sort((a, b) => a.order - b.order);
  const results: RestoreOpResult[] = [];
  const remaining: RestoreReport['remaining'] = [];
  let halted = false, haltReason: string | null = null;

  const allOps: Array<{ def: SectionAdapter; op: DeltaOp }> = [];
  for (const def of ordered) {
    const snap = def.fromSnapshot(text);
    const cur = await def.readCurrent(ctx);
    for (const op of planSection(snap, cur, mode, { singleton: def.singleton, canEdit: def.canEdit })) {
      if (op.blockedNote) continue; // unmanaged delete — never issued
      allOps.push({ def, op });
    }
  }
  for (const { def, op } of allOps) {
    if (halted) { remaining.push({ section: def.id, kind: op.kind, key: op.key }); continue; }
    try {
      const outcome = await def.apply(ctx, sac, op);
      results.push({ section: def.id, kind: op.kind, key: op.key, result: outcome.result, detail: outcome.detail, auditId: outcome.auditId });
      if (outcome.result === 'applied') continue;
      halted = true; haltReason = `${def.label} ${op.kind} "${op.key}" → ${outcome.result}: ${outcome.detail}`;
    } catch (err) {
      // a guard throw (e.g. MgmtTunnelProtected) surfaces here
      results.push({ section: def.id, kind: op.kind, key: op.key, result: 'refused', detail: (err as Error).message });
      halted = true; haltReason = `${def.label} ${op.kind} "${op.key}" refused: ${(err as Error).message}`;
    }
  }
  const applied = results.filter((r) => r.result === 'applied').length;
  return { applied, halted, haltReason, results, remaining };
}
