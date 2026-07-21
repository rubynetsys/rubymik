import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, Pencil, Plus, Plug, Power, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../api';
import type { PppoeClient, PppoeView } from '../types';

const STATUS: Record<string, { label: string; cls: string; dot: string }> = {
  running: { label: 'running', cls: 'bg-success-bg text-success-fg', dot: 'bg-success-fg' },
  connecting: { label: 'connecting…', cls: 'bg-warning-bg text-warning-fg', dot: 'bg-warning-fg animate-pulse' },
  disabled: { label: 'disabled', cls: 'bg-app text-fg-dim', dot: 'bg-fg-faint' },
};
function statusOf(c: PppoeClient) {
  if (c.disabled) return STATUS.disabled;
  if (c.running) return STATUS.running;
  return { label: c.lastError ? `down · ${c.lastError}` : 'connecting…', cls: c.lastError ? 'bg-danger-bg text-danger-fg' : 'bg-warning-bg text-warning-fg', dot: c.lastError ? 'bg-danger-fg' : 'bg-warning-fg animate-pulse' };
}

interface Draft {
  name: string; interface?: string; user?: string; password?: string; serviceName?: string;
  defaultRouteDistance?: string; allow?: string; comment?: string; addDefaultRoute?: boolean; usePeerDns?: boolean;
}
type StrKey = 'name' | 'interface' | 'user' | 'password' | 'serviceName' | 'defaultRouteDistance' | 'allow' | 'comment';

export default function PppoeManager({ deviceId }: { deviceId: number }) {
  const [view, setView] = useState<PppoeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardMsg, setGuardMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ draft: Draft; id: string | null } | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<PppoeView>(`/api/devices/${deviceId}/pppoe`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 6000); return () => clearInterval(t); }, [load]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setGuardMsg(null); setError(null);
    try { const o = await fn() as { result?: string; detail?: string }; if (o?.result === 'rolled_back') setError(`Change auto-rolled back: ${o.detail ?? 'management path lost'}.`); await load(); }
    catch (err) {
      const body = err instanceof ApiError ? err.body as { pppoeMgmtGuard?: boolean } | undefined : undefined;
      if (body?.pppoeMgmtGuard) setGuardMsg((err as Error).message); else setError((err as Error).message);
    } finally { setBusy(null); }
  }
  const save = (d: Draft, id: string | null) => act('save', async () => { const r = id ? await api.patch(`/api/devices/${deviceId}/pppoe/${encodeURIComponent(id)}`, d) : await api.post(`/api/devices/${deviceId}/pppoe`, d); setEditing(null); return r; });
  const toggle = (c: PppoeClient) => act(`t${c.id}`, () => api.post(`/api/devices/${deviceId}/pppoe/${encodeURIComponent(c.id)}/enabled`, { disabled: !c.disabled }));
  const del = (c: PppoeClient) => act(`d${c.id}`, () => api.del(`/api/devices/${deviceId}/pppoe/${encodeURIComponent(c.id)}`));
  const own = (c: PppoeClient) => act(`o${c.id}`, () => api.post(`/api/devices/${deviceId}/pppoe/${encodeURIComponent(c.id)}/take-ownership`, {}));

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load PPPoE clients: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;

  return (
    <div>
      <div className="mb-3 flex items-start gap-2 rounded-lg bg-info-bg px-3 py-2.5 text-sm text-info-fg">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>RubyMIK reaches this router at <b>{view.mgmt.mgmtIp}</b>{view.mgmt.mgmtInterface ? <> via <b>{view.mgmt.mgmtInterface}</b></> : null}. A PPPoE client on the management port — or deleting/disabling the client the management path rides — is refused; a WAN swap that management depends on must go through <b>Replace WAN</b> (add-before-remove).</span>
      </div>
      {guardMsg && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning-line bg-warning-bg px-3 py-2.5 text-sm text-warning-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span><b>Refused by the PPPoE management guard.</b> {guardMsg}</span>
          <button onClick={() => setGuardMsg(null)} className="ml-auto rounded p-0.5 hover:bg-warning-line/40"><X className="h-4 w-4" /></button>
        </div>
      )}
      {error && <div className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

      <div className="mb-2 flex items-center gap-2">
        <Plug className="h-4 w-4 text-fg-faint" />
        <h4 className="text-sm font-bold uppercase tracking-wide text-fg-dim">PPPoE clients</h4>
        <span className="text-xs text-fg-faint">WAN dial-up sessions</span>
        {view.manageable && (
          <button onClick={() => setEditing({ draft: { name: 'pppoe-wan', addDefaultRoute: true }, id: null })}
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border-strong px-2.5 py-1 text-xs font-semibold text-fg-body hover:border-accent-border hover:text-accent-text">
            <Plus className="h-3.5 w-3.5" /> Add PPPoE client
          </button>
        )}
      </div>

      {view.clients.length === 0 ? (
        <div className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-dim">No PPPoE clients.</div>
      ) : (
        <div className="space-y-2.5">
          {view.clients.map((c) => {
            const st = statusOf(c);
            return (
              <div key={c.id} className={`rounded-lg border border-border-subtle p-3 ${c.disabled ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${st.dot}`} />
                  <span className="font-semibold text-fg">{c.name}</span>
                  <span className="font-mono text-[11px] text-fg-faint">over {c.interface ?? '?'}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${st.cls}`}>{st.label}</span>
                  {c.isMgmtPath && <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-inverse">MGMT PATH</span>}
                  {c.managed
                    ? <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-semibold text-accent-text">RUBYMIK</span>
                    : <span className="rounded-full bg-app px-2 py-0.5 text-[10px] font-semibold text-fg-dim">unmanaged</span>}
                  <div className="ml-auto flex items-center gap-0.5">
                    {view.manageable && !c.dynamic && (c.managed ? (<>
                      <IconBtn title={c.disabled ? 'Enable' : 'Disable'} onClick={() => toggle(c)} busy={busy === `t${c.id}`}><Power className={`h-4 w-4 ${c.disabled ? '' : 'text-success-fg'}`} /></IconBtn>
                      <IconBtn title="Edit" onClick={() => setEditing({ draft: draftFrom(c), id: c.id })}><Pencil className="h-4 w-4" /></IconBtn>
                      <IconBtn title="Delete" onClick={() => del(c)} busy={busy === `d${c.id}`} danger><Trash2 className="h-4 w-4" /></IconBtn>
                    </>) : (
                      <IconBtn title="Take ownership to edit" onClick={() => own(c)} busy={busy === `o${c.id}`}><KeyRound className="h-4 w-4" /></IconBtn>
                    ))}
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] text-fg-dim sm:grid-cols-4">
                  <Field k="user" v={c.user} /><Field k="password" v={c.hasPassword ? '••••••••' : '—'} />
                  <Field k="local addr" v={c.localAddress} /><Field k="remote addr" v={c.remoteAddress} />
                  <Field k="uptime" v={c.uptime} /><Field k="MTU" v={c.actualMtu} />
                  <Field k="default route" v={c.addDefaultRoute ? `yes (dist ${c.defaultRouteDistance ?? '1'})` : 'no'} />
                  <Field k="peer DNS" v={c.usePeerDns ? 'yes' : 'no'} />
                </div>
                {c.comment && <div className="mt-1 text-[11px] text-fg-faint">{c.comment}</div>}
                {c.addDefaultRoute && <div className="mt-2 rounded bg-sunken px-2 py-1.5 text-[11px] text-fg-dim">Adds a default route (see the <b>Routes</b> tab). If this becomes your WAN, a masquerade out-interface may need updating — check the <b>NAT</b> tab.</div>}
              </div>
            );
          })}
        </div>
      )}

      {editing && <PppoeBuilder draft={editing.draft} id={editing.id} busy={busy === 'save'} onClose={() => setEditing(null)} onSubmit={(d) => save(d, editing.id)} />}
    </div>
  );
}

function Field({ k, v }: { k: string; v: string | null }) {
  return <div><span className="text-fg-faint">{k}: </span><span className="font-mono text-fg-body">{v ?? '—'}</span></div>;
}
function draftFrom(c: PppoeClient): Draft {
  return { name: c.name, interface: c.interface ?? '', user: c.user ?? '', serviceName: c.serviceName ?? '', defaultRouteDistance: c.defaultRouteDistance ?? '', allow: c.allow ?? '', comment: c.comment ?? '', addDefaultRoute: c.addDefaultRoute, usePeerDns: c.usePeerDns };
}
function IconBtn({ children, title, onClick, busy, danger }: { children: React.ReactNode; title: string; onClick: () => void; busy?: boolean; danger?: boolean }) {
  return <button title={title} onClick={onClick} disabled={busy} className={`rounded-md p-1.5 text-fg-faint transition disabled:opacity-30 ${danger ? 'hover:bg-danger-bg hover:text-danger-fg' : 'hover:bg-app hover:text-fg-body'}`}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : children}</button>;
}

function PppoeBuilder({ draft, id, busy, onClose, onSubmit }: { draft: Draft; id: string | null; busy: boolean; onClose: () => void; onSubmit: (d: Draft) => void }) {
  const [d, setD] = useState<Draft>(draft);
  const set = (k: StrKey, v: string) => setD((c) => ({ ...c, [k]: v }));
  const setB = (k: 'addDefaultRoute' | 'usePeerDns', v: boolean) => setD((c) => ({ ...c, [k]: v }));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-auto rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-fg-strong">{id ? 'Edit' : 'New'} PPPoE client</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Inp label="name" v={d.name} onChange={(v) => set('name', v)} ph="pppoe-wan" />
          <Inp label="parent interface" v={d.interface ?? ''} onChange={(v) => set('interface', v)} ph="ether5" />
          <Inp label="user" v={d.user ?? ''} onChange={(v) => set('user', v)} ph="p24test" />
          <Inp label="password" v={d.password ?? ''} onChange={(v) => set('password', v)} ph={id ? 'leave blank to keep' : '••••••'} type="password" />
          <Inp label="service-name (opt)" v={d.serviceName ?? ''} onChange={(v) => set('serviceName', v)} ph="" />
          <Inp label="default-route-distance" v={d.defaultRouteDistance ?? ''} onChange={(v) => set('defaultRouteDistance', v)} ph="1" />
          <Inp label="allow (auth)" v={d.allow ?? ''} onChange={(v) => set('allow', v)} ph="pap,chap,mschap1,mschap2" wide />
          <Inp label="comment" v={d.comment ?? ''} onChange={(v) => set('comment', v)} ph="" wide />
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-fg-body">
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={!!d.addDefaultRoute} onChange={(e) => setB('addDefaultRoute', e.target.checked)} className="h-4 w-4 accent-accent" /> add-default-route</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={!!d.usePeerDns} onChange={(e) => setB('usePeerDns', e.target.checked)} className="h-4 w-4 accent-accent" /> use-peer-dns</label>
        </div>
        {d.addDefaultRoute && <div className="mt-3 rounded-lg bg-sunken px-3 py-2 text-xs text-fg-dim">This adds a default route via the PPPoE link. RubyMIK won't auto-edit NAT — if this is your WAN, review masquerade out-interface on the NAT tab.</div>}
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>
          <button onClick={() => onSubmit(d)} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {id ? 'Save changes' : 'Create client'}
          </button>
        </div>
      </div>
    </div>
  );
}
function Inp({ label, v, onChange, ph, type, wide }: { label: string; v: string; onChange: (v: string) => void; ph?: string; type?: string; wide?: boolean }) {
  return (
    <label className={`text-xs font-semibold text-fg-dim ${wide ? 'col-span-2' : ''}`}>{label}
      <input type={type ?? 'text'} value={v} onChange={(e) => onChange(e.target.value)} placeholder={ph}
        className="mt-1 w-full rounded-lg border border-border-strong bg-app px-2.5 py-2 text-sm text-fg-body" autoComplete="off" />
    </label>
  );
}
