import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Plus, Radio, Save, ShieldCheck, Sparkles, X, Zap } from 'lucide-react';
import { api, ApiError } from '../api';
import type { DnsCategory, DnsFilterSettingsResp, DnsApplyResult, ResolverSettings } from '../types';

const CATEGORY_META: { key: DnsCategory; label: string; blurb: string; note?: string }[] = [
  { key: 'ads', label: 'Ads & trackers', blurb: 'Advertising and analytics/telemetry domains.' },
  { key: 'malware', label: 'Malware & phishing', blurb: 'Known-malicious, phishing and scam domains.' },
  { key: 'adult', label: 'Adult content', blurb: 'Pornography and adult sites.' },
  { key: 'gambling', label: 'Gambling', blurb: 'Betting and online-casino domains.' },
  { key: 'social', label: 'Social media', blurb: 'Facebook, TikTok, X/Twitter, Instagram and similar.' },
  { key: 'streaming', label: 'Streaming', blurb: 'Smart-TV and streaming-platform telemetry (best-effort).' },
  { key: 'gaming', label: 'Gaming', blurb: 'No default public list — add gaming domains under Custom block.', note: 'listless' },
];

// Clearly-labelled SAMPLE stats — real figures populate once filtering is deployed and running.
const SAMPLE_STATS = {
  queries: 184203, blocked: 41120, blockRatePct: 22.3,
  topBlocked: [['google-analytics.com', 8123], ['doubleclick.net', 6044], ['graph.facebook.com', 3990], ['ads.tiktok.com', 2571], ['app-measurement.com', 1902]] as [string, number][],
};

export default function DnsFilter() {
  const [resp, setResp] = useState<DnsFilterSettingsResp | null>(null);
  const [s, setS] = useState<ResolverSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'save' | 'apply'>('');
  const [applyResult, setApplyResult] = useState<DnsApplyResult | null>(null);

  const load = useCallback(async () => {
    try { const r = await api.get<DnsFilterSettingsResp>('/api/dns-filter/settings'); setResp(r); setS(r.settings); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error && !resp) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load DNS filtering: {error}</div>;
  if (!resp || !s) return <div className="mx-auto mt-10 h-40 max-w-3xl animate-pulse rounded-2xl bg-app" />;

  const set = (patch: Partial<ResolverSettings>) => setS((c) => ({ ...c!, ...patch }));
  const toggle = (k: DnsCategory) => set({ categories: { ...s.categories, [k]: !s.categories[k] } });

  async function save(apply: boolean) {
    setBusy(apply ? 'apply' : 'save'); setError(null); setApplyResult(null);
    try {
      await api.put('/api/dns-filter/settings', s);
      if (apply) setApplyResult(await api.post<DnsApplyResult>('/api/dns-filter/apply', {}));
      await load();
    } catch (err) {
      const body = err instanceof ApiError ? err.body as { notDeployed?: boolean } | undefined : undefined;
      setError(body?.notDeployed ? 'The filtering resolver is not deployed — apply docker-compose.filtering.yml, then Save & apply.' : (err as Error).message);
    } finally { setBusy(''); }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-accent-text" />
        <h1 className="text-xl font-bold text-fg-strong">DNS Content Filtering</h1>
      </div>
      <p className="mb-4 text-sm text-fg-dim">Block unwanted or malicious domains network-wide through a filtering resolver. Configure it here; enforce it per device under <b>Device → Network → DNS Filtering</b>.</p>

      {/* deployment / health status */}
      {!resp.enabled ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning-line bg-warning-bg px-3 py-2.5 text-sm text-warning-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span><b>The filtering resolver isn't deployed.</b> Bring it up with <span className="font-mono text-[12px]">docker compose -f docker-compose.yml -f docker-compose.filtering.yml up -d</span>. You can configure the settings below now — they apply the moment you deploy and <b>Save &amp; apply</b>.</span>
        </div>
      ) : (
        <div className="mb-4 flex items-center gap-2">
          <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${resp.resolverUp ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg-strong'}`}>
            <Radio className="h-3.5 w-3.5" /> Resolver {resp.resolverUp ? 'up' : 'DOWN'}
          </span>
          {!resp.resolverUp && <span className="text-xs text-danger-fg">On fail-open sites this means no filtering right now — every domain resolves.</span>}
        </div>
      )}
      {error && <div className="mb-4 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

      {/* categories */}
      <Section title="Categories" desc="Curated public blocklists, updated automatically.">
        <div className="divide-y divide-border-subtle">
          {CATEGORY_META.map((c) => (
            <label key={c.key} className="flex cursor-pointer items-center gap-3 py-2.5">
              <Switch on={s.categories[c.key]} onClick={() => toggle(c.key)} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-fg-body">{c.label} {c.note === 'listless' && <span className="ml-1 rounded bg-app px-1.5 py-0.5 text-[10px] font-semibold text-fg-faint">no default list</span>}</div>
                <div className="text-xs text-fg-faint">{c.blurb}</div>
              </div>
            </label>
          ))}
        </div>
      </Section>

      {/* custom rules */}
      <Section title="Custom rules" desc="Domains to always block or always allow (allow wins over block).">
        <div className="grid gap-4 sm:grid-cols-2">
          <DomainList label="Always block" tone="block" items={s.customBlock} onChange={(customBlock) => set({ customBlock })} />
          <DomainList label="Always allow" tone="allow" items={s.customAllow} onChange={(customAllow) => set({ customAllow })} />
        </div>
      </Section>

      {/* exemptions */}
      <Section title="Client exemptions" desc="Client IPs that skip filtering entirely — their DNS is never redirected.">
        <DomainList label="Exempt client IPs" tone="neutral" placeholder="192.168.88.50" items={s.clientExemptions} onChange={(clientExemptions) => set({ clientExemptions })} />
      </Section>

      {/* actions */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button onClick={() => save(false)} disabled={busy !== ''} className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken disabled:opacity-50">
          {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
        </button>
        <button onClick={() => save(true)} disabled={busy !== '' || !resp.enabled} title={resp.enabled ? '' : 'Deploy the resolver first'}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-40">
          {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />} Save &amp; apply
        </button>
        <span className="text-xs text-fg-faint">Apply regenerates the resolver config, reloads it, and verifies it's blocking before reporting success.</span>
      </div>
      {applyResult && (
        <div className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm ${applyResult.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg-strong'}`}>
          {applyResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{applyResult.detail}{applyResult.outageMs != null && <> Clients querying a fail-closed site may briefly have lost DNS during that window.</>}</span>
        </div>
      )}

      {/* honest stats-coarseness note */}
      <div className="mt-5 flex items-start gap-2 rounded-lg bg-sunken px-3 py-2.5 text-xs text-fg-dim">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-faint" />
        <span>Per-client breakdown requires clients to query the resolver directly. Via router forwarding (the default enforcement), all of a site's queries arrive from the router's IP, so clients are aggregated per site — exempt clients are the exception (they bypass the resolver entirely).</span>
      </div>

      {/* SAMPLE stats — clearly labelled */}
      <Section title={<span className="inline-flex items-center gap-2">Statistics <span className="inline-flex items-center gap-1 rounded-full bg-app px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-fg-faint"><Sparkles className="h-3 w-3" /> Sample data</span></span>}
        desc="Illustration only — real figures populate once filtering is deployed and running.">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Queries (24h)" value={SAMPLE_STATS.queries.toLocaleString()} />
          <Stat label="Blocked" value={SAMPLE_STATS.blocked.toLocaleString()} tone="danger" />
          <Stat label="Block rate" value={`${SAMPLE_STATS.blockRatePct}%`} />
        </div>
        <div className="mt-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-faint">Top blocked</div>
          <div className="overflow-hidden rounded-lg border border-border-subtle">
            {SAMPLE_STATS.topBlocked.map(([d, n], i) => (
              <div key={d} className={`flex items-center justify-between px-3 py-1.5 text-sm ${i % 2 ? 'bg-sunken' : ''}`}>
                <span className="font-mono text-[12px] text-fg-body">{d}</span>
                <span className="tabular-nums text-fg-dim">{n.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, desc, children }: { title: React.ReactNode; desc?: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-2xl border border-border-subtle bg-surface p-4">
      <div className="mb-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-fg-body">{title}</h2>
        {desc && <p className="mt-0.5 text-xs text-fg-faint">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-border-strong'}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface transition ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="rounded-lg border border-border-subtle p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label}</div>
      <div className={`mt-0.5 text-xl font-bold tabular-nums ${tone === 'danger' ? 'text-danger-fg' : 'text-fg-strong'}`}>{value}</div>
    </div>
  );
}

function DomainList({ label, items, onChange, tone, placeholder }: { label: string; items: string[]; onChange: (items: string[]) => void; tone: 'block' | 'allow' | 'neutral'; placeholder?: string }) {
  const [v, setV] = useState('');
  const add = () => { const t = v.trim(); if (t && !items.includes(t)) { onChange([...items, t]); setV(''); } };
  const chip = tone === 'block' ? 'bg-danger-bg text-danger-fg' : tone === 'allow' ? 'bg-success-bg text-success-fg' : 'bg-app text-fg-dim';
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-fg-dim">{label}</div>
      <div className="flex gap-2">
        <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
          placeholder={placeholder ?? 'example.com'} className="min-w-0 flex-1 rounded-lg border border-border-strong bg-app px-2.5 py-1.5 font-mono text-[13px] text-fg-body" />
        <button onClick={add} className="rounded-lg border border-border-strong px-2.5 py-1.5 text-fg-body hover:border-accent-border hover:text-accent-text"><Plus className="h-4 w-4" /></button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {items.length === 0 && <span className="text-xs text-fg-faint">None.</span>}
        {items.map((d) => (
          <span key={d} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] ${chip}`}>
            {d}<button onClick={() => onChange(items.filter((x) => x !== d))} className="rounded hover:opacity-70"><X className="h-3 w-3" /></button>
          </span>
        ))}
      </div>
    </div>
  );
}
