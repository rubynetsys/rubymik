import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Loader2, Lock, Plus, RotateCcw, ShieldAlert, ShieldCheck, Trash2, X, Zap,
} from 'lucide-react';
import { api } from '../api';
import type { ApplyOutcome, FirewallCustomRule, FirewallPreset, FirewallView, LockoutTestResult } from '../types';

const PRESETS: Array<{ key: FirewallPreset; label: string; desc: string }> = [
  { key: 'off', label: 'Off', desc: 'No RubyMIK firewall rules (removes them).' },
  { key: 'basic', label: 'Basic', desc: 'Default-drop inbound on WAN (except established + mgmt), drop invalid, basic bogons, ICMP.' },
  { key: 'standard', label: 'Standard', desc: 'Basic + port-scan auto-blacklist + SYN-flood rate limits.' },
];

export default function FirewallManager({ deviceId }: { deviceId: number }) {
  const [view, setView] = useState<FirewallView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<FirewallPreset>('off');
  const [wan, setWan] = useState('');
  const [trusted, setTrusted] = useState('');
  const [mgmt, setMgmt] = useState('');
  const [custom, setCustom] = useState<FirewallCustomRule[]>([]);
  const [busy, setBusy] = useState<null | 'apply' | 'lockout' | 'remove'>(null);
  const [outcome, setOutcome] = useState<{ title: string; result: string; detail: string; auditId?: number } | null>(null);
  const [addCustom, setAddCustom] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await api.get<FirewallView>(`/api/devices/${deviceId}/firewall`);
      setView(v);
      setPreset(v.config.preset);
      setWan(v.config.wanInterface ?? (v.interfaces.find((i) => i.name === 'ether1')?.name ?? ''));
      setTrusted(v.config.trustedInterface ?? '');
      setMgmt(v.config.mgmtSources.join(', ') || v.suggestedMgmt || '');
      setCustom(v.config.custom ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [deviceId]);

  useEffect(() => { void load(); }, [load]);

  const mgmtSources = mgmt.split(',').map((s) => s.trim()).filter(Boolean);

  async function apply() {
    setBusy('apply');
    try {
      const o = await api.put<ApplyOutcome>(`/api/devices/${deviceId}/firewall`, {
        preset, wanInterface: wan, trustedInterface: trusted || null, mgmtSources, custom,
      });
      setOutcome({ title: `Apply firewall "${preset}"`, result: o.result, detail: o.detail, auditId: o.auditId });
      await load();
    } catch (err) {
      setOutcome({ title: 'Apply failed', result: 'failed', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function removeAll() {
    if (!confirm('Remove ALL RubyMIK firewall rules from this device? Non-RubyMIK rules are left untouched.')) return;
    setBusy('remove');
    try {
      const o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/firewall`);
      setOutcome({ title: 'Remove RubyMIK firewall', result: o.result, detail: o.detail, auditId: o.auditId });
      await load();
    } catch (err) {
      setOutcome({ title: 'Remove failed', result: 'failed', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function lockoutTest() {
    if (!confirm('SELF-LOCKOUT TEST (bench only): this deliberately severs RubyMIK’s own management path with a self-expiring drop, to prove the dead-man auto-recovers. Management will be lost for ~20s. Continue?')) return;
    setBusy('lockout');
    try {
      const r = await api.post<LockoutTestResult>(`/api/devices/${deviceId}/firewall/lockout-test`, {});
      setOutcome({ title: 'Self-lockout auto-recovery test', result: r.result, detail: r.detail, auditId: r.auditId });
      await load();
    } catch (err) {
      setOutcome({ title: 'Lockout test error', result: 'failed', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (error && !view) return <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800">Could not load firewall: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-zinc-100" />;

  const ro = !view.manageable;

  return (
    <div>
      {ro ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-600">
          <Lock className="h-4 w-4" /> Monitor-only — showing the firewall read-only. Add a write credential (Edit device) to manage it.
        </div>
      ) : (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-xs font-medium text-amber-800">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>This modifies the device firewall.</strong> A management-accept rule (established/related + your
            management sources + trusted interface) is always emitted <em>first</em>, before any drop, so a preset can't
            lock RubyMIK out. Changes run through snapshot → apply → verify (mgmt reachable) → auto-rollback → audit.
          </span>
        </div>
      )}

      {!ro && (
        <>
          {/* Preset selector */}
          <div className="grid gap-2 sm:grid-cols-3">
            {PRESETS.map((p) => (
              <button key={p.key} onClick={() => setPreset(p.key)}
                className={`rounded-xl border p-3 text-left transition ${
                  preset === p.key ? 'border-ruby-400 bg-ruby-50/50 ring-2 ring-ruby-500/15' : 'border-zinc-200 hover:border-ruby-300'
                }`}>
                <div className="flex items-center gap-1.5 text-sm font-bold text-zinc-900">
                  {p.key !== 'off' && <ShieldCheck className="h-4 w-4 text-ruby-600" />} {p.label}
                </div>
                <div className="mt-1 text-[11px] leading-4 text-zinc-500">{p.desc}</div>
              </button>
            ))}
          </div>

          {preset !== 'off' && (
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="WAN / untrusted interface">
                <select value={wan} onChange={(e) => setWan(e.target.value)} className={inputCls}>
                  <option value="">— select —</option>
                  {view.interfaces.map((i) => <option key={i.name} value={i.name}>{i.name} ({i.type})</option>)}
                </select>
              </Field>
              <Field label="Trusted interface (optional)">
                <select value={trusted} onChange={(e) => setTrusted(e.target.value)} className={inputCls}>
                  <option value="">— none —</option>
                  {view.interfaces.map((i) => <option key={i.name} value={i.name}>{i.name} ({i.type})</option>)}
                </select>
              </Field>
              <Field label="Management sources (comma-sep)">
                <input value={mgmt} onChange={(e) => setMgmt(e.target.value)} className={inputCls}
                  placeholder="192.168.88.10, 10.0.0.0/24" />
                {view.suggestedMgmt && (
                  <div className="mt-1 text-[10px] text-zinc-400">RubyMIK reaches this device from {view.suggestedMgmt}</div>
                )}
              </Field>
            </div>
          )}

          {/* Custom rules */}
          {preset !== 'off' && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wide text-zinc-500">Custom rules · {custom.length}</h4>
                <button onClick={() => setAddCustom(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-ruby-700 hover:underline">
                  <Plus className="h-3.5 w-3.5" /> Add custom rule
                </button>
              </div>
              {custom.length > 0 && (
                <div className="space-y-1.5">
                  {custom.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs">
                      <span className={`rounded px-1.5 py-0.5 font-bold ${c.action === 'accept' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{c.action}</span>
                      <span className="font-mono text-zinc-600">
                        {c.chain} {c.protocol ?? 'any'}{c.dstPort ? `:${c.dstPort}` : ''}{c.srcAddress ? ` src ${c.srcAddress}` : ''}
                      </span>
                      {c.comment && <span className="text-zinc-400">— {c.comment}</span>}
                      <button onClick={() => setCustom(custom.filter((_, j) => j !== i))} className="ml-auto text-zinc-400 hover:text-red-700">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <div className="text-[10px] text-zinc-400">Custom rules always sit below the management-accept guard — a custom drop can't lock you out.</div>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button onClick={() => void apply()} disabled={busy !== null}
              className="inline-flex items-center gap-2 rounded-lg bg-ruby-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ruby-500 disabled:opacity-50">
              {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Apply firewall
            </button>
            <button onClick={() => void removeAll()} disabled={busy !== null}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-red-400 hover:text-red-700 disabled:opacity-50">
              <Trash2 className="h-4 w-4" /> Remove all RubyMIK rules
            </button>
            <button onClick={() => void lockoutTest()} disabled={busy !== null || view.config.mgmtSources.length === 0}
              title={view.config.mgmtSources.length === 0 ? 'Apply a firewall config first' : 'Deliberately self-lockout to prove the dead-man (bench)'}
              className="ml-auto inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50">
              {busy === 'lockout' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
              Test self-lockout recovery
            </button>
          </div>
        </>
      )}

      {/* Current on-device ruleset */}
      <div className="mt-6">
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
          Live RUBYMIK ruleset on device · {view.managedRules.length}
        </h4>
        {view.managedRules.length === 0 ? (
          <div className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-500">No RubyMIK firewall rules on this device.</div>
        ) : (
          <ol className="overflow-hidden rounded-lg border border-zinc-100 text-xs">
            {view.managedRules.map((r, i) => (
              <li key={r.id} className="flex items-center gap-2 border-b border-zinc-50 px-3 py-1.5 last:border-0">
                <span className="w-5 text-right tabular-nums text-zinc-300">{i + 1}</span>
                <span className={`rounded px-1.5 py-0.5 font-bold ${r.action === 'accept' ? 'bg-emerald-50 text-emerald-700' : r.action === 'drop' || r.action === 'reject' ? 'bg-red-50 text-red-700' : 'bg-zinc-100 text-zinc-600'}`}>
                  {String(r.action)}
                </span>
                <span className="font-mono text-zinc-500">{String(r.chain)}</span>
                <span className="truncate text-zinc-600">{String(r.comment ?? '').replace(/^RUBYMIK:\s*/, '')}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {addCustom && <CustomRuleModal onClose={() => setAddCustom(false)} onAdd={(r) => { setCustom([...custom, r]); setAddCustom(false); }} />}
      {outcome && <OutcomeModal {...outcome} onClose={() => setOutcome(null)} />}
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none transition focus:border-ruby-500 focus:ring-2 focus:ring-ruby-500/20';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

function CustomRuleModal({ onClose, onAdd }: { onClose: () => void; onAdd: (r: FirewallCustomRule) => void }) {
  const [chain, setChain] = useState<'input' | 'forward'>('input');
  const [action, setAction] = useState<'accept' | 'drop' | 'reject'>('accept');
  const [protocol, setProtocol] = useState('');
  const [dstPort, setDstPort] = useState('');
  const [srcAddress, setSrcAddress] = useState('');
  const [comment, setComment] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-zinc-900">Custom rule</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100"><X className="h-5 w-5" /></button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">Validated before apply; always placed below the management-accept guard.</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field label="Chain"><select value={chain} onChange={(e) => setChain(e.target.value as 'input' | 'forward')} className={inputCls}><option value="input">input</option><option value="forward">forward</option></select></Field>
          <Field label="Action"><select value={action} onChange={(e) => setAction(e.target.value as 'accept' | 'drop' | 'reject')} className={inputCls}><option>accept</option><option>drop</option><option>reject</option></select></Field>
          <Field label="Protocol"><select value={protocol} onChange={(e) => setProtocol(e.target.value)} className={inputCls}><option value="">any</option><option>tcp</option><option>udp</option><option>icmp</option></select></Field>
          <Field label="Dest port"><input value={dstPort} onChange={(e) => setDstPort(e.target.value)} className={inputCls} placeholder="80,443" /></Field>
          <div className="col-span-2"><Field label="Source address (optional)"><input value={srcAddress} onChange={(e) => setSrcAddress(e.target.value)} className={inputCls} placeholder="10.0.0.0/24" /></Field></div>
          <div className="col-span-2"><Field label="Comment"><input value={comment} onChange={(e) => setComment(e.target.value)} className={inputCls} placeholder="allow web" /></Field></div>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50">Cancel</button>
          <button onClick={() => onAdd({ chain, action, protocol: protocol || null, dstPort: dstPort || null, srcAddress: srcAddress || null, comment: comment || null })}
            className="rounded-lg bg-ruby-600 px-5 py-2 text-sm font-semibold text-white hover:bg-ruby-500">Add rule</button>
        </div>
      </div>
    </div>
  );
}

const RESULT_META: Record<string, { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  applied: { label: 'Applied & verified', cls: 'text-emerald-700 bg-emerald-50', Icon: CheckCircle2 },
  rolled_back: { label: 'Auto-rolled back (dead-man fired)', cls: 'text-amber-700 bg-amber-50', Icon: RotateCcw },
  rollback_failed: { label: 'Rollback failed', cls: 'text-red-700 bg-red-50', Icon: AlertTriangle },
  failed: { label: 'Failed', cls: 'text-red-700 bg-red-50', Icon: AlertTriangle },
};

function OutcomeModal({ title, result, detail, auditId, onClose }: { title: string; result: string; detail: string; auditId?: number; onClose: () => void }) {
  const m = RESULT_META[result] ?? RESULT_META.failed;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className={`mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${m.cls}`}>
          <m.Icon className="h-4 w-4" /> {m.label}
        </div>
        <h3 className="text-base font-semibold text-zinc-900">{title}</h3>
        <p className="mt-1.5 text-sm text-zinc-600">{detail}</p>
        {auditId !== undefined && <p className="mt-3 text-xs text-zinc-400">Recorded in the audit log (#{auditId}).</p>}
        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="rounded-lg bg-ruby-600 px-5 py-2 text-sm font-semibold text-white hover:bg-ruby-500">Close</button>
        </div>
      </div>
    </div>
  );
}
