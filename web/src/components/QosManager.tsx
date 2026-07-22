import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Gauge, KeyRound, Loader2, Pencil, Plus, Power, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../api';
import Select from './Select';
import type { SimpleQueue, QosView } from '../types';

function rate(r: SimpleQueue): string {
  if (!r.rate) return '—';
  const [u, d] = r.rate.split('/');
  const f = (v?: string) => { const n = Number(v); return !Number.isFinite(n) || n === 0 ? '0' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n); };
  return `↑${f(u)} ↓${f(d)} bps`;
}

type Draft = Partial<Record<string, string>> & { name: string };

export default function QosManager({ deviceId }: { deviceId: number }) {
  const [view, setView] = useState<QosView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardMsg, setGuardMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ draft: Draft; id: string | null } | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<QosView>(`/api/devices/${deviceId}/qos`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setGuardMsg(null); setError(null);
    try { const o = await fn() as { result?: string; detail?: string }; if (o?.result === 'rolled_back') setError(`Change auto-rolled back: ${o.detail ?? 'management strangled / unreachable'}.`); await load(); }
    catch (err) {
      const body = err instanceof ApiError ? err.body as { queueMgmtGuard?: boolean } | undefined : undefined;
      if (body?.queueMgmtGuard) setGuardMsg((err as Error).message); else setError((err as Error).message);
    } finally { setBusy(null); }
  }

  const save = (d: Draft, id: string | null) => act('save', async () => { const r = id ? await api.patch(`/api/devices/${deviceId}/qos/${encodeURIComponent(id)}`, d) : await api.post(`/api/devices/${deviceId}/qos`, d); setEditing(null); return r; });
  const toggle = (q: SimpleQueue) => act(`t${q.id}`, () => api.post(`/api/devices/${deviceId}/qos/${encodeURIComponent(q.id)}/enabled`, { disabled: !q.disabled }));
  const del = (q: SimpleQueue) => act(`d${q.id}`, () => api.del(`/api/devices/${deviceId}/qos/${encodeURIComponent(q.id)}`));
  const own = (q: SimpleQueue) => act(`o${q.id}`, () => api.post(`/api/devices/${deviceId}/qos/${encodeURIComponent(q.id)}/take-ownership`, {}));
  const move = (q: SimpleQueue, destId: string | null) => act(`m${q.id}`, () => api.post(`/api/devices/${deviceId}/qos/${encodeURIComponent(q.id)}/move`, { destId }));

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load queues: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;

  return (
    <div>
      <div className="mb-3 flex items-start gap-2 rounded-lg bg-info-bg px-3 py-2.5 text-sm text-info-fg">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>RubyMIK reaches this router on <b>{view.mgmt.mgmtScheme}:{view.mgmt.mgmtPort}</b> at <b>{view.mgmt.mgmtIp}</b>{view.mgmt.mgmtInterface ? <> via <b>{view.mgmt.mgmtInterface}</b></> : null}. A queue that would <b>strangle</b> that management flow (target = the mgmt IP/interface with a tiny max-limit) is refused; broader shaping rides the dead-man — which now also checks <b>latency</b>, not just reachability, so a slow-strangle auto-rolls-back.</span>
      </div>
      {guardMsg && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning-line bg-warning-bg px-3 py-2.5 text-sm text-warning-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span><b>Refused by the QoS management guard.</b> {guardMsg}</span>
          <button onClick={() => setGuardMsg(null)} className="ml-auto rounded p-0.5 hover:bg-warning-line/40"><X className="h-4 w-4" /></button>
        </div>
      )}
      {error && <div className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

      <div className="mb-2 flex items-center gap-2">
        <Gauge className="h-4 w-4 text-fg-faint" />
        <h4 className="text-sm font-bold uppercase tracking-wide text-fg-dim">Simple queues</h4>
        <span className="text-xs text-fg-faint">per-target rate limits · order-sensitive</span>
        {view.manageable && (
          <button onClick={() => setEditing({ draft: { name: '' }, id: null })}
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border-strong px-2.5 py-1 text-xs font-semibold text-fg-body hover:border-accent-border hover:text-accent-text">
            <Plus className="h-3.5 w-3.5" /> Add queue
          </button>
        )}
      </div>

      {view.queues.length === 0 ? (
        <div className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-dim">No simple queues.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle bg-sunken text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
                <th className="px-2 py-2 w-8">#</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Max-limit</th><th className="px-3 py-2">Live rate</th><th className="px-3 py-2">Owner</th><th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {view.queues.map((q, i) => (
                <tr key={q.id} className={`border-b border-border-subtle text-fg-body ${q.disabled ? 'opacity-45' : ''}`}>
                  <td className="px-2 py-2 tabular-nums text-fg-faint">{q.order}</td>
                  <td className="px-3 py-2">
                    <span className="font-medium text-fg">{q.name}</span>
                    {q.dynamic && <span className="ml-1.5 rounded-full bg-app px-1.5 py-0.5 text-[10px] font-semibold text-fg-dim">dynamic</span>}
                    {q.invalid && <span className="ml-1.5 rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] font-semibold text-warning-fg">invalid</span>}
                    {q.comment && <div className="mt-0.5 text-[11px] text-fg-faint">{q.comment}</div>}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-fg-dim">{q.target ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-fg-dim">{q.maxLimit ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-fg-dim">{rate(q)}</td>
                  <td className="px-3 py-2">{q.managed
                    ? <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-semibold text-accent-text">RUBYMIK</span>
                    : <span className="rounded-full bg-app px-2 py-0.5 text-[10px] font-semibold text-fg-dim">unmanaged</span>}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-0.5">
                      {view.manageable && !q.dynamic && (q.managed ? (<>
                        <IconBtn title="Move up" disabled={i === 0 || busy != null} onClick={() => move(q, view.queues[i - 1]!.id)} busy={busy === `m${q.id}`}><ChevronUp className="h-4 w-4" /></IconBtn>
                        <IconBtn title="Move down" disabled={i === view.queues.length - 1 || busy != null} onClick={() => move(q, view.queues[i + 2]?.id ?? null)} busy={busy === `m${q.id}`}><ChevronDown className="h-4 w-4" /></IconBtn>
                        <IconBtn title={q.disabled ? 'Enable' : 'Disable'} onClick={() => toggle(q)} busy={busy === `t${q.id}`}><Power className={`h-4 w-4 ${q.disabled ? '' : 'text-success-fg'}`} /></IconBtn>
                        <IconBtn title="Edit" onClick={() => setEditing({ draft: draftFrom(q), id: q.id })}><Pencil className="h-4 w-4" /></IconBtn>
                        <IconBtn title="Delete" onClick={() => del(q)} busy={busy === `d${q.id}`} danger><Trash2 className="h-4 w-4" /></IconBtn>
                      </>) : (
                        <IconBtn title="Take ownership to edit" onClick={() => own(q)} busy={busy === `o${q.id}`}><KeyRound className="h-4 w-4" /></IconBtn>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-fg-faint">The <b>queue tree</b> (marks + mangle) is intentionally out of scope here — it's a different complexity class and isn't editable from RubyMIK yet.</p>

      {editing && <QueueBuilder draft={editing.draft} id={editing.id} busy={busy === 'save'}
        parents={view.queues.map((q) => q.name).filter((n): n is string => !!n)}
        onClose={() => setEditing(null)} onSubmit={(d) => save(d, editing.id)} />}
    </div>
  );
}

function draftFrom(q: SimpleQueue): Draft {
  const [mu, md] = (q.maxLimit ?? '').split('/'); const [lu, ld] = (q.limitAt ?? '').split('/');
  return { name: q.name, target: q.target ?? '', maxLimitUp: mu ?? '', maxLimitDown: md ?? '', limitAtUp: lu ?? '', limitAtDown: ld ?? '', priority: q.priority ?? '', parent: q.parent ?? '', queueType: q.queueType ?? '', comment: q.comment ?? '' };
}

function IconBtn({ children, title, onClick, disabled, busy, danger }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; busy?: boolean; danger?: boolean }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled || busy}
      className={`rounded-md p-1.5 text-fg-faint transition disabled:opacity-30 ${danger ? 'hover:bg-danger-bg hover:text-danger-fg' : 'hover:bg-app hover:text-fg-body'}`}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : children}
    </button>
  );
}

const FIELDS: Array<{ k: string; label: string; ph: string; wide?: boolean }> = [
  { k: 'name', label: 'name', ph: 'guest-shaper' },
  { k: 'target', label: 'target (address/CIDR or interface)', ph: '192.168.88.0/24' },
  { k: 'maxLimitUp', label: 'max-limit up', ph: '10M' }, { k: 'maxLimitDown', label: 'max-limit down', ph: '10M' },
  { k: 'limitAtUp', label: 'limit-at up', ph: '' }, { k: 'limitAtDown', label: 'limit-at down', ph: '' },
  { k: 'priority', label: 'priority (1–8)', ph: '8' }, { k: 'parent', label: 'parent', ph: '' },
  { k: 'queueType', label: 'queue type (default profiles)', ph: 'default' }, { k: 'comment', label: 'comment', ph: '', wide: true },
];
// RouterOS default queue-type profiles (a knowable set; the router also allows custom
// profiles, so the current value is preserved even when it isn't one of these).
const QUEUE_TYPES = ['default', 'default-small', 'ethernet-default', 'wireless-default', 'synchronous-default', 'hotspot-default', 'pcq-upload-default', 'pcq-download-default', 'only-hardware-queue', 'multi-queue-ethernet-default'];
const PRIORITIES = ['1', '2', '3', '4', '5', '6', '7', '8'];
function selOpts(known: string[], current: string, blankLabel: string) {
  const opts = [{ value: '', label: blankLabel }, ...known.map((n) => ({ value: n, label: n }))];
  if (current && !known.includes(current)) opts.push({ value: current, label: `${current} (not listed)` });
  return opts;
}

function QueueBuilder({ draft, id, busy, parents, onClose, onSubmit }: { draft: Draft; id: string | null; busy: boolean; parents: string[]; onClose: () => void; onSubmit: (d: Draft) => void }) {
  const [d, setD] = useState<Draft>(draft);
  const set = (k: string, v: string) => setD((c) => ({ ...c, [k]: v }));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-auto rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-fg-strong">{id ? 'Edit' : 'New'} simple queue</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {FIELDS.map((f) => {
            const cls = `text-xs font-semibold text-fg-dim ${f.wide ? 'col-span-2' : ''}`;
            const v = d[f.k] ?? '';
            if (f.k === 'priority' || f.k === 'parent' || f.k === 'queueType') {
              const known = f.k === 'priority' ? PRIORITIES : f.k === 'parent' ? parents : QUEUE_TYPES;
              const blank = f.k === 'parent' ? '(none — top level)' : f.k === 'priority' ? '(default 8)' : '(default)';
              return (
                <label key={f.k} className={cls}>{f.label}
                  <Select value={v} onChange={(val) => set(f.k, val)} className="mt-1 w-full" ariaLabel={f.label}
                    placeholder={blank} options={selOpts(known, v, blank)} />
                </label>
              );
            }
            return (
              <label key={f.k} className={cls}>{f.label}
                <input value={v} onChange={(e) => set(f.k, e.target.value)} placeholder={f.ph}
                  className="mt-1 w-full rounded-lg border border-border-strong bg-app px-2.5 py-2 text-sm text-fg-body" />
              </label>
            );
          })}
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>
          <button onClick={() => onSubmit(d)} disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {id ? 'Save changes' : 'Create queue'}
          </button>
        </div>
      </div>
    </div>
  );
}
