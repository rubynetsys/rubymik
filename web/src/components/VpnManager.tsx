import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, FileKey, FilePlus2, KeyRound, Lock, Pencil, Plus, Power, Shield, ShieldAlert, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { api } from '../api';
import type { ApplyOutcome, CertView, PppSecretView, TunnelClientView, TunnelProto, VpnServerView, VpnView } from '../types';
import WireguardManager from './WireguardManager';

const inputCls = 'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong';
type Outcome = { title: string; result: string; detail: string; auditId?: number };
type SetOutcome = (o: Outcome) => void;

type TabId = 'wg' | TunnelProto | 'ppp' | 'certs';
const TABS: { id: TabId; label: string }[] = [
  { id: 'wg', label: 'WireGuard' },
  { id: 'l2tp', label: 'L2TP/IPsec' },
  { id: 'sstp', label: 'SSTP' },
  { id: 'ovpn', label: 'OpenVPN' },
  { id: 'ppp', label: 'PPP accounts' },
  { id: 'certs', label: 'Certificates' },
];
const PROTO_LABEL: Record<TunnelProto, string> = { l2tp: 'L2TP/IPsec', sstp: 'SSTP', ovpn: 'OpenVPN' };

export default function VpnManager({ deviceId }: { deviceId: number }) {
  const [tab, setTab] = useState<TabId>('wg');
  const [view, setView] = useState<VpnView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<VpnView>(`/api/devices/${deviceId}/vpn`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { if (tab !== 'wg') void load(); }, [load, tab]);

  const ro = view ? !view.manageable : false;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5 border-b border-border pb-2">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${tab === t.id ? 'bg-accent text-inverse' : 'text-fg-body hover:bg-app'}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'wg' && <WireguardManager deviceId={deviceId} />}

      {tab !== 'wg' && error && !view && <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load VPN: {error}</div>}
      {tab !== 'wg' && !view && !error && <div className="h-24 animate-pulse rounded-lg bg-app" />}

      {tab !== 'wg' && view && (
        <>
          {ro && (
            <div className="flex items-center gap-2 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted">
              <Lock className="h-4 w-4" /> Monitor-only — shown read-only. Add a write credential (Edit device) to configure it.
            </div>
          )}
          {(tab === 'l2tp' || tab === 'sstp' || tab === 'ovpn') && (
            <TunnelTab proto={tab} view={view} deviceId={deviceId} ro={ro} onOutcome={setOutcome} reload={load} />
          )}
          {tab === 'ppp' && <PppTab view={view} deviceId={deviceId} ro={ro} onOutcome={setOutcome} reload={load} />}
          {tab === 'certs' && <CertsTab certs={view.certs} deviceId={deviceId} ro={ro} onOutcome={setOutcome} reload={load} />}
        </>
      )}

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

// ---------------- tunnel clients (L2TP / SSTP / OVPN) ----------------

function TunnelTab({ proto, view, deviceId, ro, onOutcome, reload }: { proto: TunnelProto; view: VpnView; deviceId: number; ro: boolean; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  if (!view.supported[proto]) return <div className="rounded-xl bg-sunken px-4 py-4 text-sm text-fg-muted">This device's RouterOS build does not expose {PROTO_LABEL[proto]}.</div>;
  const clients = view.clients.filter((c) => c.proto === proto);
  const server = view.servers.find((s) => s.proto === proto);

  return (
    <div className="space-y-3">
      {server && <ServerRow server={server} deviceId={deviceId} ro={ro} onOutcome={onOutcome} reload={reload} />}
      {proto === 'ovpn' && <OvpnExport deviceId={deviceId} />}
      {clients.length === 0 && <div className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-muted">No {PROTO_LABEL[proto]} client tunnels.</div>}
      {clients.map((c) => <TunnelCard key={c.id} c={c} deviceId={deviceId} ro={ro} onOutcome={onOutcome} reload={reload} />)}
      {!ro && (adding
        ? <AddTunnelForm proto={proto} deviceId={deviceId} onDone={() => { setAdding(false); void reload(); }} onCancel={() => setAdding(false)} onOutcome={onOutcome} />
        : <button onClick={() => setAdding(true)} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover"><Plus className="h-4 w-4" /> Add {PROTO_LABEL[proto]} client</button>
      )}
    </div>
  );
}

function ServerRow({ server, deviceId, ro, onOutcome, reload }: { server: VpnServerView; deviceId: number; ro: boolean; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try { const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/vpn/servers/${server.proto}/enabled`, { enabled: !server.enabled }); onOutcome({ title: `${server.enabled ? 'Disable' : 'Enable'} ${PROTO_LABEL[server.proto]} server`, result: o.result, detail: o.detail, auditId: o.auditId }); await reload(); }
    catch (e) { onOutcome({ title: `${PROTO_LABEL[server.proto]} server`, result: 'refused', detail: (e as Error).message }); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-sunken px-4 py-2.5">
      <div className="flex items-center gap-2 text-sm">
        <Shield className={`h-4 w-4 ${server.enabled ? 'text-success-fg' : 'text-fg-faint'}`} />
        <span className="font-semibold text-fg-strong">{PROTO_LABEL[server.proto]} server</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${server.enabled ? 'bg-success-bg text-success-fg-strong' : 'bg-app text-fg-muted'}`}>{server.enabled ? 'enabled' : 'disabled'}</span>
        {server.certificate && <span className="text-xs text-fg-dim">cert: {server.certificate}</span>}
      </div>
      {!ro && server.supported && <button disabled={busy} onClick={() => void toggle()} className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 text-xs font-semibold text-fg-body hover:border-accent-border disabled:opacity-50"><Power className="h-3.5 w-3.5" /> {server.enabled ? 'Disable' : 'Enable'}</button>}
    </div>
  );
}

function TunnelCard({ c, deviceId, ro, onOutcome, reload }: { c: TunnelClientView; deviceId: number; ro: boolean; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const editable = !ro && c.managed && !c.isMgmtPath;
  const [editing, setEditing] = useState(false);
  async function act(kind: 'del' | 'toggle' | 'own') {
    try {
      let o: ApplyOutcome;
      if (kind === 'del') { if (!confirm(`Remove ${PROTO_LABEL[c.proto]} client ${c.name}?`)) return; o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/vpn/tunnels/${c.proto}/${encodeURIComponent(c.id)}`); }
      else if (kind === 'toggle') o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/vpn/tunnels/${c.proto}/${encodeURIComponent(c.id)}/enabled`, { disabled: !c.disabled });
      else o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/vpn/tunnels/${c.proto}/${encodeURIComponent(c.id)}/take-ownership`, {});
      onOutcome({ title: `${c.name}`, result: o.result, detail: o.detail, auditId: o.auditId }); await reload();
    } catch (e) { onOutcome({ title: c.name, result: 'refused', detail: (e as Error).message }); }
  }
  return (
    <section className={`rounded-2xl border p-4 shadow-sm ${c.isMgmtPath ? 'border-danger-line bg-danger-bg/30' : 'border-border bg-surface'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <KeyRound className={`h-4 w-4 ${c.isMgmtPath ? 'text-danger-fg-strong' : 'text-accent'}`} />
          <span className="font-bold text-fg-strong">{c.name}</span>
          <span className={`text-xs ${c.running ? 'text-success-fg' : 'text-fg-dim'}`}>{c.status}{c.uptime ? ` · ${c.uptime}` : ''}</span>
          {c.isMgmtPath && <span className="inline-flex items-center gap-1 rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-bold text-danger-fg-strong"><ShieldCheck className="h-3 w-3" /> MGMT PATH — PROTECTED</span>}
          {c.managed && !c.isMgmtPath && <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-bold text-accent-text">RUBYMIK-VPN</span>}
          {!c.managed && <span className="rounded-full bg-app px-2 py-0.5 text-[10px] font-bold text-fg-muted">unmanaged</span>}
        </div>
        {editable && <div className="flex gap-1.5">
          <button onClick={() => setEditing(!editing)} className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-fg-body hover:border-accent-border"><Pencil className="h-3.5 w-3.5" /> Edit</button>
          <button onClick={() => void act('toggle')} className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-fg-body hover:border-accent-border"><Power className="h-3.5 w-3.5" /> {c.disabled ? 'Enable' : 'Disable'}</button>
          <button onClick={() => void act('del')} className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-danger-fg-strong hover:bg-danger-bg"><Trash2 className="h-3.5 w-3.5" /> Remove</button>
        </div>}
        {!ro && !c.managed && <button onClick={() => void act('own')} className="rounded-md border border-border-strong px-2 py-1 text-xs font-semibold text-fg-body hover:border-accent-border">Take ownership</button>}
      </div>
      {c.isMgmtPath && <p className="mt-1 text-xs text-danger-fg-strong">RubyMIK reaches this router through this tunnel — it's read-only here so a VPN edit can't sever management.</p>}
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        <Field label="Server (connect-to)" value={c.connectTo} mono />
        <Field label="User" value={c.user} />
        <Field label="Password" value={c.hasPassword ? 'set (redacted)' : '—'} />
        {c.proto === 'l2tp' && <Field label="IPsec" value={c.useIpsec ? (c.hasIpsecSecret ? 'on · PSK set (redacted)' : 'on') : 'off'} />}
        {(c.proto === 'sstp' || c.proto === 'ovpn') && <Field label="Certificate" value={c.certificate ?? 'none'} />}
        {c.profile && <Field label="Profile" value={c.profile} />}
      </dl>
      {editing && editable && <EditTunnelForm c={c} deviceId={deviceId} onDone={() => { setEditing(false); void reload(); }} onCancel={() => setEditing(false)} onOutcome={onOutcome} />}
    </section>
  );
}

function EditTunnelForm({ c, deviceId, onDone, onCancel, onOutcome }: { c: TunnelClientView; deviceId: number; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [f, setF] = useState({ name: c.name, connectTo: c.connectTo ?? '', user: c.user ?? '', password: '', ipsecSecret: '', useIpsec: c.useIpsec, certificate: c.certificate ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const up = (k: string, v: string | boolean) => setF((p) => ({ ...p, [k]: v }));
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = { name: f.name, connectTo: f.connectTo, user: f.user };
      if (f.password) body.password = f.password;                       // blank = keep
      if (c.proto === 'l2tp') { body.useIpsec = f.useIpsec; if (f.ipsecSecret) body.ipsecSecret = f.ipsecSecret; }
      if (c.proto === 'sstp' || c.proto === 'ovpn') body.certificate = f.certificate;
      const o = await api.patch<ApplyOutcome>(`/api/devices/${deviceId}/vpn/tunnels/${c.proto}/${encodeURIComponent(c.id)}`, body);
      onOutcome({ title: `Edit ${f.name}`, result: o.result, detail: o.detail, auditId: o.auditId }); onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="mt-3 rounded-xl border border-accent-border bg-sunken p-4">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-dim">Edit {PROTO_LABEL[c.proto]} client — leave a secret blank to keep it</div>
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Name</span><input className={inputCls} value={f.name} onChange={(e) => up('name', e.target.value)} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Server (host or IP)</span><input className={inputCls} value={f.connectTo} onChange={(e) => up('connectTo', e.target.value)} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">User</span><input className={inputCls} value={f.user} onChange={(e) => up('user', e.target.value)} autoComplete="off" /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Password (blank = keep)</span><input className={inputCls} type="password" autoComplete="new-password" value={f.password} onChange={(e) => up('password', e.target.value)} placeholder={c.hasPassword ? '•••••• (set)' : ''} /></label>
        {c.proto === 'l2tp' && <>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-fg-body"><input type="checkbox" checked={f.useIpsec} onChange={(e) => up('useIpsec', e.target.checked)} /> Use IPsec</label>
          {f.useIpsec && <label><span className="mb-1 block text-xs font-semibold text-fg-dim">IPsec PSK (blank = keep)</span><input className={inputCls} type="password" autoComplete="new-password" value={f.ipsecSecret} onChange={(e) => up('ipsecSecret', e.target.value)} placeholder={c.hasIpsecSecret ? '•••••• (set)' : ''} /></label>}
        </>}
        {(c.proto === 'sstp' || c.proto === 'ovpn') && <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Certificate</span><input className={inputCls} value={f.certificate} onChange={(e) => up('certificate', e.target.value)} placeholder="cert name on router" /></label>}
      </div>
      <div className="mt-3 flex gap-2">
        <button disabled={busy || !f.name} onClick={() => void submit()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Save changes</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label}</dt><dd className={`mt-0.5 text-fg ${mono ? 'break-all font-mono text-xs' : ''}`}>{value ?? '—'}</dd></div>;
}

function AddTunnelForm({ proto, deviceId, onDone, onCancel, onOutcome }: { proto: TunnelProto; deviceId: number; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [f, setF] = useState({ name: `${proto}-client`, connectTo: '', user: '', password: '', ipsecSecret: '', useIpsec: proto === 'l2tp', certificate: '', createDisabled: true });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const up = (k: string, v: string | boolean) => setF((p) => ({ ...p, [k]: v }));
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = { proto, name: f.name, connectTo: f.connectTo, user: f.user, password: f.password, disabled: f.createDisabled };
      if (proto === 'l2tp') { body.useIpsec = f.useIpsec; if (f.useIpsec && f.ipsecSecret) body.ipsecSecret = f.ipsecSecret; }
      if (proto === 'sstp' || proto === 'ovpn') { if (f.certificate) body.certificate = f.certificate; }
      const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/vpn/tunnels`, body);
      onOutcome({ title: `Add ${f.name}`, result: o.result, detail: o.detail, auditId: o.auditId }); onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-border bg-sunken p-4">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-dim">New {PROTO_LABEL[proto]} client — credentials are write-only (never shown or logged)</div>
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Name</span><input className={inputCls} value={f.name} onChange={(e) => up('name', e.target.value)} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Server (host or IP)</span><input className={inputCls} value={f.connectTo} onChange={(e) => up('connectTo', e.target.value)} placeholder="vpn.example.com" /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">User</span><input className={inputCls} value={f.user} onChange={(e) => up('user', e.target.value)} autoComplete="off" /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Password (never shown)</span><input className={inputCls} type="password" autoComplete="new-password" value={f.password} onChange={(e) => up('password', e.target.value)} /></label>
        {proto === 'l2tp' && <>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-fg-body"><input type="checkbox" checked={f.useIpsec} onChange={(e) => up('useIpsec', e.target.checked)} /> Use IPsec</label>
          {f.useIpsec && <label><span className="mb-1 block text-xs font-semibold text-fg-dim">IPsec pre-shared key (never shown)</span><input className={inputCls} type="password" autoComplete="new-password" value={f.ipsecSecret} onChange={(e) => up('ipsecSecret', e.target.value)} /></label>}
        </>}
        {(proto === 'sstp' || proto === 'ovpn') && <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Certificate (optional)</span><input className={inputCls} value={f.certificate} onChange={(e) => up('certificate', e.target.value)} placeholder="cert name on router" /></label>}
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm text-fg-body"><input type="checkbox" checked={f.createDisabled} onChange={(e) => up('createDisabled', e.target.checked)} /> Create disabled (enable after checking)</label>
      <div className="mt-3 flex gap-2">
        <button disabled={busy || !f.name || !f.connectTo || !f.user || !f.password} onClick={() => void submit()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Create</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}

// ---------------- PPP accounts ----------------

function PppTab({ view, deviceId, ro, onOutcome, reload }: { view: VpnView; deviceId: number; ro: boolean; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">Server-side user accounts shared by the L2TP / SSTP / OpenVPN servers. Passwords are write-only.</p>
      {view.secrets.length === 0 && <div className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-muted">No PPP accounts.</div>}
      {view.secrets.map((sct) => <SecretCard key={sct.id} sct={sct} deviceId={deviceId} ro={ro} onOutcome={onOutcome} reload={reload} />)}
      {!ro && (adding
        ? <AddSecretForm deviceId={deviceId} onDone={() => { setAdding(false); void reload(); }} onCancel={() => setAdding(false)} onOutcome={onOutcome} />
        : <button onClick={() => setAdding(true)} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover"><Plus className="h-4 w-4" /> Add PPP account</button>
      )}
    </div>
  );
}

function SecretCard({ sct, deviceId, ro, onOutcome, reload }: { sct: PppSecretView; deviceId: number; ro: boolean; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const editable = !ro && sct.managed;
  const [editing, setEditing] = useState(false);
  async function act(kind: 'del' | 'toggle' | 'own') {
    try {
      let o: ApplyOutcome;
      if (kind === 'del') { if (!confirm(`Remove PPP account ${sct.name}?`)) return; o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/vpn/secrets/${encodeURIComponent(sct.id)}`); }
      else if (kind === 'toggle') o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/vpn/secrets/${encodeURIComponent(sct.id)}/enabled`, { disabled: !sct.disabled });
      else o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/vpn/secrets/${encodeURIComponent(sct.id)}/take-ownership`, {});
      onOutcome({ title: sct.name, result: o.result, detail: o.detail, auditId: o.auditId }); await reload();
    } catch (e) { onOutcome({ title: sct.name, result: 'refused', detail: (e as Error).message }); }
  }
  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Users className="h-4 w-4 text-accent" />
          <span className="font-semibold text-fg-strong">{sct.name}</span>
          <span className="text-xs text-fg-dim">{sct.service ?? 'any'}{sct.remoteAddress ? ` · ${sct.remoteAddress}` : ''}</span>
          {sct.disabled && <span className="rounded-full bg-app px-2 py-0.5 text-[10px] font-bold text-fg-muted">disabled</span>}
          {sct.managed ? <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-bold text-accent-text">RUBYMIK-VPN</span> : <span className="rounded-full bg-app px-2 py-0.5 text-[10px] font-bold text-fg-muted">unmanaged</span>}
        </div>
        <div className="flex gap-1.5">
          {editable && <button onClick={() => setEditing(!editing)} className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-fg-body hover:border-accent-border"><Pencil className="h-3.5 w-3.5" /> Edit</button>}
          {editable && <button onClick={() => void act('toggle')} className="rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-fg-body hover:border-accent-border">{sct.disabled ? 'Enable' : 'Disable'}</button>}
          {editable && <button onClick={() => void act('del')} className="rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-danger-fg-strong hover:bg-danger-bg">Remove</button>}
          {!ro && !sct.managed && <button onClick={() => void act('own')} className="rounded-md border border-border-strong px-2 py-1 text-xs font-semibold text-fg-body hover:border-accent-border">Take ownership</button>}
        </div>
      </div>
      {editing && editable && <div className="px-4 pb-3"><EditSecretForm sct={sct} deviceId={deviceId} onDone={() => { setEditing(false); void reload(); }} onCancel={() => setEditing(false)} onOutcome={onOutcome} /></div>}
    </div>
  );
}

function EditSecretForm({ sct, deviceId, onDone, onCancel, onOutcome }: { sct: PppSecretView; deviceId: number; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [f, setF] = useState({ name: sct.name, password: '', service: sct.service ?? 'any', remoteAddress: sct.remoteAddress ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const up = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = { name: f.name, service: f.service, remoteAddress: f.remoteAddress || undefined };
      if (f.password) body.password = f.password;                         // blank = keep
      const o = await api.patch<ApplyOutcome>(`/api/devices/${deviceId}/vpn/secrets/${encodeURIComponent(sct.id)}`, body);
      onOutcome({ title: `Edit ${f.name}`, result: o.result, detail: o.detail, auditId: o.auditId }); onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-accent-border bg-sunken p-4">
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Account name</span><input className={inputCls} value={f.name} onChange={(e) => up('name', e.target.value)} autoComplete="off" /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Password (blank = keep)</span><input className={inputCls} type="password" autoComplete="new-password" value={f.password} onChange={(e) => up('password', e.target.value)} placeholder={sct.hasPassword ? '•••••• (set)' : ''} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Service</span>
          <select className={inputCls} value={f.service} onChange={(e) => up('service', e.target.value)}>{['any', 'l2tp', 'sstp', 'ovpn', 'pptp', 'ppp'].map((sv) => <option key={sv} value={sv}>{sv}</option>)}</select>
        </label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Remote address (optional)</span><input className={inputCls} value={f.remoteAddress} onChange={(e) => up('remoteAddress', e.target.value)} placeholder="10.20.0.50" /></label>
      </div>
      <div className="mt-3 flex gap-2">
        <button disabled={busy || !f.name} onClick={() => void submit()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Save changes</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}

function AddSecretForm({ deviceId, onDone, onCancel, onOutcome }: { deviceId: number; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [f, setF] = useState({ name: '', password: '', service: 'any', remoteAddress: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const up = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  async function submit() {
    setBusy(true); setErr(null);
    try { const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/vpn/secrets`, { name: f.name, password: f.password, service: f.service, remoteAddress: f.remoteAddress || undefined }); onOutcome({ title: `Add ${f.name}`, result: o.result, detail: o.detail, auditId: o.auditId }); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-border bg-sunken p-4">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-dim">New PPP account (password write-only)</div>
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Account name</span><input className={inputCls} value={f.name} onChange={(e) => up('name', e.target.value)} autoComplete="off" /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Password (never shown)</span><input className={inputCls} type="password" autoComplete="new-password" value={f.password} onChange={(e) => up('password', e.target.value)} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Service</span>
          <select className={inputCls} value={f.service} onChange={(e) => up('service', e.target.value)}>
            {['any', 'l2tp', 'sstp', 'ovpn', 'pptp', 'ppp'].map((sv) => <option key={sv} value={sv}>{sv}</option>)}
          </select>
        </label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Remote address (optional)</span><input className={inputCls} value={f.remoteAddress} onChange={(e) => up('remoteAddress', e.target.value)} placeholder="10.20.0.50" /></label>
      </div>
      <div className="mt-3 flex gap-2">
        <button disabled={busy || !f.name || !f.password} onClick={() => void submit()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Create</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}

// ---------------- .ovpn client profile export (no secret) ----------------

function OvpnExport({ deviceId }: { deviceId: number }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ server: '', port: '1194', proto: 'udp', caCertName: '' });
  const [config, setConfig] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const up = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  async function gen() {
    setErr(null);
    try {
      const r = await api.post<{ config: string }>(`/api/devices/${deviceId}/vpn/ovpn-config`, { server: f.server || undefined, port: Number(f.port) || undefined, proto: f.proto, caCertName: f.caCertName || undefined });
      setConfig(r.config);
    } catch (e) { setErr((e as Error).message); }
  }
  function download() {
    if (!config) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([config], { type: 'application/x-openvpn-profile' }));
    a.download = 'rubymik-client.ovpn'; a.click(); URL.revokeObjectURL(a.href);
  }
  if (!open) return <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:border-accent-border"><Download className="h-4 w-4" /> Export .ovpn client profile</button>;
  return (
    <div className="rounded-xl border border-border bg-sunken p-4">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-dim">Generate a client .ovpn profile (no key — the user pastes their own cert)</div>
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Server (blank = this router)</span><input className={inputCls} value={f.server} onChange={(e) => up('server', e.target.value)} placeholder="vpn.example.com" /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Port</span><input className={inputCls} value={f.port} onChange={(e) => up('port', e.target.value)} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Protocol</span><select className={inputCls} value={f.proto} onChange={(e) => up('proto', e.target.value)}><option value="udp">udp</option><option value="tcp">tcp</option></select></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">CA cert name</span><input className={inputCls} value={f.caCertName} onChange={(e) => up('caCertName', e.target.value)} placeholder="rubymik-ca" /></label>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => void gen()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">Generate</button>
        {config && <button onClick={download} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app"><Download className="h-4 w-4" /> Download .ovpn</button>}
        <button onClick={() => { setOpen(false); setConfig(null); }} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Close</button>
      </div>
      {config && <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-app p-3 font-mono text-[11px] leading-5 text-fg-body">{config}</pre>}
    </div>
  );
}

// ---------------- certificate store (read + generate/delete) ----------------

function CertsTab({ certs, deviceId, ro, onOutcome, reload }: { certs: CertView[]; deviceId: number; ro: boolean; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const [gen, setGen] = useState(false);
  async function del(c: CertView) {
    if (!confirm(`Remove certificate "${c.name}"? Its private key is destroyed and cannot be regenerated.`)) return;
    try { const o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/vpn/certs/${encodeURIComponent(c.id)}`); onOutcome({ title: `Remove ${c.name}`, result: o.result, detail: o.detail, auditId: o.auditId }); await reload(); }
    catch (e) { onOutcome({ title: c.name, result: 'refused', detail: (e as Error).message }); }
  }
  return (
    <div className="space-y-3">
      {certs.length === 0
        ? <div className="rounded-xl bg-sunken px-4 py-4 text-sm text-fg-muted">No certificates in the store. SSTP/OpenVPN servers need one — generate a self-signed CA below (its private key is created on the router and never leaves it).</div>
        : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[680px] text-sm">
              <thead><tr className="bg-sunken text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
                <th className="px-3 py-2">Name</th><th>Common name</th><th>Type</th><th>Private key</th><th>Valid until</th><th>Status</th><th className="pr-3 text-right"></th>
              </tr></thead>
              <tbody>
                {certs.map((c) => (
                  <tr key={c.id} className="border-t border-border-subtle">
                    <td className="px-3 py-2 font-medium text-fg-strong">{c.name}{c.ca && <span className="ml-1.5 rounded bg-accent-subtle px-1.5 py-0.5 text-[10px] font-bold text-accent-text">CA</span>}</td>
                    <td className="text-fg-body">{c.commonName ?? '—'}</td>
                    <td className="text-fg-dim">{c.keyType ?? '—'}</td>
                    <td>{c.hasPrivateKey ? <span className="inline-flex items-center gap-1 text-success-fg"><FileKey className="h-3.5 w-3.5" /> present</span> : <span className="text-fg-faint">—</span>}</td>
                    <td className="text-fg-body">{c.invalidAfter ?? '—'}</td>
                    <td>{c.expired ? <span className="rounded-full bg-danger-bg px-2 py-0.5 text-[10px] font-bold text-danger-fg-strong">expired</span> : c.trusted ? <span className="rounded-full bg-success-bg px-2 py-0.5 text-[10px] font-bold text-success-fg-strong">trusted</span> : <span className="text-fg-dim text-xs">valid</span>}</td>
                    <td className="pr-3 text-right">{!ro && <button onClick={() => void del(c)} className="rounded border border-border-strong px-1.5 py-0.5 text-xs text-danger-fg-strong hover:bg-danger-bg">remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {!ro && (gen
        ? <CertGenForm deviceId={deviceId} cas={certs.filter((c) => c.ca)} onDone={() => { setGen(false); void reload(); }} onCancel={() => setGen(false)} onOutcome={onOutcome} />
        : <button onClick={() => setGen(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse hover:bg-accent-hover"><FilePlus2 className="h-4 w-4" /> Generate certificate</button>)}
    </div>
  );
}

function CertGenForm({ deviceId, cas, onDone, onCancel, onOutcome }: { deviceId: number; cas: CertView[]; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [f, setF] = useState({ name: 'rubymik-ca', commonName: 'RubyMIK CA', kind: 'ca', daysValid: '3650', ca: cas[0]?.name ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const up = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = { name: f.name, commonName: f.commonName, kind: f.kind, daysValid: Number(f.daysValid) || undefined };
      if (f.kind !== 'ca' && f.ca) body.ca = f.ca;
      const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/vpn/certs`, body);
      onOutcome({ title: `Generate ${f.name}`, result: o.result, detail: o.detail, auditId: o.auditId }); onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-border bg-sunken p-4">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-dim">Generate certificate — the private key is created on the router and never leaves it</div>
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Name</span><input className={inputCls} value={f.name} onChange={(e) => up('name', e.target.value)} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Common name (CN)</span><input className={inputCls} value={f.commonName} onChange={(e) => up('commonName', e.target.value)} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Kind</span>
          <select className={inputCls} value={f.kind} onChange={(e) => up('kind', e.target.value)}><option value="ca">CA (self-signed)</option><option value="server">Server</option><option value="client">Client</option></select>
        </label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Valid (days)</span><input className={inputCls} value={f.daysValid} onChange={(e) => up('daysValid', e.target.value)} /></label>
        {f.kind !== 'ca' && (
          <label className="sm:col-span-2"><span className="mb-1 block text-xs font-semibold text-fg-dim">Sign with CA</span>
            <select className={inputCls} value={f.ca} onChange={(e) => up('ca', e.target.value)}><option value="">(self-signed)</option>{cas.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</select>
          </label>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <button disabled={busy || !f.name || !f.commonName} onClick={() => void submit()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Generate &amp; sign</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}
