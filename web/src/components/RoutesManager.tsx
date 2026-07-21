import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Lock, Plus, Radio, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react';
import { api } from '../api';
import type { ApplyOutcome, RouteEntry, RoutesView } from '../types';

const inputCls = 'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong';

export default function RoutesManager({ deviceId }: { deviceId: number }) {
  const [view, setView] = useState<RoutesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ title: string; result: string; detail: string; auditId?: number } | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try { setView(await api.get<RoutesView>(`/api/devices/${deviceId}/routes`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load routes: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;
  const ro = !view.manageable;

  async function remove(r: RouteEntry) {
    if (!confirm(`Remove static route ${r.dst} via ${r.gateway}?`)) return;
    try {
      const o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/routes/${encodeURIComponent(r.id)}`, r.managed ? undefined : { force: true });
      setOutcome({ title: `Remove ${r.dst}`, result: o.result, detail: o.detail, auditId: o.auditId });
      await load();
    } catch (e) { setOutcome({ title: `Remove ${r.dst}`, result: 'error', detail: (e as Error).message }); }
  }

  return (
    <div className="space-y-4">
      {/* mgmt-path guard banner */}
      <div className="flex items-start gap-2 rounded-lg bg-info-bg px-3 py-2.5 text-xs text-info-fg">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Management-path guard active. RubyMIK reaches this device {view.mgmtNet === 'tunnel' ? 'over the WireGuard tunnel' : 'directly'} at <b>{view.mgmtHost}</b>.
          The default route{view.mgmtPrefixes.length ? ` and the ${view.mgmtNet === 'tunnel' ? 'overlay' : 'management'} subnet ${view.mgmtPrefixes.join(', ')}` : ''} are protected — a route that would black-hole them is refused, and every change is verified reachable-then-committed (auto-revert on lockout).
        </span>
      </div>

      {ro && (
        <div className="flex items-center gap-2 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted">
          <Lock className="h-4 w-4" /> Monitor-only — routes shown read-only. Add a write credential (Edit device) to configure them.
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
              <th className="px-3 pb-2 pt-2">Destination</th><th className="pb-2">Gateway</th>
              <th className="pb-2">Dist</th><th className="pb-2">Type</th><th className="pb-2">State</th>
              <th className="pb-2 pr-3 text-right">{ro ? '' : 'Actions'}</th>
            </tr>
          </thead>
          <tbody>
            {view.routes.map((r) => (
              <tr key={r.id} className="border-t border-border-subtle">
                <td className="px-3 py-1.5 font-mono text-fg">{r.dst ?? '—'}{r.managed && <span className="ml-2 rounded bg-accent-subtle px-1.5 py-0.5 text-[10px] font-bold text-accent-text">RUBYMIK</span>}</td>
                <td className="py-1.5 text-fg-body">{r.gateway ?? '—'}</td>
                <td className="py-1.5 text-fg-dim">{r.distance ?? '—'}</td>
                <td className="py-1.5">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.kind === 'static' ? 'bg-success-bg text-success-fg' : 'bg-app text-fg-muted'}`}>{r.kind}</span>
                </td>
                <td className="py-1.5 text-fg-dim">{r.active ? 'active' : 'inactive'}</td>
                <td className="py-1.5 pr-3 text-right">
                  {!ro && r.kind === 'static' ? (
                    <button onClick={() => void remove(r)} className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-danger-fg-strong transition hover:bg-danger-bg" title={r.managed ? 'Remove' : 'Pre-existing route — will ask to confirm'}>
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </button>
                  ) : <span className="text-[11px] text-fg-faint">{r.kind === 'static' ? '' : 'read-only'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!ro && (adding
        ? <AddForm deviceId={deviceId} onDone={() => { setAdding(false); void load(); }} onCancel={() => setAdding(false)} onOutcome={setOutcome} />
        : <button onClick={() => setAdding(true)} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover"><Plus className="h-4 w-4" /> Add static route</button>
      )}

      {outcome && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOutcome(null)}>
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                {outcome.result === 'applied' ? <CheckCircle2 className="h-5 w-5 text-success-fg" /> : <ShieldAlert className="h-5 w-5 text-warning-fg" />}
                <h3 className="text-base font-bold text-fg-strong">{outcome.title}: {outcome.result}</h3>
              </div>
              <button onClick={() => setOutcome(null)} className="rounded-lg p-1 text-fg-faint hover:bg-app"><X className="h-4 w-4" /></button>
            </div>
            <p className="mt-2 text-sm text-fg-dim">{outcome.detail}</p>
            {outcome.auditId && <p className="mt-2 text-xs text-fg-faint">Audit #{outcome.auditId} · snapshot → apply → verify-reachable → audit</p>}
          </div>
        </div>
      )}
    </div>
  );
}

type SetOutcome = (o: { title: string; result: string; detail: string; auditId?: number }) => void;

function AddForm({ deviceId, onDone, onCancel, onOutcome }: { deviceId: number; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [dst, setDst] = useState('');
  const [gateway, setGateway] = useState('');
  const [distance, setDistance] = useState('1');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/routes`, { dst, gateway, distance: Number(distance), comment: comment || null });
      onOutcome({ title: `Add ${dst}`, result: o.result, detail: o.detail, auditId: o.auditId });
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-border bg-sunken p-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-fg-dim"><Radio className="h-3.5 w-3.5" /> New static route (RUBYMIK-tagged)</div>
      {err && <div className="mb-2 flex items-start gap-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />{err}</div>}
      <div className="flex flex-wrap items-end gap-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Destination (CIDR)</span><input className={`${inputCls} w-44`} value={dst} onChange={(e) => setDst(e.target.value)} placeholder="10.20.0.0/24" /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Gateway</span><input className={`${inputCls} w-40`} value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="172.16.111.1" /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Distance</span><input className={`${inputCls} w-20`} value={distance} onChange={(e) => setDistance(e.target.value)} /></label>
        <label className="flex-1"><span className="mb-1 block text-xs font-semibold text-fg-dim">Comment (optional)</span><input className={inputCls} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
      </div>
      <div className="mt-3 flex gap-2">
        <button disabled={busy || !dst || !gateway} onClick={() => void submit()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse transition hover:bg-accent-hover disabled:opacity-50">Add route</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body transition hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}
