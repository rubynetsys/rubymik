import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  HardDriveDownload, Loader2, CheckCircle2, AlertTriangle, ArrowRight, ArrowLeft,
  ShieldCheck, Network, RadioTower, Server, Cpu, X,
} from 'lucide-react';
import { api } from '../api';
import Select from '../components/Select';
import CodeBlock from '../components/CodeBlock';
import { CATALOG, CATEGORY_META, MODEL_COUNT } from '../catalog';

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

// Port lists come from the data-driven catalogue (web/src/catalog.ts) — the full
// current MikroTik line — plus an "Other / not listed" fallback with a manual count.
const MODEL_PORTS: Record<string, string[]> = Object.fromEntries(CATALOG.map((c) => [c.model, c.ports]));
const OTHER_MODEL = 'Other / not listed';
const DEFAULT_MODEL = 'hEX (RB750Gr3)';
/** Select options grouped by category via disabled header rows. */
const MODEL_OPTIONS: { value: string; label: string; disabled?: boolean }[] = (() => {
  const opts: { value: string; label: string; disabled?: boolean }[] = [];
  for (const cat of CATEGORY_META) {
    const items = CATALOG.filter((c) => c.category === cat.id);
    if (!items.length) continue;
    opts.push({ value: `__hdr_${cat.id}`, label: `—— ${cat.plural} ——`, disabled: true });
    for (const it of items) opts.push({ value: it.model, label: it.model });
  }
  opts.push({ value: '__hdr_other', label: '——', disabled: true });
  opts.push({ value: OTHER_MODEL, label: OTHER_MODEL });
  return opts;
})();
const portsForCount = (n: number): string[] => Array.from({ length: Math.max(1, n) }, (_, i) => `ether${i + 1}`);
const input = 'w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong focus:ring-2 focus:ring-accent-border-strong/20';
const STEPS = ['Basics', 'Interfaces & WAN', 'LAN & firewall', 'Review', 'Apply'];

export default function Provision() {
  const [step, setStep] = useState(0);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [otherPorts, setOtherPorts] = useState(5);
  const [spec, setSpec] = useState<Spec>({
    identity: '', remote: false, firewall: 'standard',
    interfaces: MODEL_PORTS[DEFAULT_MODEL].map((name, i) => ({ name, role: i === 0 ? 'wan' : 'lan' as Role })),
    wan: { type: 'dhcp' },
    lan: { routerIp: '192.168.88.1', prefix: 24 },
    dhcp: { enabled: true, poolStart: '192.168.88.10', poolEnd: '192.168.88.254', dns: '1.1.1.1', leaseTime: '1h' },
  });
  const [validation, setValidation] = useState<{ ok: boolean; errors: string[]; preconditions?: string[]; firewallRuleCount: number; mgmtGuardFirst: boolean } | null>(null);
  const [mode, setMode] = useState<'A' | 'B'>('A');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [genScript, setGenScript] = useState<string | null>(null);
  const [applyOut, setApplyOut] = useState<any>(null);
  const set = (patch: Partial<Spec>) => setSpec((s) => ({ ...s, ...patch }));
  const navigate = useNavigate();
  // Completion signalling (P11 UX): the final Apply step is done when Mode A
  // has generated a script or Mode B has applied. applyRan also covers a
  // Mode B failure so the wizard always offers an exit.
  const applySucceeded = mode === 'A' ? !!genScript : applyOut?.result === 'applied';
  const applyRan = mode === 'A' ? !!genScript : !!applyOut;

  function pickModel(mName: string, count?: number) {
    setModel(mName);
    const ports = mName === OTHER_MODEL ? portsForCount(count ?? otherPorts) : MODEL_PORTS[mName];
    if (ports) set({ interfaces: ports.map((name, i) => ({ name, role: i === 0 ? 'wan' : 'lan' as Role })) });
  }
  const setOtherCount = (n: number) => { setOtherPorts(n); pickModel(OTHER_MODEL, n); };
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
        <h1 className="flex items-center gap-2 text-2xl font-bold text-fg-strong"><HardDriveDownload className="h-6 w-6 text-accent" /> Provision a new router</h1>
        <p className="mt-1 text-sm text-fg-dim">Build a complete baseline for a blank/factory MikroTik — WAN, LAN, DHCP, firewall{spec.remote ? ', and the tunnel-back' : ''}.</p>
      </header>

      <div className="rounded-2xl border border-border bg-surface p-6">
        <ol className="mb-6 flex flex-wrap gap-x-2 gap-y-1 text-xs font-semibold">
          {STEPS.map((s, i) => {
            const done = i < step || (i === step && applySucceeded);
            return (
            <li key={s} className="flex items-center gap-2">
              <span className={`flex h-6 w-6 items-center justify-center rounded-full ${done ? 'bg-success-strong text-inverse' : i === step ? 'bg-accent text-inverse' : 'bg-border text-fg-dim'}`}>{done ? <CheckCircle2 className="h-4 w-4" /> : i + 1}</span>
              <span className={i === step ? 'text-fg-strong' : 'text-fg-faint'}>{s}</span>{i < STEPS.length - 1 && <span className="mx-1 text-fg-faint">›</span>}
            </li>
            );
          })}
        </ol>
        {err && <div className="mb-4 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{err}</div>}

        {step === 0 && <Basics spec={spec} set={set} model={model} pickModel={pickModel} otherPorts={otherPorts} setOtherCount={setOtherCount} />}
        {step === 1 && <InterfacesWan spec={spec} set={set} setSpec={setSpec} />}
        {step === 2 && <LanFirewall spec={spec} set={set} />}
        {step === 3 && <Review spec={spec} validation={validation} busy={busy} revalidate={validate} mode={mode} setMode={setMode} />}
        {step === 4 && <Apply spec={spec} mode={mode} busy={busy} setBusy={setBusy} setErr={setErr} genScript={genScript} setGenScript={setGenScript} applyOut={applyOut} setApplyOut={setApplyOut} />}

        <div className="mt-6 flex items-center justify-between">
          <button onClick={() => go(-1)} disabled={step === 0} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-fg-muted hover:bg-app disabled:opacity-40"><ArrowLeft className="h-4 w-4" /> Back</button>
          {step < 4 && (
            <button onClick={() => void go(1)} disabled={busy || (step === 3 && (!validation || !validation.ok))} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-40">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : step === 3 ? 'Apply' : 'Next'} <ArrowRight className="h-4 w-4" />
            </button>
          )}
          {step === 4 && applyRan && (
            <button onClick={() => navigate('/devices')} className="inline-flex items-center gap-1.5 rounded-lg bg-success-strong px-5 py-2 text-sm font-semibold text-inverse hover:opacity-90">
              <CheckCircle2 className="h-4 w-4" /> Done — close wizard
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Title({ icon: Icon, title, sub }: { icon: any; title: string; sub: string }) {
  return <div className="mb-4 flex items-start gap-2.5"><Icon className="mt-0.5 h-5 w-5 shrink-0 text-accent" /><div><h3 className="font-bold text-fg-strong">{title}</h3><p className="text-sm text-fg-dim">{sub}</p></div></div>;
}
function Field({ label, children }: { label: string; children: any }) {
  return <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-dim">{label}</span>{children}</label>;
}

function Basics({ spec, set, model, pickModel, otherPorts, setOtherCount }: any) {
  return (
    <div className="space-y-4">
      <Title icon={Cpu} title="Router basics" sub="Name it, pick the model (for its port list), and say whether it's local or at a remote site." />
      <Field label="Router identity (name)"><input className={input} value={spec.identity} onChange={(e) => set({ identity: e.target.value })} placeholder="cpt-branch-gw" autoFocus /></Field>
      <Field label="Model (defines the interface list)">
        <Select className={input} value={model} onChange={pickModel} ariaLabel="Model" options={MODEL_OPTIONS} />
        <span className="mt-1 block text-[11px] text-fg-faint">{MODEL_COUNT} models in the catalogue · pick the closest, or "Other / not listed" to set the port count by hand.</span>
      </Field>
      {model === OTHER_MODEL && (
        <Field label="Number of ethernet ports">
          <input className={input} type="number" min={1} max={64} value={otherPorts}
            onChange={(e) => setOtherCount(Math.max(1, Math.min(64, Number(e.target.value) || 1)))} />
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <button onClick={() => set({ remote: false })} className={`rounded-xl border p-4 text-left ${!spec.remote ? 'border-accent-border bg-accent-subtle/40' : 'border-border'}`}>
          <Network className="h-6 w-6 text-accent" /><div className="mt-2 font-semibold text-fg">Local router</div><div className="text-sm text-fg-dim">On your network. Mode A (script) or Mode B (live-apply).</div>
        </button>
        <button onClick={() => set({ remote: true })} className={`rounded-xl border p-4 text-left ${spec.remote ? 'border-accent-border bg-accent-subtle/40' : 'border-border'}`}>
          <RadioTower className="h-6 w-6 text-accent" /><div className="mt-2 font-semibold text-fg">Remote site (behind NAT)</div><div className="text-sm text-fg-dim">Baseline includes a WireGuard tunnel-back. Script mode only.</div>
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
      <div className="overflow-hidden rounded-xl border border-border-subtle">
        {spec.interfaces.map((i: any) => (
          <div key={i.name} className="flex items-center gap-3 border-b border-border-subtle px-3 py-2 text-sm last:border-0">
            <span className="w-28 font-mono text-fg-body">{i.name}</span>
            <div className="flex gap-1">
              {(['wan', 'lan', 'unused'] as Role[]).map((r) => (
                <button key={r} onClick={() => setRole(i.name, r)} className={`rounded-md px-2.5 py-1 text-xs font-semibold ${i.role === r ? 'bg-accent text-inverse' : 'bg-app text-fg-muted hover:bg-border'}`}>{r.toUpperCase()}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border p-4">
        <Field label="WAN uplink type">
          <Select className={input} value={spec.wan.type} onChange={(v) => set({ wan: { type: v } })} ariaLabel="WAN uplink type"
            options={[{ value: 'dhcp', label: 'DHCP client (get an address automatically)' }, { value: 'static', label: 'Static IP' }, { value: 'pppoe', label: 'PPPoE' }]} />
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
          <Select className={input} value={spec.firewall} onChange={(v) => set({ firewall: v })} ariaLabel="Firewall"
            options={[{ value: 'off', label: 'Off' }, { value: 'basic', label: 'Basic' }, { value: 'standard', label: 'Standard' }]} />
        </Field>
      </div>
      <div className="rounded-xl border border-border p-4">
        <label className="flex items-center gap-2 text-sm font-medium text-fg"><input type="checkbox" checked={d.enabled} onChange={(e) => set({ dhcp: { ...d, enabled: e.target.checked } })} className="h-4 w-4 accent-accent" /> DHCP server for LAN clients</label>
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
        <div className="rounded-lg bg-success-bg px-3 py-2 text-xs text-success-fg"><ShieldCheck className="mr-1 inline h-3.5 w-3.5" /> The generated firewall always leads with a management-accept guard — a provisioned router can't come up locked out.</div>
      )}
    </div>
  );
}

function Review({ spec, validation, busy, revalidate, mode, setMode }: any) {
  return (
    <div className="space-y-4">
      <Title icon={CheckCircle2} title="Review & validate" sub="RubyMIK refuses to generate an incoherent config. Fix any errors before continuing." />
      {busy && !validation ? <div className="h-20 animate-pulse rounded-lg bg-app" /> : validation && (
        <>
          {validation.errors.length > 0 && (
            <div className="rounded-xl border border-danger-line bg-danger-bg p-4 text-sm">
              <div className="mb-2 flex items-center gap-2 font-bold text-danger-fg-strong"><AlertTriangle className="h-4 w-4" /> This spec is incoherent — refusing to generate:</div>
              <ul className="list-disc space-y-1 pl-5 text-danger-fg">{validation.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
              <button onClick={() => void revalidate()} className="mt-3 text-xs font-semibold text-danger-fg underline">Re-validate</button>
            </div>
          )}
          {validation.preconditions && validation.preconditions.length > 0 && (
            <div className="rounded-xl border border-warning-line bg-warning-bg/60 p-4 text-sm">
              <div className="mb-2 flex items-center gap-2 font-bold text-warning-fg"><AlertTriangle className="h-4 w-4" /> The spec is fine, but a prerequisite for Apply isn't ready:</div>
              <ul className="list-disc space-y-1 pl-5 text-warning-fg">{validation.preconditions.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
              <div className="mt-3 flex items-center gap-3">
                <Link to="/remote-access" className="text-xs font-semibold text-warning-fg underline">Set up Remote Access →</Link>
                <button onClick={() => void revalidate()} className="text-xs font-semibold text-warning-fg underline">Re-check</button>
              </div>
            </div>
          )}
          {validation.ok && (
            <div className="rounded-xl border border-success-line bg-success-bg/50 p-4 text-sm">
              <div className="flex items-center gap-2 font-bold text-success-fg"><CheckCircle2 className="h-4 w-4" /> Spec is coherent{spec.remote ? ' — hub ready' : ''}.</div>
              <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
                <Meta label="Identity" value={spec.identity} /><Meta label="Placement" value={spec.remote ? 'Remote (tunnel-back)' : 'Local'} />
                <Meta label="WAN" value={spec.wan.type} /><Meta label="LAN" value={`${spec.lan.routerIp}/${spec.lan.prefix}`} />
                <Meta label="DHCP" value={spec.dhcp.enabled ? `${spec.dhcp.poolStart}–${spec.dhcp.poolEnd}` : 'none'} />
                <Meta label="Firewall" value={`${spec.firewall}${validation.firewallRuleCount ? ` (${validation.firewallRuleCount} rules, mgmt-accept first)` : ''}`} />
              </dl>
            </div>
          )}
        </>
      )}
      {validation?.ok && (
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-dim">Application mode</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button onClick={() => setMode('A')} className={`rounded-xl border p-3 text-left text-sm ${mode === 'A' ? 'border-accent-border bg-accent-subtle/40' : 'border-border'}`}>
              <div className="font-semibold text-fg">A · Generate script (safe)</div><div className="text-fg-dim">A human applies it once. Nothing applied live. {spec.remote && 'Required for remote.'}</div>
            </button>
            <button onClick={() => !spec.remote && setMode('B')} disabled={spec.remote} className={`rounded-xl border p-3 text-left text-sm disabled:opacity-40 ${mode === 'B' ? 'border-accent-border bg-accent-subtle/40' : 'border-border'}`}>
              <div className="font-semibold text-fg">B · Live-apply (LAN only)</div><div className="text-fg-dim">RubyMIK applies it in safe order, dead-man armed. Not for remote.</div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Apply({ spec, mode, busy, setBusy, setErr, genScript, setGenScript, applyOut, setApplyOut }: any) {
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
          <button onClick={() => void generate()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Generate baseline</button>
        ) : (
          <>
            <CodeBlock code={genScript} label="baseline.rsc" filename="rubymik-baseline.rsc" maxHeightClass="max-h-96" />
            <div className="rounded-xl border border-border bg-app/50 p-4">
              <div className="mb-3 flex items-center gap-2 font-semibold text-fg-strong"><CheckCircle2 className="h-4 w-4 text-success" /> Baseline script ready — next steps</div>
              <ol className="space-y-2.5 text-sm text-fg-body">
                {[
                  'Download or copy the script above.',
                  "Paste it into the router's WinBox terminal (New Terminal) or over SSH.",
                  spec.remote ? 'The router dials the WireGuard tunnel-back to RubyMIK.' : 'The router comes up on your LAN, fully configured.',
                  'Adopt it into RubyMIK from the Onboard wizard.',
                ].map((t: string, i: number) => (
                  <li key={i} className="flex gap-2.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-[11px] font-bold text-accent">{i + 1}</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ol>
              <Link to="/onboard" className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">Adopt it in Onboard <ArrowRight className="h-4 w-4" /></Link>
            </div>
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
          <button onClick={() => void liveApply()} disabled={busy || !host || !user} className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Live-apply baseline</button>
        </>
      ) : (
        <div className={`rounded-xl border p-4 ${applyOut.result === 'applied' ? 'border-success-line bg-success-bg/50' : 'border-warning-line bg-warning-bg/50'}`}>
          <div className="flex items-center gap-2 font-bold">{applyOut.result === 'applied' ? <><CheckCircle2 className="h-4 w-4 text-success" /> Baseline applied — management preserved.</> : <><AlertTriangle className="h-4 w-4 text-warning" /> {applyOut.result === 'reverted' ? 'Reverted' : 'Failed'} at step "{applyOut.failedStep}" — router recovered ({applyOut.mgmtPreserved ? 'reachable' : 'STILL DOWN'}).</>}</div>
          <ul className="mt-2 space-y-1 text-sm">{applyOut.steps.map((s: any, i: number) => <li key={i} className="flex items-center gap-2">{s.ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <X className="h-4 w-4 text-danger" />}<span className="font-mono text-xs">{s.step}</span><span className="text-fg-dim">{s.detail}</span></li>)}</ul>
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label}</dt><dd className="mt-0.5 truncate font-medium text-fg" title={value}>{value}</dd></div>;
}
