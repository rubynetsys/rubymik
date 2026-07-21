import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Globe, Loader2, Lock, Plus, RadioTower, ShieldCheck, X, Copy, CheckCircle2,
  AlertTriangle, Link2, Clock,
} from 'lucide-react';
import { api } from '../api';
import type { RemoteAccessView, PeerView } from '../types';

const inputCls = 'w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong focus:ring-2 focus:ring-accent-border-strong/20';
const REFRESH_MS = 5000;

export default function RemoteAccess() {
  const [view, setView] = useState<RemoteAccessView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bootstrapFor, setBootstrapFor] = useState<{ peer: PeerView; bootstrap: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<RemoteAccessView>('/api/remote-access')); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => {
    void load();
    timer.current = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  if (err && !view) return <div className="rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger-fg-strong">Could not load remote access: {err}</div>;
  if (!view) return <div className="h-40 animate-pulse rounded-xl bg-border" />;
  const hub = view.hub;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-fg-strong"><RadioTower className="h-6 w-6 text-accent" /> Remote Access</h1>
          <p className="mt-1 max-w-2xl text-sm text-fg-dim">
            Optional. Manage routers that are behind NAT with no direct network path — they dial an
            outbound WireGuard tunnel into RubyMIK. Your same-LAN devices don't need any of this.
          </p>
        </div>
        {hub.configured && <EnableToggle enabled={hub.enabled} onChange={load} />}
      </header>

      {!hub.configured ? (
        <HubConfigCard onSaved={load} first />
      ) : (
        <>
          <HubStatusCard view={view} />
          <HubConfigCard onSaved={load} initial={{ endpoint: hub.endpoint ?? '', listenPort: hub.listenPort, overlayCidr: hub.overlayCidr }} />
          <SitesCard view={view} onShowBootstrap={setBootstrapFor} reload={load} />
        </>
      )}

      <DockerNote />

      {bootstrapFor && (
        <BootstrapModal
          peer={bootstrapFor.peer} bootstrap={bootstrapFor.bootstrap}
          onClose={() => setBootstrapFor(null)} reload={load}
        />
      )}
    </div>
  );
}

function EnableToggle({ enabled, onChange }: { enabled: boolean; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function toggle() {
    setBusy(true); setErr(null);
    try { await api.post('/api/remote-access/hub/enable', { enabled: !enabled }); await onChange(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="text-right">
      <button onClick={() => void toggle()} disabled={busy}
        className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-inverse transition disabled:opacity-50 ${enabled ? 'bg-fg-muted hover:bg-fg-dim' : 'bg-success hover:bg-success-strong'}`}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RadioTower className="h-4 w-4" />}
        {enabled ? 'Disable remote access' : 'Enable remote access'}
      </button>
      {err && <div className="mt-1 max-w-xs text-xs text-danger-fg">{err}</div>}
    </div>
  );
}

function HubStatusCard({ view }: { view: RemoteAccessView }) {
  const h = view.hub;
  const stateCls = !h.enabled ? 'bg-app text-fg-muted'
    : h.running ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg';
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-dim"><Globe className="h-4 w-4" /> Hub</h2>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${stateCls}`}>
          {h.running ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
          {!h.enabled ? 'disabled' : h.running ? 'running' : 'not running'}
        </span>
      </div>
      {h.enabled && !h.running && h.runtimeError && (
        <div className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">
          Hub could not start: {h.runtimeError}
        </div>
      )}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <Meta label="Endpoint (routers dial)" value={h.endpoint ? `${h.endpoint}:${h.listenPort}` : '—'} />
        <Meta label="Overlay" value={h.overlayCidr} />
        <Meta label="Hub address" value={h.hubAddress} />
        <Meta label="Hub public key" value={h.publicKey ?? '—'} mono />
      </dl>
    </div>
  );
}

function HubConfigCard({ onSaved, initial, first }: { onSaved: () => Promise<void>; initial?: { endpoint: string; listenPort: number; overlayCidr: string }; first?: boolean }) {
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? '');
  const [port, setPort] = useState(String(initial?.listenPort ?? 51820));
  const [overlay, setOverlay] = useState(initial?.overlayCidr ?? '10.9.0.0/24');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(!!first);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.post('/api/remote-access/hub', { endpoint: endpoint.trim(), listenPort: Number(port), overlayCidr: overlay.trim() });
      await onSaved();
      if (!first) setOpen(false);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (!first && !open) {
    return <button onClick={() => setOpen(true)} className="text-sm font-medium text-accent-text hover:underline">Edit hub configuration</button>;
  }
  return (
    <div className={`rounded-2xl border p-5 ${first ? 'border-accent-border bg-accent-subtle/40' : 'border-border bg-surface'}`}>
      <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-fg-dim">{first ? 'Set up the hub' : 'Hub configuration'}</h2>
      <p className="mb-4 text-xs text-fg-dim">RubyMIK needs a reachable endpoint (public IP or hostname) that remote routers can dial. Open the UDP port on your host/cloud firewall.</p>
      {err && <div className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{err}</div>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">Endpoint (public IP / hostname)</span>
          <input className={inputCls} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="vpn.example.com or 203.0.113.10" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">UDP port</span>
          <input className={inputCls} value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">Overlay subnet (CIDR)</span>
          <input className={inputCls} value={overlay} onChange={(e) => setOverlay(e.target.value)} placeholder="10.9.0.0/24" />
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        {!first && <button onClick={() => setOpen(false)} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>}
        <button onClick={() => void save()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save hub
        </button>
      </div>
    </div>
  );
}

const STATE_META: Record<string, { label: string; cls: string }> = {
  recent: { label: 'connected', cls: 'bg-success-bg text-success-fg' },
  stale: { label: 'stale', cls: 'bg-warning-bg text-warning-fg' },
  never: { label: 'never connected', cls: 'bg-app text-fg-dim' },
};

function SitesCard({ view, onShowBootstrap, reload }: { view: RemoteAccessView; onShowBootstrap: (v: { peer: PeerView; bootstrap: string }) => void; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ peer: PeerView; bootstrap: string }>('/api/remote-access/sites', { label: label.trim() });
      setAdding(false); setLabel(''); await reload();
      onShowBootstrap(r);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function showBootstrap(peer: PeerView) {
    const r = await api.get<{ bootstrap: string }>(`/api/remote-access/sites/${peer.id}/bootstrap`);
    onShowBootstrap({ peer, bootstrap: r.bootstrap });
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-dim"><ShieldCheck className="h-4 w-4" /> Remote sites · {view.peers.length}</h2>
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1 text-sm font-semibold text-accent-text hover:underline"><Plus className="h-4 w-4" /> Add remote site</button>
      </div>
      {adding && (
        <div className="mb-3 rounded-xl border border-border p-3">
          {err && <div className="mb-2 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{err}</div>}
          <div className="flex items-end gap-2">
            <label className="block flex-1">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">Site label</span>
              <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Cape Town branch" autoFocus />
            </label>
            <button onClick={() => void add()} disabled={busy || !label.trim()} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Create</button>
            <button onClick={() => { setAdding(false); setErr(null); }} className="rounded-lg border border-border-strong px-3 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>
          </div>
        </div>
      )}
      {view.peers.length === 0 ? (
        <div className="rounded-lg bg-sunken px-3 py-6 text-center text-sm text-fg-dim">No remote sites yet. Add one to generate its bootstrap script.</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border-subtle">
          {view.peers.map((p) => {
            const live = view.live[p.id];
            const state = !p.hasKey ? 'pending-key' : live?.state ?? 'never';
            const meta = STATE_META[state] ?? { label: 'pending key', cls: 'bg-info-bg text-info-fg' };
            return (
              <div key={p.id} className="flex items-center gap-3 border-b border-border-subtle px-4 py-3 text-sm last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-fg">{p.label}</div>
                  <div className="font-mono text-xs text-fg-dim">{p.tunnelIp}
                    {p.deviceId && <> · <a href={`/devices/${p.deviceId}`} className="text-accent-text hover:underline">{p.deviceName ?? `device #${p.deviceId}`}</a></>}
                  </div>
                </div>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${meta.cls}`}>
                  {state === 'recent' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}{meta.label}
                </span>
                <button onClick={() => void showBootstrap(p)} className="rounded-md px-2.5 py-1 text-xs font-semibold text-fg-muted hover:bg-app">Bootstrap</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BootstrapModal({ peer, bootstrap, onClose, reload }: { peer: PeerView; bootstrap: string; onClose: () => void; reload: () => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [pubkey, setPubkey] = useState('');
  const [name, setName] = useState(peer.label);
  const [ru, setRu] = useState(''); const [rp, setRp] = useState('');
  const [wu, setWu] = useState(''); const [wp, setWp] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function copy() {
    try { await navigator.clipboard.writeText(bootstrap); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  }
  async function register() {
    setBusy(true); setErr(null); setMsg(null);
    try { await api.post(`/api/remote-access/sites/${peer.id}/register`, { publicKey: pubkey.trim() }); setMsg('Public key registered — the hub is reconciling. Watch the tunnel status.'); await reload(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function adopt() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api.post(`/api/remote-access/sites/${peer.id}/device`, { name: name.trim(), username: ru, password: rp, writeUsername: wu || undefined, writePassword: wp || undefined });
      setMsg('Device adopted over the tunnel. It will appear in Devices/Fleet, reached via the overlay.'); await reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-fg-strong">Onboard “{peer.label}” <span className="font-mono text-sm text-fg-dim">({peer.tunnelIp})</span></h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button>
        </div>

        <ol className="mt-4 space-y-4 text-sm">
          <li>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-semibold text-fg">1. Apply this once on the router (WinBox → New Terminal, or SSH)</span>
              <button onClick={() => void copy()} className="inline-flex items-center gap-1 rounded-md bg-fg px-2.5 py-1 text-xs font-semibold text-inverse hover:bg-fg-body">
                {copied ? <><CheckCircle2 className="h-3.5 w-3.5" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}
              </button>
            </div>
            <pre className="max-h-56 overflow-auto rounded-lg bg-sidebar p-3 text-[11px] leading-relaxed text-inverse"><code>{bootstrap}</code></pre>
            <p className="mt-1 text-xs text-fg-dim">The router generates its own private key — nothing in this script is secret.</p>
          </li>
          <li>
            <div className="mb-1.5 font-semibold text-fg">2. Paste the public key the script printed (<span className="font-mono text-xs">RUBYMIK_PUBKEY=…</span>)</div>
            <div className="flex items-end gap-2">
              <input className={inputCls} value={pubkey} onChange={(e) => setPubkey(e.target.value)} placeholder="router WireGuard public key" />
              <button onClick={() => void register()} disabled={busy || !pubkey.trim()} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50"><Link2 className="h-4 w-4" /> Register</button>
            </div>
          </li>
          <li>
            <div className="mb-1.5 font-semibold text-fg">3. Adopt the router as a managed device (reached over the tunnel)</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Device name" />
              <div />
              <input className={inputCls} value={ru} onChange={(e) => setRu(e.target.value)} placeholder="Monitoring username (read)" />
              <input className={inputCls} type="password" value={rp} onChange={(e) => setRp(e.target.value)} placeholder="Monitoring password" />
              <input className={inputCls} value={wu} onChange={(e) => setWu(e.target.value)} placeholder="Write username (optional)" />
              <input className={inputCls} type="password" value={wp} onChange={(e) => setWp(e.target.value)} placeholder="Write password (optional)" />
            </div>
            <div className="mt-2 flex justify-end">
              <button onClick={() => void adopt()} disabled={busy || !ru || !rp} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Adopt device</button>
            </div>
          </li>
        </ol>

        {msg && <div className="mt-4 rounded-lg bg-success-bg px-3 py-2 text-sm text-success-fg">{msg}</div>}
        {err && <div className="mt-4 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{err}</div>}
      </div>
    </div>
  );
}

function DockerNote() {
  return (
    <div className="rounded-2xl border border-warning-line bg-warning-bg/60 p-4 text-xs text-warning-fg">
      <div className="mb-1 flex items-center gap-1.5 font-bold uppercase tracking-wide"><Lock className="h-3.5 w-3.5" /> Docker requirement</div>
      Running the WireGuard hub needs the container started with <code className="rounded bg-warning-bg px-1">NET_ADMIN</code>, as root, and the UDP port published — supplied by the opt-in override:
      <pre className="mt-2 overflow-auto rounded bg-sidebar p-2 text-[11px] text-inverse"><code>docker compose -f docker-compose.yml -f docker-compose.wireguard.yml up -d --build</code></pre>
      The default (LAN-only) deployment needs none of this and is completely unaffected.
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label}</dt>
      <dd className={`mt-0.5 truncate text-sm font-medium text-fg ${mono ? 'font-mono text-xs' : ''}`} title={value}>{value}</dd>
    </div>
  );
}
