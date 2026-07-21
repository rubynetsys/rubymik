import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Link2, Lock, Plus, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react';
import { api } from '../api';
import type { ApplyOutcome, SiteToSiteResult, WgInterfaceView, WireguardView } from '../types';

const inputCls = 'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong';
type SetOutcome = (o: { title: string; result: string; detail: string; auditId?: number }) => void;

export default function WireguardManager({ deviceId }: { deviceId: number }) {
  const [view, setView] = useState<WireguardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ title: string; result: string; detail: string; auditId?: number } | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try { setView(await api.get<WireguardView>(`/api/devices/${deviceId}/wireguard`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load WireGuard: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;
  if (!view.supported) return <div className="rounded-xl bg-sunken px-4 py-4 text-sm text-fg-muted">This device's RouterOS build does not expose WireGuard.</div>;
  const ro = !view.manageable;

  return (
    <div className="space-y-4">
      {ro && (
        <div className="flex items-center gap-2 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted">
          <Lock className="h-4 w-4" /> Monitor-only — VPN shown read-only. Add a write credential (Edit device) to configure it.
        </div>
      )}
      {view.interfaces.length === 0 && <div className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-muted">No WireGuard interfaces yet.</div>}

      {view.interfaces.map((iface) => <IfaceCard key={iface.id} iface={iface} ro={ro} deviceId={deviceId} onOutcome={setOutcome} reload={load} />)}

      {!ro && (adding
        ? <AddIfaceForm deviceId={deviceId} onDone={() => { setAdding(false); void load(); }} onCancel={() => setAdding(false)} onOutcome={setOutcome} />
        : <button onClick={() => setAdding(true)} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover"><Plus className="h-4 w-4" /> Create WireGuard interface</button>
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
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-fg-dim">{outcome.detail}</p>
            {outcome.auditId && <p className="mt-2 text-xs text-fg-faint">Audit #{outcome.auditId} · snapshot → apply → verify-reachable → audit</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function IfaceCard({ iface, ro, deviceId, onOutcome, reload }: { iface: WgInterfaceView; ro: boolean; deviceId: number; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const [addPeer, setAddPeer] = useState(false);
  const [s2s, setS2s] = useState(false);
  const mgmt = iface.role === 'mgmt';
  const managed = iface.role === 'user-managed';
  const editable = !ro && !mgmt;

  async function remove() {
    if (!confirm(`Remove WireGuard interface ${iface.name} and its peers?`)) return;
    try { const o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/wireguard/interfaces/${encodeURIComponent(iface.id)}`); onOutcome({ title: `Remove ${iface.name}`, result: o.result, detail: o.detail, auditId: o.auditId }); await reload(); }
    catch (e) { onOutcome({ title: `Remove ${iface.name}`, result: 'refused', detail: (e as Error).message }); }
  }
  async function removePeer(peerId: string) {
    try { const o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/wireguard/peers/${encodeURIComponent(peerId)}`); onOutcome({ title: 'Remove peer', result: o.result, detail: o.detail, auditId: o.auditId }); await reload(); }
    catch (e) { onOutcome({ title: 'Remove peer', result: 'refused', detail: (e as Error).message }); }
  }

  return (
    <section className={`rounded-2xl border p-4 shadow-sm ${mgmt ? 'border-danger-line bg-danger-bg/30' : 'border-border bg-surface'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <KeyRound className={`h-4 w-4 ${mgmt ? 'text-danger-fg-strong' : 'text-accent'}`} />
          <span className="font-bold text-fg-strong">{iface.name}</span>
          <span className="text-xs text-fg-dim">{iface.running ? 'running' : 'down'}{iface.listenPort ? ` · udp/${iface.listenPort}` : ''}</span>
          {mgmt && <span className="inline-flex items-center gap-1 rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-bold text-danger-fg-strong"><ShieldCheck className="h-3 w-3" /> MGMT TUNNEL — PROTECTED</span>}
          {managed && <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-bold text-accent-text">RUBYMIK-VPN</span>}
        </div>
        {editable && <button onClick={() => void remove()} className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-danger-fg-strong hover:bg-danger-bg"><Trash2 className="h-3.5 w-3.5" /> Remove</button>}
      </div>

      {mgmt && <p className="mt-1 text-xs text-danger-fg-strong">This is the RubyMIK management tunnel (P9). It is read-only here — user-VPN config can't modify or reroute it.</p>}

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Public key</dt><dd className="mt-0.5 break-all font-mono text-xs text-fg">{iface.publicKey ?? '—'}</dd></div>
        <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Addresses</dt><dd className="mt-0.5 font-mono text-xs text-fg">{iface.addresses.join(', ') || '—'}</dd></div>
      </dl>

      {iface.peers.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[560px] text-xs">
            <thead><tr className="text-left font-semibold uppercase tracking-wide text-fg-faint"><th className="px-3 py-1.5">Peer public key</th><th>Endpoint</th><th>Allowed IPs</th><th>PSK</th><th>Handshake</th><th className="pr-3 text-right"></th></tr></thead>
            <tbody>
              {iface.peers.map((p) => (
                <tr key={p.id} className="border-t border-border-subtle">
                  <td className="px-3 py-1.5 break-all font-mono">{p.publicKey?.slice(0, 20) ?? '—'}…</td>
                  <td className="text-fg-body">{p.endpoint ?? '—'}</td>
                  <td className="font-mono text-fg-body">{p.allowedAddress ?? '—'}</td>
                  <td>{p.hasPresharedKey ? <span className="text-success-fg">set</span> : <span className="text-fg-faint">—</span>}</td>
                  <td className="text-fg-dim">{p.lastHandshake ?? 'never'}</td>
                  <td className="pr-3 text-right">{editable && <button onClick={() => void removePeer(p.id)} className="rounded border border-border-strong px-1.5 py-0.5 text-danger-fg-strong hover:bg-danger-bg">remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editable && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => setAddPeer(!addPeer)} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-fg-body hover:border-accent-border hover:text-accent-text"><Plus className="h-3.5 w-3.5" /> Add peer</button>
          <button onClick={() => setS2s(!s2s)} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-fg-body hover:border-accent-border hover:text-accent-text"><Link2 className="h-3.5 w-3.5" /> Site-to-site helper</button>
        </div>
      )}
      {addPeer && editable && <AddPeerForm deviceId={deviceId} iface={iface.name} onDone={() => { setAddPeer(false); void reload(); }} onOutcome={onOutcome} />}
      {s2s && editable && <SiteToSiteForm deviceId={deviceId} iface={iface.name} />}
    </section>
  );
}

function AddIfaceForm({ deviceId, onDone, onCancel, onOutcome }: { deviceId: number; onDone: () => void; onCancel: () => void; onOutcome: SetOutcome }) {
  const [name, setName] = useState('vpn-site');
  const [port, setPort] = useState('13231');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setErr(null);
    try { const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/wireguard/interfaces`, { name, listenPort: port ? Number(port) : null }); onOutcome({ title: `Create ${name}`, result: o.result, detail: o.detail, auditId: o.auditId }); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-border bg-sunken p-4">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-dim">New WireGuard interface (router generates its own private key)</div>
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="flex flex-wrap items-end gap-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Name</span><input className={`${inputCls} w-44`} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Listen port</span><input className={`${inputCls} w-28`} value={port} onChange={(e) => setPort(e.target.value)} /></label>
        <button disabled={busy || !name} onClick={() => void submit()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Create</button>
        <button onClick={onCancel} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Cancel</button>
      </div>
    </div>
  );
}

function AddPeerForm({ deviceId, iface, onDone, onOutcome }: { deviceId: number; iface: string; onDone: () => void; onOutcome: SetOutcome }) {
  const [publicKey, setPublicKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [allowedAddress, setAllowed] = useState('');
  const [psk, setPsk] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setErr(null);
    try { const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/wireguard/interfaces/${encodeURIComponent(iface)}/peers`, { publicKey, endpoint, allowedAddress, keepalive: '25s', presharedKey: psk || undefined }); onOutcome({ title: `Add peer on ${iface}`, result: o.result, detail: o.detail, auditId: o.auditId }); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="mt-3 rounded-xl border border-border bg-sunken p-4">
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Peer public key</span><input className={inputCls} value={publicKey} onChange={(e) => setPublicKey(e.target.value)} placeholder="44-char base64" /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Endpoint (host:port)</span><input className={inputCls} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="vpn.example.com:51820" /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Allowed IPs (CIDR)</span><input className={inputCls} value={allowedAddress} onChange={(e) => setAllowed(e.target.value)} placeholder="10.20.0.0/24" /></label>
        <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Preshared key (optional, never shown)</span><input className={inputCls} type="password" autoComplete="new-password" value={psk} onChange={(e) => setPsk(e.target.value)} /></label>
      </div>
      <button disabled={busy || !publicKey || !allowedAddress} onClick={() => void submit()} className="mt-3 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Add peer</button>
    </div>
  );
}

function SiteToSiteForm({ deviceId, iface }: { deviceId: number; iface: string }) {
  const [f, setF] = useState({ localEndpoint: '', localPort: '13231', localSubnet: '', remotePub: '', remoteEndpoint: '', remotePort: '13231', remoteSubnet: '' });
  const [out, setOut] = useState<SiteToSiteResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const up = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  async function gen() {
    setErr(null);
    try {
      setOut(await api.post<SiteToSiteResult>(`/api/devices/${deviceId}/wireguard/site-to-site`, {
        localIface: iface,
        local: { endpoint: f.localEndpoint, port: Number(f.localPort), tunnelSubnet: f.localSubnet },
        remote: { publicKey: f.remotePub, endpoint: f.remoteEndpoint, port: Number(f.remotePort), tunnelSubnet: f.remoteSubnet },
      }));
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="mt-3 rounded-xl border border-border bg-sunken p-4">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-dim">Site-to-site — generate matched config for both ends</div>
      {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <input className={inputCls} value={f.localEndpoint} onChange={(e) => up('localEndpoint', e.target.value)} placeholder="local endpoint host" />
        <input className={inputCls} value={f.localSubnet} onChange={(e) => up('localSubnet', e.target.value)} placeholder="local subnet 10.10.0.0/24" />
        <input className={inputCls} value={f.remotePub} onChange={(e) => up('remotePub', e.target.value)} placeholder="remote public key" />
        <input className={inputCls} value={f.remoteEndpoint} onChange={(e) => up('remoteEndpoint', e.target.value)} placeholder="remote endpoint host" />
        <input className={inputCls} value={f.remoteSubnet} onChange={(e) => up('remoteSubnet', e.target.value)} placeholder="remote subnet 10.20.0.0/24" />
      </div>
      <button onClick={() => void gen()} className="mt-3 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">Generate matched config</button>
      {out && (
        <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-app p-3 font-mono text-[11px] leading-5 text-fg-body">{out.remoteScript}</pre>
      )}
    </div>
  );
}
