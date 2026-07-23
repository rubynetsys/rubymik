// P43 — DNS content filtering. This module is the PURE resolver-config core: it maps the
// user's category toggles + custom rules + client exemptions to a valid Blocky YAML config.
// No I/O — every function here is a pure transform, so the exact generated config is
// fixture-diffable. The live Blocky container validates the schema in the P43.1 proof.
//
// Blocky schema targeted: v0.24+ (denylists / allowlists / clientGroupsBlock). Pinned in
// docker-compose; the reload-verify step catches a schema drift by failing the probe.

export type DnsCategory = 'ads' | 'malware' | 'adult' | 'gambling' | 'social' | 'streaming' | 'gaming';

/** Curated public blocklists per category. This is DATA — an admin can retune it, and the UI
 *  exposes custom rules on top. Sources are the most reputable maintained feeds; `streaming`
 *  and `gaming` are best-effort (no canonical public DNS list exists for either — `gaming`
 *  ships empty and leans on custom rules, which the UI states plainly). */
export const CATEGORY_META: { key: DnsCategory; label: string; blurb: string; lists: string[] }[] = [
  { key: 'ads', label: 'Ads & trackers', blurb: 'Advertising and analytics/telemetry domains.',
    lists: ['https://raw.githubusercontent.com/hagezi/dns-blocklists/main/hosts/light.txt'] },
  { key: 'malware', label: 'Malware & phishing', blurb: 'Known-malicious, phishing and scam domains.',
    lists: ['https://raw.githubusercontent.com/hagezi/dns-blocklists/main/hosts/tif.medium.txt'] },
  { key: 'adult', label: 'Adult content', blurb: 'Pornography and adult sites.',
    lists: ['https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts'] },
  { key: 'gambling', label: 'Gambling', blurb: 'Betting and online-casino domains.',
    lists: ['https://raw.githubusercontent.com/hagezi/dns-blocklists/main/hosts/gambling.medium.txt'] },
  { key: 'social', label: 'Social media', blurb: 'Facebook, TikTok, X/Twitter, Instagram and similar.',
    lists: ['https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/social/hosts'] },
  { key: 'streaming', label: 'Streaming', blurb: 'Smart-TV and streaming-platform telemetry (best-effort).',
    lists: ['https://raw.githubusercontent.com/Perflyst/PiHoleBlocklist/master/SmartTV.txt'] },
  { key: 'gaming', label: 'Gaming', blurb: 'No canonical public list — add gaming domains under Custom rules.',
    lists: [] },
];

export type BlockType = 'zeroIP' | 'nxDomain';
export interface ResolverSettings {
  categories: Record<DnsCategory, boolean>;
  customBlock: string[];        // exact domains to always block
  customAllow: string[];        // exact domains to always allow (wins over blocks)
  clientExemptions: string[];   // client IPs that skip ALL blocking at the resolver
  upstreams: string[];          // upstream resolvers Blocky forwards to (DoT/DoH/plain)
  blockType: BlockType;         // zeroIP (0.0.0.0) or nxDomain
}

export const DEFAULT_SETTINGS: ResolverSettings = {
  categories: { ads: true, malware: true, adult: false, gambling: false, social: false, streaming: false, gaming: false },
  customBlock: [],
  customAllow: [],
  clientExemptions: [],
  upstreams: ['https://dns.quad9.net/dns-query', 'tcp-tls:9.9.9.9'],
  blockType: 'zeroIP',
};

// ── validation ──
const DOMAIN_RE = /^(\*\.)?([a-z0-9_](-?[a-z0-9_])*\.)+[a-z]{2,}$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export function validateResolverSettings(s: ResolverSettings): string[] {
  const e: string[] = [];
  if (!s.upstreams.length) e.push('At least one upstream resolver is required.');
  for (const d of s.customBlock) if (!DOMAIN_RE.test(d)) e.push(`Custom block "${d}" is not a valid domain.`);
  for (const d of s.customAllow) if (!DOMAIN_RE.test(d)) e.push(`Custom allow "${d}" is not a valid domain.`);
  for (const ip of s.clientExemptions) if (!IPV4_RE.test(ip)) e.push(`Exemption "${ip}" is not a valid IPv4 address.`);
  if (s.blockType !== 'zeroIP' && s.blockType !== 'nxDomain') e.push('blockType must be zeroIP or nxDomain.');
  return e;
}

/** The category groups that carry at least one source (URL or custom-inline), in canonical order. */
export function activeGroups(s: ResolverSettings): DnsCategory[] {
  return CATEGORY_META.filter((c) => s.categories[c.key] && c.lists.length > 0).map((c) => c.key);
}

// ── Blocky YAML generation (pure) ──
const indent = (n: number) => '  '.repeat(n);
const yamlList = (items: string[], level: number) => items.map((i) => `${indent(level)}- ${i}`).join('\n');
/** An inline denylist source: Blocky reads a `- |`-scalar as an inline hosts list. */
function inlineSource(domains: string[], level: number): string {
  if (!domains.length) return '';
  const body = domains.map((d) => `${indent(level + 2)}${d}`).join('\n');
  return `${indent(level)}- |\n${body}`;
}

/**
 * Produce the complete Blocky config YAML for these settings. Deterministic + ordered so the
 * output is fixture-diffable. Custom block/allow become inline `custom` groups; exempt client
 * IPs get their own clientGroupsBlock entry that blocks nothing (belt to the router-side
 * address-list suspenders). Groups with no sources are omitted (e.g. gaming with no custom rules).
 */
export function buildBlockyConfig(s: ResolverSettings): string {
  const groups = activeGroups(s);
  const denyGroups = [...groups];
  if (s.customBlock.length) denyGroups.push('custom' as DnsCategory);

  const lines: string[] = [];
  lines.push('# Generated by RubyMIK — do not edit by hand; changes are overwritten on Save & apply.');
  lines.push('upstreams:');
  lines.push(`${indent(1)}groups:`);
  lines.push(`${indent(2)}default:`);
  lines.push(yamlList(s.upstreams, 3));
  lines.push('ports:');
  lines.push(`${indent(1)}dns: 53`);
  lines.push(`${indent(1)}http: :4000`); // stats/API + reload probe target
  lines.push('blocking:');
  lines.push(`${indent(1)}blockType: ${s.blockType}`);
  lines.push(`${indent(1)}blockTTL: 1m`);
  lines.push(`${indent(1)}denylists:`);
  for (const g of groups) {
    const meta = CATEGORY_META.find((c) => c.key === g)!;
    lines.push(`${indent(2)}${g}:`);
    lines.push(yamlList(meta.lists, 3));
  }
  if (s.customBlock.length) {
    lines.push(`${indent(2)}custom:`);
    lines.push(inlineSource(s.customBlock, 3));
  }
  if (s.customAllow.length) {
    lines.push(`${indent(1)}allowlists:`);
    lines.push(`${indent(2)}custom:`);
    lines.push(inlineSource(s.customAllow, 3));
  }
  lines.push(`${indent(1)}clientGroupsBlock:`);
  lines.push(`${indent(2)}default:`);
  lines.push(denyGroups.length ? yamlList(denyGroups, 3) : `${indent(3)}[]`);
  // exempt clients: a per-IP group that blocks nothing (allowlists still apply globally)
  for (const ip of s.clientExemptions) {
    lines.push(`${indent(2)}"${ip}":`);
    lines.push(`${indent(3)}[]`);
  }
  lines.push('queryLog:');
  lines.push(`${indent(1)}type: csv`);
  lines.push(`${indent(1)}target: /logs`);
  lines.push(`${indent(1)}logRetentionDays: 1`);
  lines.push('');
  return lines.join('\n');
}

/** A domain we can rely on to be blocked when the given category is enabled (probe target for
 *  reload-verify) — a stable, unambiguous member of that category's list. */
export function probeBlockedDomain(s: ResolverSettings): string | null {
  // A domain we're confident is blocked under these settings, for the reload-verify probe.
  // Only return one we're sure of — otherwise the caller falls back to "does the resolver answer".
  if (s.customBlock.length) return s.customBlock[0]!;
  if (s.categories.ads) return 'google-analytics.com'; // stable member of the ads list (verified live on hagezi light)
  return null;
}
