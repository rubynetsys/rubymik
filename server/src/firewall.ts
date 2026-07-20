import { restGet } from './routeros/rest.js';
import { restAdd, restRemove, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { runSafeApply, writeAudit, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';
import { log } from './log.js';

/**
 * Managed firewall — the first config feature that can lock you out of a
 * router. Preset-driven (constrained, like RubyBPO), riding runSafeApply().
 *
 * THE #1 GUARDRAIL — never sever the management path — has TWO structural
 * protections, both built into the pure generator below:
 *   1. mgmt-accept rules (established/related + each mgmt source + the trusted
 *      interface) are ALWAYS emitted FIRST, before any drop. Not user-orderable.
 *   2. Drops are WAN/interface-scoped; trusted-interface traffic is accepted
 *      before anything can drop it.
 *
 * All RubyMIK rules are tagged `RUBYMIK:` so they are identifiable, reconciled
 * idempotently (never stacked), and cleanly removable.
 */

export const TAG = 'RUBYMIK:';
export const BLACKLIST = 'RUBYMIK-blacklist';

export type Preset = 'off' | 'basic' | 'standard';

export interface FirewallConfig {
  wanInterface: string;
  trustedInterface: string | null;
  mgmtSources: string[];
}

export interface CustomRule {
  chain: 'input' | 'forward';
  action: 'accept' | 'drop' | 'reject';
  protocol?: string | null;
  dstPort?: string | null;
  srcAddress?: string | null;
  comment?: string | null;
}

/** A RouterOS /ip/firewall/filter rule as REST field names. */
export type Rule = Record<string, string>;

// ---------- pure validation (unit-tested) ----------

export function isValidIpOrCidr(v: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/.exec(v);
  if (!m) return false;
  if ([m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) return false;
  if (m[6] !== undefined && Number(m[6]) > 32) return false;
  return true;
}

export function isValidPortSpec(v: string): boolean {
  // "80", "80,443", "1000-2000", "80,1000-2000"
  if (!/^[0-9,\-]+$/.test(v)) return false;
  for (const part of v.split(',')) {
    if (part === '') return false;
    const range = part.split('-');
    if (range.length > 2) return false;
    for (const p of range) {
      if (!/^\d{1,5}$/.test(p)) return false;
      const n = Number(p);
      if (n < 1 || n > 65535) return false;
    }
    if (range.length === 2 && Number(range[0]) > Number(range[1])) return false;
  }
  return true;
}

export function validateCustomRule(r: CustomRule): string[] {
  const errors: string[] = [];
  if (!['input', 'forward'].includes(r.chain)) errors.push('Chain must be input or forward.');
  if (!['accept', 'drop', 'reject'].includes(r.action)) errors.push('Action must be accept, drop or reject.');
  if (r.protocol && !['tcp', 'udp', 'icmp'].includes(r.protocol)) errors.push('Protocol must be tcp, udp or icmp.');
  if (r.dstPort) {
    if (!r.protocol || !['tcp', 'udp'].includes(r.protocol)) errors.push('A destination port needs protocol tcp or udp.');
    if (!isValidPortSpec(r.dstPort)) errors.push(`"${r.dstPort}" is not a valid port / port range.`);
  }
  if (r.srcAddress && !isValidIpOrCidr(r.srcAddress)) errors.push(`"${r.srcAddress}" is not a valid IP or CIDR.`);
  return errors;
}

// ---------- pure generator (unit-tested: mgmt-accept-ALWAYS-first) ----------

/** The mgmt-safety guard. ALWAYS the first rules of the input chain. */
function mgmtGuard(cfg: FirewallConfig): Rule[] {
  const rules: Rule[] = [
    { chain: 'input', action: 'accept', 'connection-state': 'established,related', comment: `${TAG} mgmt keep established/related` },
  ];
  for (const src of cfg.mgmtSources) {
    rules.push({ chain: 'input', action: 'accept', 'src-address': src, comment: `${TAG} mgmt allow ${src}` });
  }
  if (cfg.trustedInterface) {
    rules.push({ chain: 'input', action: 'accept', 'in-interface': cfg.trustedInterface, comment: `${TAG} allow trusted interface ${cfg.trustedInterface}` });
  }
  return rules;
}

function basicBody(cfg: FirewallConfig): { before: Rule[]; catchall: Rule[] } {
  return {
    before: [
      { chain: 'input', action: 'drop', 'connection-state': 'invalid', comment: `${TAG} drop invalid (basic)` },
      { chain: 'input', action: 'drop', 'src-address': '127.0.0.0/8', 'in-interface': cfg.wanInterface, comment: `${TAG} drop bogon loopback-src on WAN (basic)` },
      { chain: 'input', action: 'drop', 'src-address': '169.254.0.0/16', 'in-interface': cfg.wanInterface, comment: `${TAG} drop bogon link-local-src on WAN (basic)` },
      { chain: 'input', action: 'accept', protocol: 'icmp', comment: `${TAG} allow ICMP (basic)` },
    ],
    catchall: [
      { chain: 'input', action: 'drop', 'in-interface': cfg.wanInterface, comment: `${TAG} default-drop inbound on WAN (basic)` },
    ],
  };
}

function standardBody(cfg: FirewallConfig): { before: Rule[]; catchall: Rule[] } {
  return {
    before: [
      { chain: 'input', action: 'drop', 'src-address-list': BLACKLIST, comment: `${TAG} drop blacklisted (standard)` },
      { chain: 'input', action: 'drop', 'connection-state': 'invalid', comment: `${TAG} drop invalid (standard)` },
      { chain: 'input', action: 'add-src-to-address-list', 'address-list': BLACKLIST, 'address-list-timeout': '1h',
        protocol: 'tcp', psd: '21,3s,3,1', 'in-interface': cfg.wanInterface, comment: `${TAG} detect port scanners (standard)` },
      { chain: 'input', action: 'accept', protocol: 'tcp', 'tcp-flags': 'syn', 'connection-state': 'new',
        limit: '30,5:packet', 'in-interface': cfg.wanInterface, comment: `${TAG} SYN within rate (standard)` },
      { chain: 'input', action: 'drop', protocol: 'tcp', 'tcp-flags': 'syn', 'connection-state': 'new',
        'in-interface': cfg.wanInterface, comment: `${TAG} SYN-flood drop excess (standard)` },
      { chain: 'input', action: 'accept', protocol: 'icmp', limit: '5,10:packet', comment: `${TAG} allow ICMP limited (standard)` },
    ],
    catchall: [
      { chain: 'input', action: 'drop', 'in-interface': cfg.wanInterface, comment: `${TAG} default-drop inbound on WAN (standard)` },
    ],
  };
}

function customToRule(c: CustomRule): Rule {
  const r: Rule = { chain: c.chain, action: c.action, comment: `${TAG} custom${c.comment ? ` ${c.comment}` : ''}` };
  if (c.protocol) r.protocol = c.protocol;
  if (c.dstPort) r['dst-port'] = c.dstPort;
  if (c.srcAddress) r['src-address'] = c.srcAddress;
  return r;
}

/**
 * Generate the full ordered RUBYMIK ruleset. The mgmt guard is ALWAYS first;
 * custom rules land AFTER the guard and preset body but BEFORE the catch-all
 * drop — so a custom drop can never sit above the mgmt guard.
 */
export function generateFirewall(preset: Preset, cfg: FirewallConfig, custom: CustomRule[] = []): Rule[] {
  if (preset === 'off') return [];
  const body = preset === 'standard' ? standardBody(cfg) : basicBody(cfg);
  return [
    ...mgmtGuard(cfg),
    ...body.before,
    ...custom.map(customToRule),
    ...body.catchall,
  ];
}

// ---------- device I/O + safe-apply ----------

export interface FirewallContext {
  read: DeviceTarget;
  write: DeviceTarget;
  transport: WriteTransport;
}

interface FilterRow extends Record<string, unknown> {
  '.id': string;
  chain?: string;
  action?: string;
  comment?: string;
}

const g = (ctx: FirewallContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

export async function readManagedRules(ctx: FirewallContext): Promise<FilterRow[]> {
  const all = await g(ctx, '/ip/firewall/filter') as FilterRow[];
  return all.filter((r) => (r.comment ?? '').startsWith(TAG));
}

async function allFilterRules(ctx: FirewallContext): Promise<FilterRow[]> {
  return await g(ctx, '/ip/firewall/filter') as FilterRow[];
}

/** Remove every RUBYMIK-tagged filter rule (used by reconcile + rollback + removal). */
async function removeManaged(ctx: FirewallContext): Promise<void> {
  const managed = await readManagedRules(ctx);
  for (const r of managed) {
    await restRemove(ctx.write, ctx.transport, '/ip/firewall/filter', r['.id']);
  }
}

/** Add rules in order, placed at the TOP of the input chain (before any
 *  pre-existing non-RUBYMIK input rule) so the mgmt guard leads the chain. */
async function addRulesAtTop(ctx: FirewallContext, rules: Rule[]): Promise<void> {
  const existing = await allFilterRules(ctx);
  const firstInput = existing.find((r) => r.chain === 'input' && !(r.comment ?? '').startsWith(TAG));
  const placeBefore = firstInput ? firstInput['.id'] : undefined;
  for (const rule of rules) {
    const body: Record<string, unknown> = { ...rule };
    if (placeBefore) body['place-before'] = placeBefore;
    await restAdd(ctx.write, ctx.transport, '/ip/firewall/filter', body);
  }
}

/** Retry a management-reachability probe for up to windowMs (the dead-man window). */
function reachableProbe(ctx: FirewallContext, windowMs: number): () => Promise<boolean> {
  return async () => {
    const deadline = Date.now() + windowMs;
    for (;;) {
      try {
        await restGet({ ...ctx.read, timeoutMs: 4000 }, ctx.transport.scheme, ctx.transport.port, '/system/resource');
        return true;
      } catch {
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
}

const DEADMAN_WINDOW_MS = 20_000;

/**
 * Apply a preset (+ optional custom rules) through the full pipeline:
 * snapshot → apply(reconcile) → verify(mgmt reachable AND rules present) →
 * auto-rollback on failure → audit. Idempotent (reconcile), RUBYMIK-tagged.
 */
export async function applyFirewall(
  ctx: FirewallContext,
  sac: Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>,
  preset: Preset, cfg: FirewallConfig, custom: CustomRule[],
): Promise<SafeApplyOutcome> {
  const generated = generateFirewall(preset, cfg, custom);
  const full: SafeApplyContext = {
    ...sac, target: ctx.read, transport: ctx.transport,
    probe: reachableProbe(ctx, DEADMAN_WINDOW_MS),
  };
  return runSafeApply<FilterRow[]>(full, {
    snapshot: () => readManagedRules(ctx),
    summary: (before) =>
      preset === 'off'
        ? `Firewall OFF — remove ${before.length} RUBYMIK rule(s)`
        : `Firewall "${preset}" — ${generated.length} RUBYMIK rules (mgmt-accept first), WAN=${cfg.wanInterface}, mgmt=${cfg.mgmtSources.join(',')}`,
    apply: async () => {
      // Reconcile: strip existing RUBYMIK rules, then add the generated set.
      await removeManaged(ctx);
      await addRulesAtTop(ctx, generated);
    },
    verifyTook: async () => {
      const managed = await readManagedRules(ctx);
      if (managed.length !== generated.length) {
        return { ok: false, detail: `Expected ${generated.length} RUBYMIK rules, found ${managed.length}.` };
      }
      // mgmt-accept must be the first RUBYMIK input rule.
      const firstInput = managed.filter((r) => r.chain === 'input')[0];
      if (generated.length > 0 && firstInput && firstInput.action !== 'accept') {
        return { ok: false, detail: 'mgmt-accept is not first in the input chain.' };
      }
      return { ok: true, after: managed };
    },
    rollback: async (before) => {
      await removeManaged(ctx);
      // Restore the pre-change RUBYMIK rules verbatim (their fields, sans .id).
      const restore: Rule[] = before.map((r) => {
        const { ['.id']: _id, dynamic: _d, invalid: _i, bytes: _b, packets: _p, ...fields } = r;
        return fields as Rule;
      });
      await addRulesAtTop(ctx, restore);
    },
  });
}

/** Remove ALL RUBYMIK firewall rules (the clean removal path). */
export async function removeFirewall(
  ctx: FirewallContext,
  sac: Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>,
): Promise<SafeApplyOutcome> {
  const full: SafeApplyContext = {
    ...sac, target: ctx.read, transport: ctx.transport, probe: reachableProbe(ctx, DEADMAN_WINDOW_MS),
  };
  return runSafeApply<FilterRow[]>(full, {
    snapshot: () => readManagedRules(ctx),
    summary: (before) => `Remove all RUBYMIK firewall rules (${before.length})`,
    apply: () => removeManaged(ctx),
    verifyTook: async () => {
      const managed = await readManagedRules(ctx);
      return managed.length === 0 ? { ok: true, after: [] } : { ok: false, detail: `${managed.length} RUBYMIK rules remain.` };
    },
    rollback: async (before) => {
      const restore = before.map((r) => {
        const { ['.id']: _id, dynamic: _d, invalid: _i, bytes: _b, packets: _p, ...fields } = r;
        return fields as Rule;
      });
      await addRulesAtTop(ctx, restore);
    },
  });
}

export const LOCKOUT_LIST = 'RUBYMIK-LOCKOUT';

/**
 * ACCEPTANCE C — the make-or-break proof. Deliberately sever RubyMIK's own
 * management path with a drop placed ABOVE the mgmt guard, but arm it with a
 * router-enforced self-expiring timer (address-list timeout). RubyMIK then:
 *   1. verifies management is LOST (probe fails),
 *   2. waits — it cannot reach the device to revert,
 *   3. the router auto-expires the lockout entry (the dead-man timer) →
 *      reachability returns WITHOUT RubyMIK's involvement,
 *   4. RubyMIK cleans up the sabotage and restores the snapshot, logging
 *      the whole thing as rolled_back.
 * Bench device only.
 */
export async function lockoutTest(
  ctx: FirewallContext,
  sac: Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>,
  mgmtSources: string[], timeoutSec: number,
): Promise<{ result: 'rolled_back' | 'rollback_failed' | 'failed'; detail: string; lostForSec: number | null; auditId: number }> {
  const before = await readManagedRules(ctx);
  const probeOnce = async (): Promise<boolean> => {
    try {
      await restGet({ ...ctx.read, timeoutMs: 3000 }, ctx.transport.scheme, ctx.transport.port, '/system/resource');
      return true;
    } catch { return false; }
  };

  log.warn(`[firewall] LOCKOUT TEST arming on "${sac.deviceName}" — will sever mgmt (${mgmtSources.join(',')}) for ~${timeoutSec}s via router-enforced timer`);

  // 1. sabotage: a drop at the ABSOLUTE top of the input chain (above even the
  //    mgmt guard — genuinely severing), matched by a self-expiring address list.
  const allRules = await allFilterRules(ctx);
  const firstInput = allRules.find((r) => r.chain === 'input');
  const sabotage: Record<string, unknown> = {
    chain: 'input', action: 'drop', 'src-address-list': LOCKOUT_LIST,
    comment: `${TAG} LOCKOUT-TEST sabotage (self-expiring, bench only)`,
  };
  if (firstInput) sabotage['place-before'] = firstInput['.id'];
  await restAdd(ctx.write, ctx.transport, '/ip/firewall/filter', sabotage);
  // 2. trigger the lockout — the write for the last source may get no response
  //    (our own reply is now dropped); the entry is still created on-device.
  const shortWrite = { ...ctx.write, timeoutMs: 4000 };
  for (const src of mgmtSources) {
    try {
      await restAdd(shortWrite, ctx.transport, '/ip/firewall/address-list',
        { list: LOCKOUT_LIST, address: src, timeout: `${timeoutSec}s`, comment: `${TAG} lockout-test` });
    } catch (err) {
      log.debug(`[firewall] lockout entry for ${src}: no response (expected — path is cutting): ${(err as Error).message}`);
    }
  }

  // 3. observe: expect LOST, then router-enforced RECOVERY.
  const start = Date.now();
  const deadline = start + (timeoutSec + 30) * 1000;
  let lostAt: number | null = null;
  let recoveredAt: number | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const ok = await probeOnce();
    if (!ok && lostAt === null) {
      lostAt = Date.now();
      log.warn(`[firewall] LOCKOUT confirmed on "${sac.deviceName}" — management path lost; waiting for the router-enforced dead-man timer`);
    }
    if (ok && lostAt !== null) { recoveredAt = Date.now(); break; }
  }

  // 4. clean up whatever we can now that we're back (reconcile to snapshot).
  let cleanupError: string | null = null;
  try {
    // remove any lingering lockout list entries + the sabotage rule, restore snapshot
    const entries = await g(ctx, '/ip/firewall/address-list') as Array<{ '.id': string; list?: string }>;
    for (const e of entries.filter((x) => x.list === LOCKOUT_LIST)) {
      await restRemove(ctx.write, ctx.transport, '/ip/firewall/address-list', e['.id']);
    }
    await removeManaged(ctx);
    const restore: Rule[] = before.map((r) => {
      const { ['.id']: _id, dynamic: _d, invalid: _i, bytes: _b, packets: _p, ...fields } = r;
      return fields as Rule;
    });
    await addRulesAtTop(ctx, restore);
  } catch (err) {
    cleanupError = (err as Error).message;
  }

  const lostForSec = lostAt && recoveredAt ? Math.round((recoveredAt - lostAt) / 1000) : null;
  let result: 'rolled_back' | 'rollback_failed' | 'failed';
  let detail: string;
  if (lostAt && recoveredAt && !cleanupError) {
    result = 'rolled_back';
    detail = `Self-lockout PROVEN: management path was severed for ~${lostForSec}s, then the router-enforced dead-man timer (address-list timeout) auto-restored reachability without RubyMIK. Sabotage cleaned up and snapshot restored.`;
  } else if (lostAt && recoveredAt && cleanupError) {
    result = 'rollback_failed';
    detail = `Management auto-recovered after ~${lostForSec}s, but snapshot cleanup errored: ${cleanupError}`;
  } else if (!lostAt) {
    result = 'failed';
    detail = 'Could not induce a lockout (management never dropped) — test inconclusive; nothing left applied.';
  } else {
    result = 'rollback_failed';
    detail = `Management was lost and did NOT auto-recover within the window — MANUAL INTERVENTION NEEDED.`;
  }
  const auditId = writeAudit(sac, result, 'Firewall self-lockout auto-recovery test', before, null, detail);
  log.info(`[firewall] LOCKOUT TEST on "${sac.deviceName}": ${result} — ${detail}`);
  return { result, detail, lostForSec, auditId };
}
