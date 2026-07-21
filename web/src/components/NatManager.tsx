import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, ChevronDown, ChevronUp, KeyRound, Loader2, Pencil, Plus, Power, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../api';
import Select from './Select';
import type { NatRule, NatView } from '../types';

function matchers(r: NatRule): string {
  const p: string[] = [];
  if (r.inInterface) p.push(`in:${r.inInterface}`);
  if (r.inInterfaceList) p.push(`in-list:${r.inInterfaceList}`);
  if (r.outInterface) p.push(`out:${r.outInterface}`);
  if (r.outInterfaceList) p.push(`out-list:${r.outInterfaceList}`);
  if (r.protocol) p.push(r.protocol);
  if (r.srcAddress) p.push(`src:${r.srcAddress}`);
  if (r.srcAddressList) p.push(`src-list:${r.srcAddressList}`);
  if (r.srcPort) p.push(`sport:${r.srcPort}`);
  if (r.dstAddress) p.push(`dst:${r.dstAddress}`);
  if (r.dstAddressList) p.push(`dst-list:${r.dstAddressList}`);
  if (r.dstPort) p.push(`dport:${r.dstPort}`);
  return p.join(' · ') || 'all traffic';
}
function target(r: NatRule): string {
  let t = '';
  if (r.toAddresses) t += `→ ${r.toAddresses}`;
  if (r.toPorts) t += `:${r.toPorts}`;
  return t;
}
function fmtCount(v: number | null): string {
  if (v == null) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

type Draft = Partial<Record<keyof NatRule, string>> & { chain: string; action: string };
const emptyDraft = (chain: string): Draft => ({ chain, action: chain === 'srcnat' ? 'masquerade' : 'dst-nat' });

export default function NatManager({ deviceId }: { deviceId: number }) {
  const [view, setView] = useState<NatView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardMsg, setGuardMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ draft: Draft; id: string | null } | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<NatView>(`/api/devices/${deviceId}/nat`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setGuardMsg(null); setError(null);
    try { const o = await fn() as { result?: string; detail?: string }; if (o?.result === 'rolled_back') setError(`Change auto-rolled back: ${o.detail ?? 'management became unreachable'}.`); await load(); }
    catch (err) {
      const body = err instanceof ApiError ? err.body as { natMgmtGuard?: boolean } | undefined : undefined;
      if (body?.natMgmtGuard) setGuardMsg((err as Error).message);
      else setError((err as Error).message);
    } finally { setBusy(null); }
  }

  const create = (d: Draft) => act('save', async () => { const r = await api.post(`/api/devices/${deviceId}/nat`, d); setEditing(null); return r; });
  const edit = (id: string, d: Draft) => act('save', async () => { const r = await api.patch(`/api/devices/${deviceId}/nat/${encodeURIComponent(id)}`, d); setEditing(null); return r; });
  const toggle = (r: NatRule) => act(`t${r.id}`, () => api.post(`/api/devices/${deviceId}/nat/${encodeURIComponent(r.id)}/enabled`, { disabled: !r.disabled }));
  const del = (r: NatRule) => act(`d${r.id}`, () => api.del(`/api/devices/${deviceId}/nat/${encodeURIComponent(r.id)}`));
  const own = (r: NatRule) => act(`o${r.id}`, () => api.post(`/api/devices/${deviceId}/nat/${encodeURIComponent(r.id)}/take-ownership`, {}));
  const move = (r: NatRule, destId: string | null) => act(`m${r.id}`, () => api.post(`/api/devices/${deviceId}/nat/${encodeURIComponent(r.id)}/move`, { destId }));

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load NAT rules: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;

  const chains: Array<{ key: string; label: string }> = [
    { key: 'dstnat', label: 'destination NAT — port-forwarding, redirect' },
    { key: 'srcnat', label: 'source NAT — masquerade, src-nat' },
  ];

  return (
    <div>
      <div className="mb-3 flex items-start gap-2 rounded-lg bg-info-bg px-3 py-2.5 text-sm text-info-fg">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>RubyMIK reaches this router on <b>{view.mgmt.mgmtScheme}:{view.mgmt.mgmtPort}</b> at <b>{view.mgmt.mgmtIp}</b>{view.mgmt.mgmtInterface ? <> via <b>{view.mgmt.mgmtInterface}</b></> : null}. A rule that would steal that management socket or break its return path is refused; everything else rides the dead-man (verify-reachable-then-commit) and is snapshotted pre/post.</span>
      </div>
      {guardMsg && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning-line bg-warning-bg px-3 py-2.5 text-sm text-warning-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span><b>Refused by the NAT management guard.</b> {guardMsg}</span>
          <button onClick={() => setGuardMsg(null)} className="ml-auto rounded p-0.5 hover:bg-warning-line/40"><X className="h-4 w-4" /></button>
        </div>
      )}
      {error && <div className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

      {chains.map(({ key, label }) => {
        const rules = view.rules.filter((r) => r.chain === key);
        return (
          <div key={key} className="mb-5">
            <div className="mb-2 flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4 text-fg-faint" />
              <h4 className="text-sm font-bold uppercase tracking-wide text-fg-dim">{key}</h4>
              <span className="text-xs text-fg-faint">{label}</span>
              {view.manageable && (
                <button onClick={() => setEditing({ draft: emptyDraft(key), id: null })}
                  className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border-strong px-2.5 py-1 text-xs font-semibold text-fg-body hover:border-accent-border hover:text-accent-text">
                  <Plus className="h-3.5 w-3.5" /> Add {key} rule
                </button>
              )}
            </div>
            {rules.length === 0 ? (
              <div className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-dim">No {key} rules.</div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border-subtle">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-subtle bg-sunken text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
                      <th className="px-2 py-2 w-8">#</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Match</th>
                      <th className="px-3 py-2">Target</th><th className="px-3 py-2 text-right">Pkts</th><th className="px-3 py-2 text-right">Bytes</th>
                      <th className="px-3 py-2">Owner</th><th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((r, i) => (
                      <tr key={r.id} className={`border-b border-border-subtle text-fg-body ${r.disabled ? 'opacity-45' : ''}`}>
                        <td className="px-2 py-2 tabular-nums text-fg-faint">{r.order}</td>
                        <td className="px-3 py-2">
                          <span className="font-mono text-[12px] font-semibold text-fg">{r.action}</span>
                          {r.dynamic && <span className="ml-1.5 rounded-full bg-app px-1.5 py-0.5 text-[10px] font-semibold text-fg-dim">dynamic</span>}
                          {r.invalid && <span className="ml-1.5 rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] font-semibold text-warning-fg">invalid</span>}
                          {r.comment && <div className="mt-0.5 text-[11px] text-fg-faint">{r.comment}</div>}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] text-fg-dim">{matchers(r)}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-fg-dim">{target(r) || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-fg-dim">{fmtCount(r.packets)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-fg-dim">{fmtCount(r.bytes)}</td>
                        <td className="px-3 py-2">{r.managed
                          ? <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-semibold text-accent-text">RUBYMIK</span>
                          : <span className="rounded-full bg-app px-2 py-0.5 text-[10px] font-semibold text-fg-dim">unmanaged</span>}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-0.5">
                            {view.manageable && !r.dynamic && (r.managed ? (<>
                              <IconBtn title="Move up" disabled={i === 0 || busy != null} onClick={() => move(r, rules[i - 1]!.id)} busy={busy === `m${r.id}`}><ChevronUp className="h-4 w-4" /></IconBtn>
                              <IconBtn title="Move down" disabled={i === rules.length - 1 || busy != null} onClick={() => move(r, rules[i + 2]?.id ?? null)} busy={busy === `m${r.id}`}><ChevronDown className="h-4 w-4" /></IconBtn>
                              <IconBtn title={r.disabled ? 'Enable' : 'Disable'} onClick={() => toggle(r)} busy={busy === `t${r.id}`}><Power className={`h-4 w-4 ${r.disabled ? '' : 'text-success-fg'}`} /></IconBtn>
                              <IconBtn title="Edit" onClick={() => setEditing({ draft: { ...r } as unknown as Draft, id: r.id })}><Pencil className="h-4 w-4" /></IconBtn>
                              <IconBtn title="Delete" onClick={() => del(r)} busy={busy === `d${r.id}`} danger><Trash2 className="h-4 w-4" /></IconBtn>
                            </>) : (
                              <IconBtn title="Take ownership to edit" onClick={() => own(r)} busy={busy === `o${r.id}`}><KeyRound className="h-4 w-4" /></IconBtn>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {editing && <RuleBuilder draft={editing.draft} id={editing.id} busy={busy === 'save'}
        onClose={() => setEditing(null)} onSubmit={(d) => editing.id ? edit(editing.id, d) : create(d)} />}
    </div>
  );
}

function IconBtn({ children, title, onClick, disabled, busy, danger }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; busy?: boolean; danger?: boolean }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled || busy}
      className={`rounded-md p-1.5 text-fg-faint transition disabled:opacity-30 ${danger ? 'hover:bg-danger-bg hover:text-danger-fg' : 'hover:bg-app hover:text-fg-body'}`}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : children}
    </button>
  );
}

const F = ['inInterface', 'outInterface', 'srcAddress', 'dstAddress', 'protocol', 'srcPort', 'dstPort', 'toAddresses', 'toPorts', 'comment'] as const;
const LABEL: Record<string, string> = { inInterface: 'in-interface', outInterface: 'out-interface', srcAddress: 'src-address', dstAddress: 'dst-address', protocol: 'protocol (tcp/udp)', srcPort: 'src-port', dstPort: 'dst-port', toAddresses: 'to-addresses', toPorts: 'to-ports', comment: 'comment' };
const ACTIONS: Record<string, string[]> = { srcnat: ['masquerade', 'src-nat', 'netmap', 'accept'], dstnat: ['dst-nat', 'redirect', 'netmap', 'accept'] };

function RuleBuilder({ draft, id, busy, onClose, onSubmit }: { draft: Draft; id: string | null; busy: boolean; onClose: () => void; onSubmit: (d: Draft) => void }) {
  const [d, setD] = useState<Draft>(draft);
  const set = (k: string, v: string) => setD((c) => ({ ...c, [k]: v }));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-auto rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-fg-strong">{id ? 'Edit' : 'New'} NAT rule</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-xs font-semibold text-fg-dim">Chain
            <Select value={d.chain} onChange={(v) => setD((c) => ({ ...c, chain: v, action: ACTIONS[v]![0]! }))} className="mt-1 w-full" ariaLabel="Chain"
              options={[{ value: 'dstnat', label: 'dstnat' }, { value: 'srcnat', label: 'srcnat' }]} />
          </label>
          <label className="text-xs font-semibold text-fg-dim">Action
            <Select value={d.action} onChange={(v) => set('action', v)} className="mt-1 w-full" ariaLabel="Action"
              options={ACTIONS[d.chain]!.map((a) => ({ value: a, label: a }))} />
          </label>
          {F.map((k) => (
            <label key={k} className={`text-xs font-semibold text-fg-dim ${k === 'comment' ? 'col-span-2' : ''}`}>{LABEL[k]}
              <input value={(d as Record<string, string>)[k] ?? ''} onChange={(e) => set(k, e.target.value)} placeholder=""
                className="mt-1 w-full rounded-lg border border-border-strong bg-app px-2.5 py-2 text-sm text-fg-body" />
            </label>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>
          <button onClick={() => onSubmit(d)} disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {id ? 'Save changes' : 'Create rule'}
          </button>
        </div>
      </div>
    </div>
  );
}
