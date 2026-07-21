import { restGet } from './routeros/rest.js';
import { restAdd, restSet, restRemove, restCommand, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { type AddressableRow } from './transport.js';
import { runSafeApply, auditRejected, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import { readL2, type L2Context } from './netl2.js';
import { log } from './log.js';

/**
 * Native NAT configuration (P22) — /ip/firewall/nat CRUD + reorder + enable/disable.
 *
 * NAT is IP-layer-recoverable, so the safety mechanism is the EXISTING dead-man
 * (P5 runSafeApply: apply → verify reachable → auto-rollback of the nat delta), not
 * a new one. On top of that a NAT-specific mgmt guard refuses, up front, the two NAT
 * shapes that can cut management before the dead-man could ever see it:
 *   1. a dst-nat/redirect that captures RubyMIK's management socket, and
 *   2. an all-port redirect on the management in-interface.
 * A src-nat/masquerade that provably rewrites the management flow is also refused;
 * anything ambiguous falls through to the dead-man rather than being refused.
 */

export const TAG = 'RUBYMIK-NAT';

type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const n = (v: unknown): number | null => { const x = Number(v); return Number.isFinite(x) ? x : null; };

export type NatContext = L2Context; // { read, write, transport, row }
const g = (ctx: NatContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

export class NatProtected extends Error {}

export interface NatRule {
  id: string;
  order: number;                 // position in the chain (0-based, as returned)
  chain: string;                 // srcnat | dstnat
  action: string;                // masquerade | src-nat | dst-nat | redirect | netmap | accept | ...
  inInterface: string | null;
  outInterface: string | null;
  inInterfaceList: string | null;
  outInterfaceList: string | null;
  srcAddress: string | null;
  dstAddress: string | null;
  srcAddressList: string | null;
  dstAddressList: string | null;
  protocol: string | null;
  srcPort: string | null;
  dstPort: string | null;
  toAddresses: string | null;
  toPorts: string | null;
  comment: string | null;
  disabled: boolean;
  dynamic: boolean;
  invalid: boolean;
  bytes: number | null;
  packets: number | null;
  managed: boolean;              // RubyMIK created/owns it (RUBYMIK-NAT comment)
}

export interface NatMgmtInfo {
  mgmtIp: string;
  mgmtInterface: string | null;  // the interface (bridge/vlan/physical) carrying the mgmt IP
  mgmtPorts: string[];           // physical ports on the mgmt path
  mgmtPort: number;              // the service port RubyMIK connects to (REST)
  mgmtScheme: string;
}

export interface NatView { rules: NatRule[]; mgmt: NatMgmtInfo }

function isManaged(comment: string | null): boolean { return !!comment && comment.startsWith(TAG); }

function toRule(r: Dict, order: number): NatRule {
  const comment = s(r['comment']);
  return {
    id: s(r['.id']) ?? String(order),
    order,
    chain: s(r['chain']) ?? '?',
    action: s(r['action']) ?? '?',
    inInterface: s(r['in-interface']),
    outInterface: s(r['out-interface']),
    inInterfaceList: s(r['in-interface-list']),
    outInterfaceList: s(r['out-interface-list']),
    srcAddress: s(r['src-address']),
    dstAddress: s(r['dst-address']),
    srcAddressList: s(r['src-address-list']),
    dstAddressList: s(r['dst-address-list']),
    protocol: s(r['protocol']),
    srcPort: s(r['src-port']),
    dstPort: s(r['dst-port']),
    toAddresses: s(r['to-addresses']),
    toPorts: s(r['to-ports']),
    comment,
    disabled: r['disabled'] === 'true',
    dynamic: r['dynamic'] === 'true',
    invalid: r['invalid'] === 'true',
    bytes: n(r['bytes']),
    packets: n(r['packets']),
    managed: isManaged(comment),
  };
}

/** Read the whole NAT table (order preserved) + the management path/port context. */
export async function readNat(ctx: NatContext): Promise<NatView> {
  const rows = await g(ctx, '/ip/firewall/nat') as Dict[];
  const rules = rows.map((r, i) => toRule(r, i));
  return { rules, mgmt: await mgmtInfo(ctx) };
}

/** Management context: reuse the P20 L2 mgmt-path trace + the transport service port. */
export async function mgmtInfo(ctx: NatContext): Promise<NatMgmtInfo> {
  const l2 = await readL2(ctx);
  return {
    mgmtIp: l2.path.mgmtIp,
    mgmtInterface: l2.path.mgmtInterface,
    mgmtPorts: l2.path.mgmtPorts,
    mgmtPort: ctx.transport.port,
    mgmtScheme: ctx.transport.scheme,
  };
}

// ---------------- validation (pure) ----------------

export interface NatRuleSpec {
  chain: string; action: string;
  inInterface?: string | null; outInterface?: string | null; inInterfaceList?: string | null; outInterfaceList?: string | null;
  srcAddress?: string | null; dstAddress?: string | null; srcAddressList?: string | null; dstAddressList?: string | null;
  protocol?: string | null; srcPort?: string | null; dstPort?: string | null; toAddresses?: string | null; toPorts?: string | null;
  comment?: string | null; disabled?: boolean;
}

const SRCNAT_ACTIONS = new Set(['masquerade', 'src-nat', 'netmap', 'accept']);
const DSTNAT_ACTIONS = new Set(['dst-nat', 'redirect', 'netmap', 'accept']);
const isIpish = (v: string) => /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?(-(\d{1,3}\.){3}\d{1,3})?$/.test(v);

/** A RouterOS port spec: single, comma list, and/or N-M ranges (1–65535). */
export function isValidPortSpec(spec: string): boolean {
  if (!spec) return false;
  return spec.split(',').every((part) => {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return false;
    const a = Number(m[1]); const b = m[2] === undefined ? a : Number(m[2]);
    return a >= 1 && a <= 65535 && b >= 1 && b <= 65535 && a <= b;
  });
}

/** Does a RouterOS dst/src-port spec include a given port? Empty spec = all ports. */
export function portSpecIncludes(spec: string | null | undefined, port: number): boolean {
  if (!spec) return true; // no port constraint → matches every port
  return spec.split(',').some((part) => {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return false;
    const a = Number(m[1]); const b = m[2] === undefined ? a : Number(m[2]);
    return port >= a && port <= b;
  });
}

export function validateNatInput(r: NatRuleSpec): string[] {
  const e: string[] = [];
  if (r.chain !== 'srcnat' && r.chain !== 'dstnat') e.push('Chain must be srcnat or dstnat.');
  const allowed = r.chain === 'srcnat' ? SRCNAT_ACTIONS : r.chain === 'dstnat' ? DSTNAT_ACTIONS : new Set<string>();
  if (!allowed.has(r.action)) e.push(`Action "${r.action}" is not valid for chain ${r.chain}.`);
  // action-specific required targets
  if ((r.action === 'src-nat' || r.action === 'netmap') && !r.toAddresses) e.push(`${r.action} requires to-addresses.`);
  if (r.action === 'dst-nat' && !r.toAddresses && !r.toPorts) e.push('dst-nat requires to-addresses and/or to-ports.');
  if (r.action === 'redirect' && !r.toPorts) e.push('redirect requires to-ports.');
  // field formats
  for (const [k, v] of [['src-port', r.srcPort], ['dst-port', r.dstPort], ['to-ports', r.toPorts]] as const)
    if (v && !isValidPortSpec(v)) e.push(`${k} "${v}" is not a valid port / port range.`);
  for (const [k, v] of [['src-address', r.srcAddress], ['dst-address', r.dstAddress], ['to-addresses', r.toAddresses]] as const)
    if (v && !isIpish(v)) e.push(`${k} "${v}" is not a valid address / range.`);
  if ((r.srcPort || r.dstPort) && !r.protocol) e.push('A port match requires a protocol (tcp or udp).');
  return e;
}

// ---------------- the NAT management guard ----------------
// Refuse ONLY provable cuts; ambiguous cases fall through to the dead-man.

const onMgmt = (iface: string | null | undefined, mgmt: NatMgmtInfo): boolean =>
  !!iface && (iface === mgmt.mgmtInterface || mgmt.mgmtPorts.includes(iface));

/**
 * Returns a refusal message if the (effective, enabled) rule would provably cut the
 * management path, else null. Callers pass the rule that would RESULT from the op;
 * a disabled result can't cut, so it's never refused (covers class 4).
 */
export function natMgmtGuard(mgmt: NatMgmtInfo, r: NatRuleSpec): string | null {
  if (r.disabled) return null; // a disabled rule cannot steal the socket
  const dstIsMgmt = !r.dstAddress || r.dstAddress === mgmt.mgmtIp; // empty dst-address = every dst incl. the router
  const tcpish = !r.protocol || r.protocol === 'tcp'; // RubyMIK's REST management is TCP

  // Class 2: an all-port redirect on the management in-interface captures everything, incl. mgmt.
  if (r.action === 'redirect' && !r.dstPort && onMgmt(r.inInterface, mgmt)) {
    return `An all-port "redirect" on the management interface "${r.inInterface}" would capture the management connection RubyMIK uses to reach this router. Refused.`;
  }
  // Class 1: dst-nat/redirect that catches the mgmt service port at/for the router.
  if ((r.action === 'dst-nat' || r.action === 'redirect') && tcpish && dstIsMgmt && portSpecIncludes(r.dstPort, mgmt.mgmtPort)) {
    return `This ${r.action} rule captures the management port ${mgmt.mgmtPort} on ${mgmt.mgmtIp} — it would steal RubyMIK's management socket and forward it elsewhere. Refused.`;
  }
  // Class 3: src-nat/masquerade that PROVABLY rewrites the management return path.
  // Provable = it rewrites traffic leaving the mgmt interface with no narrowing scope.
  // Ambiguous (any src/dst scoping present) → do NOT refuse; the dead-man catches a real cut.
  if (r.chain === 'srcnat' && (r.action === 'masquerade' || r.action === 'src-nat')) {
    const scoped = !!(r.srcAddress || r.dstAddress || r.srcAddressList || r.dstAddressList || r.inInterface || r.inInterfaceList);
    if (onMgmt(r.outInterface, mgmt) && !scoped) {
      return `This ${r.action} rewrites the source of ALL traffic leaving the management interface "${r.outInterface}" — it would break the return path for RubyMIK's management traffic. Refused.`;
    }
  }
  return null;
}

// ---------------- NAT writes via runSafeApply (dead-man) ----------------

type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: NatContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });
const NAT = '/ip/firewall/nat';

const FIELD_MAP: Record<string, string> = {
  inInterface: 'in-interface', outInterface: 'out-interface', inInterfaceList: 'in-interface-list', outInterfaceList: 'out-interface-list',
  srcAddress: 'src-address', dstAddress: 'dst-address', srcAddressList: 'src-address-list', dstAddressList: 'dst-address-list',
  protocol: 'protocol', srcPort: 'src-port', dstPort: 'dst-port', toAddresses: 'to-addresses', toPorts: 'to-ports',
};

export function taggedComment(c: string | null | undefined): string {
  const u = (c ?? '').replace(/^RUBYMIK-NAT:?\s*/i, '').trim();
  return u ? `${TAG}: ${u}` : TAG;
}

function specToBody(spec: NatRuleSpec): Record<string, unknown> {
  const b: Record<string, unknown> = { chain: spec.chain, action: spec.action };
  const rec = spec as unknown as Record<string, unknown>;
  for (const [k, ros] of Object.entries(FIELD_MAP)) {
    const v = rec[k];
    if (v != null && v !== '') b[ros] = v;
  }
  if (spec.disabled) b.disabled = 'yes';
  b.comment = taggedComment(spec.comment);
  return b;
}

/** Every editable NAT field, so an edit's rollback can fully restore (clearing
 *  fields the edit added by setting them empty). */
const EDITABLE = [...Object.values(FIELD_MAP), 'chain', 'action', 'comment', 'disabled'];
function restoreBody(before: Dict): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  for (const f of EDITABLE) b[f] = f in before && before[f] != null ? before[f] : '';
  return b;
}

const readIds = async (ctx: NatContext): Promise<string[]> => ((await g(ctx, NAT)) as Dict[]).map((r) => s(r['.id']) ?? '');
const findRule = async (ctx: NatContext, id: string): Promise<Dict | undefined> => ((await g(ctx, NAT)) as Dict[]).find((r) => s(r['.id']) === id);

/** Create a NAT rule (RUBYMIK-NAT tagged). Rollback removes any rule not present
 *  before (the nat-delta restore — narrowly scoped to /ip/firewall/nat). */
export async function createNat(ctx: NatContext, sac: Sac, spec: NatRuleSpec): Promise<SafeApplyOutcome> {
  let beforeIds: string[] = [];
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => { beforeIds = await readIds(ctx); return { ids: beforeIds }; },
    summary: () => `Add ${spec.chain} ${spec.action} rule`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, NAT, specToBody(spec)); },
    verifyTook: async () => ({ ok: (await readIds(ctx)).some((id) => !beforeIds.includes(id)), after: { chain: spec.chain, action: spec.action } }),
    rollback: async (b) => { for (const id of (await readIds(ctx)).filter((x) => !b.ids.includes(x))) await restRemove(ctx.write, ctx.transport, NAT, id); },
  });
}

/** Edit a NAT rule. Rollback restores the full pre-edit field set. */
export async function editNat(ctx: NatContext, sac: Sac, id: string, spec: NatRuleSpec): Promise<SafeApplyOutcome> {
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => findRule(ctx, id),
    summary: () => `Edit ${spec.chain} ${spec.action} rule ${id}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, NAT, id, specToBody(spec)); },
    verifyTook: async () => ({ ok: !!(await findRule(ctx, id)) }),
    rollback: async (b) => { if (b) await restSet(ctx.write, ctx.transport, NAT, id, restoreBody(b)); },
  });
}

/** Enable/disable a NAT rule. (Disable is never guard-refused; enable is guarded by the route.) */
export async function setNatEnabled(ctx: NatContext, sac: Sac, id: string, disabled: boolean): Promise<SafeApplyOutcome> {
  return runSafeApply<{ was: boolean }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ was: (await findRule(ctx, id))?.['disabled'] === 'true' }),
    summary: () => `${disabled ? 'Disable' : 'Enable'} NAT rule ${id}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, NAT, id, { disabled: disabled ? 'yes' : 'no' }); },
    verifyTook: async () => ({ ok: ((await findRule(ctx, id))?.['disabled'] === 'true') === disabled }),
    rollback: async (b) => { await restSet(ctx.write, ctx.transport, NAT, id, { disabled: b.was ? 'yes' : 'no' }); },
  });
}

/** Remove a NAT rule. Rollback re-adds it. (Removal never steals the socket → not guard-refused.) */
export async function removeNat(ctx: NatContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => findRule(ctx, id),
    summary: () => `Remove NAT rule ${id}`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, NAT, id); },
    verifyTook: async () => ({ ok: !(await findRule(ctx, id)) }),
    rollback: async (b) => {
      if (!b) return;
      const body: Dict = { ...b };
      for (const k of ['.id', '.nextid', 'dynamic', 'invalid', 'bytes', 'packets']) delete body[k];
      await restAdd(ctx.write, ctx.transport, NAT, body as Record<string, unknown>);
    },
  });
}

/** Take ownership of an unmanaged rule: tag it RUBYMIK-NAT (keeping any existing comment). */
export async function takeOwnershipNat(ctx: NatContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => findRule(ctx, id),
    summary: () => `Take ownership of NAT rule ${id}`,
    apply: async () => { const r = await findRule(ctx, id); await restSet(ctx.write, ctx.transport, NAT, id, { comment: taggedComment(s(r?.['comment'])) }); },
    verifyTook: async () => ({ ok: isManaged(s((await findRule(ctx, id))?.['comment'])) }),
    rollback: async (b) => { if (b) await restSet(ctx.write, ctx.transport, NAT, id, { comment: s(b['comment']) ?? '' }); },
  });
}

/** Reorder: a single move of `id` to sit before `destId` (or to the end when destId is null). */
export async function moveNat(ctx: NatContext, sac: Sac, id: string, destId: string | null): Promise<SafeApplyOutcome> {
  let beforeOrder: string[] = [];
  return runSafeApply<{ order: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => { beforeOrder = await readIds(ctx); return { order: beforeOrder }; },
    summary: () => `Move NAT rule ${id} ${destId ? `before ${destId}` : 'to end'}`,
    apply: async () => { await restCommand(ctx.write, ctx.transport, `${NAT}/move`, destId ? { numbers: id, destination: destId } : { numbers: id }); },
    verifyTook: async () => {
      // success = the rule reached the requested position (immediately before destId,
      // or at the end when destId is null) — true even if it was already there.
      const order = await readIds(ctx); const i = order.indexOf(id);
      if (i < 0) return { ok: false, detail: 'rule not found after move' };
      if (destId === null) return { ok: i === order.length - 1 };
      const j = order.indexOf(destId);
      return { ok: j >= 0 && i === j - 1, detail: `now at ${i}, target before ${j}` };
    },
    rollback: async (b) => {
      // restore original order: place `id` before the id that originally followed it.
      const idx = b.order.indexOf(id);
      const successor = idx >= 0 && idx + 1 < b.order.length ? b.order[idx + 1] : null;
      if (successor === id) return;
      await restCommand(ctx.write, ctx.transport, `${NAT}/move`, successor ? { numbers: id, destination: successor } : { numbers: id });
    },
  });
}

export { auditRejected };
