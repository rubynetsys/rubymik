// P43 — persistence for DNS filtering: the single global resolver settings (dns_filter) and the
// per-device enforcement config (dns_enforcement, incl. the prior /ip/dns captured for teardown).
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS, type ResolverSettings } from './dnsfilter.js';
import type { DnsEnforceSpec, DnsSettingsPatch, FailMode } from './netdns.js';

interface FilterRow { categories_json: string; custom_block_json: string; custom_allow_json: string; client_exemptions_json: string; upstreams_json: string; block_type: string }
export function loadResolverSettings(db: DatabaseSync): ResolverSettings {
  const row = db.prepare('SELECT * FROM dns_filter WHERE id = 1').get() as FilterRow | undefined;
  if (!row) return DEFAULT_SETTINGS;
  return {
    categories: JSON.parse(row.categories_json),
    customBlock: JSON.parse(row.custom_block_json),
    customAllow: JSON.parse(row.custom_allow_json),
    clientExemptions: JSON.parse(row.client_exemptions_json),
    upstreams: JSON.parse(row.upstreams_json),
    blockType: row.block_type === 'nxDomain' ? 'nxDomain' : 'zeroIP',
  };
}
export function saveResolverSettings(db: DatabaseSync, s: ResolverSettings): void {
  db.prepare(`INSERT INTO dns_filter (id, categories_json, custom_block_json, custom_allow_json, client_exemptions_json, upstreams_json, block_type, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET categories_json=excluded.categories_json, custom_block_json=excluded.custom_block_json,
      custom_allow_json=excluded.custom_allow_json, client_exemptions_json=excluded.client_exemptions_json,
      upstreams_json=excluded.upstreams_json, block_type=excluded.block_type, updated_at=excluded.updated_at`)
    .run(JSON.stringify(s.categories), JSON.stringify(s.customBlock), JSON.stringify(s.customAllow),
      JSON.stringify(s.clientExemptions), JSON.stringify(s.upstreams), s.blockType, new Date().toISOString());
}

interface EnforceRow {
  enabled: number; resolver_ip: string | null; resolver_net: string | null; lan_interfaces_json: string | null;
  exemptions_json: string | null; fail_mode: string | null; fallback_upstream: string | null; block_doh: number; prior_dns_json: string | null;
}
export interface StoredEnforcement { enabled: boolean; spec: DnsEnforceSpec | null; priorDns: DnsSettingsPatch | null }
export function loadEnforcement(db: DatabaseSync, deviceId: number): StoredEnforcement {
  const r = db.prepare('SELECT * FROM dns_enforcement WHERE device_id = ?').get(deviceId) as EnforceRow | undefined;
  if (!r || !r.enabled || !r.resolver_ip) return { enabled: false, spec: null, priorDns: null };
  return {
    enabled: true,
    spec: {
      resolverIp: r.resolver_ip, resolverNet: r.resolver_net === 'tunnel' ? 'tunnel' : 'direct',
      lanInterfaces: JSON.parse(r.lan_interfaces_json ?? '[]'), wanInterfaces: [],
      exemptions: JSON.parse(r.exemptions_json ?? '[]'),
      failMode: (r.fail_mode === 'open' ? 'open' : 'closed') as FailMode,
      fallbackUpstream: r.fallback_upstream ?? '', blockDoh: r.block_doh === 1,
    },
    priorDns: r.prior_dns_json ? JSON.parse(r.prior_dns_json) : null,
  };
}
export function saveEnforcement(db: DatabaseSync, deviceId: number, spec: DnsEnforceSpec, priorDns: DnsSettingsPatch): void {
  db.prepare(`INSERT INTO dns_enforcement (device_id, enabled, resolver_ip, resolver_net, lan_interfaces_json, exemptions_json, fail_mode, fallback_upstream, block_doh, prior_dns_json, updated_at)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET enabled=1, resolver_ip=excluded.resolver_ip, resolver_net=excluded.resolver_net,
      lan_interfaces_json=excluded.lan_interfaces_json, exemptions_json=excluded.exemptions_json, fail_mode=excluded.fail_mode,
      fallback_upstream=excluded.fallback_upstream, block_doh=excluded.block_doh, prior_dns_json=excluded.prior_dns_json, updated_at=excluded.updated_at`)
    .run(deviceId, spec.resolverIp, spec.resolverNet, JSON.stringify(spec.lanInterfaces), JSON.stringify(spec.exemptions),
      spec.failMode, spec.fallbackUpstream, spec.blockDoh ? 1 : 0, JSON.stringify(priorDns), new Date().toISOString());
}
export function clearEnforcement(db: DatabaseSync, deviceId: number): void {
  db.prepare('UPDATE dns_enforcement SET enabled = 0, prior_dns_json = NULL, updated_at = ? WHERE device_id = ?').run(new Date().toISOString(), deviceId);
}
