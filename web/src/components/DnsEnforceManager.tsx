import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Radio, ShieldCheck, ShieldOff, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../api';
import type { DnsEnforceView, DnsEnforceSpec, DnsFailMode } from '../types';

const emptySpec = (): DnsEnforceSpec => ({
  resolverIp: '', resolverNet: 'direct', lanInterfaces: [], wanInterfaces: [], exemptions: [],
  failMode: 'open', fallbackUpstream: '1.1.1.1', blockDoh: true,
});

export default function DnsEnforceManager({ deviceId, deviceName, interfaces = [] }: { deviceId: number; deviceName: string; interfaces?: string[] }) {
  const [view, setView] = useState<DnsEnforceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardMsg, setGuardMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [wizard, setWizard] = useState<DnsEnforceSpec | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<DnsEnforceView>(`/api/devices/${deviceId}/dns-enforcement`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setGuardMsg(null); setError(null);
    try {
      const o = await fn() as { result?: string; detail?: string };
      if (o?.result === 'rolled_back') setError(`Change auto-rolled back: ${o.detail ?? 'management became unreachable'}.`);
      await load();
    } catch (err) {
      const body = err instanceof ApiError ? err.body as { dnsMgmtGuard?: boolean } | undefined : undefined;
      if (body?.dnsMgmtGuard) setGuardMsg((err as Error).message);
      else setError((err as Error).message);
    } finally { setBusy(null); }
  }
  const teardown = () => act('teardown', () => api.post(`/api/devices/${deviceId}/dns-enforcement/teardown`, {}));

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load DNS enforcement: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;

  const failOpen = view.dnsServers.includes(',');

  return (
    <div>
      <div className="mb-3 flex items-start gap-2 rounded-lg bg-info-bg px-3 py-2.5 text-sm text-info-fg">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>RubyMIK reaches this router on <b>{view.mgmt.mgmtScheme}:{view.mgmt.mgmtPort}</b> via <b>{view.mgmt.mgmtInterface}</b>. Enforcement matches LAN client interfaces only — never the management path — and always drops <span className="font-mono text-[12px]">:53</span> on the WAN so the router is never left an open resolver.</span>
      </div>
      {guardMsg && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning-line bg-warning-bg px-3 py-2.5 text-sm text-warning-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span><b>Refused by the DNS management guard.</b> {guardMsg}</span>
          <button onClick={() => setGuardMsg(null)} className="ml-auto rounded p-0.5 hover:bg-warning-line/40"><X className="h-4 w-4" /></button>
        </div>
      )}
      {error && <div className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

      {!view.configured ? (
        <div className="rounded-xl border border-border-subtle bg-sunken p-5 text-center">
          <ShieldOff className="mx-auto h-8 w-8 text-fg-faint" />
          <p className="mt-2 text-sm font-semibold text-fg-body">DNS filtering not enforced on this device</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-fg-dim">Force this router's LAN clients through the filtering resolver — a preview shows the exact redirect, blocks and <span className="font-mono text-[12px]">/ip/dns</span> change before anything is applied.</p>
          {view.manageable ? (
            <button onClick={() => setWizard(emptySpec())} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">
              <ShieldCheck className="h-4 w-4" /> Enforce DNS filtering
            </button>
          ) : <p className="mt-3 text-xs text-fg-faint">This device is monitor-only — add a write credential to enforce filtering.</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-success-bg px-3 py-1 text-sm font-bold text-success-fg"><Radio className="h-3.5 w-3.5" /> Enforcing</span>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${failOpen ? 'bg-warning-bg text-warning-fg' : 'bg-app text-fg-dim'}`}>{failOpen ? 'fail-open' : 'fail-closed'}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Fact label="Resolver (/ip/dns)" value={view.dnsServers} mono />
            <Fact label="Redirect rules" value={`${view.redirects}`} />
            <Fact label="DoT / DoH blocks" value={`${view.dotBlocks} / ${view.dohBlocks}`} />
            <Fact label="WAN :53 drops" value={`${view.wanDrops}`} />
            <Fact label="Exempt clients" value={`${view.exemptions}`} />
            <Fact label="allow-remote-requests" value={view.allowRemoteRequests} mono />
          </div>
          {failOpen && (
            <div className="flex items-start gap-2 rounded-lg bg-sunken px-3 py-2.5 text-xs text-fg-dim">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-fg" />
              <span>Under fail-open, some queries may reach the fallback unfiltered — RouterOS does not guarantee resolver preference. Choose <b>fail-closed</b> for strict sites.</span>
            </div>
          )}
          {view.manageable && (
            <div className="flex items-center gap-3 pt-1">
              <button onClick={() => setWizard(emptySpec())} className="rounded-lg border border-border-strong px-3 py-1.5 text-sm font-semibold text-fg-body hover:border-accent-border hover:text-accent-text">Reconfigure…</button>
              <button onClick={teardown} disabled={busy != null} className="inline-flex items-center gap-1.5 rounded-lg border border-danger-line px-3 py-1.5 text-sm font-semibold text-danger-fg hover:bg-danger-bg disabled:opacity-50">
                {busy === 'teardown' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Stop enforcing
              </button>
              <span className="text-xs text-fg-faint">Teardown restores the original /ip/dns (closing the resolver) before removing the rules.</span>
            </div>
          )}
        </div>
      )}

      {wizard && <EnforceWizard deviceId={deviceId} deviceName={deviceName} interfaces={interfaces} initial={wizard}
        onClose={() => setWizard(null)} onApplied={() => { setWizard(null); void load(); }}
        onGuard={(m) => { setWizard(null); setGuardMsg(m); }} />}
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border-subtle px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label}</div>
      <div className={`mt-0.5 text-sm text-fg-body ${mono ? 'font-mono text-[13px]' : ''}`}>{value || '—'}</div>
    </div>
  );
}

const IFToggle = ({ iface, on, onToggle }: { iface: string; on: boolean; onToggle: () => void }) => (
  <button type="button" onClick={onToggle} aria-pressed={on}
    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${on ? 'border-accent-border bg-accent-subtle text-accent-text' : 'border-border-strong text-fg-dim hover:border-accent-border'}`}>{iface}</button>
);

function EnforceWizard({ deviceId, deviceName, interfaces, initial, onClose, onApplied, onGuard }: {
  deviceId: number; deviceName: string; interfaces: string[]; initial: DnsEnforceSpec;
  onClose: () => void; onApplied: () => void; onGuard: (m: string) => void;
}) {
  const [spec, setSpec] = useState<DnsEnforceSpec>(initial);
  const [preview, setPreview] = useState<{ plan: { all: unknown[]; dns: Record<string, string> }; guard: string | null; mgmtSafe: { safe: boolean } } | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'apply'>('');
  const [error, setError] = useState<string | null>(null);

  const setF = (patch: Partial<DnsEnforceSpec>) => { setSpec((s) => ({ ...s, ...patch })); setPreview(null); };
  const toggleIface = (key: 'lanInterfaces' | 'wanInterfaces', iface: string) =>
    setF({ [key]: spec[key].includes(iface) ? spec[key].filter((i) => i !== iface) : [...spec[key], iface] } as Partial<DnsEnforceSpec>);

  async function doPreview() {
    setBusy('preview'); setError(null);
    try { setPreview(await api.post(`/api/devices/${deviceId}/dns-enforcement/preview`, { spec })); }
    catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  }
  async function doApply() {
    setBusy('apply'); setError(null);
    try {
      const o = await api.post(`/api/devices/${deviceId}/dns-enforcement`, { spec }) as { result?: string; detail?: string };
      if (o?.result === 'applied') { onApplied(); return; }
      setError(`Not applied (${o?.result}): ${o?.detail ?? 'see audit log'}.`);
    } catch (err) {
      const body = err instanceof ApiError ? err.body as { dnsMgmtGuard?: boolean } | undefined : undefined;
      if (body?.dnsMgmtGuard) { onGuard((err as Error).message); return; }
      setError((err as Error).message);
    } finally { setBusy(''); }
  }
  const canApply = preview != null && preview.guard == null && preview.mgmtSafe.safe && spec.resolverIp !== '' && spec.lanInterfaces.length > 0 && spec.wanInterfaces.length > 0 && busy === '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-auto rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div><h3 className="text-lg font-bold text-fg-strong">Enforce DNS filtering</h3>
            <p className="mt-0.5 text-sm text-fg-dim">Force LAN clients on <b>{deviceName}</b> through the filtering resolver.</p></div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button>
        </div>

        <label className="mt-4 block text-xs font-semibold text-fg-dim">Resolver IP (the /ip/dns upstream — same-LAN or the WireGuard tunnel IP)
          <input value={spec.resolverIp} onChange={(e) => setF({ resolverIp: e.target.value })} placeholder="192.168.88.2"
            className="mt-1 w-full rounded-lg border border-border-strong bg-app px-2.5 py-2 font-mono text-sm text-fg-body" />
        </label>

        <div className="mt-3 text-xs font-semibold text-fg-dim">LAN client interfaces (redirect here — never the mgmt path)</div>
        <div className="mt-1 flex flex-wrap gap-1.5">{interfaces.map((i) => <IFToggle key={i} iface={i} on={spec.lanInterfaces.includes(i)} onToggle={() => toggleIface('lanInterfaces', i)} />)}</div>
        <div className="mt-3 text-xs font-semibold text-fg-dim">WAN interfaces (drop :53 here — closes the open resolver)</div>
        <div className="mt-1 flex flex-wrap gap-1.5">{interfaces.map((i) => <IFToggle key={i} iface={i} on={spec.wanInterfaces.includes(i)} onToggle={() => toggleIface('wanInterfaces', i)} />)}</div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="text-xs font-semibold text-fg-dim">If the resolver is unreachable</div>
            <div className="mt-1 flex gap-1.5">
              {(['open', 'closed'] as DnsFailMode[]).map((m) => (
                <button key={m} type="button" onClick={() => setF({ failMode: m })}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ${spec.failMode === m ? 'border-accent-border bg-accent-subtle text-accent-text' : 'border-border-strong text-fg-dim'}`}>
                  {m === 'open' ? 'Fail-open (keep internet)' : 'Fail-closed (strict)'}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-end gap-2 pb-1 text-xs font-semibold text-fg-dim">
            <input type="checkbox" checked={spec.blockDoh} onChange={(e) => setF({ blockDoh: e.target.checked })} className="h-4 w-4" /> Block known DoH endpoints (best-effort)
          </label>
        </div>
        {spec.failMode === 'open' ? (
          <div className="mt-2 flex items-start gap-2 rounded-lg bg-sunken px-3 py-2 text-xs text-fg-dim">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-fg" />
            <span>Under fail-open, some queries may reach the fallback unfiltered — RouterOS does not guarantee resolver preference; choose fail-closed for strict sites.</span>
          </div>
        ) : (
          <div className="mt-2 text-xs text-fg-faint">Fail-closed: if the resolver goes down, clients lose DNS (no unfiltered fallback). RouterOS check-gateway does not apply here — a resolver restart is a brief DNS outage for this site.</div>
        )}
        {spec.failMode === 'open' && (
          <label className="mt-2 block text-xs font-semibold text-fg-dim">Fallback upstream (used only when the resolver is down)
            <input value={spec.fallbackUpstream} onChange={(e) => setF({ fallbackUpstream: e.target.value })} placeholder="1.1.1.1"
              className="mt-1 w-full rounded-lg border border-border-strong bg-app px-2.5 py-2 font-mono text-sm text-fg-body" />
          </label>
        )}

        {error && <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}
        {preview && (
          <div className="mt-4 rounded-xl border border-border-subtle">
            <div className="border-b border-border-subtle bg-sunken px-3 py-2 text-xs font-bold uppercase tracking-wide text-fg-dim">Preview — {preview.plan.all.length} objects + /ip/dns → {preview.plan.dns.servers}</div>
            <div className="space-y-1.5 p-3">
              {preview.guard && <div className="flex items-start gap-1.5 text-xs text-danger-fg"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{preview.guard}</span></div>}
              {preview.mgmtSafe.safe && !preview.guard && <div className="flex items-center gap-1.5 text-xs text-success-fg"><CheckCircle2 className="h-3.5 w-3.5" /> Management-safe: no rule matches the mgmt path or the tunnel-back.</div>}
            </div>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>
          <button onClick={doPreview} disabled={busy !== ''} className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:border-accent-border hover:text-accent-text disabled:opacity-50">
            {busy === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {preview ? 'Re-preview' : 'Preview'}
          </button>
          <button onClick={doApply} disabled={!canApply} className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-40">
            {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Apply
          </button>
        </div>
      </div>
    </div>
  );
}
