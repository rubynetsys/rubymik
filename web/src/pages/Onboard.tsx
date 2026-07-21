import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Wand2, Network, RadioTower, ShieldCheck, ShieldQuestion, Loader2, CheckCircle2, AlertTriangle,
  Copy, Link2, ArrowRight, ArrowLeft, Server, Lock, Eye, Archive, Clock, Building2, X,
} from 'lucide-react';
import { api } from '../api';
import type { RemoteAccessView, Site } from '../types';

/**
 * Existing-router onboarding wizard (P10). Orchestrates P0 (add/identify), P9
 * (tunnel/transport) and P7 (backup) into a guided flow whose default posture is
 * TOUCH NOTHING: monitor-only is the baseline, every write is explicit opt-in.
 */

type Path = 'direct' | 'tunnel';
interface DeviceInfo { identity: string | null; model: string | null; boardName: string | null; serialNumber: string | null; version: string; }
const inputCls = 'w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none transition focus:border-ruby-500 focus:ring-2 focus:ring-ruby-500/20';

export default function Onboard() {
  const nav = useNavigate();
  const [path, setPath] = useState<Path | null>(null);
  const [step, setStep] = useState(0); // index into the active step list

  // shared state
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [readUser, setReadUser] = useState('');
  const [readPass, setReadPass] = useState('');
  const [wantWrite, setWantWrite] = useState(false);
  const [writeUser, setWriteUser] = useState('');
  const [writePass, setWritePass] = useState('');
  const [info, setInfo] = useState<DeviceInfo | null>(null);

  // tunnel state
  const [hub, setHub] = useState<RemoteAccessView['hub'] | null>(null);
  const [peerId, setPeerId] = useState<number | null>(null);
  const [tunnelIp, setTunnelIp] = useState('');
  const [bootstrap, setBootstrap] = useState('');
  const [pubkey, setPubkey] = useState('');
  const [handshake, setHandshake] = useState(false);

  // site + extras + result
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<number | ''>('');
  const [newSiteName, setNewSiteName] = useState('');
  const [backupNow, setBackupNow] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [result, setResult] = useState<{ deviceId: number; siteName: string | null; backupTaken: boolean } | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api.get<Site[]>('/api/sites').then(setSites).catch(() => {}); }, []);
  useEffect(() => { api.get<RemoteAccessView>('/api/remote-access').then((r) => setHub(r.hub)).catch(() => {}); }, []);

  const STEPS: Record<Path, string[]> = {
    direct: ['Identify', 'Management', 'Site', 'Extras', 'Finish'],
    tunnel: ['Tunnel', 'Identify', 'Management', 'Site', 'Extras', 'Finish'],
  };
  const steps = path ? STEPS[path] : [];
  const cur = steps[step];

  function reset() { setPath(null); setStep(0); setInfo(null); setResult(null); setErr(null); }
  const go = (d: 1 | -1) => { setErr(null); setStep((s) => Math.max(0, Math.min(steps.length - 1, s + d))); };

  if (result) return <DoneSummary path={path!} result={result} wantWrite={wantWrite} onDone={() => nav(`/devices/${result.deviceId}`)} onAnother={reset} />;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-zinc-900"><Wand2 className="h-6 w-6 text-ruby-600" /> Onboard a router</h1>
        <p className="mt-1 text-sm text-zinc-500">Bring an existing, live MikroTik under RubyMIK management — same-LAN or behind NAT.</p>
      </header>

      <DoNoHarmBanner />

      {!path ? (
        <PathChooser hub={hub} onPick={(p) => { setPath(p); setStep(0); }} />
      ) : (
        <div className="rounded-2xl border border-zinc-200 bg-white p-6">
          <StepBar steps={steps} step={step} />
          {err && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}

          {cur === 'Tunnel' && (
            <TunnelStep
              hub={hub} name={name} setName={setName} peerId={peerId} tunnelIp={tunnelIp} bootstrap={bootstrap}
              pubkey={pubkey} setPubkey={setPubkey} handshake={handshake} setHandshake={setHandshake}
              busy={busy} setBusy={setBusy} setErr={setErr}
              onProvisioned={(pid, ip, bs) => { setPeerId(pid); setTunnelIp(ip); setBootstrap(bs); }}
            />
          )}

          {cur === 'Identify' && (
            <IdentifyStep
              path={path} name={name} setName={setName} host={host} setHost={setHost} tunnelIp={tunnelIp}
              readUser={readUser} setReadUser={setReadUser} readPass={readPass} setReadPass={setReadPass}
              info={info} setInfo={setInfo} busy={busy} setBusy={setBusy} setErr={setErr}
            />
          )}

          {cur === 'Management' && (
            <ManagementStep wantWrite={wantWrite} setWantWrite={setWantWrite} writeUser={writeUser} setWriteUser={setWriteUser} writePass={writePass} setWritePass={setWritePass} />
          )}

          {cur === 'Site' && (
            <SiteStep sites={sites} siteId={siteId} setSiteId={setSiteId} newSiteName={newSiteName} setNewSiteName={setNewSiteName} />
          )}

          {cur === 'Extras' && (
            <ExtrasStep backupNow={backupNow} setBackupNow={setBackupNow} scheduled={scheduled} setScheduled={setScheduled} manageable={wantWrite} />
          )}

          {cur === 'Finish' && (
            <ReviewStep
              path={path} name={name} host={host} tunnelIp={tunnelIp} info={info} wantWrite={wantWrite}
              siteName={siteLabel(sites, siteId, newSiteName)} backupNow={backupNow} scheduled={scheduled}
            />
          )}

          <div className="mt-6 flex items-center justify-between">
            <button onClick={() => (step === 0 ? reset() : go(-1))} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-zinc-600 hover:bg-zinc-100">
              <ArrowLeft className="h-4 w-4" /> {step === 0 ? 'Change path' : 'Back'}
            </button>
            {cur === 'Finish' ? (
              <FinishButton
                path={path} name={name} host={host} readUser={readUser} readPass={readPass}
                wantWrite={wantWrite} writeUser={writeUser} writePass={writePass} peerId={peerId}
                pubkey={pubkey} sites={sites} siteId={siteId} newSiteName={newSiteName}
                backupNow={backupNow} scheduled={scheduled} busy={busy} setBusy={setBusy} setErr={setErr}
                onDone={setResult}
              />
            ) : (
              <button
                onClick={() => go(1)}
                disabled={!canAdvance(cur, { info, handshake, wantWrite, writeUser, writePass, siteId, newSiteName })}
                className="inline-flex items-center gap-1.5 rounded-lg bg-ruby-600 px-5 py-2 text-sm font-semibold text-white hover:bg-ruby-500 disabled:opacity-40"
              >
                Next <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function canAdvance(cur: string, s: { info: DeviceInfo | null; handshake: boolean; wantWrite: boolean; writeUser: string; writePass: string; siteId: number | ''; newSiteName: string }): boolean {
  if (cur === 'Tunnel') return s.handshake;
  if (cur === 'Identify') return !!s.info;
  if (cur === 'Management') return !s.wantWrite || (!!s.writeUser && !!s.writePass);
  return true; // Site (any/none allowed), Extras
}

function siteLabel(sites: Site[], siteId: number | '', newSiteName: string): string | null {
  if (newSiteName.trim()) return newSiteName.trim();
  if (siteId === '') return null;
  return sites.find((x) => x.id === siteId)?.name ?? null;
}

// ---------- persistent framing ----------
function DoNoHarmBanner() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3">
      <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
      <div className="text-sm text-emerald-900">
        <span className="font-semibold">This router is live.</span> RubyMIK will not change anything on it unless you explicitly choose to.
        Monitoring is read-only. The only optional change is a management tunnel (remote path) — and you'll see the exact script first.
      </div>
    </div>
  );
}

function PathChooser({ hub, onPick }: { hub: RemoteAccessView['hub'] | null; onPick: (p: Path) => void }) {
  const tunnelReady = hub?.enabled && hub?.running;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <button onClick={() => onPick('direct')} className="rounded-2xl border border-zinc-200 bg-white p-6 text-left transition hover:border-ruby-300 hover:shadow-sm">
        <Network className="h-8 w-8 text-ruby-600" />
        <h3 className="mt-3 font-bold text-zinc-900">Router on my network</h3>
        <p className="mt-1 text-sm text-zinc-500">Reachable directly on the LAN RubyMIK is on. Pure monitoring attach — no change to the router.</p>
      </button>
      <button onClick={() => onPick('tunnel')} className="rounded-2xl border border-zinc-200 bg-white p-6 text-left transition hover:border-ruby-300 hover:shadow-sm">
        <RadioTower className="h-8 w-8 text-ruby-600" />
        <h3 className="mt-3 font-bold text-zinc-900">Router at a remote site (behind NAT)</h3>
        <p className="mt-1 text-sm text-zinc-500">Not directly reachable. It dials an outbound WireGuard tunnel into RubyMIK (the only additive change).</p>
        {!tunnelReady && (
          <span className="mt-3 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5" /> Remote access must be enabled first
          </span>
        )}
      </button>
    </div>
  );
}

function StepBar({ steps, step }: { steps: string[]; step: number }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full ${i < step ? 'bg-emerald-500 text-white' : i === step ? 'bg-ruby-600 text-white' : 'bg-zinc-200 text-zinc-500'}`}>
            {i < step ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
          </span>
          <span className={i === step ? 'text-zinc-900' : 'text-zinc-400'}>{s}</span>
          {i < steps.length - 1 && <span className="mx-1 text-zinc-300">›</span>}
        </li>
      ))}
    </ol>
  );
}

// ---------- steps ----------
function TunnelStep(props: {
  hub: RemoteAccessView['hub'] | null; name: string; setName: (s: string) => void;
  peerId: number | null; tunnelIp: string; bootstrap: string; pubkey: string; setPubkey: (s: string) => void;
  handshake: boolean; setHandshake: (b: boolean) => void; busy: boolean; setBusy: (b: boolean) => void;
  setErr: (s: string | null) => void; onProvisioned: (pid: number, ip: string, bs: string) => void;
}) {
  const { hub, name, setName, peerId, tunnelIp, bootstrap, pubkey, setPubkey, handshake, setHandshake, busy, setBusy, setErr, onProvisioned } = props;
  const [copied, setCopied] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  if (!hub?.enabled || !hub?.running) {
    return (
      <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
        <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> Remote access isn't running</div>
        <p className="mt-1">The tunnel path needs the WireGuard hub enabled. Set it up on the <a href="/remote-access" className="font-semibold underline">Remote Access</a> page, then come back — or use the direct path.</p>
      </div>
    );
  }

  async function provision() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ peer: { id: number; tunnelIp: string }; bootstrap: string }>('/api/remote-access/sites', { label: name.trim() || 'Remote router' });
      onProvisioned(r.peer.id, r.peer.tunnelIp, r.bootstrap);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function register() {
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/remote-access/sites/${peerId}/register`, { publicKey: pubkey.trim() });
      // watch for handshake
      if (poll.current) clearInterval(poll.current);
      let n = 0;
      poll.current = setInterval(async () => {
        n++;
        try {
          const ra = await api.get<RemoteAccessView>('/api/remote-access');
          const live = ra.live[peerId!];
          if (live && live.state === 'recent') { setHandshake(true); clearInterval(poll.current!); }
          else if (n > 20) clearInterval(poll.current!);
        } catch { /* keep polling */ }
      }, 3000);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      {!peerId ? (
        <div>
          <StepTitle icon={RadioTower} title="Provision the tunnel" sub="RubyMIK allocates an overlay IP and prepares a one-time bootstrap script for the router." />
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Name for this router</span>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Cape Town branch gateway" autoFocus />
          </label>
          <button onClick={() => void provision()} disabled={busy} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-ruby-600 px-4 py-2 text-sm font-semibold text-white hover:bg-ruby-500 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Generate bootstrap</button>
        </div>
      ) : (
        <>
          <AdditiveBootstrap tunnelIp={tunnelIp} bootstrap={bootstrap} copied={copied} onCopy={async () => { try { await navigator.clipboard.writeText(bootstrap); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ } }} />
          <div>
            <StepTitle icon={Link2} title="Register the router's key" sub="After you apply the script, it prints RUBYMIK_PUBKEY=… — paste that here." />
            <div className="mt-2 flex items-end gap-2">
              <input className={inputCls} value={pubkey} onChange={(e) => setPubkey(e.target.value)} placeholder="router WireGuard public key" disabled={handshake} />
              <button onClick={() => void register()} disabled={busy || !pubkey.trim() || handshake} className="inline-flex items-center gap-2 rounded-lg bg-ruby-600 px-4 py-2 text-sm font-semibold text-white hover:bg-ruby-500 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Register</button>
            </div>
          </div>
          <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${handshake ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-600'}`}>
            {handshake ? <><CheckCircle2 className="h-4 w-4" /> Tunnel connected — the router is reachable at {tunnelIp}.</> : <><Loader2 className="h-4 w-4 animate-spin" /> Waiting for the tunnel handshake…</>}
          </div>
        </>
      )}
    </div>
  );
}

function AdditiveBootstrap({ tunnelIp, bootstrap, copied, onCopy }: { tunnelIp: string; bootstrap: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="rounded-xl border border-zinc-200 p-4">
      <StepTitle icon={ShieldCheck} title="Apply this once on the router" sub={`Overlay IP ${tunnelIp}. WinBox → New Terminal, or paste over SSH.`} />
      <div className="mt-3 rounded-lg bg-emerald-50/70 p-3 text-sm text-emerald-900">
        <div className="font-semibold">This only ADDS a management tunnel. It changes nothing else on your router.</div>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-emerald-800">
          <li>a WireGuard interface <code className="rounded bg-emerald-100 px-1">rmik-wg</code> (the router generates its own private key)</li>
          <li>the overlay address <code className="rounded bg-emerald-100 px-1">{tunnelIp}</code> on that interface</li>
          <li>a peer pointing at RubyMIK's hub, so it dials outbound</li>
          <li>one input-accept rule (RUBYMIK-tagged) so RubyMIK can reach it over the tunnel</li>
        </ul>
        <div className="mt-1.5 text-xs">Everything is tagged <code className="rounded bg-emerald-100 px-1">RUBYMIK</code> / <code className="rounded bg-emerald-100 px-1">rmik-wg</code> and removes cleanly. Nothing existing is modified or removed.</div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">The exact script</span>
        <button onClick={onCopy} className="inline-flex items-center gap-1 rounded-md bg-ink-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-zinc-700">{copied ? <><CheckCircle2 className="h-3.5 w-3.5" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}</button>
      </div>
      <pre className="mt-1.5 max-h-52 overflow-auto rounded-lg bg-ink-900 p-3 text-[11px] leading-relaxed text-zinc-100"><code>{bootstrap}</code></pre>
    </div>
  );
}

function IdentifyStep(props: {
  path: Path; name: string; setName: (s: string) => void; host: string; setHost: (s: string) => void; tunnelIp: string;
  readUser: string; setReadUser: (s: string) => void; readPass: string; setReadPass: (s: string) => void;
  info: DeviceInfo | null; setInfo: (i: DeviceInfo | null) => void; busy: boolean; setBusy: (b: boolean) => void; setErr: (s: string | null) => void;
}) {
  const { path, name, setName, host, setHost, tunnelIp, readUser, setReadUser, readPass, setReadPass, info, setInfo, busy, setBusy, setErr } = props;
  const effectiveHost = path === 'tunnel' ? tunnelIp : host;

  async function identify() {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await api.post<{ ok: boolean; info: DeviceInfo }>('/api/devices/test', { host: effectiveHost, username: readUser, password: readPass });
      setInfo(r.info);
      if (!name.trim() && r.info.identity) setName(r.info.identity);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <StepTitle icon={Server} title="Connect & identify" sub={path === 'tunnel' ? `Testing over the tunnel (${tunnelIp}) with a read-only credential.` : 'Enter the router address and a monitoring (read) credential. This is read-only — it changes nothing.'} />
      {path === 'direct' && (
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Router IP / hostname</span>
          <input className={inputCls} value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.88.1" autoFocus />
        </label>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Read username</span><input className={inputCls} value={readUser} onChange={(e) => setReadUser(e.target.value)} placeholder="rubymik-ro" /></label>
        <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Read password</span><input className={inputCls} type="password" value={readPass} onChange={(e) => setReadPass(e.target.value)} /></label>
      </div>
      <button onClick={() => void identify()} disabled={busy || !effectiveHost || !readUser} className="inline-flex items-center gap-2 rounded-lg bg-zinc-800 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Test & identify
      </button>
      {info && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-emerald-800"><CheckCircle2 className="h-4 w-4" /> Reached the router — is this the right one?</div>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
            <Meta label="Identity" value={info.identity ?? '—'} />
            <Meta label="Model / board" value={info.model ?? info.boardName ?? '—'} />
            <Meta label="RouterOS" value={info.version} />
            <Meta label="Serial" value={info.serialNumber ?? '—'} />
          </dl>
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Name in RubyMIK</span>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
      )}
    </div>
  );
}

function ManagementStep({ wantWrite, setWantWrite, writeUser, setWriteUser, writePass, setWritePass }: { wantWrite: boolean; setWantWrite: (b: boolean) => void; writeUser: string; setWriteUser: (s: string) => void; writePass: string; setWritePass: (s: string) => void }) {
  return (
    <div className="space-y-4">
      <StepTitle icon={ShieldQuestion} title="Monitoring or management?" sub="Monitoring is read-only and the default. Managing config later (DHCP, firewall, DNS/NTP, restore) needs a separate write credential — nothing is written now either way." />
      <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${!wantWrite ? 'border-ruby-300 bg-ruby-50/40' : 'border-zinc-200'}`}>
        <input type="radio" checked={!wantWrite} onChange={() => setWantWrite(false)} className="mt-1 h-4 w-4 accent-ruby-600" />
        <div><div className="flex items-center gap-1.5 font-semibold text-zinc-800"><Eye className="h-4 w-4" /> Monitor only</div><div className="text-sm text-zinc-500">RubyMIK can never change this router. Zero write capability.</div></div>
      </label>
      <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${wantWrite ? 'border-ruby-300 bg-ruby-50/40' : 'border-zinc-200'}`}>
        <input type="radio" checked={wantWrite} onChange={() => setWantWrite(true)} className="mt-1 h-4 w-4 accent-ruby-600" />
        <div className="flex-1">
          <div className="flex items-center gap-1.5 font-semibold text-zinc-800"><Lock className="h-4 w-4" /> Also allow management (add a write credential)</div>
          <div className="text-sm text-zinc-500">Enables config features later. Still writes nothing during onboarding.</div>
          {wantWrite && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <input className={inputCls} value={writeUser} onChange={(e) => setWriteUser(e.target.value)} placeholder="Write username" />
              <input className={inputCls} type="password" value={writePass} onChange={(e) => setWritePass(e.target.value)} placeholder="Write password" />
            </div>
          )}
        </div>
      </label>
    </div>
  );
}

function SiteStep({ sites, siteId, setSiteId, newSiteName, setNewSiteName }: { sites: Site[]; siteId: number | ''; setSiteId: (v: number | '') => void; newSiteName: string; setNewSiteName: (s: string) => void }) {
  return (
    <div className="space-y-4">
      <StepTitle icon={Building2} title="Assign a site" sub="Group this router by location or client. Optional — you can leave it unassigned." />
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Existing site</span>
        <select className={inputCls} value={siteId} onChange={(e) => { setSiteId(e.target.value === '' ? '' : Number(e.target.value)); if (e.target.value) setNewSiteName(''); }}>
          <option value="">— Unassigned —</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.clientName ? ` (${s.clientName})` : ''}</option>)}
        </select>
      </label>
      <div className="text-center text-xs font-semibold uppercase tracking-wide text-zinc-400">or</div>
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Create a new site</span>
        <input className={inputCls} value={newSiteName} onChange={(e) => { setNewSiteName(e.target.value); if (e.target.value) setSiteId(''); }} placeholder="New site name" />
      </label>
    </div>
  );
}

function ExtrasStep({ backupNow, setBackupNow, scheduled, setScheduled, manageable }: { backupNow: boolean; setBackupNow: (b: boolean) => void; scheduled: boolean; setScheduled: (b: boolean) => void; manageable: boolean }) {
  return (
    <div className="space-y-4">
      <StepTitle icon={Archive} title="Optional extras" sub="All off by default. None of these change the router's live config — backups are reads. Skip everything and RubyMIK touches nothing." />
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 p-4">
        <input type="checkbox" checked={backupNow} onChange={(e) => setBackupNow(e.target.checked)} className="mt-1 h-4 w-4 accent-ruby-600" />
        <div><div className="flex items-center gap-1.5 font-semibold text-zinc-800"><Archive className="h-4 w-4" /> Take an initial backup now <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700">recommended</span></div>
          <div className="text-sm text-zinc-500">A read-only {manageable ? 'export' : 'snapshot'} captured as a day-one restore point. Writes nothing to the router.</div></div>
      </label>
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 p-4">
        <input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} className="mt-1 h-4 w-4 accent-ruby-600" />
        <div><div className="flex items-center gap-1.5 font-semibold text-zinc-800"><Clock className="h-4 w-4" /> Include in automatic scheduled backups</div>
          <div className="text-sm text-zinc-500">Periodic read-only config backups on the fleet schedule. Off unless you opt in here.</div></div>
      </label>
    </div>
  );
}

function ReviewStep({ path, name, host, tunnelIp, info, wantWrite, siteName, backupNow, scheduled }: { path: Path; name: string; host: string; tunnelIp: string; info: DeviceInfo | null; wantWrite: boolean; siteName: string | null; backupNow: boolean; scheduled: boolean }) {
  return (
    <div className="space-y-4">
      <StepTitle icon={CheckCircle2} title="Review" sub="Here's exactly what will happen when you finish." />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl bg-zinc-50 p-4 text-sm sm:grid-cols-3">
        <Meta label="Router" value={`${name || info?.identity || 'router'}`} />
        <Meta label="Transport" value={path === 'tunnel' ? `WireGuard tunnel (${tunnelIp})` : `Direct (${host})`} />
        <Meta label="Access" value={wantWrite ? 'Manageable (write cred)' : 'Monitor-only'} />
        <Meta label="Site" value={siteName ?? 'Unassigned'} />
        <Meta label="Initial backup" value={backupNow ? 'Yes (read-only)' : 'No'} />
        <Meta label="Scheduled backups" value={scheduled ? 'On' : 'Off'} />
      </dl>
      <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        <span className="font-semibold">Writes to the router:</span> {path === 'tunnel' ? 'only the additive management tunnel you already applied.' : 'none — this is a monitoring attach.'} {backupNow && 'The initial backup is a read.'}
      </div>
    </div>
  );
}

function FinishButton(props: {
  path: Path; name: string; host: string; readUser: string; readPass: string; wantWrite: boolean; writeUser: string; writePass: string;
  peerId: number | null; pubkey: string; sites: Site[]; siteId: number | ''; newSiteName: string; backupNow: boolean; scheduled: boolean;
  busy: boolean; setBusy: (b: boolean) => void; setErr: (s: string | null) => void; onDone: (r: { deviceId: number; siteName: string | null; backupTaken: boolean }) => void;
}) {
  const p = props;
  async function finish() {
    p.setBusy(true); p.setErr(null);
    try {
      // Resolve site (create if new)
      let siteId: number | null = p.siteId === '' ? null : p.siteId;
      let siteName: string | null = siteLabel(p.sites, p.siteId, p.newSiteName);
      if (p.newSiteName.trim()) {
        const s = await api.post<Site>('/api/sites', { name: p.newSiteName.trim() });
        siteId = s.id; siteName = s.name;
      }
      const write = p.wantWrite ? { writeUsername: p.writeUser, writePassword: p.writePass } : {};
      let deviceId: number;
      if (p.path === 'direct') {
        const d = await api.post<{ id: number }>('/api/devices', {
          name: p.name, host: p.host, username: p.readUser, password: p.readPass,
          siteId, backupsEnabled: p.scheduled, ...write,
        });
        deviceId = d.id;
      } else {
        const d = await api.post<{ deviceId: number }>(`/api/remote-access/sites/${p.peerId}/device`, {
          name: p.name, username: p.readUser, password: p.readPass,
          siteId, backupsEnabled: p.scheduled, ...write,
        });
        deviceId = d.deviceId;
      }
      let backupTaken = false;
      if (p.backupNow) { try { await api.post(`/api/devices/${deviceId}/backups`); backupTaken = true; } catch { /* surfaced in summary */ } }
      p.onDone({ deviceId, siteName, backupTaken });
    } catch (e) { p.setErr((e as Error).message); } finally { p.setBusy(false); }
  }
  return (
    <button onClick={() => void finish()} disabled={p.busy} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
      {p.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Finish onboarding
    </button>
  );
}

function DoneSummary({ path, result, wantWrite, onDone, onAnother }: { path: Path; result: { deviceId: number; siteName: string | null; backupTaken: boolean }; wantWrite: boolean; onDone: () => void; onAnother: () => void }) {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-2xl border border-emerald-200 bg-white p-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100"><CheckCircle2 className="h-8 w-8 text-emerald-600" /></div>
        <h2 className="mt-4 text-xl font-bold text-zinc-900">RubyMIK is now monitoring this router.</h2>
        <div className="mt-4 space-y-2 text-left text-sm">
          <Line ok label={`Attached as a ${wantWrite ? 'manageable' : 'monitor-only'} ${path === 'tunnel' ? 'TUNNEL' : 'DIRECT'} device`} />
          {result.siteName && <Line ok label={`Assigned to site "${result.siteName}"`} />}
          {result.backupTaken && <Line ok label="Initial backup captured (read-only)" />}
          <Line
            ok={path !== 'tunnel'}
            neutral={path === 'tunnel'}
            label={path === 'tunnel' ? 'We added a management tunnel (WireGuard) — and nothing else on the router.' : 'We made NO changes to the router — this is a pure monitoring attach.'}
          />
        </div>
        <div className="mt-6 flex justify-center gap-3">
          <button onClick={onDone} className="rounded-lg bg-ruby-600 px-5 py-2 text-sm font-semibold text-white hover:bg-ruby-500">Open device</button>
          <button onClick={onAnother} className="rounded-lg border border-zinc-300 px-5 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50">Onboard another</button>
        </div>
      </div>
    </div>
  );
}

// ---------- small shared bits ----------
function StepTitle({ icon: Icon, title, sub }: { icon: React.ComponentType<{ className?: string }>; title: string; sub: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-ruby-600" />
      <div><h3 className="font-bold text-zinc-900">{title}</h3><p className="text-sm text-zinc-500">{sub}</p></div>
    </div>
  );
}
function Meta({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{label}</dt><dd className="mt-0.5 truncate text-sm font-medium text-zinc-800" title={value}>{value}</dd></div>;
}
function Line({ label, ok, neutral }: { label: string; ok?: boolean; neutral?: boolean }) {
  const Icon = neutral ? RadioTower : ok ? CheckCircle2 : X;
  return <div className="flex items-start gap-2"><Icon className={`mt-0.5 h-4 w-4 shrink-0 ${neutral ? 'text-sky-600' : 'text-emerald-600'}`} /><span className="text-zinc-700">{label}</span></div>;
}
