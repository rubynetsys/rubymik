import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Download, History, Loader2, Lock, MinusCircle, OctagonX, PlusCircle, RotateCcw, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import type { RestoreSectionDef, RestorePlanView, RestorePlanOp, RestoreReport } from '../types';

interface SnapMeta { id: number; capturedAt: string; trigger: string; operation: string | null; outcome: string | null; format: string }
const fmtWhen = (s: string) => new Date(s).toLocaleString();

/**
 * P37 — section-scoped restore. Preview a per-section delta from a snapshot
 * (works read-only, incl. monitor-only devices), then apply it THROUGH the guarded
 * write modules. RubyMIK never pushes a whole .rsc (that's the manual helper).
 */
export default function RestoreManager({ deviceId, deviceName, manageable }: { deviceId: number; deviceName: string; manageable: boolean }) {
  const [snaps, setSnaps] = useState<SnapMeta[]>([]);
  const [sections, setSections] = useState<RestoreSectionDef[]>([]);
  const [snapId, setSnapId] = useState<number | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'additive' | 'exact'>('additive');
  const [plan, setPlan] = useState<RestorePlanView | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.get<{ snapshots: SnapMeta[] }>(`/api/devices/${deviceId}/snapshots`);
      setSnaps(s.snapshots ?? []);
      if (!snapId && s.snapshots?.length) setSnapId(s.snapshots[0].id);
      const cat = await api.get<{ sections: RestoreSectionDef[] }>(`/api/devices/${deviceId}/restore/sections`);
      setSections(cat.sections);
    } catch (err) { setError((err as Error).message); }
  }, [deviceId, snapId]);
  useEffect(() => { void load(); }, [load]);

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const sel = () => [...picked].join(',');

  async function preview() {
    if (!snapId || picked.size === 0) return;
    setBusy('plan'); setError(null); setReport(null);
    try { setPlan(await api.get<RestorePlanView>(`/api/devices/${deviceId}/snapshots/${snapId}/plan?sections=${sel()}&mode=${mode}`)); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }
  async function restore() {
    if (!snapId) return;
    setBusy('restore'); setError(null);
    try {
      const rep = await api.post<RestoreReport>(`/api/devices/${deviceId}/snapshots/${snapId}/restore`, { sections: [...picked], mode, confirm: confirmText.trim() });
      setReport(rep); setPlan(null); setConfirmText('');
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  const confirmOk = confirmText.trim() === `RESTORE ${deviceName}`;

  return (
    <div className="space-y-4">
      {!manageable && (
        <div className="flex items-center gap-2 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted">
          <Lock className="h-4 w-4" /> Monitor-only — you can PREVIEW drift here (read-only), but restore is refused by the server.
        </div>
      )}
      {error && <div className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Restore from snapshot</span>
          <select className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm" value={snapId ?? ''} onChange={(e) => { setSnapId(Number(e.target.value)); setPlan(null); setReport(null); }}>
            {snaps.map((s) => <option key={s.id} value={s.id}>#{s.id} · {fmtWhen(s.capturedAt)} · {s.trigger}{s.operation ? ` (${s.operation})` : ''} · {s.format}</option>)}
          </select>
        </label>
        <div>
          <span className="mb-1 block text-xs font-semibold text-fg-dim">Mode</span>
          <div className="flex overflow-hidden rounded-lg border border-border-strong text-xs font-semibold">
            {(['additive', 'exact'] as const).map((m) => (
              <button key={m} onClick={() => { setMode(m); setPlan(null); }} className={`flex-1 px-3 py-2 transition ${mode === m ? 'bg-accent text-inverse' : 'bg-surface text-fg-dim hover:bg-sunken'}`}>
                {m === 'additive' ? 'Additive + changes' : 'Exact (incl. deletes)'}
              </button>
            ))}
          </div>
          {mode === 'exact' && <p className="mt-1 text-[11px] text-warning-fg">Exact removes config that isn’t in the snapshot. Guard-protected and unmanaged items are never deleted.</p>}
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs font-semibold text-fg-dim">Sections</span>
        <div className="flex flex-wrap gap-2">
          {sections.map((s) => (
            <label key={s.id} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${picked.has(s.id) ? 'border-accent-border bg-accent-subtle text-accent-text' : 'border-border-strong text-fg-body'}`}>
              <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} /> {s.label}
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button disabled={!snapId || picked.size === 0 || busy !== null} onClick={() => void preview()} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy === 'plan' ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />} Preview plan (drift)</button>
        {snapId && <a href={`/api/devices/${deviceId}/snapshots/${snapId}/rsc`} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app"><Download className="h-4 w-4" /> Full .rsc + manual procedure</a>}
      </div>

      {plan && <PlanView plan={plan} />}

      {plan && plan.total > 0 && manageable && (
        <div className="rounded-xl border border-warning-line bg-warning-bg/40 p-4">
          <div className="text-sm text-warning-fg">Restore <b>{plan.total}</b> change(s) to <b>{deviceName}</b>. Each op runs through its section’s guard + dead-man + a pre/post snapshot; the restore <b>halts</b> on the first refusal.</div>
          <label className="mt-2 block text-xs font-semibold text-fg-dim">Type <code>RESTORE {deviceName}</code> to confirm
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={`RESTORE ${deviceName}`} className="mt-1 w-full rounded-lg border border-border-strong bg-app px-3 py-2 text-sm outline-none focus:border-warning-line" />
          </label>
          <button disabled={!confirmOk || busy !== null} onClick={() => void restore()} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-warning px-4 py-2 text-sm font-semibold text-inverse hover:opacity-90 disabled:opacity-40">{busy === 'restore' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Restore selected sections</button>
        </div>
      )}

      {report && <ReportView report={report} onReset={() => { setReport(null); void load(); }} />}
    </div>
  );
}

function PlanView({ plan }: { plan: RestorePlanView }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-fg-faint">Plan — {plan.total} change(s) · {plan.mode} · nothing applied yet</div>
      {plan.plan.map((s) => (
        <div key={s.section} className="rounded-xl border border-border bg-surface p-3">
          <div className="mb-1 text-sm font-bold text-fg-strong">{s.label} {s.error ? <span className="text-danger-fg-strong">— {s.error}</span> : <span className="text-fg-faint">({s.ops.length})</span>}</div>
          {s.ops.length === 0 && !s.error && <div className="text-xs text-success-fg">In sync — no change.</div>}
          <ul className="space-y-1">
            {s.ops.map((o, i) => <li key={i}><OpRow op={o} /></li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function OpRow({ op }: { op: RestorePlanOp }) {
  const kv = (r?: { fields: Record<string, string> }) => r ? Object.entries(r.fields).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  if (op.blockedNote) return <div className="flex items-start gap-1.5 text-xs text-fg-muted"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>skip <b>{op.key.slice(0, 40)}</b> — {op.blockedNote}</span></div>;
  const Icon = op.kind === 'create' ? PlusCircle : op.kind === 'delete' ? MinusCircle : ArrowRight;
  const cls = op.kind === 'create' ? 'text-success-fg' : op.kind === 'delete' ? 'text-danger-fg-strong' : 'text-warning-fg';
  return (
    <div className="flex items-start gap-1.5 text-xs">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${cls}`} />
      <span className="min-w-0">
        <b className={cls}>{op.kind}</b> <span className="font-mono text-fg-body">{op.key.slice(0, 48)}</span>
        {op.secretChanged && <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-app px-1 text-[10px] text-fg-muted"><Lock className="h-2.5 w-2.5" />secret</span>}
        {op.kind === 'edit' && <span className="block break-all text-fg-faint">{kv(op.before)} → {kv(op.after)}</span>}
        {op.kind !== 'edit' && <span className="block break-all text-fg-faint">{kv(op.after ?? op.before)}</span>}
      </span>
    </div>
  );
}

function ReportView({ report, onReset }: { report: RestoreReport; onReset: () => void }) {
  return (
    <div className={`rounded-xl border p-4 ${report.halted ? 'border-danger-line bg-danger-bg/30' : 'border-success-line bg-success-bg/30'}`}>
      <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body">
        {report.halted ? <OctagonX className="h-4 w-4 text-danger-fg-strong" /> : <CheckCircle2 className="h-4 w-4 text-success-fg" />}
        Restore {report.halted ? 'HALTED' : 'complete'} — {report.applied} applied
      </h3>
      {report.halted && <p className="mt-1 text-sm text-danger-fg-strong">Halted: {report.haltReason}</p>}
      <ul className="mt-2 space-y-1 text-xs">
        {report.results.map((r, i) => (
          <li key={i} className="flex items-center gap-1.5">
            {r.result === 'applied' ? <CheckCircle2 className="h-3.5 w-3.5 text-success-fg" /> : <OctagonX className="h-3.5 w-3.5 text-danger-fg-strong" />}
            <span><b>{r.section}</b> {r.kind} <span className="font-mono">{r.key.slice(0, 32)}</span> → <b>{r.result}</b></span>
          </li>
        ))}
      </ul>
      {report.remaining.length > 0 && <p className="mt-2 text-xs text-fg-muted"><ShieldCheck className="mr-1 inline h-3.5 w-3.5" />{report.remaining.length} op(s) NOT attempted (restore halted, no force): {report.remaining.map((r) => `${r.section}:${r.key.slice(0, 16)}`).join(', ')}</p>}
      <button onClick={onReset} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app"><RotateCcw className="h-4 w-4" /> Done</button>
    </div>
  );
}
