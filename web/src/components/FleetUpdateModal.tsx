import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, OctagonX, Play, RefreshCw, Rocket, X } from 'lucide-react';
import { api } from '../api';

/**
 * P35 — fleet update orchestrator UI. Previews the plan (canary → batches, with
 * excluded devices + why), then rehearses it as a DRY-RUN: the real orchestration
 * runs against the live plan without contacting a single router, so you can see the
 * canary-gate, batching, halt-on-failure and abort behaviour before doing it for
 * real. Live orchestrated execution is attended (per device, via Router Admin).
 */
interface PlanItem { id: number; name: string; installed: string | null; latest: string | null }
interface Plan { canary: PlanItem[]; batches: PlanItem[][]; excluded: Array<{ id: number; name: string; reason: string }>; total: number }
interface RunTarget { id: number; name: string; stage: 'canary' | 'batch'; batch: number; status: 'queued' | 'updating' | 'done' | 'failed' | 'skipped'; detail?: string }
interface RunState { id: string; phase: 'running' | 'done' | 'halted' | 'aborted'; targets: RunTarget[]; log: string[] }

const STATUS_CLS: Record<string, string> = {
  queued: 'text-fg-faint', updating: 'text-accent-text', done: 'text-success-fg', failed: 'text-danger-fg-strong', skipped: 'text-fg-muted',
};

export default function FleetUpdateModal({ onClose }: { onClose: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [simFail, setSimFail] = useState(false);
  const [run, setRun] = useState<RunState | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadPlan = useCallback(async () => {
    setLoading(true); setError(null);
    try { const r = await api.post<{ plan: Plan }>('/api/fleet/update/plan', {}); setPlan(r.plan); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void loadPlan(); return () => { if (timer.current) clearInterval(timer.current); }; }, [loadPlan]);

  const poll = useCallback((id: string) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const st = await api.get<RunState>(`/api/fleet/update/run/${id}`);
        setRun(st);
        if (st.phase !== 'running' && timer.current) { clearInterval(timer.current); timer.current = null; }
      } catch { /* keep last */ }
    }, 500);
  }, []);

  async function rehearse() {
    setError(null); setRun(null);
    try {
      const body: Record<string, unknown> = { dryRun: true };
      if (simFail && plan?.canary[0]) body.simFailIds = [plan.canary[0].id]; // demonstrate halt on the canary
      const r = await api.post<{ runId: string }>('/api/fleet/update/run', body);
      setRunId(r.runId); poll(r.runId);
    } catch (e) { setError((e as Error).message); }
  }
  async function abort() { if (runId) { try { await api.post(`/api/fleet/update/run/${runId}/abort`, {}); } catch { /* ignore */ } } }

  const running = run?.phase === 'running';
  const phaseMeta: Record<string, { cls: string; label: string; Icon: typeof CheckCircle2 }> = {
    running: { cls: 'bg-accent-subtle text-accent-text', label: 'Rehearsing…', Icon: Loader2 },
    done: { cls: 'bg-success-bg text-success-fg-strong', label: 'Rehearsal complete', Icon: CheckCircle2 },
    halted: { cls: 'bg-danger-bg text-danger-fg-strong', label: 'Halted on failure', Icon: OctagonX },
    aborted: { cls: 'bg-app text-fg-muted', label: 'Aborted', Icon: OctagonX },
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2"><Rocket className="h-5 w-5 text-accent" /><h3 className="text-base font-bold text-fg-strong">Fleet update</h3></div>
          <button onClick={onClose} className="rounded-lg p-1 text-fg-faint hover:bg-app"><X className="h-4 w-4" /></button>
        </div>
        <p className="mt-1 text-sm text-fg-dim">
          Update RouterOS across the fleet with a canary first, then batches, halting if a device doesn’t come back.
          Rehearse it as a <b>dry-run</b> (no router is touched); the real install stays per-device and attended.
        </p>

        {error && <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}
        {loading && <div className="mt-4 h-24 animate-pulse rounded-lg bg-app" />}

        {plan && !run && (
          <div className="mt-4 space-y-3">
            {plan.total === 0 ? (
              <div className="rounded-lg bg-sunken px-3 py-3 text-sm text-fg-muted">No reachable, manageable device has an available update. Run “Check for updates” on individual devices first.</div>
            ) : (
              <>
                <StageBlock title={`Canary (${plan.canary.length})`} items={plan.canary} />
                {plan.batches.map((b, i) => <StageBlock key={i} title={`Batch ${i + 1} (${b.length})`} items={b} />)}
              </>
            )}
            {plan.excluded.length > 0 && (
              <details className="rounded-lg border border-border bg-sunken px-3 py-2 text-xs text-fg-muted">
                <summary className="cursor-pointer font-semibold">Excluded ({plan.excluded.length})</summary>
                <ul className="mt-2 space-y-1">{plan.excluded.map((e) => <li key={e.id}>{e.name} — {e.reason}</li>)}</ul>
              </details>
            )}
          </div>
        )}

        {run && (
          <div className="mt-4 space-y-3">
            {run.phase && (() => { const m = phaseMeta[run.phase]; const Icon = m.Icon; return (
              <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold ${m.cls}`}>
                <Icon className={`h-3.5 w-3.5 ${run.phase === 'running' ? 'animate-spin' : ''}`} /> {m.label}
              </div>
            ); })()}
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <tbody>
                  {run.targets.map((t) => (
                    <tr key={t.id} className="border-b border-border-subtle last:border-0">
                      <td className="px-3 py-1.5 font-medium text-fg-body">{t.name}</td>
                      <td className="px-3 py-1.5 text-xs text-fg-faint">{t.stage === 'canary' ? 'canary' : `batch ${t.batch}`}</td>
                      <td className={`px-3 py-1.5 text-right text-xs font-semibold ${STATUS_CLS[t.status]}`}>
                        {t.status === 'updating' && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}{t.status}{t.detail ? ` · ${t.detail}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <pre className="max-h-32 overflow-auto rounded-lg bg-app p-2 font-mono text-[11px] leading-4 text-fg-body">{run.log.join('\n')}</pre>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-fg-dim">
            <input type="checkbox" checked={simFail} onChange={(e) => setSimFail(e.target.checked)} disabled={running} />
            Simulate a canary failure (show halt)
          </label>
          <div className="flex gap-2">
            {!run && <button onClick={() => void loadPlan()} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-sunken"><RefreshCw className="h-4 w-4" /> Re-scan</button>}
            {running ? (
              <button onClick={() => void abort()} className="inline-flex items-center gap-1.5 rounded-lg border border-danger-line px-3.5 py-2 text-sm font-semibold text-danger-fg-strong hover:bg-danger-bg"><OctagonX className="h-4 w-4" /> Abort</button>
            ) : run ? (
              <button onClick={() => { setRun(null); setRunId(null); void loadPlan(); }} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover"><Play className="h-4 w-4" /> Rehearse again</button>
            ) : (
              <button disabled={!plan || plan.total === 0} onClick={() => void rehearse()} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50"><Play className="h-4 w-4" /> Dry-run rehearsal</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StageBlock({ title, items }: { title: string; items: PlanItem[] }) {
  return (
    <div className="rounded-lg border border-border bg-sunken px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-fg-dim"><AlertTriangle className="h-3.5 w-3.5" /> {title}</div>
      <ul className="space-y-0.5 text-sm">
        {items.map((it) => <li key={it.id} className="flex justify-between text-fg-body"><span>{it.name}</span><span className="font-mono text-xs text-fg-faint">{it.installed ?? '?'} → {it.latest ?? '?'}</span></li>)}
      </ul>
    </div>
  );
}
