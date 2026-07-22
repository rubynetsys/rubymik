import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Lock, Network, Plus, ShieldAlert, ShieldCheck, Waypoints, X } from 'lucide-react';
import { api } from '../api';
import Select from './Select';
import type { ApplyOutcome, L2BridgeView, L2MoveResult, L2View } from '../types';

const inputCls = 'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong';
type SetOutcome = (o: { title: string; result: string; detail: string; sequence?: string[] }) => void;

/** Select option list, keeping the current value even if it isn't in the known set. */
function ifaceOpts(known: string[], current: string, blankLabel: string) {
  const opts = [{ value: '', label: blankLabel }, ...known.map((n) => ({ value: n, label: n }))];
  if (current && !known.includes(current)) opts.push({ value: current, label: `${current} (not listed)` });
  return opts;
}

export default function L2Manager({ deviceId, interfaces = [] }: { deviceId: number; interfaces?: string[] }) {
  const [view, setView] = useState<L2View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ title: string; result: string; detail: string; sequence?: string[] } | null>(null);
  const [addBridge, setAddBridge] = useState(false);
  const [addVlan, setAddVlan] = useState(false);
  const [moving, setMoving] = useState(false);

  const load = useCallback(async () => {
    try { setView(await api.get<L2View>(`/api/devices/${deviceId}/l2`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load L2: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;
  const ro = !view.manageable;
  const p = view.path;
  const bridgeNames = view.bridges.map((b) => b.name);
  const portOptions = interfaces.filter((n) => !bridgeNames.includes(n)); // physical/vlan ports, not bridges

  async function remove(resource: string, id: string, label: string) {
    if (!confirm(`Remove ${label}?`)) return;
    try { const o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/l2/${resource}/${encodeURIComponent(id)}`); setOutcome({ title: `Remove ${label}`, result: o.result, detail: o.detail }); await load(); }
    catch (e) { setOutcome({ title: `Remove ${label}`, result: 'refused', detail: (e as Error).message }); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg bg-info-bg px-3 py-2.5 text-xs text-info-fg">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          L2 management path traced & protected. RubyMIK reaches this router {p.mgmtNet === 'tunnel' ? 'over the tunnel' : 'directly'} via <b>{p.mgmtInterface ?? '?'}</b> ({p.mgmtInterfaceType}
          {p.mgmtBridge ? `, bridge ${p.mgmtBridge}` : ''}{p.mgmtVlan ? `, VLAN ${p.mgmtVlan}` : ''}{p.mgmtPorts.length ? `, port ${p.mgmtPorts.join('/')}` : ''}).
          These can't be disabled/deleted, the mgmt port can't be stranded, and vlan-filtering can't be enabled on the mgmt bridge without the mgmt VLAN — the classic L2 lock is refused. Restructuring the mgmt path uses add-before-remove at L2.
        </span>
      </div>

      {ro && <div className="flex items-center gap-2 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted"><Lock className="h-4 w-4" /> Monitor-only — L2 read-only. Add a write credential to configure it.</div>}

      {/* Bridges */}
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-fg-dim"><Waypoints className="h-3.5 w-3.5" /> Bridges</h3>
        {view.bridges.length === 0 && <div className="rounded-lg bg-sunken px-3 py-2 text-sm text-fg-muted">No bridges.</div>}
        {view.bridges.map((br) => <BridgeCard key={br.id} br={br} ro={ro} deviceId={deviceId} onRemove={remove} onOutcome={setOutcome} reload={load} portOptions={portOptions.filter((n) => !br.ports.some((pt) => pt.interface === n))} />)}
        {!ro && (addBridge
          ? <AddBridgeForm deviceId={deviceId} onDone={() => { setAddBridge(false); void load(); }} onCancel={() => setAddBridge(false)} onOutcome={setOutcome} />
          : <button onClick={() => setAddBridge(true)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover"><Plus className="h-4 w-4" /> Create bridge</button>)}
      </div>

      {/* VLAN interfaces */}
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-fg-dim"><Network className="h-3.5 w-3.5" /> VLAN interfaces</h3>
        {view.vlans.length === 0 && <div className="rounded-lg bg-sunken px-3 py-2 text-sm text-fg-muted">No VLAN interfaces.</div>}
        {view.vlans.map((v) => (
          <div key={v.id} className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${v.isMgmt ? 'bg-accent-subtle/30' : 'bg-sunken'}`}>
            <span className="font-mono font-semibold text-fg">{v.name}</span>
            <span className="text-xs text-fg-dim">vlan {v.vlanId} on {v.interface}</span>
            {v.managed && <span className="rounded bg-accent-subtle px-1.5 py-0.5 text-[10px] font-bold text-accent-text">RUBYMIK-L2</span>}
            {v.isMgmt && <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-inverse"><ShieldCheck className="h-3 w-3" /> MGMT VLAN</span>}
            {!ro && !v.isMgmt && <button onClick={() => void remove('vlans', v.id, `VLAN ${v.name}`)} className="ml-auto rounded border border-border-strong px-1.5 py-0.5 text-xs text-danger-fg-strong hover:bg-danger-bg">remove</button>}
          </div>
        ))}
        {!ro && (addVlan
          ? <AddVlanForm deviceId={deviceId} interfaces={interfaces} onDone={() => { setAddVlan(false); void load(); }} onCancel={() => setAddVlan(false)} onOutcome={setOutcome} />
          : <button onClick={() => setAddVlan(true)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:border-accent-border hover:text-accent-text"><Plus className="h-4 w-4" /> Create VLAN interface</button>)}
      </div>

      {!ro && <button onClick={() => setMoving(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-warning-line px-3.5 py-2 text-sm font-semibold text-warning-fg hover:bg-warning-bg"><ShieldAlert className="h-4 w-4" /> Move management onto a new bridge…</button>}
      {moving && <MoveMgmtModal deviceId={deviceId} interfaces={portOptions} onClose={() => setMoving(false)} onDone={(o) => { setMoving(false); setOutcome(o); void load(); }} />}

      {outcome && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOutcome(null)}>
          <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">{outcome.result === 'applied' ? <CheckCircle2 className="h-5 w-5 text-success-fg" /> : <ShieldAlert className="h-5 w-5 text-warning-fg" />}<h3 className="text-base font-bold text-fg-strong">{outcome.title}: {outcome.result}</h3></div>
              <button onClick={() => setOutcome(null)} className="rounded-lg p-1 text-fg-faint hover:bg-app"><X className="h-4 w-4" /></button>
            </div>
            <p className="mt-2 text-sm text-fg-dim">{outcome.detail}</p>
            {outcome.sequence?.length ? <ol className="mt-3 space-y-1 rounded-lg bg-sunken p-3 text-xs text-fg-body">{outcome.sequence.map((s, i) => <li key={i}><span className="text-fg-faint">{i + 1}.</span> {s}</li>)}</ol> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function BridgeCard({ br, ro, deviceId, onRemove, onOutcome, reload, portOptions }: { br: L2BridgeView; ro: boolean; deviceId: number; onRemove: (r: string, id: string, l: string) => void; onOutcome: SetOutcome; reload: () => Promise<void>; portOptions: string[] }) {
  async function toggleVf() {
    try { const o = await api.patch<ApplyOutcome>(`/api/devices/${deviceId}/l2/bridges/${encodeURIComponent(br.id)}`, { vlanFiltering: !br.vlanFiltering }); onOutcome({ title: `${br.vlanFiltering ? 'Disable' : 'Enable'} vlan-filtering on ${br.name}`, result: o.result, detail: o.detail }); await reload(); }
    catch (e) { onOutcome({ title: `vlan-filtering on ${br.name}`, result: 'refused', detail: (e as Error).message }); }
  }
  return (
    <section className={`mt-2 rounded-xl border p-3 ${br.isMgmt ? 'border-accent-border bg-accent-subtle/20' : 'border-border bg-surface'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-bold text-fg-strong">{br.name}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${br.vlanFiltering ? 'bg-info-bg text-info-fg' : 'bg-app text-fg-muted'}`}>vlan-filtering {br.vlanFiltering ? 'on' : 'off'}</span>
          {br.managed && <span className="rounded bg-accent-subtle px-1.5 py-0.5 text-[10px] font-bold text-accent-text">RUBYMIK-L2</span>}
          {br.isMgmt && <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-inverse"><ShieldCheck className="h-3 w-3" /> MGMT BRIDGE</span>}
        </div>
        {!ro && (
          <div className="flex gap-1.5">
            <button onClick={() => void toggleVf()} className="rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-fg-body hover:bg-app">{br.vlanFiltering ? 'Disable' : 'Enable'} vlan-filtering</button>
            {!br.isMgmt && <button onClick={() => onRemove('bridges', br.id, `bridge ${br.name}`)} className="rounded-md border border-border-strong px-2 py-1 text-xs text-danger-fg-strong hover:bg-danger-bg">Delete</button>}
          </div>
        )}
      </div>
      <div className="mt-2 space-y-1">
        {br.ports.length === 0 && <div className="text-xs text-fg-faint">no member ports</div>}
        {br.ports.map((port) => (
          <div key={port.id} className="flex items-center gap-2 rounded bg-sunken px-2.5 py-1 text-xs">
            <span className="font-mono text-fg">{port.interface}</span>{port.pvid ? <span className="text-fg-dim">pvid {port.pvid}</span> : null}
            {port.isMgmtPort && <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-inverse">MGMT PORT</span>}
            {!ro && !port.isMgmtPort && <button onClick={() => onRemove('ports', port.id, `port ${port.interface}`)} className="ml-auto text-danger-fg-strong hover:underline">remove</button>}
          </div>
        ))}
      </div>
      {!ro && <AddPortInline deviceId={deviceId} bridge={br.name} portOptions={portOptions} onOutcome={onOutcome} reload={reload} />}
    </section>
  );
}

function AddPortInline({ deviceId, bridge, portOptions, onOutcome, reload }: { deviceId: number; bridge: string; portOptions: string[]; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const [iface, setIface] = useState('');
  return (
    <div className="mt-2 flex items-center gap-2">
      <Select value={iface} onChange={setIface} className="w-44" ariaLabel={`add port to ${bridge}`}
        placeholder="add a port…" options={ifaceOpts(portOptions, iface, 'add a port…')} />
      <button disabled={!iface} onClick={async () => { try { const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/l2/ports`, { bridge, interface: iface }); onOutcome({ title: `Add port ${iface}`, result: o.result, detail: o.detail }); setIface(''); await reload(); } catch (e) { onOutcome({ title: `Add port ${iface}`, result: 'refused', detail: (e as Error).message }); } }} className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Add port</button>
    </div>
  );
}

function AddBridgeForm({ deviceId, onDone, onCancel, onOutcome }: { deviceId: number; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [name, setName] = useState('br-lan'); const [vf, setVf] = useState(false); const [err, setErr] = useState<string | null>(null);
  return (
    <div className="mt-2 rounded-xl border border-border bg-sunken p-3">
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="flex flex-wrap items-end gap-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Bridge name</span><input className={`${inputCls} w-44`} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={vf} onChange={(e) => setVf(e.target.checked)} /> vlan-filtering</label>
        <button onClick={async () => { setErr(null); try { const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/l2/bridges`, { name, vlanFiltering: vf }); onOutcome({ title: `Create bridge ${name}`, result: o.result, detail: o.detail }); onDone(); } catch (e) { setErr((e as Error).message); } }} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">Create</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}

function AddVlanForm({ deviceId, interfaces, onDone, onCancel, onOutcome }: { deviceId: number; interfaces: string[]; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [name, setName] = useState('vlan100'); const [vid, setVid] = useState('100'); const [iface, setIface] = useState(''); const [err, setErr] = useState<string | null>(null);
  return (
    <div className="mt-2 rounded-xl border border-border bg-sunken p-3">
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="flex flex-wrap items-end gap-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Name</span><input className={`${inputCls} w-36`} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">VLAN id</span><input className={`${inputCls} w-24`} value={vid} onChange={(e) => setVid(e.target.value)} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">On interface</span><Select value={iface} onChange={setIface} className="w-44" ariaLabel="on interface" placeholder="ether4 or a bridge" options={ifaceOpts(interfaces, iface, 'ether4 or a bridge')} /></label>
        <button disabled={!iface} onClick={async () => { setErr(null); try { const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/l2/vlans`, { name, vlanId: Number(vid), interface: iface }); onOutcome({ title: `Create VLAN ${name}`, result: o.result, detail: o.detail }); onDone(); } catch (e) { setErr((e as Error).message); } }} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Create</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}

function MoveMgmtModal({ deviceId, interfaces, onClose, onDone }: { deviceId: number; interfaces: string[]; onClose: () => void; onDone: (o: { title: string; result: string; detail: string; sequence?: string[] }) => void }) {
  const [f, setF] = useState({ newBridge: 'br-mgmt-new', port: '', newCidr: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const up = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2"><ShieldAlert className="h-5 w-5 text-warning-fg" /><h3 className="text-base font-bold text-fg-strong">Move management onto a new bridge</h3></div>
        <div className="mt-3 rounded-lg bg-warning-bg px-3 py-2.5 text-xs text-warning-fg">
          This restructures the L2 path RubyMIK reaches the router through — an instant-brick risk if done wrong. It's done by <b>add-before-remove at L2</b>: RubyMIK builds the new bridge, moves a port, adds the new management address, <b>verifies it can still reach the same router</b>, and only then removes the old path. If the new path doesn't verify, it's torn down and the old kept — the router is never left unreachable.
        </div>
        {err && <div className="mt-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <input className={inputCls} value={f.newBridge} onChange={(e) => up('newBridge', e.target.value)} placeholder="new bridge name" />
          <Select value={f.port} onChange={(v) => up('port', v)} ariaLabel="port to move" placeholder="port to move (ether…)" options={ifaceOpts(interfaces, f.port, 'port to move (ether…)')} />
          <input className={inputCls} value={f.newCidr} onChange={(e) => up('newCidr', e.target.value)} placeholder="new mgmt CIDR" />
        </div>
        <div className="mt-4 flex gap-2">
          <button disabled={busy || !f.port || !f.newCidr} onClick={async () => { setBusy(true); setErr(null); try { const r = await api.post<L2MoveResult>(`/api/devices/${deviceId}/l2/move-mgmt`, f); onDone({ title: `Move mgmt → ${f.newBridge}`, result: r.result, detail: r.detail, sequence: r.sequence }); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy ? 'Working…' : 'Restructure safely (add-before-remove at L2)'}</button>
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
        </div>
      </div>
    </div>
  );
}
