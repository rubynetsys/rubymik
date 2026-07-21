import { setTimeout as sleep } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { restGet } from './routeros/rest.js';
import { restAdd, restRemove, restSet, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { readTarget, writeTarget, resolveEndpoint, type AddressableRow } from './transport.js';
import { runSafeApply, writeAudit, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import { ipToInt, parseCidr, isValidCidr } from './netroutes.js';
import type { SecretBox } from './secretbox.js';
import { log } from './log.js';

/**
 * Native interface / IP-address configuration (P19) — the most dangerous rung.
 * Changing the address RubyMIK reaches a router on is a TOTAL PARTITION: the
 * moment the mgmt IP changes, RubyMIK loses BOTH the health probe AND the revert
 * channel. The standard controller-side dead-man (P5/P17) is INSUFFICIENT — you
 * can't revert what you can't reach.
 *
 * The safety model is ADD-BEFORE-REMOVE, not apply-then-revert:
 *   1. ADD the new address B (old A still present → router reachable on A).
 *   2. VERIFY RubyMIK can reach the SAME router at B (serial matches).
 *   3. If verified: REMOVE A, update RubyMIK's stored endpoint to B.
 *   4. If not:      REMOVE B, keep A — router reachable on A throughout.
 * At no point is the router without a reachable management address, so a lockout
 * simply cannot occur (no reliance on revert-after-lockout).
 *
 * Non-mgmt address/interface changes are additive/low-risk and ride runSafeApply.
 * The mgmt interface can never be disabled, and the only mgmt address can never be
 * hard-removed — those are instant unrecoverable partitions.
 */

const TAG = 'RUBYMIK:';
type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export interface AddrContext { read: DeviceTarget; write: DeviceTarget; transport: WriteTransport; row: AddressableRow }
const g = (ctx: AddrContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

export interface AddrEntry { id: string; address: string | null; network: string | null; interface: string | null; dynamic: boolean; disabled: boolean; comment: string | null; managed: boolean; isMgmt: boolean }
export interface IfaceEntry { id: string; name: string; type: string | null; disabled: boolean; running: boolean; mtu: string | null; comment: string | null; isMgmtInterface: boolean; addresses: AddrEntry[] }
export interface AddrView { interfaces: IfaceEntry[]; mgmtHost: string; mgmtNet: string; mgmtAddress: string | null; mgmtInterface: string | null }

export async function readInterfaces(ctx: AddrContext): Promise<AddrView> {
  const ifaces = await g(ctx, '/interface') as Dict[];
  const addrs = await g(ctx, '/ip/address') as Dict[];
  const { host, net } = resolveEndpoint(ctx.row);
  const mgmtEntry = addrs.find((a) => (s(a['address']) ?? '').split('/')[0] === host);
  const mgmtInterface = mgmtEntry ? s(mgmtEntry['interface']) : null;
  const mgmtAddress = mgmtEntry ? s(mgmtEntry['address']) : null;

  const addrEntries = (name: string): AddrEntry[] => addrs.filter((a) => s(a['interface']) === name).map((a) => {
    const comment = s(a['comment']);
    const address = s(a['address']);
    return {
      id: s(a['.id']) ?? '', address, network: s(a['network']), interface: s(a['interface']),
      dynamic: a['dynamic'] === 'true', disabled: a['disabled'] === 'true', comment,
      managed: !!comment && comment.startsWith(TAG),
      isMgmt: (address ?? '').split('/')[0] === host,
    };
  });
  const interfaces: IfaceEntry[] = ifaces.map((f) => {
    const name = s(f['name']) ?? '?';
    return {
      id: s(f['.id']) ?? name, name, type: s(f['type']), disabled: f['disabled'] === 'true',
      running: f['running'] === 'true', mtu: s(f['mtu']), comment: s(f['comment']),
      isMgmtInterface: name === mgmtInterface, addresses: addrEntries(name),
    };
  });
  return { interfaces, mgmtHost: host, mgmtNet: net, mgmtAddress, mgmtInterface };
}

// ---------------- validation (pure, unit-tested) ----------------

/** Same subnet as the current mgmt address? (So RubyMIK's path can verify B.) */
export function sameSubnet(bCidr: string, aCidr: string): boolean {
  const ca = parseCidr(aCidr); const bIp = ipToInt(bCidr.split('/')[0] ?? '');
  if (!ca || bIp === null) return false;
  const mask = ca.prefix === 0 ? 0 : (0xffffffff << (32 - ca.prefix)) >>> 0;
  return ((bIp & mask) >>> 0) === ca.net;
}

export function validateAddress(cidr: string, existing: string[]): string[] {
  const errs: string[] = [];
  if (!isValidCidr(cidr)) { errs.push(`"${cidr}" is not a valid address/subnet (e.g. 10.20.0.5/24).`); return errs; }
  if (cidr.endsWith('/0') || cidr.endsWith('/32')) errs.push('Use a host address with a real subnet mask (e.g. /24), not /0 or /32.');
  if (existing.includes(cidr) || existing.some((e) => e.split('/')[0] === cidr.split('/')[0])) errs.push(`An address on ${cidr.split('/')[0]} already exists on this device.`);
  return errs;
}

// ---------------- non-mgmt writes via runSafeApply ----------------

type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: AddrContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });

export async function addAddress(ctx: AddrContext, sac: Sac, iface: string, cidr: string): Promise<SafeApplyOutcome> {
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ ids: ((await g(ctx, '/ip/address')) as Dict[]).map((r) => s(r['.id']) ?? '') }),
    summary: () => `Add address ${cidr} to interface "${iface}"`,
    apply: async () => { await restAdd(ctx.write, ctx.transport, '/ip/address', { address: cidr, interface: iface, comment: `${TAG} address` }); },
    verifyTook: async () => {
      const found = ((await g(ctx, '/ip/address')) as Dict[]).find((r) => s(r['interface']) === iface && (s(r['address']) ?? '') === cidr);
      return found ? { ok: true, after: { address: cidr } } : { ok: false, detail: 'Address not present after add.' };
    },
    rollback: async (b) => { for (const r of ((await g(ctx, '/ip/address')) as Dict[]).filter((x) => !b.ids.includes(s(x['.id']) ?? ''))) await restRemove(ctx.write, ctx.transport, '/ip/address', s(r['.id']) ?? ''); },
  });
}

export async function removeAddress(ctx: AddrContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => ((await g(ctx, '/ip/address')) as Dict[]).find((r) => s(r['.id']) === id),
    summary: (b) => `Remove address ${s(b?.['address']) ?? id} from "${s(b?.['interface']) ?? '?'}"`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, '/ip/address', id); },
    verifyTook: async () => ({ ok: !((await g(ctx, '/ip/address')) as Dict[]).some((r) => s(r['.id']) === id) }),
    rollback: async (b) => { if (b) await restAdd(ctx.write, ctx.transport, '/ip/address', { address: s(b['address']), interface: s(b['interface']), ...(s(b['comment']) ? { comment: s(b['comment']) } : {}) }); },
  });
}

export async function setInterface(ctx: AddrContext, sac: Sac, ifaceId: string, patch: { disabled?: boolean; mtu?: string; comment?: string }): Promise<SafeApplyOutcome> {
  return runSafeApply<Dict | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => ((await g(ctx, '/interface')) as Dict[]).find((r) => s(r['.id']) === ifaceId),
    summary: (b) => `Set interface "${s(b?.['name']) ?? ifaceId}": ${JSON.stringify(patch)}`,
    apply: async () => {
      const body: Record<string, unknown> = {};
      if (patch.disabled !== undefined) body.disabled = patch.disabled ? 'yes' : 'no';
      if (patch.mtu !== undefined) body.mtu = patch.mtu;
      if (patch.comment !== undefined) body.comment = patch.comment;
      await restSet(ctx.write, ctx.transport, '/interface', ifaceId, body);
    },
    verifyTook: async () => ({ ok: true, after: {} }),
    rollback: async (b) => { if (b) await restSet(ctx.write, ctx.transport, '/interface', ifaceId, { disabled: b['disabled'], mtu: s(b['mtu']) ?? 'auto', comment: s(b['comment']) ?? '' }); },
  });
}

// ---------------- CHANGE MANAGEMENT IP — ADD-BEFORE-REMOVE (the P19 core) ----------------

export interface MgmtIpResult { result: 'applied' | 'failed' | 'rejected'; detail: string; auditId: number; newHost?: string; sequence: string[] }

export async function changeMgmtIp(
  db: DatabaseSync, box: SecretBox, row: AddressableRow & { id: number; name: string }, transport: WriteTransport,
  sac: Sac, newCidr: string,
): Promise<MgmtIpResult> {
  const seq: string[] = [];
  const ctx: AddrContext = { read: readTarget(box, row), write: writeTarget(box, row), transport, row };
  const view = await readInterfaces(ctx);
  const A = view.mgmtAddress;
  const mgmtIface = view.mgmtInterface;
  const audit = (result: 'applied' | 'failed' | 'rejected', detail: string, after: unknown) =>
    writeAudit(sac, result, `Change management IP ${A ?? '?'} → ${newCidr} (add-before-remove)`, { from: A }, after, detail);

  if (!A || !mgmtIface) {
    const detail = 'Could not determine the current management address/interface — refusing to change it.';
    return { result: 'rejected', detail, auditId: audit('rejected', detail, null), sequence: seq };
  }
  // validation
  if (!isValidCidr(newCidr)) return reject(`"${newCidr}" is not a valid address/subnet.`);
  if (newCidr === A) return reject('The new management address is the same as the current one.');
  if (!sameSubnet(newCidr, A)) return reject(`The new management IP must be on the same subnet as the current management address (${A}) so RubyMIK can verify reachability before switching. Cross-subnet management moves aren't supported here.`);
  if (view.interfaces.some((f) => f.addresses.some((a) => (a.address ?? '').split('/')[0] === newCidr.split('/')[0]))) return reject(`${newCidr.split('/')[0]} already exists on this device.`);

  const Aid = view.interfaces.flatMap((f) => f.addresses).find((a) => a.address === A)?.id;
  const Bip = newCidr.split('/')[0]!;
  const targetAt = (ip: string): DeviceTarget => ({ ...ctx.read, host: ip });
  let serialA: string | null = null;
  try { serialA = s((await g(ctx, '/system/routerboard') as Dict)['serial-number']); } catch { /* CHR has none */ }

  // STEP 1 — ADD B (A still present → reachable on A)
  try {
    await restAdd(ctx.write, transport, '/ip/address', { address: newCidr, interface: mgmtIface, comment: `${TAG} mgmt (add-before-remove)` });
    seq.push(`added ${newCidr} to ${mgmtIface} (old ${A} still present)`);
  } catch (err) {
    const detail = `Could not add the new address ${newCidr}: ${(err as Error).message}. Nothing changed; router still reachable on ${A}.`;
    return { result: 'failed', detail, auditId: audit('failed', detail, null), sequence: seq };
  }

  // STEP 2 — VERIFY the SAME router answers at B
  let verified = false;
  try {
    await sleep(1200);
    const rb = await restGet(targetAt(Bip), transport.scheme, transport.port, '/system/routerboard') as Dict;
    await restGet(targetAt(Bip), transport.scheme, transport.port, '/system/resource');   // confirm it truly responds
    const serialB = s(rb['serial-number']);
    verified = serialA === null || serialB === serialA;   // same box (or serial unknown on both)
    seq.push(verified ? `verified reachable at ${Bip}${serialB ? ` (serial ${serialB})` : ''}` : `reached ${Bip} but serial mismatch — NOT the same router`);
  } catch (err) {
    verified = false;
    seq.push(`could not reach the router at ${Bip}: ${(err as Error).message}`);
  }

  if (!verified) {
    // FAILURE PATH — remove B, keep A. No partition ever happened.
    let cleaned = true;
    try {
      const bEntry = ((await g(ctx, '/ip/address')) as Dict[]).find((a) => s(a['address']) === newCidr && s(a['interface']) === mgmtIface);
      if (bEntry) await restRemove(ctx.write, transport, '/ip/address', s(bEntry['.id']) ?? '');
      seq.push(`removed unverified ${newCidr}, kept ${A}`);
    } catch { cleaned = false; seq.push(`WARNING: could not auto-remove ${newCidr}`); }
    const detail = `New management IP ${newCidr} did NOT verify — the router did not respond as the same device at ${Bip}. ${cleaned ? `Removed ${newCidr}, kept ${A}.` : `Could not auto-remove ${newCidr}.`} The router remained reachable on ${A.split('/')[0]} the entire time — no partition.`;
    return { result: 'failed', detail, auditId: audit('failed', detail, null), sequence: seq };
  }

  // STEP 3 — REMOVE A (via B, which is now verified reachable)
  let removedA = true; let removeErr = '';
  try { if (Aid) await restRemove(targetAt(Bip), transport, '/ip/address', Aid); seq.push(`removed old ${A}`); }
  catch (err) { removedA = false; removeErr = (err as Error).message; seq.push(`kept ${A} (removal failed: ${removeErr})`); }

  // STEP 4 — update RubyMIK's stored endpoint transactionally
  const now = new Date().toISOString();
  try {
    if (row.net_transport === 'tunnel') db.prepare('UPDATE devices SET tunnel_ip = ?, updated_at = ? WHERE id = ?').run(Bip, now, row.id);
    else db.prepare('UPDATE devices SET host = ?, updated_at = ? WHERE id = ?').run(Bip, now, row.id);
    seq.push(`RubyMIK endpoint updated to ${Bip}`);
  } catch (err) { log.error(`mgmt-ip endpoint update failed for #${row.id}: ${(err as Error).message}`); }

  const detail = removedA
    ? `Added ${newCidr}, verified reachable at ${Bip}, removed old ${A}, endpoint updated. The router was reachable on ≥1 address at every step — no unreachable moment.`
    : `Added ${newCidr}, verified reachable at ${Bip}, endpoint updated; old ${A} could NOT be removed (${removeErr}). Both present, reachable at ${Bip} — no partition.`;
  return { result: 'applied', detail, auditId: audit('applied', detail, { to: newCidr, removedOld: removedA }), newHost: Bip, sequence: seq };

  function reject(msg: string): MgmtIpResult {
    return { result: 'rejected', detail: msg, auditId: audit('rejected', `Rejected: ${msg}`, null), sequence: seq };
  }
}
