import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Clock, Globe, Loader2, Lock, Plus, RotateCcw, Timer, Trash2, X,
} from 'lucide-react';
import { api } from '../api';
import type { ApplyOutcome, NetConfigView, NtpState } from '../types';

export default function DnsNtpManager({ deviceId }: { deviceId: number }) {
  const [view, setView] = useState<NetConfigView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ title: string; result: string; detail: string; auditId?: number } | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<NetConfigView>(`/api/devices/${deviceId}/netconfig`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load DNS/NTP: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;
  const ro = !view.manageable;

  return (
    <div className="space-y-6">
      {ro && (
        <div className="flex items-center gap-2 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted">
          <Lock className="h-4 w-4" /> Monitor-only — showing DNS/NTP read-only. Add a write credential (Edit device) to manage them.
        </div>
      )}
      <DnsPanel view={view} ro={ro} deviceId={deviceId} onOutcome={setOutcome} reload={load} />
      <NtpPanel ntp={view.ntp} ro={ro} deviceId={deviceId} onOutcome={setOutcome} reload={load} />
      {outcome && <OutcomeModal {...outcome} onClose={() => setOutcome(null)} />}
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong focus:ring-2 focus:ring-accent-border-strong/20';
type SetOutcome = (o: { title: string; result: string; detail: string; auditId?: number }) => void;

function DnsPanel({ view, ro, deviceId, onOutcome, reload }: { view: NetConfigView; ro: boolean; deviceId: number; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const dns = view.dns;
  const [servers, setServers] = useState(dns.servers.join(', '));
  const [allow, setAllow] = useState(dns.allowRemoteRequests);
  const [cache, setCache] = useState(String(dns.cacheSize));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addStatic, setAddStatic] = useState(false);

  async function apply() {
    setBusy(true); setErr(null);
    try {
      const o = await api.put<ApplyOutcome>(`/api/devices/${deviceId}/dns`, {
        servers: servers.split(',').map((s) => s.trim()).filter(Boolean), allowRemoteRequests: allow, cacheSize: Number(cache),
      });
      onOutcome({ title: 'Set DNS', result: o.result, detail: o.detail, auditId: o.auditId });
      await reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function removeStatic(id: string, label: string) {
    if (!confirm(`Remove static DNS entry ${label}?`)) return;
    try { const o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/dns/static/${id}`); onOutcome({ title: `Remove static ${label}`, result: o.result, detail: o.detail, auditId: o.auditId }); await reload(); }
    catch (e) { setErr((e as Error).message); }
  }

  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-fg-dim"><Globe className="h-3.5 w-3.5" /> DNS</h3>
      <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Meta label="Servers" value={dns.servers.join(', ') || '—'} />
        <Meta label="Dynamic (from DHCP)" value={dns.dynamicServers.join(', ') || '—'} />
        <Meta label="Allow remote requests" value={dns.allowRemoteRequests ? 'yes' : 'no'} />
        <Meta label="Cache" value={`${dns.cacheUsed} / ${dns.cacheSize} KiB`} />
      </dl>
      {!ro && (
        <div className="rounded-xl border border-border p-3.5">
          {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{err}</div>}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">DNS servers (comma-sep IPs)</span>
              <input className={inputCls} value={servers} onChange={(e) => setServers(e.target.value)} placeholder="1.1.1.1, 8.8.8.8" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">Cache (KiB)</span>
              <input className={inputCls} value={cache} onChange={(e) => setCache(e.target.value)} inputMode="numeric" />
            </label>
          </div>
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} className="mt-0.5 h-4 w-4 accent-accent" />
            <span><span className="font-medium text-fg">Allow remote requests</span>
              <span className="block text-xs text-fg-dim">Makes the router a DNS resolver for its clients. Useful — but don't enable blindly (exposes the resolver to that network).</span>
            </span>
          </label>
          <div className="mt-3 flex justify-end">
            <button onClick={() => void apply()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse transition hover:bg-accent-hover disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Apply DNS
            </button>
          </div>
        </div>
      )}
      {/* Static entries */}
      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wide text-fg-dim">Static entries · {dns.static.length}</span>
          {!ro && <button onClick={() => setAddStatic(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-accent-text hover:underline"><Plus className="h-3.5 w-3.5" /> Add</button>}
        </div>
        {dns.static.length === 0 ? (
          <div className="rounded-lg bg-sunken px-3 py-2 text-sm text-fg-dim">No static DNS entries.</div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border-subtle">
            {dns.static.map((e) => (
              <div key={e.id} className="flex items-center gap-3 border-b border-border-subtle px-3 py-1.5 text-sm last:border-0">
                <span className="font-medium text-fg">{e.name}</span>
                <span className="font-mono text-xs text-fg-dim">{e.address}</span>
                {e.comment && <span className="text-xs text-fg-faint">{e.comment}</span>}
                {!ro && <button onClick={() => void removeStatic(e.id, `${e.name} → ${e.address}`)} className="ml-auto rounded-md p-1.5 text-fg-faint hover:bg-danger-bg hover:text-danger-fg"><Trash2 className="h-4 w-4" /></button>}
              </div>
            ))}
          </div>
        )}
      </div>
      {addStatic && <StaticModal deviceId={deviceId} onClose={() => setAddStatic(false)} onDone={(o) => { setAddStatic(false); onOutcome(o); void reload(); }} />}
    </div>
  );
}

function NtpPanel({ ntp, ro, deviceId, onOutcome, reload }: { ntp: NtpState; ro: boolean; deviceId: number; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(ntp.enabled);
  const [servers, setServers] = useState(ntp.servers.join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<NtpState>(ntp);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => setLive(ntp), [ntp]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function apply() {
    setBusy(true); setErr(null);
    try {
      const o = await api.put<ApplyOutcome>(`/api/devices/${deviceId}/ntp`, { enabled, servers: servers.split(',').map((s) => s.trim()).filter(Boolean) });
      onOutcome({ title: 'Set NTP', result: o.result, detail: o.detail, auditId: o.auditId });
      await reload();
      // watch sync for ~30s
      if (enabled) {
        if (pollRef.current) clearInterval(pollRef.current);
        let n = 0;
        pollRef.current = setInterval(async () => {
          n++;
          try { const s = await api.get<NtpState>(`/api/devices/${deviceId}/netconfig/ntp`); setLive(s); if (s.synced || n > 12) { clearInterval(pollRef.current!); } } catch { /* keep */ }
        }, 2500);
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const statusCls = live.synced ? 'bg-success-bg text-success-fg' : live.enabled ? 'bg-warning-bg text-warning-fg' : 'bg-app text-fg-dim';
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-fg-dim"><Timer className="h-3.5 w-3.5" /> NTP (time sync)</h3>
      <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Status</dt>
          <dd className="mt-0.5"><span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${statusCls}`}>
            {live.synced ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />} {live.enabled ? live.status : 'disabled'}
          </span></dd>
        </div>
        <Meta label="Servers" value={live.servers.join(', ') || '—'} />
        <Meta label="Router time" value={live.time ?? '—'} />
        <Meta label="Time zone" value={live.timeZone ?? '—'} />
      </dl>
      {!ro && (
        <div className="rounded-xl border border-border p-3.5">
          {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{err}</div>}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">NTP servers (IP or hostname)</span>
              <input className={inputCls} value={servers} onChange={(e) => setServers(e.target.value)} placeholder="pool.ntp.org, 162.159.200.1" />
            </label>
            <label className="flex items-center gap-2 pt-5 text-sm font-medium text-fg-body">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-accent" /> Enable NTP client
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button onClick={() => void apply()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse transition hover:bg-accent-hover disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Apply NTP
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-fg" title={value}>{value}</dd>
    </div>
  );
}

function StaticModal({ deviceId, onClose, onDone }: { deviceId: number; onClose: () => void; onDone: (o: { title: string; result: string; detail: string; auditId?: number }) => void }) {
  const [name, setName] = useState(''); const [address, setAddress] = useState(''); const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/dns/static`, { name, address, comment: comment || null }); onDone({ title: `Add static ${name}`, result: o.result, detail: o.detail, auditId: o.auditId }); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between"><h3 className="text-lg font-bold text-fg-strong">Static DNS entry</h3><button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button></div>
        <p className="mt-1 text-xs text-fg-dim">A hostname → IP mapping the router resolves locally. Goes through the audited pipeline.</p>
        <div className="mt-4 space-y-3">
          {err && <div className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{err}</div>}
          <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">Hostname</span><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="nas.lan" autoFocus /></label>
          <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">IP address</span><input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.90.10" /></label>
          <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">Comment (optional)</span><input className={inputCls} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>
          <button onClick={() => void save()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Add entry</button>
        </div>
      </div>
    </div>
  );
}

const RESULT_META: Record<string, { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  applied: { label: 'Applied & verified', cls: 'text-success-fg bg-success-bg', Icon: CheckCircle2 },
  rolled_back: { label: 'Auto-rolled back', cls: 'text-warning-fg bg-warning-bg', Icon: RotateCcw },
  rollback_failed: { label: 'Rollback failed', cls: 'text-danger-fg bg-danger-bg', Icon: AlertTriangle },
  failed: { label: 'Failed', cls: 'text-danger-fg bg-danger-bg', Icon: AlertTriangle },
};
function OutcomeModal({ title, result, detail, auditId, onClose }: { title: string; result: string; detail: string; auditId?: number; onClose: () => void }) {
  const m = RESULT_META[result] ?? RESULT_META.failed;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className={`mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${m.cls}`}><m.Icon className="h-4 w-4" /> {m.label}</div>
        <h3 className="text-base font-semibold text-fg-strong">{title}</h3>
        <p className="mt-1.5 text-sm text-fg-muted">{detail}</p>
        {auditId !== undefined && <p className="mt-3 text-xs text-fg-faint">Recorded in the audit log (#{auditId}).</p>}
        <div className="mt-5 flex justify-end"><button onClick={onClose} className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">Close</button></div>
      </div>
    </div>
  );
}
