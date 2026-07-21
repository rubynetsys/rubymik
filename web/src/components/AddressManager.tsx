import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Lock, Plus, Radio, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react';
import { api } from '../api';
import Select from './Select';
import type { AddrView, ApplyOutcome, IfaceEntry, MgmtIpResult } from '../types';

const inputCls = 'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong';

export default function AddressManager({ deviceId }: { deviceId: number }) {
  const [view, setView] = useState<AddrView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ title: string; result: string; detail: string; sequence?: string[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [changingMgmt, setChangingMgmt] = useState(false);

  const load = useCallback(async () => {
    try { setView(await api.get<AddrView>(`/api/devices/${deviceId}/addresses`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load addresses: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;
  const ro = !view.manageable;
  const withAddr = view.interfaces.filter((f) => f.addresses.length > 0);

  async function removeAddr(id: string, label: string) {
    if (!confirm(`Remove address ${label}?`)) return;
    try { const o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/addresses/${encodeURIComponent(id)}`); setOutcome({ title: `Remove ${label}`, result: o.result, detail: o.detail }); await load(); }
    catch (e) { setOutcome({ title: `Remove ${label}`, result: 'refused', detail: (e as Error).message }); }
  }

  return (
    <div className="space-y-4">
      {/* mgmt banner */}
      <div className="flex items-start gap-2 rounded-lg bg-info-bg px-3 py-2.5 text-xs text-info-fg">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          RubyMIK reaches this router {view.mgmtNet === 'tunnel' ? 'over the WireGuard tunnel' : 'directly'} at <b>{view.mgmtAddress ?? view.mgmtHost}</b> on <b>{view.mgmtInterface ?? '?'}</b>.
          That address and interface are <b>protected</b>: the mgmt interface can't be disabled and the mgmt address can't be hard-removed. Changing the mgmt IP is done safely by <b>add-before-remove</b> (add new → verify reachable → remove old) — the router is never unreachable.
        </span>
      </div>

      {ro && <div className="flex items-center gap-2 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted"><Lock className="h-4 w-4" /> Monitor-only — addresses read-only. Add a write credential to configure them.</div>}

      {withAddr.map((iface) => (
        <IfaceBlock key={iface.id} iface={iface} ro={ro} deviceId={deviceId} onRemove={removeAddr} onChangeMgmt={() => setChangingMgmt(true)} onOutcome={setOutcome} reload={load} />
      ))}

      {!ro && (adding
        ? <AddAddrForm deviceId={deviceId} interfaces={view.interfaces} onDone={() => { setAdding(false); void load(); }} onCancel={() => setAdding(false)} onOutcome={setOutcome} />
        : <button onClick={() => setAdding(true)} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover"><Plus className="h-4 w-4" /> Add IP address</button>
      )}

      {changingMgmt && view.mgmtAddress && (
        <ChangeMgmtModal deviceId={deviceId} current={view.mgmtAddress} onClose={() => setChangingMgmt(false)} onDone={(o) => { setChangingMgmt(false); setOutcome(o); void load(); }} />
      )}

      {outcome && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOutcome(null)}>
          <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                {outcome.result === 'applied' ? <CheckCircle2 className="h-5 w-5 text-success-fg" /> : <ShieldAlert className="h-5 w-5 text-warning-fg" />}
                <h3 className="text-base font-bold text-fg-strong">{outcome.title}: {outcome.result}</h3>
              </div>
              <button onClick={() => setOutcome(null)} className="rounded-lg p-1 text-fg-faint hover:bg-app"><X className="h-4 w-4" /></button>
            </div>
            <p className="mt-2 text-sm text-fg-dim">{outcome.detail}</p>
            {outcome.sequence && outcome.sequence.length > 0 && (
              <ol className="mt-3 space-y-1 rounded-lg bg-sunken p-3 text-xs text-fg-body">
                {outcome.sequence.map((s, i) => <li key={i} className="flex gap-2"><span className="text-fg-faint">{i + 1}.</span> {s}</li>)}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type SetOutcome = (o: { title: string; result: string; detail: string; sequence?: string[] }) => void;

function IfaceBlock({ iface, ro, deviceId, onRemove, onChangeMgmt, onOutcome, reload }: { iface: IfaceEntry; ro: boolean; deviceId: number; onRemove: (id: string, label: string) => void; onChangeMgmt: () => void; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  async function toggleDisabled() {
    try { const o = await api.patch<ApplyOutcome>(`/api/devices/${deviceId}/interfaces/${encodeURIComponent(iface.id)}`, { disabled: !iface.disabled }); onOutcome({ title: `${iface.disabled ? 'Enable' : 'Disable'} ${iface.name}`, result: o.result, detail: o.detail }); await reload(); }
    catch (e) { onOutcome({ title: `${iface.disabled ? 'Enable' : 'Disable'} ${iface.name}`, result: 'refused', detail: (e as Error).message }); }
  }
  return (
    <section className={`rounded-xl border p-3 ${iface.isMgmtInterface ? 'border-accent-border bg-accent-subtle/20' : 'border-border bg-surface'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-bold text-fg-strong">{iface.name}</span>
          <span className="text-xs text-fg-dim">{iface.type ?? ''} · {iface.running ? 'running' : 'down'}{iface.mtu ? ` · mtu ${iface.mtu}` : ''}</span>
          {iface.isMgmtInterface && <span className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-bold text-accent-text"><ShieldCheck className="h-3 w-3" /> MGMT INTERFACE</span>}
          {iface.disabled && <span className="rounded-full bg-danger-bg px-2 py-0.5 text-[10px] font-bold text-danger-fg-strong">disabled</span>}
        </div>
        {!ro && !iface.isMgmtInterface && iface.type !== 'loopback' && (
          <button onClick={() => void toggleDisabled()} className="rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-fg-body hover:bg-app">{iface.disabled ? 'Enable' : 'Disable'}</button>
        )}
      </div>
      <div className="mt-2 space-y-1">
        {iface.addresses.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-sunken px-3 py-1.5 text-sm">
            <span className="font-mono text-fg">{a.address}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${a.dynamic ? 'bg-app text-fg-muted' : 'bg-success-bg text-success-fg'}`}>{a.dynamic ? 'dynamic (DHCP)' : 'static'}</span>
            {a.managed && <span className="rounded bg-accent-subtle px-1.5 py-0.5 text-[10px] font-bold text-accent-text">RUBYMIK</span>}
            {a.isMgmt && <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-inverse"><Radio className="h-3 w-3" /> MANAGEMENT ADDRESS</span>}
            <span className="ml-auto">
              {!ro && (a.isMgmt
                ? <button onClick={onChangeMgmt} className="rounded-md bg-accent px-2 py-1 text-xs font-semibold text-inverse hover:bg-accent-hover">Change management IP…</button>
                : <button onClick={() => onRemove(a.id, a.address ?? '')} className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs text-danger-fg-strong hover:bg-danger-bg"><Trash2 className="h-3.5 w-3.5" /> Remove</button>)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AddAddrForm({ deviceId, interfaces, onDone, onCancel, onOutcome }: { deviceId: number; interfaces: IfaceEntry[]; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [iface, setIface] = useState(interfaces[0]?.name ?? '');
  const [cidr, setCidr] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setErr(null);
    try { const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/addresses`, { interface: iface, cidr }); onOutcome({ title: `Add ${cidr}`, result: o.result, detail: o.detail }); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-border bg-sunken p-4">
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="flex flex-wrap items-end gap-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Interface</span>
          <Select className={inputCls} value={iface} onChange={setIface} ariaLabel="Interface" options={interfaces.map((f) => ({ value: f.name, label: f.name }))} /></label>
        <label className="flex-1"><span className="mb-1 block text-xs font-semibold text-fg-dim">Address (CIDR)</span>
          <input className={inputCls} value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="10.20.0.1/24" /></label>
        <button disabled={busy || !cidr || !iface} onClick={() => void submit()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Add</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}

function ChangeMgmtModal({ deviceId, current, onClose, onDone }: { deviceId: number; current: string; onClose: () => void; onDone: (o: { title: string; result: string; detail: string; sequence?: string[] }) => void }) {
  const [cidr, setCidr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<MgmtIpResult>(`/api/devices/${deviceId}/mgmt-ip`, { cidr });
      onDone({ title: `Change management IP ${current} → ${cidr}`, result: r.result, detail: r.detail, sequence: r.sequence });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2"><ShieldAlert className="h-5 w-5 text-warning-fg" /><h3 className="text-base font-bold text-fg-strong">Change management IP</h3></div>
        <div className="mt-3 rounded-lg bg-warning-bg px-3 py-2.5 text-xs text-warning-fg">
          You're changing <b>the address RubyMIK reaches this router on</b> ({current}). This is done by <b>add-before-remove</b>: RubyMIK adds the new address, verifies it can reach the same router there, and only then removes the old one. If the new address doesn't verify, it's removed and the old one kept — the router is never left unreachable. The new address must be on the same subnet as {current}.
        </div>
        {err && <div className="mt-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
        <label className="mt-3 block"><span className="mb-1 block text-xs font-semibold text-fg-dim">New management address (CIDR)</span>
          <input className={inputCls} value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder={current.replace(/\.\d+\//, '.222/')} /></label>
        <div className="mt-4 flex gap-2">
          <button disabled={busy || !cidr} onClick={() => void submit()} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy ? 'Working…' : 'Change safely (add-before-remove)'}</button>
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
        </div>
      </div>
    </div>
  );
}
