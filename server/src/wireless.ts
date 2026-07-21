import { restGet } from './routeros/rest.js';
import { restSet, type WriteTransport } from './routeros/write.js';
import type { DeviceTarget } from './routeros/types.js';
import { runSafeApply, type SafeApplyContext, type SafeApplyOutcome } from './safeapply.js';

/**
 * Native wireless configuration — the first higher-risk native-config feature,
 * riding runSafeApply(). RouterOS has TWO wireless stacks and a device runs one:
 *   - MODERN  (wifiwave2, RouterOS 7.13+): /interface/wifi, nested dotted props
 *     (configuration.ssid, security.authentication-types, security.passphrase,
 *     channel.band/frequency/width).
 *   - LEGACY  (/interface/wireless + /interface/wireless/security-profiles).
 * We DETECT the stack (presence of actual interfaces, not just an answering
 * endpoint) and generate/apply against the CORRECT one; a device with neither
 * shows "no wireless" honestly.
 *
 * SECRETS: a Wi-Fi passphrase is a secret. It is NEVER returned to the browser
 * (reads report only whether one is set), NEVER put in a summary/log, and NEVER
 * written to the audit before/after JSON — the old value is kept only in a
 * closure for rollback.
 */

export type WirelessStack = 'wifi' | 'wireless' | 'none';

export interface WirelessInterface {
  id: string;
  name: string;
  ssid: string | null;
  mode: string | null;          // ap / station / …
  disabled: boolean;
  running: boolean;
  band: string | null;
  frequency: string | null;
  width: string | null;
  authTypes: string[];          // e.g. ['wpa2-psk','wpa3-psk']
  hasPassphrase: boolean;       // NEVER the value
  securityProfile: string | null; // legacy only
  carriesManagement: boolean;   // the wireless-lockout flag
}

export interface WirelessView {
  stack: WirelessStack;
  capsmanManaged: boolean;
  interfaces: WirelessInterface[];
  clients: Array<Record<string, string | null>>;
}

export interface WirelessContext {
  read: DeviceTarget;
  write: DeviceTarget;
  transport: WriteTransport;
  /** Address RubyMIK reaches this device at — for the wireless-lockout check. */
  mgmtHost: string;
}

type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const g = (ctx: WirelessContext, path: string) => restGet(ctx.read, ctx.transport.scheme, ctx.transport.port, path);

// ---------------- stack detection ----------------

/** True stack detection: a stack counts only if it has ≥1 real interface. The
 *  modern /interface/wifi endpoint answers 200-empty even with no radio (the
 *  bench), so an answering endpoint is NOT enough — we require interfaces. */
export async function detectStack(ctx: WirelessContext): Promise<WirelessStack> {
  try {
    const wifi = await g(ctx, '/interface/wifi') as Dict[];
    if (Array.isArray(wifi) && wifi.length > 0) return 'wifi';
  } catch { /* not modern */ }
  try {
    const legacy = await g(ctx, '/interface/wireless') as Dict[];
    if (Array.isArray(legacy) && legacy.length > 0) return 'wireless';
  } catch { /* not legacy */ }
  return 'none';
}

// ---------------- management-path (wireless-lockout) detection ----------------

/** Which interface carries the address RubyMIK manages this device on, and the
 *  bridge-port map, so we can flag a wireless interface that IS the mgmt path. */
async function mgmtContext(ctx: WirelessContext): Promise<{ mgmtIface: string | null; portBridge: Map<string, string> }> {
  let mgmtIface: string | null = null;
  try {
    const addrs = await g(ctx, '/ip/address') as Dict[];
    const hit = addrs.find((a) => (s(a['address']) ?? '').split('/')[0] === ctx.mgmtHost);
    mgmtIface = hit ? s(hit['interface']) : null;
  } catch { /* ignore */ }
  const portBridge = new Map<string, string>();
  try {
    const ports = await g(ctx, '/interface/bridge/port') as Dict[];
    for (const p of ports) { const i = s(p['interface']); const b = s(p['bridge']); if (i && b) portBridge.set(i, b); }
  } catch { /* ignore */ }
  return { mgmtIface, portBridge };
}

function carriesMgmt(name: string, mgmtIface: string | null, portBridge: Map<string, string>): boolean {
  if (!mgmtIface) return false;
  if (name === mgmtIface) return true;              // mgmt IP directly on the wireless iface
  if (portBridge.get(name) === mgmtIface) return true; // wireless iface is a port of the mgmt bridge
  return false;
}

// ---------------- read (passphrase redacted) ----------------

export async function readWireless(ctx: WirelessContext): Promise<WirelessView> {
  const stack = await detectStack(ctx);
  if (stack === 'none') return { stack, capsmanManaged: false, interfaces: [], clients: [] };
  const { mgmtIface, portBridge } = await mgmtContext(ctx);

  if (stack === 'wifi') {
    const rows = await g(ctx, '/interface/wifi') as Dict[];
    const clients = await g(ctx, '/interface/wifi/registration-table').catch(() => []) as Dict[];
    const capsmanManaged = rows.some((r) => s(r['configuration.manager']) !== null);
    const interfaces: WirelessInterface[] = rows.map((r) => {
      const name = s(r['name']) ?? '?';
      return {
        id: s(r['.id']) ?? name,
        name,
        ssid: s(r['configuration.ssid']),
        mode: s(r['configuration.mode']),
        disabled: r['disabled'] === 'true',
        running: r['running'] === 'true',
        band: s(r['channel.band']),
        frequency: s(r['channel.frequency']),
        width: s(r['channel.width']),
        authTypes: (s(r['security.authentication-types']) ?? '').split(',').filter(Boolean),
        hasPassphrase: !!s(r['security.passphrase']),   // presence only — value dropped
        securityProfile: null,
        carriesManagement: carriesMgmt(name, mgmtIface, portBridge),
      };
    });
    return { stack, capsmanManaged, interfaces, clients: mapClients(clients, ['mac-address', 'interface', 'ssid', 'signal', 'tx-rate', 'rx-rate', 'uptime']) };
  }

  // legacy /interface/wireless
  const rows = await g(ctx, '/interface/wireless') as Dict[];
  const profiles = await g(ctx, '/interface/wireless/security-profiles').catch(() => []) as Dict[];
  const clients = await g(ctx, '/interface/wireless/registration-table').catch(() => []) as Dict[];
  const profByName = new Map(profiles.map((p) => [s(p['name']) ?? '', p]));
  const interfaces: WirelessInterface[] = rows.map((r) => {
    const name = s(r['name']) ?? '?';
    const profName = s(r['security-profile']);
    const prof = profName ? profByName.get(profName) : undefined;
    return {
      id: s(r['.id']) ?? name,
      name,
      ssid: s(r['ssid']),
      mode: s(r['mode']),
      disabled: r['disabled'] === 'true',
      running: r['running'] === 'true',
      band: s(r['band']),
      frequency: s(r['frequency']),
      width: s(r['channel-width']),
      authTypes: prof ? (s(prof['authentication-types']) ?? '').split(',').filter(Boolean) : [],
      hasPassphrase: prof ? !!(s(prof['wpa2-pre-shared-key']) || s(prof['wpa-pre-shared-key'])) : false,
      securityProfile: profName,
      carriesManagement: carriesMgmt(name, mgmtIface, portBridge),
    };
  });
  return { stack, capsmanManaged: false, interfaces, clients: mapClients(clients, ['mac-address', 'interface', 'signal-strength', 'tx-rate', 'rx-rate', 'uptime']) };
}

function mapClients(rows: Dict[], keys: string[]): Array<Record<string, string | null>> {
  return rows.map((r) => Object.fromEntries(keys.map((k) => [k, s(r[k])])));
}

// ---------------- pure validation (unit-tested) ----------------

export function validateSsid(ssid: string): string[] {
  const errs: string[] = [];
  if (ssid.length < 1) errs.push('SSID cannot be empty.');
  // RouterOS SSID limit is 32 bytes.
  if (Buffer.byteLength(ssid, 'utf8') > 32) errs.push('SSID must be at most 32 bytes.');
  return errs;
}

export function validatePassphrase(p: string): string[] {
  // WPA2/WPA3-PSK passphrase length is 8–63 printable ASCII characters.
  if (p.length < 8 || p.length > 63) return ['Wi-Fi passphrase must be 8–63 characters (WPA2/WPA3).'];
  return [];
}

const BANDS: Record<WirelessStack, string[]> = {
  wifi: ['2ghz-ax', '2ghz-n', '2ghz-g', '2ghz-b', '5ghz-ax', '5ghz-ac', '5ghz-n', '5ghz-a'],
  wireless: ['2ghz-b', '2ghz-b/g', '2ghz-b/g/n', '2ghz-onlyn', '2ghz-onlyg', '5ghz-a', '5ghz-a/n', '5ghz-a/n/ac', '5ghz-onlyn', '5ghz-onlyac'],
  none: [],
};
const WIDTHS = ['20mhz', '20/40mhz', '20/40/80mhz', '20/40/80/160mhz', '20/40mhz-Ce', '20/40mhz-eC', '40mhz', '80mhz', '160mhz'];

export function validateChannel(
  stack: WirelessStack,
  input: { band?: string; frequency?: number | null; width?: string },
): string[] {
  const errs: string[] = [];
  if (input.band !== undefined && input.band !== '') {
    if (!BANDS[stack].includes(input.band)) {
      errs.push(`Band "${input.band}" is not valid for this device's ${stack === 'wifi' ? 'wifi (wifiwave2)' : 'wireless'} stack.`);
    }
    if (input.frequency != null) {
      const is5 = input.band.startsWith('5ghz');
      const lo = is5 ? 5150 : 2400;
      const hi = is5 ? 5895 : 2484;
      if (!Number.isInteger(input.frequency) || input.frequency < lo || input.frequency > hi) {
        errs.push(`Frequency ${input.frequency} MHz is outside the ${is5 ? '5' : '2.4'} GHz band (${lo}–${hi}).`);
      }
    }
  } else if (input.frequency != null) {
    if (!Number.isInteger(input.frequency) || input.frequency < 2400 || input.frequency > 5895) {
      errs.push(`Frequency ${input.frequency} MHz is not a valid Wi-Fi frequency.`);
    }
  }
  if (input.width !== undefined && input.width !== '' && !WIDTHS.includes(input.width)) {
    errs.push(`Channel width "${input.width}" is not recognised.`);
  }
  return errs;
}

// ---------------- pure write-body generation (unit-tested → proves F) ----------------

export interface SsidInput { ssid: string; enabled: boolean }
export interface SecurityInput { authTypes: string[]; passphrase: string }
export interface ChannelInput { band?: string; frequency?: number | null; width?: string }

/** The RouterOS write body for an SSID/enable change — correct for each stack. */
export function genSsidBody(stack: WirelessStack, input: SsidInput): Record<string, string> {
  const disabled = input.enabled ? 'no' : 'yes';
  return stack === 'wifi'
    ? { 'configuration.ssid': input.ssid, disabled }
    : { ssid: input.ssid, disabled };
}

/** Security body. For modern wifi it sets the interface's inline security props;
 *  for legacy it targets the referenced security-profile. Includes the secret. */
export function genSecurityBody(stack: WirelessStack, input: SecurityInput): Record<string, string> {
  if (stack === 'wifi') {
    return { 'security.authentication-types': input.authTypes.join(','), 'security.passphrase': input.passphrase };
  }
  const body: Record<string, string> = {
    'authentication-types': input.authTypes.join(','),
    mode: 'dynamic-keys',
    'wpa2-pre-shared-key': input.passphrase,
  };
  if (input.authTypes.some((t) => t.includes('wpa3'))) body['wpa3-pre-shared-key'] = input.passphrase;
  return body;
}

export function genChannelBody(stack: WirelessStack, input: ChannelInput): Record<string, string> {
  const body: Record<string, string> = {};
  if (stack === 'wifi') {
    if (input.band) body['channel.band'] = input.band;
    if (input.frequency != null) body['channel.frequency'] = String(input.frequency);
    if (input.width) body['channel.width'] = input.width;
  } else {
    if (input.band) body.band = input.band;
    if (input.frequency != null) body.frequency = String(input.frequency);
    if (input.width) body['channel-width'] = input.width;
  }
  return body;
}

// ---------------- apply (via runSafeApply) ----------------

type Sac = Omit<SafeApplyContext, 'target' | 'transport' | 'probe'>;
const ctxFull = (ctx: WirelessContext, sac: Sac): SafeApplyContext => ({ ...sac, target: ctx.read, transport: ctx.transport });
const wifiPath = (stack: WirelessStack) => (stack === 'wifi' ? '/interface/wifi' : '/interface/wireless');

async function readIface(ctx: WirelessContext, stack: WirelessStack, id: string): Promise<Dict | undefined> {
  const rows = await g(ctx, wifiPath(stack)) as Dict[];
  return rows.find((r) => s(r['.id']) === id || s(r['name']) === id);
}

export async function applySsid(ctx: WirelessContext, stack: WirelessStack, sac: Sac, id: string, input: SsidInput): Promise<SafeApplyOutcome> {
  const key = stack === 'wifi' ? 'configuration.ssid' : 'ssid';
  return runSafeApply<{ ssid: string; disabled: string }>(ctxFull(ctx, sac), {
    snapshot: async () => {
      const r = await readIface(ctx, stack, id);
      return { ssid: s(r?.[key]) ?? '', disabled: s(r?.['disabled']) ?? 'false' };
    },
    summary: (b) => `Wi-Fi "${id}": SSID ${b.ssid || '(none)'} → ${input.ssid}, ${input.enabled ? 'enabled' : 'disabled'}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, wifiPath(stack), id, genSsidBody(stack, input)); },
    verifyTook: async () => {
      const r = await readIface(ctx, stack, id);
      const ssidOk = (s(r?.[key]) ?? '') === input.ssid;
      const enabledOk = (r?.['disabled'] === 'true') === !input.enabled;
      return ssidOk && enabledOk ? { ok: true, after: { ssid: s(r?.[key]), disabled: s(r?.['disabled']) } }
        : { ok: false, detail: `SSID/enable did not take (ssid="${s(r?.[key])}", disabled=${r?.['disabled']}).` };
    },
    rollback: async (b) => { await restSet(ctx.write, ctx.transport, wifiPath(stack), id, { [key]: b.ssid, disabled: b.disabled }); },
  });
}

export async function applySecurity(ctx: WirelessContext, stack: WirelessStack, sac: Sac, id: string, input: SecurityInput): Promise<SafeApplyOutcome> {
  // Legacy security lives on the referenced security-profile; modern is inline.
  let target = wifiPath(stack);
  let targetId = id;
  let oldAuth = '';
  let oldPass = '';          // closure ONLY — never audited/logged
  let oldPass3 = '';
  if (stack === 'wireless') {
    const iface = await readIface(ctx, stack, id);
    const profName = s(iface?.['security-profile']) ?? 'default';
    const profs = await g(ctx, '/interface/wireless/security-profiles') as Dict[];
    const prof = profs.find((p) => s(p['name']) === profName);
    target = '/interface/wireless/security-profiles';
    targetId = s(prof?.['.id']) ?? profName;
    oldAuth = s(prof?.['authentication-types']) ?? '';
    oldPass = s(prof?.['wpa2-pre-shared-key']) ?? '';
    oldPass3 = s(prof?.['wpa3-pre-shared-key']) ?? '';
  }
  return runSafeApply<{ authTypes: string[]; hadPassphrase: boolean }>(ctxFull(ctx, sac), {
    snapshot: async () => {
      if (stack === 'wifi') {
        const r = await readIface(ctx, stack, id);
        oldAuth = s(r?.['security.authentication-types']) ?? '';
        oldPass = s(r?.['security.passphrase']) ?? '';
        return { authTypes: oldAuth.split(',').filter(Boolean), hadPassphrase: !!oldPass };
      }
      return { authTypes: oldAuth.split(',').filter(Boolean), hadPassphrase: !!oldPass };
    },
    // NO passphrase in the summary — this string is logged + audited.
    summary: (b) => `Wi-Fi security on "${id}": ${b.authTypes.join('+') || 'open'} → ${input.authTypes.join('+')} (passphrase set, redacted)`,
    apply: async () => { await restSet(ctx.write, ctx.transport, target, targetId, genSecurityBody(stack, input)); },
    verifyTook: async () => {
      if (stack === 'wifi') {
        const r = await readIface(ctx, stack, id);
        const got = (s(r?.['security.authentication-types']) ?? '').split(',').filter(Boolean).sort().join(',');
        const want = [...input.authTypes].sort().join(',');
        return got === want ? { ok: true, after: { authTypes: got, hasPassphrase: !!s(r?.['security.passphrase']) } }
          : { ok: false, detail: `Security auth-types did not take (got "${got}").` };
      }
      const profs = await g(ctx, '/interface/wireless/security-profiles') as Dict[];
      const p = profs.find((x) => s(x['.id']) === targetId);
      const got = (s(p?.['authentication-types']) ?? '').split(',').filter(Boolean).sort().join(',');
      const want = [...input.authTypes].sort().join(',');
      return got === want ? { ok: true, after: { authTypes: got, hasPassphrase: !!s(p?.['wpa2-pre-shared-key']) } }
        : { ok: false, detail: `Security auth-types did not take (got "${got}").` };
    },
    rollback: async () => {
      // Restore old auth + old passphrase from the closure (no secret was audited).
      if (stack === 'wifi') {
        await restSet(ctx.write, ctx.transport, target, targetId, { 'security.authentication-types': oldAuth, 'security.passphrase': oldPass });
      } else {
        await restSet(ctx.write, ctx.transport, target, targetId, {
          'authentication-types': oldAuth, 'wpa2-pre-shared-key': oldPass, 'wpa3-pre-shared-key': oldPass3,
        });
      }
    },
  });
}

export async function applyChannel(ctx: WirelessContext, stack: WirelessStack, sac: Sac, id: string, input: ChannelInput): Promise<SafeApplyOutcome> {
  const bandKey = stack === 'wifi' ? 'channel.band' : 'band';
  const freqKey = stack === 'wifi' ? 'channel.frequency' : 'frequency';
  const widthKey = stack === 'wifi' ? 'channel.width' : 'channel-width';
  return runSafeApply<{ band: string; frequency: string; width: string }>(ctxFull(ctx, sac), {
    snapshot: async () => {
      const r = await readIface(ctx, stack, id);
      return { band: s(r?.[bandKey]) ?? '', frequency: s(r?.[freqKey]) ?? '', width: s(r?.[widthKey]) ?? '' };
    },
    summary: (b) => `Wi-Fi "${id}" channel: band ${b.band || '(auto)'} → ${input.band ?? b.band}, freq ${b.frequency || '(auto)'} → ${input.frequency ?? b.frequency}, width ${b.width || '(auto)'} → ${input.width ?? b.width}`,
    apply: async () => { await restSet(ctx.write, ctx.transport, wifiPath(stack), id, genChannelBody(stack, input)); },
    verifyTook: async () => {
      const r = await readIface(ctx, stack, id);
      const bandOk = input.band === undefined || (s(r?.[bandKey]) ?? '') === input.band;
      const freqOk = input.frequency == null || (s(r?.[freqKey]) ?? '') === String(input.frequency);
      return bandOk && freqOk ? { ok: true, after: { band: s(r?.[bandKey]), frequency: s(r?.[freqKey]), width: s(r?.[widthKey]) } }
        : { ok: false, detail: `Channel did not take (band="${s(r?.[bandKey])}", freq="${s(r?.[freqKey])}").` };
    },
    rollback: async (b) => {
      const body: Record<string, string> = { [bandKey]: b.band, [widthKey]: b.width };
      if (b.frequency) body[freqKey] = b.frequency;
      await restSet(ctx.write, ctx.transport, wifiPath(stack), id, body);
    },
  });
}
