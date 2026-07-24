import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Globe, Loader2, Plus, RadioTower, ShieldCheck, X, CheckCircle2,
  AlertTriangle, Link2, Clock, Boxes, Terminal, HelpCircle, RefreshCw,
} from 'lucide-react';
import { api } from '../api';
import type { RemoteAccessView, PeerView, HubCapability, HubStatus } from '../types';
import { phaseFor } from '../lib/hubphase';
import CodeBlock from '../components/CodeBlock';

const inputCls = 'w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong focus:ring-2 focus:ring-accent-border-strong/20';
const REFRESH_MS = 5000;

export default function RemoteAccess() {
  const [view, setView] = useState<RemoteAccessView | null>(null);
  const [cap, setCap] = useState<HubCapability | null>(null);
  const [capErr, setCapErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [bootstrapFor, setBootstrapFor] = useState<{ peer: PeerView; bootstrap: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<RemoteAccessView>('/api/remote-access')); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }, []);
  // Capability is checked at page LOAD (and on demand), not on the status poll —
  // it's a per-boot fact, and its live probe shouldn't run every few seconds.
  const checkCapability = useCallback(async () => {
    setChecking(true);
    try { setCap(await api.get<HubCapability>('/api/remote-access/capability')); setCapErr(null); }
    catch (e) { setCapErr((e as Error).message); } finally { setChecking(false); }
  }, []);
  useEffect(() => {
    void load(); void checkCapability();
    timer.current = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load, checkCapability]);

  if (err && !view) return <div className="rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger-fg-strong">Could not load remote access: {err}</div>;
  if (!view || !cap) return <div className="h-40 animate-pulse rounded-xl bg-border" />;
  const hub = view.hub;
  const phase = phaseFor(cap.capable, hub.enabled);

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
        {/* Enable is offered ONLY when the container is actually capable. */}
        {phase !== 'setup' && hub.configured && <EnableToggle enabled={hub.enabled} onChange={load} />}
      </header>

      {phase === 'setup' && <SetupCard cap={cap} hub={hub} checking={checking} onRecheck={checkCapability} capErr={capErr} />}

      {phase === 'ready' && (
        <>
          <CapabilityReady />
          {!hub.configured
            ? <HubConfigCard onSaved={load} first />
            : <>
                <HubStatusCard view={view} />
                <HubConfigCard onSaved={load} initial={{ endpoint: hub.endpoint ?? '', listenPort: hub.listenPort, overlayCidr: hub.overlayCidr }} />
              </>}
        </>
      )}

      {phase === 'running' && (
        <>
          <HubStatusCard view={view} />
          <HubConfigCard onSaved={load} initial={{ endpoint: hub.endpoint ?? '', listenPort: hub.listenPort, overlayCidr: hub.overlayCidr }} />
          <SitesCard view={view} onShowBootstrap={setBootstrapFor} reload={load} />
        </>
      )}

      {bootstrapFor && (
        <BootstrapModal
          peer={bootstrapFor.peer} bootstrap={bootstrapFor.bootstrap}
          onClose={() => setBootstrapFor(null)} reload={load}
        />
      )}
    </div>
  );
}

function CapabilityReady() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-success-line bg-success-bg/50 px-4 py-2.5 text-sm text-success-fg">
      <CheckCircle2 className="h-4 w-4 shrink-0" /> This container can run the WireGuard hub (NET_ADMIN + WireGuard detected). Configure the endpoint, then Enable.
    </div>
  );
}

function CapPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg-strong'}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />} {label}
    </span>
  );
}

function SetupCard({ cap, hub, checking, onRecheck, capErr }: { cap: HubCapability; hub: HubStatus; checking: boolean; onRecheck: () => Promise<void>; capErr: string | null }) {
  const [tab, setTab] = useState<'portainer' | 'cli' | 'about'>('portainer');
  const tabs = [
    { id: 'portainer', label: 'Portainer / single stack', Icon: Boxes },
    { id: 'cli', label: 'docker compose CLI', Icon: Terminal },
    { id: 'about', label: 'What is this?', Icon: HelpCircle },
  ] as const;
  return (
    <div className="rounded-2xl border border-accent-border bg-surface p-5">
      <div className="flex items-start gap-2.5">
        <RadioTower className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
        <div>
          <h2 className="font-bold text-fg-strong">Enable remote access — one server-side step</h2>
          <p className="mt-1 text-sm text-fg-dim">{cap.reason}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <CapPill ok={cap.checks.netAdmin} label="NET_ADMIN (root)" />
        <CapPill ok={cap.wireguard} label="WireGuard available" />
      </div>

      {hub.enabled && hub.runtimeError && (
        <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">Remote access is switched on but can't run here: {hub.runtimeError}</div>
      )}

      <div className="mt-4 flex flex-wrap gap-1 border-b border-border">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`-mb-px inline-flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-sm font-semibold ${tab === t.id ? 'border-accent bg-app text-fg-strong' : 'border-transparent text-fg-muted hover:text-fg'}`}>
            <t.Icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      <div className="pt-4">
        {tab === 'portainer' && (
          <div className="space-y-3">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-body">
              <li>In Portainer: <b>Stacks → your RubyMIK stack → Editor</b>.</li>
              <li><b>Replace</b> the editor contents with the file below — your ports, volumes and environment are reproduced as-is; only the WireGuard lines are added.</li>
              <li>Click <b>Update the stack</b>, then reload this page.</li>
            </ol>
            {cap.mainHostPort != null ? (
              <p className="text-xs text-fg-dim">Detected your host port as <b className="text-fg-body">{cap.mainHostPort}</b> and reproduced it exactly (no assumed 8080, no extra published ports).</p>
            ) : (
              <p className="rounded-lg bg-warning-bg/60 px-3 py-2 text-xs text-warning-fg">Couldn't auto-detect your host port — the file has a <b>“set your host port”</b> comment where it belongs. Set it to the port you open RubyMIK on before applying (don't leave a wrong default).</p>
            )}
            <CodeBlock code={cap.compose.portainer} label="docker-compose.yml (complete)" filename="docker-compose.yml" />
            <p className="text-xs text-fg-dim">Also open <b>UDP {cap.listenPort}</b> on your host / cloud firewall so remote routers can reach the hub.</p>
          </div>
        )}
        {tab === 'cli' && (
          <div className="space-y-3">
            <p className="text-sm text-fg-body">From the directory that holds your <code className="rounded bg-app px-1">docker-compose.yml</code>, run the opt-in override — it adds NET_ADMIN, root, the UDP port and <code className="rounded bg-app px-1">/dev/net/tun</code>:</p>
            <CodeBlock code={cap.compose.cli} label="shell" maxHeightClass="" />
            <p className="text-xs text-fg-dim">Then open <b>UDP {cap.listenPort}</b> on your host / cloud firewall, and reload this page.</p>
          </div>
        )}
        {tab === 'about' && (
          <div className="space-y-3 text-sm text-fg-body">
            <p><b>Why one server-side step?</b> Remote access turns RubyMIK into a small WireGuard VPN hub that behind-NAT routers dial into. Creating and managing a VPN network interface is a privileged operation — a container can't do it unless it was started with the <code className="rounded bg-app px-1">NET_ADMIN</code> capability, as root.</p>
            <p><b>Why can't RubyMIK just do it for me?</b> A running container cannot grant itself new capabilities — that's Docker's security model, by design, not a RubyMIK limitation. The capability has to be set when the container is (re)created, which is why it's a one-time change to your compose/stack.</p>
            <p><b>Do I even need this?</b> Only to manage routers that aren't on your network. If every device you manage is on the same LAN, you never need remote access — leave it off and none of this applies.</p>
            <p className="text-fg-dim">RubyMIK checks for the capability before offering the Enable button, so clicking can never produce a cryptic kernel error.</p>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
        <p className="text-xs text-fg-dim">After you recreate the container, reload this page — Enable appears automatically.</p>
        <button onClick={() => void onRecheck()} disabled={checking} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-fg-body hover:bg-app disabled:opacity-50">
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Re-check
        </button>
      </div>
      {capErr && <div className="mt-2 text-xs text-danger-fg">Capability check failed: {capErr}</div>}
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
  const [pubkey, setPubkey] = useState('');
  const [name, setName] = useState(peer.label);
  const [ru, setRu] = useState(''); const [rp, setRp] = useState('');
  const [wu, setWu] = useState(''); const [wp, setWp] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
            <div className="mb-1.5 font-semibold text-fg">1. Apply this once on the router (WinBox → New Terminal, or SSH)</div>
            <CodeBlock code={bootstrap} label="bootstrap.rsc" filename={`rubymik-bootstrap-${peer.tunnelIp}.rsc`} maxHeightClass="max-h-56" />
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

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label}</dt>
      <dd className={`mt-0.5 truncate text-sm font-medium text-fg ${mono ? 'font-mono text-xs' : ''}`} title={value}>{value}</dd>
    </div>
  );
}
