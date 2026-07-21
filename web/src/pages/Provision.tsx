import { useState } from 'react';
import {
  HardDriveDownload, Loader2, CheckCircle2, AlertTriangle, ArrowRight, ArrowLeft, Copy,
  ShieldCheck, Network, RadioTower, Server, Cpu, X,
} from 'lucide-react';
import { api } from '../api';

/**
 * New-router provisioning wizard (P11). Builds a complete baseline for a blank
 * router with ruthless live validation, then either generates a script (Mode A,
 * safe/default) or live-applies it in safe order with a dead-man (Mode B, LAN).
 */

type Role = 'wan' | 'lan' | 'unused';
type WanType = 'dhcp' | 'static' | 'pppoe';
type Preset = 'off' | 'basic' | 'standard';
interface Spec {
  identity: string;
  interfaces: Array<{ name: string; role: Role }>;
  wan: { type: WanType; static?: { address: string; gateway: string; dns: string }; pppoe?: { user: string; password: string } };
  lan: { routerIp: string; prefix: number };
  dhcp: { enabled: boolean; poolStart?: string; poolEnd?: string; dns?: string; leaseTime?: string };
  firewall: Preset;
  remote: boolean;
}

const MODELS: Record<string, string[]> = {
  'hEX / hEX S (RB750/E60)': ['ether1', 'ether2', 'ether3', 'ether4', 'ether5'],
  'hAP ac²': ['ether1', 'ether2', 'ether3', 'ether4', 'ether5', 'wlan1', 'wlan2'],
  'RB4011': ['ether1', 'ether2', 'ether3', 'ether4', 'ether5', 'ether6', 'ether7', 'ether8', 'ether9', 'ether10', 'sfp-sfpplus1'],
};
const input = 'w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none transition focus:border-ruby-500 focus:ring-2 focus:ring-ruby-500/20';
const STEPS = ['Basics', 'Interfaces & WAN', 'LAN & firewall', 'Review', 'Apply'];

export default function Provision() {
  const [step, setStep] = useState(0);
  const [model, setModel] = useState('hEX / hEX S (RB750/E60)');
  const [spec, setSpec] = useState<Spec>({
    identity: '', remote: false, firewall: 'standard',
    interfaces: MODELS['hEX / hEX S (RB750/E60)'].map((name, i) => ({ name, role: i === 0 ? 'wan' : 'lan' as Role })),
    wan: { type: 'dhcp' },
    lan: { routerIp: '192.168.88.1', prefix: 24 },
    dhcp: { enabled: true, poolStart: '192.168.88.10', poolEnd: '192.168.88.254', dns: '1.1.1.1', leaseTime: '1h' },
  });
  const [validation, setValidation] = useState<{ ok: boolean; errors: string[]; firewallRuleCount: number; mgmtGuardFirst: boolean } | null>(null);
  const [mode, setMode] = useState<'A' | 'B'>('A');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [genScript, setGenScript] = useState<string | null>(null);
  const [applyOut, setApplyOut] = useState<any>(null);
  const set = (patch: Partial<Spec>) => setSpec((s) => ({ ...s, ...patch }));

  function pickModel(m: string) {
    setModel(m);
    if (MODELS[m]) set({ interfaces: MODELS[m].map((name, i) => ({ name, role: i === 0 ? 'wan' : 'lan' as Role })) });
  }
  async function validate() {
    setBusy(true); setErr(null);
    try { setValidation(await api.post('/api/provision/validate', { spec })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const go = async (d: 1 | -1) => {
    setErr(null);
    if (d === 1 && step === 2) { await validate(); } // entering Review → validate
    setStep((s) => Math.max(0, Math.min(STEPS.length - 1, s + d)));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-zinc-900"><HardDriveDownload className="h-6 w-6 text-ruby-600" /> Provision a new router</h1>
        <p className="mt-1 text-sm text-zinc-500">Build a complete baseline for a blank/factory MikroTik — WAN, LAN, DHCP, firewall{spec.remote ? ', and the tunnel-back' : ''}.</p>
      </header>

      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <ol className="mb-6 flex flex-wrap gap-x-2 gap-y-1 text-xs font-semibold">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className={`flex h-6 w-6 items-center justify-center rounded-full ${i < step ? 'bg-emerald-500 text-white' : i === step ? 'bg-ruby-600 text-white' : 'bg-zinc-200 text-zinc-500'}`}>{i < step ? <CheckCircle2 className="h-4 w-4" /> : i + 1}</span>
              <span className={i === step ? 'text-zinc-900' : 'text-zinc-400'}>{s}</span>{i < STEPS.length - 1 && <span className="mx-1 text-zinc-300">›</span>}
            </li>
          ))}
        </ol>
        {err && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}

        {step === 0 && <Basics spec={spec} set={set} model={model} pickModel={pickModel} />}
        {step === 1 && <InterfacesWan spec={spec} set={set} setSpec={setSpec} />}
        {step === 2 && <LanFirewall spec={spec} set={set} />}
        {step === 3 && <Review spec={spec} validation={validation} busy={busy} revalidate={validate} mode={mode} setMode={setMode} />}
        {step === 4 && <Apply spec={spec} mode={mode} busy={busy} setBusy={setBusy} setErr={setErr} genScript={genScript} setGenScript={setGenScript} applyOut={applyOut} setApplyOut={setApplyOut} />}

        <div className="mt-6 flex items-center justify-between">
          <button onClick={() => go(-1)} disabled={step === 0} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-zinc-600 hover:bg-zinc-100 disabled:opacity-40"><ArrowLeft className="h-4 w-4" /> Back</button>
          {step < 4 && (
            <button onClick={() => void go(1)} disabled={busy || (step === 3 && (!validation || !validation.ok))} className="inline-flex items-center gap-1.5 rounded-lg bg-ruby-600 px-5 py-2 text-sm font-semibold text-white hover:bg-ruby-500 disabled:opacity-40">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : step === 3 ? 'Apply' : 'Next'} <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Title({ icon: Icon, title, sub }: { icon: any; title: string; sub: string }) {
  return <div className="mb-4 flex items-start gap-2.5"><Icon className="mt-0.5 h-5 w-5 shrink-0 text-ruby-600" /><div><h3 className="font-bold text-zinc-900">{title}</h3><p className="text-sm text-zinc-500">{sub}</p></div></div>;
}
function Field({ label, children }: { label: string; children: any }) {
  return <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{label}</span>{children}</label>;
}

function Basics({ spec, set, model, pickModel }: any) {
  return (
    <div className="space-y-4">
      <Title icon={Cpu} title="Router basics" sub="Name it, pick the model (for its port list), and say whether it's local or at a remote site." />
      <Field label="Router identity (name)"><input className={input} value={spec.identity} onChange={(e) => set({ identity: e.target.value })} placeholder="cpt-branch-gw" autoFocus /></Field>
      <Field label="Model (defines the interface list)">
        <select className={input} value={model} onChange={(e) => pickModel(e.target.value)}>{Object.keys(MODELS).map((m) => <option key={m}>{m}</option>)}</select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <button onClick={() => set({ remote: false })} className={`rounded-xl border p-4 text-left ${!spec.remote ? 'border-ruby-300 bg-ruby-50/40' : 'border-zinc-200'}`}>
          <Network className="h-6 w-6 text-ruby-600" /><div className="mt-2 font-semibold text-zinc-800">Local router</div><div className="text-sm text-zinc-500">On your network. Mode A (script) or Mode B (live-apply).</div>
        </button>
        <button onClick={() => set({ remote: true })} className={`rounded-xl border p-4 text-left ${spec.remote ? 'border-ruby-300 bg-ruby-50/40' : 'border-zinc-200'}`}>
          <RadioTower className="h-6 w-6 text-ruby-600" /><div className="mt-2 font-semibold text-zinc-800">Remote site (behind NAT)</div><div className="text-sm text-zinc-500">Baseline includes a WireGuard tunnel-back. Script mode only.</div>
        </button>
      </div>
    </div>
  );
}

function InterfacesWan({ spec, set, setSpec }: any) {
  const setRole = (name: string, role: Role) => setSpec((s: Spec) => ({ ...s, interfaces: s.interfaces.map((i) => i.name === name ? { ...i, role } : i) }));
  return (
    <div className="space-y-5">
      <Title icon={Server} title="Interface roles & WAN" sub="Assign each port a role, and configure the WAN uplink." />
      <div className="overflow-hidden rounded-xl border border-zinc-100">
        {spec.interfaces.map((i: any) => (
          <div key={i.name} className="flex items-center gap-3 border-b border-zinc-50 px-3 py-2 text-sm last:border-0">
            <span className="w-28 font-mono text-zinc-700">{i.name}</span>
            <div className="flex gap-1">
              {(['wan', 'lan', 'unused'] as Role[]).map((r) => (
                <button key={r} onClick={() => setRole(i.name, r)} className={`rounded-md px-2.5 py-1 text-xs font-semibold ${i.role === r ? 'bg-ruby-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}>{r.toUpperCase()}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-zinc-200 p-4">
        <Field label="WAN uplink type">
          <select className={input} value={spec.wan.type} onChange={(e) => set({ wan: { type: e.target.value } })}>
            <option value="dhcp">DHCP client (get an address automatically)</option>
            <option value="static">Static IP</option>
            <option value="pppoe">PPPoE</option>
          </select>
        </Field>
        {spec.wan.type === 'static' && (
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <input className={input} placeholder="Address CIDR e.g. 41.0.0.2/30" value={spec.wan.static?.address ?? ''} onChange={(e) => set({ wan: { ...spec.wan, static: { ...spec.wan.static, address: e.target.value } } })} />
            <input className={input} placeholder="Gateway" value={spec.wan.static?.gateway ?? ''} onChange={(e) => set({ wan: { ...spec.wan, static: { ...spec.wan.static, gateway: e.target.value } } })} />
            <input className={input} placeholder="DNS" value={spec.wan.static?.dns ?? ''} onChange={(e) => set({ wan: { ...spec.wan, static: { ...spec.wan.static, dns: e.target.value } } })} />
          </div>
        )}
        {spec.wan.type === 'pppoe' && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <input className={input} placeholder="PPPoE username" value={spec.wan.pppoe?.user ?? ''} onChange={(e) => set({ wan: { ...spec.wan, pppoe: { ...spec.wan.pppoe, user: e.target.value } } })} />
            <input className={input} type="password" placeholder="PPPoE password" value={spec.wan.pppoe?.password ?? ''} onChange={(e) => set({ wan: { ...spec.wan, pppoe: { ...spec.wan.pppoe, password: e.target.value } } })} />
          </div>
        )}
      </div>
    </div>
  );
}

function LanFirewall({ spec, set }: any) {
  const d = spec.dhcp;
  return (
    <div className="space-y-5">
      <Title icon={ShieldCheck} title="LAN, DHCP & firewall" sub="The LAN gateway, the DHCP scope handed to clients, and the firewall level (always mgmt-safe)." />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Router LAN IP"><input className={input} value={spec.lan.routerIp} onChange={(e) => set({ lan: { ...spec.lan, routerIp: e.target.value } })} /></Field>
        <Field label="Prefix (/n)"><input className={input} value={spec.lan.prefix} onChange={(e) => set({ lan: { ...spec.lan, prefix: Number(e.target.value) || 0 } })} inputMode="numeric" /></Field>
        <Field label="Firewall">
          <select className={input} value={spec.firewall} onChange={(e) => set({ firewall: e.target.value })}>
            <option value="off">Off</option><option value="basic">Basic</option><option value="standard">Standard</option>
          </select>
        </Field>
      </div>
      <div className="rounded-xl border border-zinc-200 p-4">
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-800"><input type="checkbox" checked={d.enabled} onChange={(e) => set({ dhcp: { ...d, enabled: e.target.checked } })} className="h-4 w-4 accent-ruby-600" /> DHCP server for LAN clients</label>
        {d.enabled && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Field label="Pool start"><input className={input} value={d.poolStart ?? ''} onChange={(e) => set({ dhcp: { ...d, poolStart: e.target.value } })} /></Field>
            <Field label="Pool end"><input className={input} value={d.poolEnd ?? ''} onChange={(e) => set({ dhcp: { ...d, poolEnd: e.target.value } })} /></Field>
            <Field label="DNS handed to clients"><input className={input} value={d.dns ?? ''} onChange={(e) => set({ dhcp: { ...d, dns: e.target.value } })} /></Field>
            <Field label="Lease time"><input className={input} value={d.leaseTime ?? ''} onChange={(e) => set({ dhcp: { ...d, leaseTime: e.target.value } })} placeholder="1h" /></Field>
          </div>
        )}
      </div>
      {spec.firewall !== 'off' && (
        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800"><ShieldCheck className="mr-1 inline h-3.5 w-3.5" /> The generated firewall always leads with a management-accept guard — a provisioned router can't come up locked out.</div>
      )}
    </div>
  );
}

function Review({ spec, validation, busy, revalidate, mode, setMode }: any) {
  return (
    <div className="space-y-4">
      <Title icon={CheckCircle2} title="Review & validate" sub="RubyMIK refuses to generate an incoherent config. Fix any errors before continuing." />
      {busy && !validation ? <div className="h-20 animate-pulse rounded-lg bg-zinc-100" /> : validation && (
        validation.ok ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 text-sm">
            <div className="flex items-center gap-2 font-bold text-emerald-800"><CheckCircle2 className="h-4 w-4" /> Spec is coherent.</div>
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
              <Meta label="Identity" value={spec.identity} /><Meta label="Placement" value={spec.remote ? 'Remote (tunnel-back)' : 'Local'} />
              <Meta label="WAN" value={spec.wan.type} /><Meta label="LAN" value={`${spec.lan.routerIp}/${spec.lan.prefix}`} />
              <Meta label="DHCP" value={spec.dhcp.enabled ? `${spec.dhcp.poolStart}–${spec.dhcp.poolEnd}` : 'none'} />
              <Meta label="Firewall" value={`${spec.firewall}${validation.firewallRuleCount ? ` (${validation.firewallRuleCount} rules, mgmt-accept first)` : ''}`} />
            </dl>
          </div>
        ) : (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
            <div className="mb-2 flex items-center gap-2 font-bold text-red-800"><AlertTriangle className="h-4 w-4" /> This spec is incoherent — refusing to generate:</div>
            <ul className="list-disc space-y-1 pl-5 text-red-700">{validation.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
            <button onClick={() => void revalidate()} className="mt-3 text-xs font-semibold text-red-700 underline">Re-validate</button>
          </div>
        )
      )}
      {validation?.ok && (
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Application mode</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button onClick={() => setMode('A')} className={`rounded-xl border p-3 text-left text-sm ${mode === 'A' ? 'border-ruby-300 bg-ruby-50/40' : 'border-zinc-200'}`}>
              <div className="font-semibold text-zinc-800">A · Generate script (safe)</div><div className="text-zinc-500">A human applies it once. Nothing applied live. {spec.remote && 'Required for remote.'}</div>
            </button>
            <button onClick={() => !spec.remote && setMode('B')} disabled={spec.remote} className={`rounded-xl border p-3 text-left text-sm disabled:opacity-40 ${mode === 'B' ? 'border-ruby-300 bg-ruby-50/40' : 'border-zinc-200'}`}>
              <div className="font-semibold text-zinc-800">B · Live-apply (LAN only)</div><div className="text-zinc-500">RubyMIK applies it in safe order, dead-man armed. Not for remote.</div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Apply({ spec, mode, busy, setBusy, setErr, genScript, setGenScript, applyOut, setApplyOut }: any) {
  const [copied, setCopied] = useState(false);
  const [host, setHost] = useState(''); const [user, setUser] = useState(''); const [pass, setPass] = useState('');

  async function generate() {
    setBusy(true); setErr(null);
    try { const r = await api.post<{ script: string }>('/api/provision/generate', { spec }); setGenScript(r.script); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function liveApply() {
    setBusy(true); setErr(null);
    try { setApplyOut(await api.post('/api/provision/apply', { spec, host, username: user, password: pass })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (mode === 'A') {
    return (
      <div className="space-y-4">
        <Title icon={HardDriveDownload} title="Mode A — generate baseline script" sub="Apply this once to the blank router (WinBox terminal / SSH). It comes up fully configured." />
        {!genScript ? (
          <button onClick={() => void generate()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-ruby-600 px-5 py-2 text-sm font-semibold text-white hover:bg-ruby-500 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Generate baseline</button>
        ) : (
          <>
            <div className="flex justify-end"><button onClick={async () => { try { await navigator.clipboard.writeText(genScript); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ } }} className="inline-flex items-center gap-1 rounded-md bg-ink-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-zinc-700">{copied ? <><CheckCircle2 className="h-3.5 w-3.5" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}</button></div>
            <pre className="max-h-96 overflow-auto rounded-lg bg-ink-900 p-3 text-[11px] leading-relaxed text-zinc-100"><code>{genScript}</code></pre>
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">After it's applied and the router is reachable{spec.remote ? ' over the tunnel' : ''}, adopt it from the Onboard wizard.</div>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Title icon={ShieldCheck} title="Mode B — live-apply (dead-man armed)" sub="Applied in safe order; management preserved throughout; firewall last. A blank router reachable on the LAN." />
      {!applyOut ? (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            <input className={input} placeholder="Router IP (reachable)" value={host} onChange={(e) => setHost(e.target.value)} />
            <input className={input} placeholder="Write username" value={user} onChange={(e) => setUser(e.target.value)} />
            <input className={input} type="password" placeholder="Password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </div>
          <button onClick={() => void liveApply()} disabled={busy || !host || !user} className="inline-flex items-center gap-2 rounded-lg bg-ruby-600 px-5 py-2 text-sm font-semibold text-white hover:bg-ruby-500 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Live-apply baseline</button>
        </>
      ) : (
        <div className={`rounded-xl border p-4 ${applyOut.result === 'applied' ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
          <div className="flex items-center gap-2 font-bold">{applyOut.result === 'applied' ? <><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Baseline applied — management preserved.</> : <><AlertTriangle className="h-4 w-4 text-amber-600" /> {applyOut.result === 'reverted' ? 'Reverted' : 'Failed'} at step "{applyOut.failedStep}" — router recovered ({applyOut.mgmtPreserved ? 'reachable' : 'STILL DOWN'}).</>}</div>
          <ul className="mt-2 space-y-1 text-sm">{applyOut.steps.map((s: any, i: number) => <li key={i} className="flex items-center gap-2">{s.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <X className="h-4 w-4 text-red-600" />}<span className="font-mono text-xs">{s.step}</span><span className="text-zinc-500">{s.detail}</span></li>)}</ul>
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{label}</dt><dd className="mt-0.5 truncate font-medium text-zinc-800" title={value}>{value}</dd></div>;
}
