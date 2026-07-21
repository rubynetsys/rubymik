import { setTimeout as sleep } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { restGet } from './routeros/rest.js';
import { restAdd, restSet, restRemove, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { readTarget, writeTarget, resolveEndpoint, type AddressableRow } from './transport.js';
import { runSafeApply, writeAudit, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import { withWriteOp } from './snapshothook.js';
import { readL2, type L2Context } from './netl2.js';
import type { SecretBox } from './secretbox.js';
import { log } from './log.js';

/**
 * Native PPPoE client (P24) — /interface/pppoe-client CRUD + enable/disable.
 *
 * PPPoE reconfigures a WAN-facing interface. On a LAN-managed router that's
 * additive; but where RubyMIK reaches a router THROUGH its WAN, replacing WAN
 * connectivity is the P19/P20 total-partition problem. So P24 adds:
 *   - pppoeMgmtGuard: refuses provable cuts (a client on the mgmt port, or
 *     deleting/disabling / re-parenting the client the mgmt path rides).
 *   - replaceWanPppoe: add-before-remove for a mgmt-path WAN swap (moveMgmtToBridge
 *     applied to PPPoE).
 * The PPPoE password is a secret: never returned to the browser (presence only),
 * never logged, never written to the audit before/after (kept in a closure for
 * rollback). /export show-sensitive still captures it, but snapshots are encrypted.
 */

export const TAG = 'RUBYMIK-PPPOE';

type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const b = (v: unknown): boolean => v === 'true' || v === 'yes';

export type PppoeContext = L2Context; // { read, write, transport, row }
const g = (ctx: PppoeContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

export class PppoeProtected extends Error {}

export interface PppoeClient {
  id: string; name: string; interface: string | null; user: string | null; hasPassword: boolean;
  serviceName: string | null; acName: string | null;
  addDefaultRoute: boolean; defaultRouteDistance: string | null; usePeerDns: boolean; allow: string | null;
  disabled: boolean; dynamic: boolean; invalid: boolean; comment: string | null; managed: boolean;
  // session status — the "is the line up" signal
  running: boolean; status: string; uptime: string | null; localAddress: string | null; remoteAddress: string | null; actualMtu: string | null; lastError: string | null;
  isMgmtPath: boolean; // the mgmt IP currently rides this pppoe interface
}
export interface PppoeMgmtInfo { mgmtIp: string; mgmtInterface: string | null; mgmtPorts: string[]; mgmtPort: number; mgmtScheme: string }
export interface PppoeView { clients: PppoeClient[]; mgmt: PppoeMgmtInfo }

const isManaged = (comment: string | null): boolean => !!comment && comment.startsWith(TAG);

export async function readPppoe(ctx: PppoeContext): Promise<PppoeView> {
  const [rows, ifaces, addrs] = await Promise.all([
    g(ctx, '/interface/pppoe-client') as Promise<Dict[]>,
    g(ctx, '/interface').catch(() => []) as Promise<Dict[]>,
    g(ctx, '/ip/address').catch(() => []) as Promise<Dict[]>,
  ]);
  const mgmt = await mgmtInfo(ctx);
  const clients = rows.map((r) => {
    const name = s(r['name']) ?? '?';
    const iface = ifaces.find((i) => s(i['name']) === name);
    const localAddr = addrs.find((a) => s(a['interface']) === name);
    const running = b(r['running']) || b(iface?.['running']);
    const disabled = b(r['disabled']);
    const comment = s(r['comment']);
    const status = disabled ? 'disabled' : running ? 'running' : s(r['status']) ?? 'connecting';
    return {
      id: s(r['.id']) ?? name, name, interface: s(r['interface']), user: s(r['user']), hasPassword: !!s(r['password']),
      serviceName: s(r['service-name']), acName: s(r['ac-name']),
      addDefaultRoute: b(r['add-default-route']), defaultRouteDistance: s(r['default-route-distance']), usePeerDns: b(r['use-peer-dns']), allow: s(r['allow']),
      disabled, dynamic: b(r['dynamic']), invalid: b(r['invalid']), comment, managed: isManaged(comment),
      running, status, uptime: s(r['uptime']) ?? s(iface?.['last-link-up-time']),
      localAddress: s(r['local-address']) ?? (localAddr ? ((s(localAddr['address']) ?? '').split('/')[0] ?? null) : null),
      remoteAddress: s(r['remote-address']), actualMtu: s(iface?.['actual-mtu']), lastError: running || disabled ? null : (s(r['status']) ?? s(r['last-error'])),
      isMgmtPath: name === mgmt.mgmtInterface,
    };
  });
  return { clients, mgmt };
}

export async function mgmtInfo(ctx: PppoeContext): Promise<PppoeMgmtInfo> {
  const l2 = await readL2(ctx);
  return { mgmtIp: l2.path.mgmtIp, mgmtInterface: l2.path.mgmtInterface, mgmtPorts: l2.path.mgmtPorts, mgmtPort: ctx.transport.port, mgmtScheme: ctx.transport.scheme };
}

// ---------------- validation (pure) ----------------

export interface PppoeSpec {
  name: string; interface?: string | null; user?: string | null; password?: string | null;
  serviceName?: string | null; acName?: string | null;
  addDefaultRoute?: boolean; defaultRouteDistance?: string | null; usePeerDns?: boolean; allow?: string | null;
  comment?: string | null; disabled?: boolean;
}
const isName = (v: string) => /^[A-Za-z][\w.\-]{0,63}$/.test(v);

export function validatePppoeInput(p: PppoeSpec, opts: { create: boolean }): string[] {
  const e: string[] = [];
  if (!p.name || !isName(p.name.trim())) e.push('A valid PPPoE client name is required.');
  if (!p.interface || !p.interface.trim()) e.push('A parent interface (the port PPPoE dials over) is required.');
  if (opts.create && (!p.user || !p.user.trim())) e.push('A PPPoE user name is required.');
  if (opts.create && !p.password) e.push('A PPPoE password is required.');
  if (p.defaultRouteDistance && !/^\d{1,3}$/.test(p.defaultRouteDistance.trim())) e.push('default-route-distance must be 0–255.');
  if (p.allow) { const ok = new Set(['pap', 'chap', 'mschap1', 'mschap2']); if (!p.allow.split(',').every((a) => ok.has(a.trim()))) e.push('allow must be pap/chap/mschap1/mschap2.'); }
  return e;
}

// ---------------- the PPPoE management guard ----------------

const onMgmtPort = (iface: string | null | undefined, mgmt: PppoeMgmtInfo): boolean =>
  !!iface && (iface === mgmt.mgmtInterface || mgmt.mgmtPorts.includes(iface));

export type PppoeOp = 'create' | 'edit' | 'delete' | 'disable' | 'enable';

/** Refuse provable management cuts (classes 1–3). Class 4 (spare-port PPPoE,
 *  credential/service edits on non-mgmt sessions) → null → dead-man. */
export function pppoeMgmtGuard(mgmt: PppoeMgmtInfo, op: PppoeOp, spec: PppoeSpec | null, existing?: PppoeClient): string | null {
  // class 1: a NEW client would seize the mgmt port for PPP.
  if (op === 'create' && spec && onMgmtPort(spec.interface, mgmt)) {
    return `The parent interface "${spec.interface}" carries the management path — a PPPoE client would seize it for PPP and management traffic on that port would die. Refused.`;
  }
  // class 2: deleting/disabling the client the mgmt IP currently rides severs mgmt.
  if ((op === 'delete' || op === 'disable') && existing?.isMgmtPath) {
    return `"${existing.name}" is the interface the management IP currently rides — ${op === 'delete' ? 'deleting' : 'disabling'} it would sever management. Refused (use "Replace WAN" for a safe add-before-remove swap).`;
  }
  // class 3: re-parenting the mgmt-path client = delete+recreate elsewhere → must use add-before-remove.
  if (op === 'edit' && existing?.isMgmtPath && spec?.interface && spec.interface !== existing.interface) {
    return `Changing the parent interface of the management-path PPPoE client "${existing.name}" is a delete-and-recreate — it must go through "Replace WAN" (add-before-remove), not a direct edit. Refused.`;
  }
  return null;
}

// ---------------- writes via runSafeApply (password redacted from audit) ----------------

type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: PppoeContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });
const PC = '/interface/pppoe-client';

export function taggedComment(c: string | null | undefined): string {
  const u = (c ?? '').replace(/^RUBYMIK-PPPOE:?\s*/i, '').trim();
  return u ? `${TAG}: ${u}` : TAG;
}
/** A copy with the PPPoE password stripped — for anything audited/logged. */
function redact(row: Dict): Dict { const c: Dict = { ...row }; if ('password' in c) c.password = '(set)'; return c; }

function specToBody(p: PppoeSpec, opts: { includePassword: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = { name: p.name.trim() };
  if (p.interface) body.interface = p.interface.trim();
  if (p.user) body.user = p.user.trim();
  if (opts.includePassword && p.password) body.password = p.password;
  if (p.serviceName !== undefined) body['service-name'] = p.serviceName ?? '';
  if (p.acName !== undefined) body['ac-name'] = p.acName ?? '';
  if (p.addDefaultRoute !== undefined) body['add-default-route'] = p.addDefaultRoute ? 'yes' : 'no';
  if (p.defaultRouteDistance) body['default-route-distance'] = p.defaultRouteDistance;
  if (p.usePeerDns !== undefined) body['use-peer-dns'] = p.usePeerDns ? 'yes' : 'no';
  if (p.allow) body.allow = p.allow;
  if (p.disabled) body.disabled = 'yes';
  body.comment = taggedComment(p.comment);
  return body;
}

const readIds = async (ctx: PppoeContext): Promise<string[]> => ((await g(ctx, PC)) as Dict[]).map((r) => s(r['.id']) ?? '');
const findRow = async (ctx: PppoeContext, id: string): Promise<Dict | undefined> => ((await g(ctx, PC)) as Dict[]).find((r) => s(r['.id']) === id);

export async function createPppoe(ctx: PppoeContext, sac: Sac, spec: PppoeSpec): Promise<SafeApplyOutcome> {
  let beforeIds: string[] = [];
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => { beforeIds = await readIds(ctx); return { ids: beforeIds }; },
    summary: () => `Create PPPoE client "${spec.name}" on ${spec.interface} (user ${spec.user}, password set — redacted)`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, PC, specToBody(spec, { includePassword: true })); },
    verifyTook: async () => ({ ok: (await readIds(ctx)).some((id) => !beforeIds.includes(id)), after: { name: spec.name } }),
    rollback: async (bb) => { for (const id of (await readIds(ctx)).filter((x) => !bb.ids.includes(x))) await restRemove(ctx.write, ctx.transport, PC, id); },
  });
}

export async function editPppoe(ctx: PppoeContext, sac: Sac, id: string, spec: PppoeSpec): Promise<SafeApplyOutcome> {
  let realBefore: Dict | undefined; // holds the real password for rollback; NEVER audited
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => { realBefore = await findRow(ctx, id); return realBefore ? redact(realBefore) : undefined; },
    summary: () => `Edit PPPoE client "${spec.name}"${spec.password ? ' (password changed — redacted)' : ''}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, PC, id, specToBody(spec, { includePassword: !!spec.password })); },
    verifyTook: async () => ({ ok: !!(await findRow(ctx, id)) }),
    rollback: async () => { if (realBefore) { const bod: Dict = { ...realBefore }; for (const k of ['.id', '.nextid', 'dynamic', 'running', 'uptime', 'invalid']) delete bod[k]; await restSet(ctx.write, ctx.transport, PC, id, bod as Record<string, unknown>); } },
  });
}

export async function setPppoeEnabled(ctx: PppoeContext, sac: Sac, id: string, disabled: boolean): Promise<SafeApplyOutcome> {
  return runSafeApply<{ was: boolean }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ was: b((await findRow(ctx, id))?.['disabled']) }),
    summary: () => `${disabled ? 'Disable' : 'Enable'} PPPoE client ${id}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, PC, id, { disabled: disabled ? 'yes' : 'no' }); },
    verifyTook: async () => ({ ok: b((await findRow(ctx, id))?.['disabled']) === disabled }),
    rollback: async (bb) => { await restSet(ctx.write, ctx.transport, PC, id, { disabled: bb.was ? 'yes' : 'no' }); },
  });
}

export async function removePppoe(ctx: PppoeContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  let realBefore: Dict | undefined; // holds the real password for re-add on rollback; NEVER audited
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => { realBefore = await findRow(ctx, id); return realBefore ? redact(realBefore) : undefined; },
    summary: () => `Remove PPPoE client ${id}`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, PC, id); },
    verifyTook: async () => ({ ok: !(await findRow(ctx, id)) }),
    rollback: async () => { if (realBefore) { const bod: Dict = { ...realBefore }; for (const k of ['.id', '.nextid', 'dynamic', 'running', 'uptime', 'invalid']) delete bod[k]; await restAdd(ctx.write, ctx.transport, PC, bod as Record<string, unknown>); } },
  });
}

export async function takeOwnershipPppoe(ctx: PppoeContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  return runSafeApply<{ comment: string | null }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ comment: s((await findRow(ctx, id))?.['comment']) }),
    summary: () => `Take ownership of PPPoE client ${id}`,
    apply: async () => { const r = await findRow(ctx, id); await restSet(ctx.write, ctx.transport, PC, id, { comment: taggedComment(s(r?.['comment'])) }); },
    verifyTook: async () => ({ ok: isManaged(s((await findRow(ctx, id))?.['comment'])) }),
    rollback: async (bb) => { await restSet(ctx.write, ctx.transport, PC, id, { comment: bb.comment ?? '' }); },
  });
}

// ---------------- ADD-BEFORE-REMOVE: replace the mgmt-path WAN with a new PPPoE ----------------

export interface PppoeReplaceResult { result: 'applied' | 'failed' | 'rejected'; detail: string; auditId: number; newHost?: string; sequence: string[] }

export function replaceWanPppoe(
  db: DatabaseSync, box: SecretBox, row: AddressableRow & { id: number; name: string }, transport: WriteTransport,
  sac: Sac, opts: { newInterface: string; user: string; password: string; serviceName?: string; timeoutMs?: number },
): Promise<PppoeReplaceResult> {
  // P21: bracket this bespoke add-before-remove flow with pre/post snapshots.
  return withWriteOp(row.id, 'pppoe.replace-wan', () => replaceWanPppoeInner(db, box, row, transport, sac, opts));
}
async function replaceWanPppoeInner(
  db: DatabaseSync, box: SecretBox, row: AddressableRow & { id: number; name: string }, transport: WriteTransport,
  sac: Sac, opts: { newInterface: string; user: string; password: string; serviceName?: string; timeoutMs?: number },
): Promise<PppoeReplaceResult> {
  const seq: string[] = [];
  const ctx: PppoeContext = { read: readTarget(box, row), write: writeTarget(box, row), transport, row };
  const A = resolveEndpoint(row).host;
  const audit = (result: 'applied' | 'failed' | 'rejected', detail: string, after: unknown) =>
    writeAudit(sac, result, `Replace WAN with PPPoE on ${opts.newInterface} (add-before-remove)`, { from: A }, after, detail);
  const reject = (m: string): PppoeReplaceResult => ({ result: 'rejected', detail: m, auditId: audit('rejected', `Rejected: ${m}`, null), sequence: seq });
  if (!opts.newInterface || !opts.user || !opts.password) return reject('newInterface, user and password are required.');
  const targetAt = (ip: string): DeviceTarget => ({ ...ctx.read, host: ip });
  let serialA: string | null = null;
  try { serialA = s(((await g(ctx, '/system/routerboard')) as Dict)['serial-number']); } catch { /* CHR */ }

  const created: Array<{ resource: string; id: string }> = [];
  let Bip: string | null = null;
  try {
    // STEP 1 — build the NEW pppoe-client. Old WAN/path still intact.
    const pc = await restAdd(ctx.write, transport, PC, {
      name: 'rmik-wan', interface: opts.newInterface, user: opts.user, password: opts.password,
      'add-default-route': 'yes', 'use-peer-dns': 'no', comment: `${TAG} wan (add-before-remove — password redacted)`,
    });
    created.push({ resource: PC, id: s(pc['.id']) ?? '' });
    seq.push(`created pppoe-client on ${opts.newInterface} (old path still up)`);
    // STEP 2 — wait for the session to come up + learn its local address.
    const deadline = Date.now() + (opts.timeoutMs ?? 8000);
    while (Date.now() < deadline) {
      await sleep(1500);
      const cur = (await g(ctx, PC) as Dict[]).find((r) => s(r['name']) === 'rmik-wan');
      const ifaceRunning = (await g(ctx, '/interface') as Dict[]).find((i) => s(i['name']) === 'rmik-wan');
      if (b(cur?.['running']) || b(ifaceRunning?.['running'])) {
        const addr = (await g(ctx, '/ip/address') as Dict[]).find((a) => s(a['interface']) === 'rmik-wan');
        Bip = s(cur?.['local-address']) ?? (addr ? ((s(addr['address']) ?? '').split('/')[0] ?? null) : null);
        if (Bip) { seq.push(`pppoe session up, local address ${Bip}`); break; }
      }
    }
  } catch (err) {
    await teardown(ctx, transport, created);
    const detail = `Could not build the new PPPoE WAN: ${(err as Error).message}. Rolled back; router still reachable on ${A}.`;
    return { result: 'failed', detail, auditId: audit('failed', detail, null), sequence: seq };
  }

  if (!Bip) {
    await teardown(ctx, transport, created);
    const detail = `The new PPPoE session never came up (bad credentials or no server). Tore it down, kept the old WAN. Router stayed reachable on ${A} throughout — no partition.`;
    return { result: 'failed', detail, auditId: audit('failed', detail, null), sequence: seq };
  }

  // STEP 3 — VERIFY the SAME router answers over the new path.
  let verified = false;
  try {
    const rb = await restGet(targetAt(Bip), transport.scheme, transport.port, '/system/routerboard') as Dict;
    await restGet(targetAt(Bip), transport.scheme, transport.port, '/system/resource');
    verified = serialA === null || s(rb['serial-number']) === serialA;
    seq.push(verified ? `verified reachable at ${Bip} over the new WAN${serialA ? ` (serial ${serialA})` : ''}` : `reached ${Bip} but serial mismatch`);
  } catch (err) { seq.push(`could not reach ${Bip}: ${(err as Error).message}`); }

  if (!verified) {
    await teardown(ctx, transport, created);
    const detail = `The new PPPoE WAN did NOT verify as the same router at ${Bip}. Tore it down, kept the old WAN — reachable on ${A} throughout, no partition.`;
    return { result: 'failed', detail, auditId: audit('failed', detail, null), sequence: seq };
  }

  // STEP 4 — move RubyMIK's endpoint to the new path. (Old WAN teardown is the user's
  // follow-up; we never remove the path we haven't yet re-homed onto safely.)
  const now = new Date().toISOString();
  if (row.net_transport === 'tunnel') db.prepare('UPDATE devices SET tunnel_ip = ?, updated_at = ? WHERE id = ?').run(Bip, now, row.id);
  else db.prepare('UPDATE devices SET host = ?, updated_at = ? WHERE id = ?').run(Bip, now, row.id);
  seq.push(`RubyMIK endpoint moved to ${Bip}`);
  const detail = `Built new PPPoE WAN on ${opts.newInterface}, session up + verified at ${Bip}, endpoint moved. Reachable on ≥1 path at every step — no unreachable moment.`;
  return { result: 'applied', detail, auditId: audit('applied', detail, { newInterface: opts.newInterface, to: Bip }), newHost: Bip, sequence: seq };
}

async function teardown(ctx: PppoeContext, transport: WriteTransport, created: Array<{ resource: string; id: string }>): Promise<void> {
  for (const c of [...created].reverse()) { try { if (c.id) await restRemove(ctx.write, transport, c.resource, c.id); } catch (err) { log.warn(`PPPoE teardown: ${(err as Error).message}`); } }
}

export { redact as _redactForTest };
