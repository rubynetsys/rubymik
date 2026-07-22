import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Lock, Network, Plus, Power, Server, ShieldCheck, ShieldAlert, Trash2, Waypoints, X } from 'lucide-react';
import { api } from '../api';
import type { ApplyOutcome, DhcpFullView, DhcpServerView, DhcpPoolView, DhcpNetworkView } from '../types';

/**
 * P29 — DHCP server / pool / network management. Every write rides the safe-apply
 * pipeline; a change that would sever RubyMIK's own management path (a server on
 * the mgmt interface, a pool/network covering the mgmt IP) is refused by the
 * server (dhcpMgmtGuard) and flagged read-only here. Deleting anything with active
 * clients on it asks for confirmation first.
 */
const inputCls = 'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong';
type Outcome = { title: string; result: string; detail: string; auditId?: number };
type SetOutcome = (o: Outcome) => void;

export default function DhcpInfra({ deviceId, interfaces = [] }: { deviceId: number; interfaces?: string[] }) {
  const [view, setView] = useState<DhcpFullView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<DhcpFullView>(`/api/devices/${deviceId}/dhcp/full`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load DHCP: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;
  const ro = !view.manageable;

  return (
    <div className="space-y-5">
      {ro && (
        <div className="flex items-center gap-2 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted">
          <Lock className="h-4 w-4" /> Monitor-only — DHCP shown read-only. Add a write credential to configure it.
        </div>
      )}
      <ServersSection view={view} deviceId={deviceId} ro={ro} interfaces={interfaces} onOutcome={setOutcome} reload={load} />
      <PoolsSection view={view} deviceId={deviceId} ro={ro} onOutcome={setOutcome} reload={load} />
      <NetworksSection view={view} deviceId={deviceId} ro={ro} onOutcome={setOutcome} reload={load} />
      {outcome && <OutcomeModal outcome={outcome} onClose={() => { setOutcome(null); void load(); }} />}
    </div>
  );
}

function OutcomeModal({ outcome, onClose }: { outcome: Outcome; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            {outcome.result === 'applied' ? <CheckCircle2 className="h-5 w-5 text-success-fg" /> : <ShieldAlert className="h-5 w-5 text-warning-fg" />}
            <h3 className="text-base font-bold text-fg-strong">{outcome.title}: {outcome.result}</h3>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-fg-faint hover:bg-app"><X className="h-4 w-4" /></button>
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-fg-dim">{outcome.detail}</p>
        {outcome.auditId && <p className="mt-2 text-xs text-fg-faint">Audit #{outcome.auditId} · snapshot → apply → verify-reachable → audit</p>}
      </div>
    </div>
  );
}

function SectionShell({ icon: Icon, title, sub, children }: { icon: typeof Server; title: string; sub: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body"><Icon className="h-4 w-4 text-accent" /> {title}</h3>
      <p className="mb-2 mt-0.5 text-xs text-fg-dim">{sub}</p>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

// ---------------- servers ----------------

function ServersSection({ view, deviceId, ro, interfaces, onOutcome, reload }: { view: DhcpFullView; deviceId: number; ro: boolean; interfaces: string[]; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  return (
    <SectionShell icon={Server} title="DHCP servers" sub="Each server hands out addresses on one interface. A server on the management interface is protected.">
      {view.servers.length === 0 && <div className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-muted">No DHCP servers.</div>}
      {view.servers.map((sv) => <ServerCard key={sv.id} sv={sv} deviceId={deviceId} ro={ro} onOutcome={onOutcome} reload={reload} />)}
      {!ro && (adding
        ? <AddServerForm deviceId={deviceId} pools={view.pools} interfaces={interfaces} onDone={() => { setAdding(false); void reload(); }} onCancel={() => setAdding(false)} onOutcome={onOutcome} />
        : <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover"><Plus className="h-4 w-4" /> Add DHCP server</button>)}
    </SectionShell>
  );
}

function ServerCard({ sv, deviceId, ro, onOutcome, reload }: { sv: DhcpServerView; deviceId: number; ro: boolean; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const editable = !ro && sv.managed && !sv.isMgmtInterface;
  async function act(kind: 'del' | 'toggle' | 'own') {
    try {
      let o: ApplyOutcome;
      if (kind === 'del') { if (!confirm(`Remove DHCP server "${sv.name}"?${sv.activeLeases ? `\n\n${sv.activeLeases} client(s) currently have a lease from it — they will lose their address on renewal.` : ''}`)) return; o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/dhcp/servers/${encodeURIComponent(sv.id)}`); }
      else if (kind === 'toggle') o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/dhcp/servers/${encodeURIComponent(sv.id)}/enabled`, { disabled: !sv.disabled });
      else o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/dhcp/servers/${encodeURIComponent(sv.id)}/take-ownership`, {});
      onOutcome({ title: sv.name, result: o.result, detail: o.detail, auditId: o.auditId }); await reload();
    } catch (e) { onOutcome({ title: sv.name, result: 'refused', detail: (e as Error).message }); }
  }
  return (
    <div className={`rounded-xl border p-3 ${sv.isMgmtInterface ? 'border-danger-line bg-danger-bg/30' : 'border-border bg-surface'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Server className={`h-4 w-4 ${sv.isMgmtInterface ? 'text-danger-fg-strong' : 'text-accent'}`} />
          <span className="font-bold text-fg-strong">{sv.name}</span>
          <span className="text-xs text-fg-dim">on {sv.interface ?? '—'}{sv.addressPool ? ` · pool ${sv.addressPool}` : ''}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${sv.disabled ? 'bg-app text-fg-muted' : 'bg-success-bg text-success-fg-strong'}`}>{sv.disabled ? 'disabled' : 'enabled'}</span>
          {sv.activeLeases > 0 && <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-bold text-accent-text">{sv.activeLeases} active</span>}
          {sv.isMgmtInterface && <span className="inline-flex items-center gap-1 rounded-full bg-danger-bg px-2 py-0.5 text-[10px] font-bold text-danger-fg-strong"><ShieldCheck className="h-3 w-3" /> MGMT INTERFACE — PROTECTED</span>}
          {sv.managed && !sv.isMgmtInterface && <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-bold text-accent-text">RUBYMIK-DHCP</span>}
          {!sv.managed && <span className="rounded-full bg-app px-2 py-0.5 text-[10px] font-bold text-fg-muted">unmanaged</span>}
        </div>
        <div className="flex gap-1.5">
          {editable && <button onClick={() => void act('toggle')} className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-fg-body hover:border-accent-border"><Power className="h-3.5 w-3.5" /> {sv.disabled ? 'Enable' : 'Disable'}</button>}
          {editable && <button onClick={() => void act('del')} className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-danger-fg-strong hover:bg-danger-bg"><Trash2 className="h-3.5 w-3.5" /> Remove</button>}
          {!ro && !sv.managed && <button onClick={() => void act('own')} className="rounded-md border border-border-strong px-2 py-1 text-xs font-semibold text-fg-body hover:border-accent-border">Take ownership</button>}
        </div>
      </div>
      {sv.isMgmtInterface && <p className="mt-1 text-xs text-danger-fg-strong">RubyMIK reaches this router through {sv.interface} — this server is read-only here so a change can't sever management.</p>}
    </div>
  );
}

function AddServerForm({ deviceId, pools, interfaces, onDone, onCancel, onOutcome }: { deviceId: number; pools: DhcpPoolView[]; interfaces: string[]; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [f, setF] = useState({ name: 'zzz-dhcp', interface: interfaces[0] ?? '', addressPool: pools[0]?.name ?? '', leaseTime: '10m' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const up = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  async function submit() {
    setBusy(true); setErr(null);
    try { const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/dhcp/servers`, { name: f.name, interface: f.interface, addressPool: f.addressPool || undefined, leaseTime: f.leaseTime || undefined }); onOutcome({ title: `Add ${f.name}`, result: o.result, detail: o.detail, auditId: o.auditId }); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-border bg-sunken p-4">
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Name</span><input className={inputCls} value={f.name} onChange={(e) => up('name', e.target.value)} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Interface</span>
          {interfaces.length ? <select className={inputCls} value={f.interface} onChange={(e) => up('interface', e.target.value)}><option value="">Select…</option>{interfaces.map((i) => <option key={i} value={i}>{i}</option>)}</select>
            : <input className={inputCls} value={f.interface} onChange={(e) => up('interface', e.target.value)} placeholder="ether2" />}
        </label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Address pool</span>
          <select className={inputCls} value={f.addressPool} onChange={(e) => up('addressPool', e.target.value)}><option value="">(none)</option>{pools.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}</select>
        </label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Lease time</span><input className={inputCls} value={f.leaseTime} onChange={(e) => up('leaseTime', e.target.value)} placeholder="10m" /></label>
      </div>
      <div className="mt-3 flex gap-2">
        <button disabled={busy || !f.name || !f.interface} onClick={() => void submit()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Create</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}

// ---------------- pools ----------------

function PoolsSection({ view, deviceId, ro, onOutcome, reload }: { view: DhcpFullView; deviceId: number; ro: boolean; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  async function del(p: DhcpPoolView) {
    if (!confirm(`Remove IP pool "${p.name}" (${p.ranges})?`)) return;
    try { const o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/dhcp/pools/${encodeURIComponent(p.id)}`); onOutcome({ title: p.name, result: o.result, detail: o.detail, auditId: o.auditId }); await reload(); }
    catch (e) { onOutcome({ title: p.name, result: 'refused', detail: (e as Error).message }); }
  }
  return (
    <SectionShell icon={Waypoints} title="Address pools" sub="The ranges a server draws from. A pool covering the management IP is protected.">
      {view.pools.length === 0 && <div className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-muted">No pools.</div>}
      {view.pools.map((p) => (
        <div key={p.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm ${p.coversMgmtIp ? 'border-danger-line bg-danger-bg/20' : 'border-border bg-surface'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-fg-strong">{p.name}</span>
            <span className="font-mono text-xs text-fg-dim">{p.ranges ?? '—'}</span>
            {p.coversMgmtIp && <span className="inline-flex items-center gap-1 rounded-full bg-danger-bg px-2 py-0.5 text-[10px] font-bold text-danger-fg-strong"><ShieldCheck className="h-3 w-3" /> MGMT — PROTECTED</span>}
          </div>
          {!ro && !p.coversMgmtIp && <button onClick={() => void del(p)} className="rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-danger-fg-strong hover:bg-danger-bg">Remove</button>}
        </div>
      ))}
      {!ro && (adding
        ? <AddInlineForm deviceId={deviceId} kind="pools" fields={[['name', 'Name', 'zzz-pool'], ['ranges', 'Ranges', '10.9.0.10-10.9.0.250']]} onDone={() => { setAdding(false); void reload(); }} onCancel={() => setAdding(false)} onOutcome={onOutcome} />
        : <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:border-accent-border"><Plus className="h-4 w-4" /> Add pool</button>)}
    </SectionShell>
  );
}

// ---------------- networks ----------------

function NetworksSection({ view, deviceId, ro, onOutcome, reload }: { view: DhcpFullView; deviceId: number; ro: boolean; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  async function del(n: DhcpNetworkView) {
    if (!confirm(`Remove DHCP network ${n.address}?`)) return;
    try { const o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/dhcp/networks/${encodeURIComponent(n.id)}`); onOutcome({ title: n.address ?? 'network', result: o.result, detail: o.detail, auditId: o.auditId }); await reload(); }
    catch (e) { onOutcome({ title: n.address ?? 'network', result: 'refused', detail: (e as Error).message }); }
  }
  return (
    <SectionShell icon={Network} title="Networks" sub="Gateway / DNS / domain per subnet. The management subnet is protected.">
      {view.networks.length === 0 && <div className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-muted">No DHCP networks.</div>}
      {view.networks.map((n) => (
        <div key={n.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm ${n.coversMgmtIp ? 'border-danger-line bg-danger-bg/20' : 'border-border bg-surface'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-semibold text-fg-strong">{n.address}</span>
            <span className="text-xs text-fg-dim">gw {n.gateway ?? '—'}{n.dnsServer ? ` · dns ${n.dnsServer}` : ''}</span>
            {n.coversMgmtIp && <span className="inline-flex items-center gap-1 rounded-full bg-danger-bg px-2 py-0.5 text-[10px] font-bold text-danger-fg-strong"><ShieldCheck className="h-3 w-3" /> MGMT SUBNET — PROTECTED</span>}
          </div>
          {!ro && !n.coversMgmtIp && <button onClick={() => void del(n)} className="rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-danger-fg-strong hover:bg-danger-bg">Remove</button>}
        </div>
      ))}
      {!ro && (adding
        ? <AddInlineForm deviceId={deviceId} kind="networks" fields={[['address', 'Network (CIDR)', '10.9.0.0/24'], ['gateway', 'Gateway', '10.9.0.1'], ['dnsServer', 'DNS', '1.1.1.1']]} onDone={() => { setAdding(false); void reload(); }} onCancel={() => setAdding(false)} onOutcome={onOutcome} />
        : <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:border-accent-border"><Plus className="h-4 w-4" /> Add network</button>)}
    </SectionShell>
  );
}

function AddInlineForm({ deviceId, kind, fields, onDone, onCancel, onOutcome }: { deviceId: number; kind: 'pools' | 'networks'; fields: Array<[string, string, string]>; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [f, setF] = useState<Record<string, string>>(Object.fromEntries(fields.map(([k]) => [k, ''])));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()));
      const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/dhcp/${kind}`, body);
      onOutcome({ title: `Add ${kind === 'pools' ? 'pool' : 'network'}`, result: o.result, detail: o.detail, auditId: o.auditId }); onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-border bg-sunken p-4">
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {fields.map(([k, label, ph]) => <label key={k}><span className="mb-1 block text-xs font-semibold text-fg-dim">{label}</span><input className={inputCls} value={f[k]} onChange={(e) => setF((p) => ({ ...p, [k]: e.target.value }))} placeholder={ph} /></label>)}
      </div>
      <div className="mt-3 flex gap-2">
        <button disabled={busy} onClick={() => void submit()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Create</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}
