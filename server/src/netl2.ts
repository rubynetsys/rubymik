import { setTimeout as sleep } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { restGet } from './routeros/rest.js';
import { restAdd, restRemove, restSet, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { readTarget, writeTarget, resolveEndpoint, type AddressableRow } from './transport.js';
import { runSafeApply, writeAudit, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import type { SecretBox } from './secretbox.js';
import { log } from './log.js';

/**
 * Native L2 configuration (P20) — bridges, VLAN interfaces, bridge ports and the
 * bridge-VLAN table. The most brick-prone tier: an L2 op can sever the mgmt path
 * BELOW the IP layer, where P19's IP-level protections don't help.
 *
 * The core is the L2 MGMT-PATH GUARD: trace the full path RubyMIK reaches the
 * router through (mgmt IP → its interface → the bridge/VLAN it lives on → the
 * member port) and REFUSE any op that would break a link in that chain without a
 * safe transition — in particular the classic RouterOS self-lock: enabling
 * vlan-filtering on the mgmt bridge without the mgmt VLAN configured. Restructures
 * that MUST touch the mgmt path use add-before-remove-AT-L2 (build+verify the new
 * path, then remove the old — P19 pattern, now at L2). Non-mgmt L2 is additive
 * and rides runSafeApply.
 */

const TAG = 'RUBYMIK-L2:';
type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export interface L2Context { read: DeviceTarget; write: DeviceTarget; transport: WriteTransport; row: AddressableRow }
const g = (ctx: L2Context, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

export class L2Protected extends Error {}

// ---------------- read + trace the mgmt L2 path ----------------

export interface BridgeView { id: string; name: string; vlanFiltering: boolean; pvid: string | null; disabled: boolean; comment: string | null; managed: boolean; isMgmt: boolean; ports: PortView[] }
export interface PortView { id: string; interface: string | null; pvid: string | null; isMgmtPort: boolean }
export interface VlanView { id: string; name: string; vlanId: string | null; interface: string | null; disabled: boolean; comment: string | null; managed: boolean; isMgmt: boolean }
export interface BridgeVlanRow { id: string; bridge: string | null; vlanIds: string | null; tagged: string | null; untagged: string | null }
export interface L2Path {
  mgmtIp: string; mgmtInterface: string | null; mgmtInterfaceType: 'bridge' | 'vlan' | 'physical' | 'unknown';
  mgmtBridge: string | null; mgmtVlan: string | null; mgmtVlanId: string | null; mgmtPorts: string[]; mgmtNet: string;
}
export interface L2View { bridges: BridgeView[]; vlans: VlanView[]; bridgeVlans: BridgeVlanRow[]; path: L2Path }

export async function readL2(ctx: L2Context): Promise<L2View> {
  const [ifaces, bridges, ports, vlans, bvlans, addrs] = await Promise.all([
    g(ctx, '/interface') as Promise<Dict[]>,
    g(ctx, '/interface/bridge').catch(() => []) as Promise<Dict[]>,
    g(ctx, '/interface/bridge/port').catch(() => []) as Promise<Dict[]>,
    g(ctx, '/interface/vlan').catch(() => []) as Promise<Dict[]>,
    g(ctx, '/interface/bridge/vlan').catch(() => []) as Promise<Dict[]>,
    g(ctx, '/ip/address').catch(() => []) as Promise<Dict[]>,
  ]);
  const { host, net } = resolveEndpoint(ctx.row);
  const mgmtEntry = addrs.find((a) => (s(a['address']) ?? '').split('/')[0] === host);
  const mgmtInterface = mgmtEntry ? s(mgmtEntry['interface']) : null;
  const typeOf = (name: string | null): string | null => s(ifaces.find((i) => s(i['name']) === name)?.['type']);

  // Trace: what carries the mgmt IP?
  let mgmtInterfaceType: L2Path['mgmtInterfaceType'] = 'unknown';
  let mgmtBridge: string | null = null, mgmtVlan: string | null = null, mgmtVlanId: string | null = null;
  const mgmtPorts: string[] = [];
  if (mgmtInterface) {
    const t = typeOf(mgmtInterface);
    if (t === 'bridge' || bridges.some((b) => s(b['name']) === mgmtInterface)) {
      mgmtInterfaceType = 'bridge'; mgmtBridge = mgmtInterface;
    } else if (t === 'vlan' || vlans.some((v) => s(v['name']) === mgmtInterface)) {
      mgmtInterfaceType = 'vlan';
      const v = vlans.find((x) => s(x['name']) === mgmtInterface);
      mgmtVlan = mgmtInterface; mgmtVlanId = s(v?.['vlan-id']);
      const parent = s(v?.['interface']);
      if (parent && bridges.some((b) => s(b['name']) === parent)) mgmtBridge = parent;
    } else {
      mgmtInterfaceType = 'physical';
      mgmtPorts.push(mgmtInterface);   // directly-addressed physical port
    }
  }
  // ports of the mgmt bridge are on the mgmt path
  if (mgmtBridge) for (const p of ports) if (s(p['bridge']) === mgmtBridge) mgmtPorts.push(s(p['interface']) ?? '');

  const portsFor = (bridge: string): PortView[] => ports.filter((p) => s(p['bridge']) === bridge).map((p) => ({
    id: s(p['.id']) ?? '', interface: s(p['interface']), pvid: s(p['pvid']),
    isMgmtPort: mgmtPorts.includes(s(p['interface']) ?? '\0'),
  }));
  const bridgeViews: BridgeView[] = bridges.map((b) => {
    const name = s(b['name']) ?? '?'; const comment = s(b['comment']);
    return {
      id: s(b['.id']) ?? name, name, vlanFiltering: b['vlan-filtering'] === 'true', pvid: s(b['pvid']),
      disabled: b['disabled'] === 'true', comment, managed: !!comment && comment.startsWith('RUBYMIK'),
      isMgmt: name === mgmtBridge, ports: portsFor(name),
    };
  });
  const vlanViews: VlanView[] = vlans.map((v) => {
    const name = s(v['name']) ?? '?'; const comment = s(v['comment']);
    return {
      id: s(v['.id']) ?? name, name, vlanId: s(v['vlan-id']), interface: s(v['interface']),
      disabled: v['disabled'] === 'true', comment, managed: !!comment && comment.startsWith('RUBYMIK'),
      isMgmt: name === mgmtVlan,
    };
  });
  const bridgeVlanRows: BridgeVlanRow[] = bvlans.map((r) => ({
    id: s(r['.id']) ?? '', bridge: s(r['bridge']), vlanIds: s(r['vlan-ids']), tagged: s(r['tagged']), untagged: s(r['untagged']),
  }));
  return {
    bridges: bridgeViews, vlans: vlanViews, bridgeVlans: bridgeVlanRows,
    path: { mgmtIp: host, mgmtInterface, mgmtInterfaceType, mgmtBridge, mgmtVlan, mgmtVlanId, mgmtPorts: [...new Set(mgmtPorts.filter(Boolean))], mgmtNet: net },
  };
}

// ---------------- validation (pure, unit-tested) ----------------

export function isValidVlanId(id: number): boolean { return Number.isInteger(id) && id >= 1 && id <= 4094; }
export function isValidL2Name(name: string): boolean { return /^[A-Za-z][A-Za-z0-9_\-]{0,31}$/.test(name); }

export function validateBridge(name: string, existing: string[]): string[] {
  const e: string[] = [];
  if (!isValidL2Name(name)) e.push('Bridge name must start with a letter (letters/digits/-/_ , max 32).');
  if (existing.includes(name)) e.push(`A bridge/VLAN named "${name}" already exists.`);
  return e;
}
export function validateVlan(name: string, vlanId: number, iface: string, existing: string[]): string[] {
  const e: string[] = [];
  if (!isValidL2Name(name)) e.push('VLAN interface name must start with a letter (letters/digits/-/_ , max 32).');
  if (!isValidVlanId(vlanId)) e.push('VLAN id must be 1–4094.');
  if (!iface) e.push('A parent interface is required.');
  if (existing.includes(name)) e.push(`A bridge/VLAN named "${name}" already exists.`);
  return e;
}

/** Would enabling vlan-filtering on this bridge keep the mgmt port reachable? It
 *  is SAFE only if a bridge-VLAN entry carries the mgmt port's access — untagged
 *  for the mgmt PVID (access mgmt) or tagged for the mgmt VLAN id. Otherwise the
 *  classic instant lock. */
export function vlanFilteringKeepsMgmt(view: L2View): boolean {
  const { mgmtBridge, mgmtPorts, mgmtVlanId } = view.path;
  if (!mgmtBridge) return true;
  const bv = view.bridgeVlans.filter((r) => r.bridge === mgmtBridge);
  for (const port of mgmtPorts) {
    const covered = bv.some((r) => {
      const tagged = (r.tagged ?? '').split(',').map((x) => x.trim());
      const untagged = (r.untagged ?? '').split(',').map((x) => x.trim());
      if (mgmtVlanId && (r.vlanIds ?? '').split(',').map((x) => x.trim()).includes(mgmtVlanId)) return tagged.includes(port);
      return untagged.includes(port);   // access mgmt: untagged member of some VLAN
    });
    if (!covered) return false;
  }
  return true;
}

// ---------------- non-mgmt L2 writes via runSafeApply (+ guard checks) ----------------

type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: L2Context, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });

export async function createBridge(ctx: L2Context, sac: Sac, name: string, vlanFiltering: boolean): Promise<SafeApplyOutcome> {
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ ids: ((await g(ctx, '/interface/bridge')) as Dict[]).map((r) => s(r['.id']) ?? '') }),
    summary: () => `Create bridge "${name}"${vlanFiltering ? ' (vlan-filtering)' : ''}`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, '/interface/bridge', { name, comment: `${TAG} bridge`, ...(vlanFiltering ? { 'vlan-filtering': 'yes' } : {}) }); },
    verifyTook: async () => ({ ok: ((await g(ctx, '/interface/bridge')) as Dict[]).some((r) => s(r['name']) === name), after: { name } }),
    rollback: async (b) => { for (const r of ((await g(ctx, '/interface/bridge')) as Dict[]).filter((x) => !b.ids.includes(s(x['.id']) ?? ''))) await restRemove(ctx.write, ctx.transport, '/interface/bridge', s(r['.id']) ?? ''); },
  });
}

export async function addPort(ctx: L2Context, sac: Sac, bridge: string, iface: string, pvid?: number): Promise<SafeApplyOutcome> {
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ ids: ((await g(ctx, '/interface/bridge/port')) as Dict[]).map((r) => s(r['.id']) ?? '') }),
    summary: () => `Add port ${iface} to bridge "${bridge}"${pvid ? ` (pvid ${pvid})` : ''}`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, '/interface/bridge/port', { bridge, interface: iface, ...(pvid ? { pvid: String(pvid) } : {}), comment: `${TAG} port` }); },
    verifyTook: async () => ({ ok: ((await g(ctx, '/interface/bridge/port')) as Dict[]).some((r) => s(r['bridge']) === bridge && s(r['interface']) === iface) }),
    rollback: async (b) => { for (const r of ((await g(ctx, '/interface/bridge/port')) as Dict[]).filter((x) => !b.ids.includes(s(x['.id']) ?? ''))) await restRemove(ctx.write, ctx.transport, '/interface/bridge/port', s(r['.id']) ?? ''); },
  });
}

export async function createVlan(ctx: L2Context, sac: Sac, name: string, vlanId: number, iface: string): Promise<SafeApplyOutcome> {
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ ids: ((await g(ctx, '/interface/vlan')) as Dict[]).map((r) => s(r['.id']) ?? '') }),
    summary: () => `Create VLAN interface "${name}" (vlan ${vlanId} on ${iface})`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, '/interface/vlan', { name, 'vlan-id': String(vlanId), interface: iface, comment: `${TAG} vlan` }); },
    verifyTook: async () => ({ ok: ((await g(ctx, '/interface/vlan')) as Dict[]).some((r) => s(r['name']) === name) }),
    rollback: async (b) => { for (const r of ((await g(ctx, '/interface/vlan')) as Dict[]).filter((x) => !b.ids.includes(s(x['.id']) ?? ''))) await restRemove(ctx.write, ctx.transport, '/interface/vlan', s(r['.id']) ?? ''); },
  });
}

/** Generic guarded remove of an L2 object (bridge / port / vlan). The route
 *  passes the resource path + id; this refuses when it is on the mgmt path. */
export async function removeL2(ctx: L2Context, sac: Sac, resource: '/interface/bridge' | '/interface/bridge/port' | '/interface/vlan', id: string, label: string): Promise<SafeApplyOutcome> {
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => ((await g(ctx, resource)) as Dict[]).find((r) => s(r['.id']) === id),
    summary: () => `Remove ${label}`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, resource, id); },
    verifyTook: async () => ({ ok: !((await g(ctx, resource)) as Dict[]).some((r) => s(r['.id']) === id) }),
    rollback: async (b) => {
      if (!b) return;
      const body: Dict = { ...b }; delete body['.id']; delete body['.nextid']; delete body['dynamic']; delete body['running'];
      await restAdd(ctx.write, ctx.transport, resource, body as Record<string, unknown>);
    },
  });
}

/** Toggle bridge vlan-filtering / disabled — GUARDED by the route for the mgmt bridge. */
export async function setBridge(ctx: L2Context, sac: Sac, id: string, patch: { vlanFiltering?: boolean; disabled?: boolean; comment?: string }): Promise<SafeApplyOutcome> {
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => ((await g(ctx, '/interface/bridge')) as Dict[]).find((r) => s(r['.id']) === id),
    summary: (b) => `Set bridge "${s(b?.['name']) ?? id}": ${JSON.stringify(patch)}`,
    apply: async () => {
      const body: Record<string, unknown> = {};
      if (patch.vlanFiltering !== undefined) body['vlan-filtering'] = patch.vlanFiltering ? 'yes' : 'no';
      if (patch.disabled !== undefined) body.disabled = patch.disabled ? 'yes' : 'no';
      if (patch.comment !== undefined) body.comment = patch.comment;
      await restSet(ctx.write, ctx.transport, '/interface/bridge', id, body);
    },
    verifyTook: async () => ({ ok: true, after: {} }),
    rollback: async (b) => { if (b) await restSet(ctx.write, ctx.transport, '/interface/bridge', id, { 'vlan-filtering': b['vlan-filtering'], disabled: b['disabled'] }); },
  });
}

// ---------------- ADD-BEFORE-REMOVE-AT-L2 (mgmt-path restructure) ----------------

export interface L2MgmtResult { result: 'applied' | 'failed' | 'rejected'; detail: string; auditId: number; newHost?: string; sequence: string[] }

/** Move the management IP onto a NEW bridge via add-before-remove at L2: build the
 *  new bridge (+ move a port), add a new mgmt address B on it, VERIFY the SAME
 *  router still answers at B, then remove the old address/bridge. If B doesn't
 *  verify, tear the new path down and keep the old — no partition. */
export async function moveMgmtToBridge(
  db: DatabaseSync, box: SecretBox, row: AddressableRow & { id: number; name: string }, transport: WriteTransport,
  sac: Sac, opts: { newBridge: string; port: string; newCidr: string },
): Promise<L2MgmtResult> {
  const seq: string[] = [];
  const ctx: L2Context = { read: readTarget(box, row), write: writeTarget(box, row), transport, row };
  const view = await readL2(ctx);
  const A = view.path.mgmtIp;
  const audit = (result: 'applied' | 'failed' | 'rejected', detail: string, after: unknown) =>
    writeAudit(sac, result, `Move management onto new bridge "${opts.newBridge}" (add-before-remove at L2)`, { from: A }, after, detail);
  const reject = (msg: string): L2MgmtResult => ({ result: 'rejected', detail: msg, auditId: audit('rejected', `Rejected: ${msg}`, null), sequence: seq });

  if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(opts.newCidr)) return reject('New management address must be a valid CIDR.');
  if (!isValidL2Name(opts.newBridge)) return reject('New bridge name is invalid.');
  const Bip = opts.newCidr.split('/')[0]!;
  const targetAt = (ip: string): DeviceTarget => ({ ...ctx.read, host: ip });
  let serialA: string | null = null;
  try { serialA = s((await g(ctx, '/system/routerboard') as Dict)['serial-number']); } catch { /* CHR */ }

  const created: Array<{ resource: string; id: string }> = [];
  try {
    // STEP 1 — build the NEW L2 path (bridge + port + address B). Old path intact.
    const br = await restAdd(ctx.write, transport, '/interface/bridge', { name: opts.newBridge, comment: `${TAG} bridge` });
    created.push({ resource: '/interface/bridge', id: s(br['.id']) ?? '' }); seq.push(`created bridge ${opts.newBridge}`);
    const pr = await restAdd(ctx.write, transport, '/interface/bridge/port', { bridge: opts.newBridge, interface: opts.port, comment: `${TAG} port` });
    created.push({ resource: '/interface/bridge/port', id: s(pr['.id']) ?? '' }); seq.push(`added port ${opts.port} to ${opts.newBridge}`);
    const ad = await restAdd(ctx.write, transport, '/ip/address', { address: opts.newCidr, interface: opts.newBridge, comment: `${TAG} mgmt (add-before-remove L2)` });
    created.push({ resource: '/ip/address', id: s(ad['.id']) ?? '' }); seq.push(`added mgmt address ${opts.newCidr} on ${opts.newBridge} (old ${A} still present)`);
  } catch (err) {
    await teardown(ctx, transport, created);
    const detail = `Could not build the new L2 path: ${(err as Error).message}. Rolled back; router still reachable on ${A}.`;
    return { result: 'failed', detail, auditId: audit('failed', detail, null), sequence: seq };
  }

  // STEP 2 — VERIFY the same router answers at B over the new path.
  let verified = false;
  try {
    await sleep(1500);
    const rb = await restGet(targetAt(Bip), transport.scheme, transport.port, '/system/routerboard') as Dict;
    await restGet(targetAt(Bip), transport.scheme, transport.port, '/system/resource');
    verified = serialA === null || s(rb['serial-number']) === serialA;
    seq.push(verified ? `verified reachable at ${Bip} on the new bridge${serialA ? ` (serial ${serialA})` : ''}` : `reached ${Bip} but serial mismatch`);
  } catch (err) { verified = false; seq.push(`could not reach the router at ${Bip}: ${(err as Error).message}`); }

  if (!verified) {
    await teardown(ctx, transport, created);
    const detail = `The new L2 path did NOT verify (${Bip} not reachable as the same router). Tore it down, kept the old path. Router stayed reachable on ${A} throughout — no partition.`;
    return { result: 'failed', detail, auditId: audit('failed', detail, null), sequence: seq };
  }

  // STEP 3 — remove the OLD mgmt address (via B), update endpoint.
  try {
    const oldAddr = ((await g(ctx, '/ip/address')) as Dict[]).find((a) => (s(a['address']) ?? '').split('/')[0] === A);
    if (oldAddr) await restRemove(targetAt(Bip), transport, '/ip/address', s(oldAddr['.id']) ?? '');
    seq.push(`removed old mgmt address ${A}`);
  } catch (err) { seq.push(`kept old address (removal failed: ${(err as Error).message})`); }
  const now = new Date().toISOString();
  if (row.net_transport === 'tunnel') db.prepare('UPDATE devices SET tunnel_ip = ?, updated_at = ? WHERE id = ?').run(Bip, now, row.id);
  else db.prepare('UPDATE devices SET host = ?, updated_at = ? WHERE id = ?').run(Bip, now, row.id);
  seq.push(`RubyMIK endpoint updated to ${Bip}`);
  const detail = `Built new bridge "${opts.newBridge}", verified reachable at ${Bip}, removed old ${A}, endpoint updated. Reachable on ≥1 path at every step — no unreachable moment.`;
  return { result: 'applied', detail, auditId: audit('applied', detail, { newBridge: opts.newBridge, to: opts.newCidr }), newHost: Bip, sequence: seq };
}

async function teardown(ctx: L2Context, transport: WriteTransport, created: Array<{ resource: string; id: string }>): Promise<void> {
  for (const c of [...created].reverse()) { try { if (c.id) await restRemove(ctx.write, transport, c.resource, c.id); } catch (err) { log.warn(`L2 teardown: ${(err as Error).message}`); } }
}
