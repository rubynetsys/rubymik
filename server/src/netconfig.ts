import { restGet } from './routeros/rest.js';
import { restAdd, restRemove, restSet, restCommand, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { runSafeApply, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';

/**
 * DNS & NTP configuration — gentle settings-level config riding runSafeApply().
 * Reads are GET; every write is a POST `.../set` command (singleton menus) or a
 * list op, done only through the write module, wrapped in snapshot → apply →
 * verify → auto-rollback → audit.
 */

export interface NetConfigContext {
  read: DeviceTarget;
  write: DeviceTarget;
  transport: WriteTransport;
}

// ---------- pure validation (unit-tested) ----------

export function isValidIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return !!m && [m[1], m[2], m[3], m[4]].every((o) => Number(o) <= 255);
}

/** DNS/NTP servers may be IPv6 too — accept a loose IPv6 form. */
export function isValidIp(ip: string): boolean {
  return isValidIpv4(ip) || (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(':') && ip.length >= 2);
}

export function isValidHostname(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false;
  return /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(h);
}

export function validateDnsServers(servers: string[]): string[] {
  const errors: string[] = [];
  for (const srv of servers) {
    if (!isValidIp(srv)) errors.push(`"${srv}" is not a valid DNS server IP address.`);
  }
  return errors;
}

export function validateNtpServers(servers: string[]): string[] {
  const errors: string[] = [];
  for (const srv of servers) {
    if (!isValidIp(srv) && !isValidHostname(srv)) errors.push(`"${srv}" is not a valid NTP server (IP or hostname).`);
  }
  return errors;
}

export function validateStaticEntry(name: string, address: string): string[] {
  const errors: string[] = [];
  if (!isValidHostname(name)) errors.push(`"${name}" is not a valid hostname.`);
  if (!isValidIpv4(address)) errors.push(`"${address}" is not a valid IPv4 address.`);
  return errors;
}

// ---------- reads ----------

const g = (ctx: NetConfigContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

export async function readDns(ctx: NetConfigContext) {
  const d = await g(ctx, '/ip/dns') as Record<string, unknown>;
  const st = await g(ctx, '/ip/dns/static').catch(() => []) as Array<Record<string, unknown>>;
  return {
    servers: (d.servers as string || '').split(',').filter(Boolean),
    dynamicServers: (d['dynamic-servers'] as string || '').split(',').filter(Boolean),
    allowRemoteRequests: d['allow-remote-requests'] === 'true',
    cacheSize: Number(d['cache-size']) || 2048,
    cacheUsed: Number(d['cache-used']) || 0,
    static: st.map((e) => ({
      id: e['.id'] as string, name: (e.name as string) ?? null, address: (e.address as string) ?? null,
      type: (e.type as string) ?? null, comment: (e.comment as string) ?? null, disabled: e.disabled === 'true',
    })),
  };
}

export async function readNtp(ctx: NetConfigContext) {
  const n = await g(ctx, '/system/ntp/client') as Record<string, unknown>;
  const clock = await g(ctx, '/system/clock').catch(() => ({})) as Record<string, unknown>;
  return {
    enabled: n.enabled === 'true',
    servers: (n.servers as string || '').split(',').filter(Boolean),
    status: (n.status as string) ?? 'unknown',
    synced: n.status === 'synchronized',
    freqDrift: (n['freq-drift'] as string) ?? null,
    time: clock.time ? `${clock.date} ${clock.time}` : null,
    timeZone: (clock['time-zone-name'] as string) ?? null,
  };
}

// ---------- writes (via runSafeApply) ----------

type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: NetConfigContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });

export interface DnsInput { servers: string[]; allowRemoteRequests: boolean; cacheSize: number }

export async function applyDns(ctx: NetConfigContext, sac: Sac, input: DnsInput): Promise<SafeApplyOutcome> {
  return runSafeApply<{ servers: string; allow: string; cache: string }>(ctxFull(ctx, sac), {
    snapshot: async () => {
      const d = await g(ctx, '/ip/dns') as Record<string, unknown>;
      return { servers: (d.servers as string) ?? '', allow: (d['allow-remote-requests'] as string) ?? 'false', cache: (d['cache-size'] as string) ?? '2048' };
    },
    summary: (before) => `DNS: servers ${before.servers || '(none)'} → ${input.servers.join(',') || '(none)'}, allow-remote-requests → ${input.allowRemoteRequests}`,
    apply: async () => {
      await restCommand(ctx.write, ctx.transport, '/ip/dns/set', {
        servers: input.servers.join(','),
        'allow-remote-requests': input.allowRemoteRequests ? 'yes' : 'no',
        'cache-size': String(input.cacheSize),
      });
    },
    verifyTook: async () => {
      const d = await g(ctx, '/ip/dns') as Record<string, unknown>;
      const now = (d.servers as string || '').split(',').filter(Boolean).sort().join(',');
      const want = [...input.servers].sort().join(',');
      return now === want ? { ok: true, after: { servers: d.servers, 'allow-remote-requests': d['allow-remote-requests'] } }
        : { ok: false, detail: `DNS servers did not take (got "${d.servers}").` };
    },
    rollback: async (before) => {
      await restCommand(ctx.write, ctx.transport, '/ip/dns/set', {
        servers: before.servers, 'allow-remote-requests': before.allow, 'cache-size': before.cache,
      });
    },
  });
}

export interface NtpInput { enabled: boolean; servers: string[] }

export async function applyNtp(ctx: NetConfigContext, sac: Sac, input: NtpInput): Promise<SafeApplyOutcome> {
  return runSafeApply<{ enabled: string; servers: string }>(ctxFull(ctx, sac), {
    snapshot: async () => {
      const n = await g(ctx, '/system/ntp/client') as Record<string, unknown>;
      return { enabled: (n.enabled as string) ?? 'false', servers: (n.servers as string) ?? '' };
    },
    summary: (before) => `NTP: enabled ${before.enabled} → ${input.enabled}, servers ${before.servers || '(none)'} → ${input.servers.join(',') || '(none)'}`,
    apply: async () => {
      await restCommand(ctx.write, ctx.transport, '/system/ntp/client/set', {
        enabled: input.enabled ? 'yes' : 'no', servers: input.servers.join(','),
      });
    },
    verifyTook: async () => {
      const n = await g(ctx, '/system/ntp/client') as Record<string, unknown>;
      const enabledOk = (n.enabled === 'true') === input.enabled;
      const serversOk = (n.servers as string || '').split(',').filter(Boolean).sort().join(',') === [...input.servers].sort().join(',');
      return enabledOk && serversOk ? { ok: true, after: { enabled: n.enabled, servers: n.servers, status: n.status } }
        : { ok: false, detail: `NTP settings did not take (enabled=${n.enabled}, servers="${n.servers}").` };
    },
    rollback: async (before) => {
      await restCommand(ctx.write, ctx.transport, '/system/ntp/client/set', { enabled: before.enabled, servers: before.servers });
    },
  });
}

// ---------- static DNS entries (list ops) ----------

interface StaticRow { '.id': string; name?: string; address?: string; comment?: string }

export async function addStatic(ctx: NetConfigContext, sac: Sac, name: string, address: string, comment: string | null): Promise<SafeApplyOutcome> {
  let createdId: string | null = null;
  return runSafeApply<{ ids: string[] }>(ctxFull(ctx, sac), {
    snapshot: async () => ({ ids: ((await g(ctx, '/ip/dns/static')) as StaticRow[]).map((r) => r['.id']) }),
    summary: () => `DNS static: add ${name} → ${address}${comment ? ` (${comment})` : ''}`,
    apply: async () => {
      const c = await restAdd(ctx.write, ctx.transport, '/ip/dns/static', { name, address, ...(comment ? { comment } : {}) });
      createdId = (c['.id'] as string) ?? null;
    },
    verifyTook: async () => {
      const found = ((await g(ctx, '/ip/dns/static')) as StaticRow[]).find((r) => r.name === name && r.address === address);
      return found ? { ok: true, after: found } : { ok: false, detail: 'Static entry not found after add.' };
    },
    rollback: async (before) => {
      const now = (await g(ctx, '/ip/dns/static')) as StaticRow[];
      for (const r of now.filter((x) => !before.ids.includes(x['.id']))) await restRemove(ctx.write, ctx.transport, '/ip/dns/static', r['.id']);
      if (createdId) { /* covered by diff above */ }
    },
  });
}

export async function editStatic(ctx: NetConfigContext, sac: Sac, id: string, patch: { address?: string; comment?: string | null }): Promise<SafeApplyOutcome> {
  return runSafeApply<StaticRow | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => ((await g(ctx, '/ip/dns/static')) as StaticRow[]).find((r) => r['.id'] === id),
    summary: (before) => `DNS static: edit ${before?.name ?? id} → ${JSON.stringify(patch)}`,
    apply: async () => {
      const body: Record<string, unknown> = {};
      if (patch.address !== undefined) body.address = patch.address;
      if (patch.comment !== undefined) body.comment = patch.comment ?? '';
      await restSet(ctx.write, ctx.transport, '/ip/dns/static', id, body);
    },
    verifyTook: async () => {
      const found = ((await g(ctx, '/ip/dns/static')) as StaticRow[]).find((r) => r['.id'] === id);
      if (!found) return { ok: false, detail: 'Static entry vanished after edit.' };
      if (patch.address !== undefined && found.address !== patch.address) return { ok: false, detail: 'Address did not update.' };
      return { ok: true, after: found };
    },
    rollback: async (before) => {
      if (before) await restSet(ctx.write, ctx.transport, '/ip/dns/static', id, { address: before.address, comment: before.comment ?? '' });
    },
  });
}

export async function removeStatic(ctx: NetConfigContext, sac: Sac, id: string): Promise<SafeApplyOutcome> {
  return runSafeApply<StaticRow | undefined>(ctxFull(ctx, sac), {
    snapshot: async () => ((await g(ctx, '/ip/dns/static')) as StaticRow[]).find((r) => r['.id'] === id),
    summary: (before) => `DNS static: remove ${before?.name ?? id} (${before?.address ?? '?'})`,
    apply: async () => { await restRemove(ctx.write, ctx.transport, '/ip/dns/static', id); },
    verifyTook: async () => {
      const still = ((await g(ctx, '/ip/dns/static')) as StaticRow[]).some((r) => r['.id'] === id);
      return still ? { ok: false, detail: 'Static entry still present after delete.' } : { ok: true };
    },
    rollback: async (before) => {
      if (before) await restAdd(ctx.write, ctx.transport, '/ip/dns/static', { name: before.name, address: before.address, ...(before.comment ? { comment: before.comment } : {}) });
    },
  });
}
