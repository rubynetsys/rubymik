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

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load firewall: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;

  const ro = !view.manageable;

  return (
    <div>
      {ro ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted">
          <Lock className="h-4 w-4" /> Monitor-only — showing the firewall read-only. Add a write credential (Edit device) to manage it.
        </div>
      ) : (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-warning-bg px-3 py-2.5 text-xs font-medium text-warning-fg">
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
                  preset === p.key ? 'border-accent-border bg-accent-subtle/50 ring-2 ring-accent-border-strong/15' : 'border-border hover:border-accent-border'
                }`}>
                <div className="flex items-center gap-1.5 text-sm font-bold text-fg-strong">
                  {p.key !== 'off' && <ShieldCheck className="h-4 w-4 text-accent" />} {p.label}
                </div>
                <div className="mt-1 text-[11px] leading-4 text-fg-dim">{p.desc}</div>
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
                  <div className="mt-1 text-[10px] text-fg-faint">RubyMIK reaches this device from {view.suggestedMgmt}</div>
                )}
              </Field>
            </div>
          )}

          {/* Custom rules */}
          {preset !== 'off' && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wide text-fg-dim">Custom rules · {custom.length}</h4>
                <button onClick={() => setAddCustom(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-accent-text hover:underline">
                  <Plus className="h-3.5 w-3.5" /> Add custom rule
                </button>
              </div>
              {custom.length > 0 && (
                <div className="space-y-1.5">
                  {custom.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs">
                      <span className={`rounded px-1.5 py-0.5 font-bold ${c.action === 'accept' ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg'}`}>{c.action}</span>
                      <span className="font-mono text-fg-muted">
                        {c.chain} {c.protocol ?? 'any'}{c.dstPort ? `:${c.dstPort}` : ''}{c.srcAddress ? ` src ${c.srcAddress}` : ''}
                      </span>
                      {c.comment && <span className="text-fg-faint">— {c.comment}</span>}
                      <button onClick={() => setCustom(custom.filter((_, j) => j !== i))} className="ml-auto text-fg-faint hover:text-danger-fg">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <div className="text-[10px] text-fg-faint">Custom rules always sit below the management-accept guard — a custom drop can't lock you out.</div>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button onClick={() => void apply()} disabled={busy !== null}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse transition hover:bg-accent-hover disabled:opacity-50">
              {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Apply firewall
            </button>
            <button onClick={() => void removeAll()} disabled={busy !== null}
              className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body transition hover:border-danger-line hover:text-danger-fg disabled:opacity-50">
              <Trash2 className="h-4 w-4" /> Remove all RubyMIK rules
            </button>
            <button onClick={() => void lockoutTest()} disabled={busy !== null || view.config.mgmtSources.length === 0}
              title={view.config.mgmtSources.length === 0 ? 'Apply a firewall config first' : 'Deliberately self-lockout to prove the dead-man (bench)'}
              className="ml-auto inline-flex items-center gap-2 rounded-lg border border-warning-line bg-warning-bg px-4 py-2 text-sm font-semibold text-warning-fg transition hover:bg-warning-bg disabled:opacity-50">
              {busy === 'lockout' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
              Test self-lockout recovery
            </button>
          </div>
        </>
      )}

      {/* Current on-device ruleset */}
      <div className="mt-6">
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-dim">
          Live RUBYMIK ruleset on device · {view.managedRules.length}
        </h4>
        {view.managedRules.length === 0 ? (
          <div className="rounded-lg bg-sunken px-3 py-2 text-sm text-fg-dim">No RubyMIK firewall rules on this device.</div>
        ) : (
          <ol className="overflow-hidden rounded-lg border border-border-subtle text-xs">
            {view.managedRules.map((r, i) => (
              <li key={r.id} className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5 last:border-0">
                <span className="w-5 text-right tabular-nums text-fg-faint">{i + 1}</span>
                <span className={`rounded px-1.5 py-0.5 font-bold ${r.action === 'accept' ? 'bg-success-bg text-success-fg' : r.action === 'drop' || r.action === 'reject' ? 'bg-danger-bg text-danger-fg' : 'bg-app text-fg-muted'}`}>
                  {String(r.action)}
                </span>
                <span className="font-mono text-fg-dim">{String(r.chain)}</span>
                <span className="truncate text-fg-muted">{String(r.comment ?? '').replace(/^RUBYMIK:\s*/, '')}</span>
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

const inputCls = 'w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong focus:ring-2 focus:ring-accent-border-strong/20';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-dim">{label}</span>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-fg-strong">Custom rule</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button>
        </div>
        <p className="mt-1 text-xs text-fg-dim">Validated before apply; always placed below the management-accept guard.</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field label="Chain"><select value={chain} onChange={(e) => setChain(e.target.value as 'input' | 'forward')} className={inputCls}><option value="input">input</option><option value="forward">forward</option></select></Field>
          <Field label="Action"><select value={action} onChange={(e) => setAction(e.target.value as 'accept' | 'drop' | 'reject')} className={inputCls}><option>accept</option><option>drop</option><option>reject</option></select></Field>
          <Field label="Protocol"><select value={protocol} onChange={(e) => setProtocol(e.target.value)} className={inputCls}><option value="">any</option><option>tcp</option><option>udp</option><option>icmp</option></select></Field>
          <Field label="Dest port"><input value={dstPort} onChange={(e) => setDstPort(e.target.value)} className={inputCls} placeholder="80,443" /></Field>
          <div className="col-span-2"><Field label="Source address (optional)"><input value={srcAddress} onChange={(e) => setSrcAddress(e.target.value)} className={inputCls} placeholder="10.0.0.0/24" /></Field></div>
          <div className="col-span-2"><Field label="Comment"><input value={comment} onChange={(e) => setComment(e.target.value)} className={inputCls} placeholder="allow web" /></Field></div>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>
          <button onClick={() => onAdd({ chain, action, protocol: protocol || null, dstPort: dstPort || null, srcAddress: srcAddress || null, comment: comment || null })}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">Add rule</button>
        </div>
      </div>
    </div>
  );
}

const RESULT_META: Record<string, { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  applied: { label: 'Applied & verified', cls: 'text-success-fg bg-success-bg', Icon: CheckCircle2 },
  rolled_back: { label: 'Auto-rolled back (dead-man fired)', cls: 'text-warning-fg bg-warning-bg', Icon: RotateCcw },
  rollback_failed: { label: 'Rollback failed', cls: 'text-danger-fg bg-danger-bg', Icon: AlertTriangle },
  failed: { label: 'Failed', cls: 'text-danger-fg bg-danger-bg', Icon: AlertTriangle },
};

function OutcomeModal({ title, result, detail, auditId, onClose }: { title: string; result: string; detail: string; auditId?: number; onClose: () => void }) {
  const m = RESULT_META[result] ?? RESULT_META.failed;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className={`mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${m.cls}`}>
          <m.Icon className="h-4 w-4" /> {m.label}
        </div>
        <h3 className="text-base font-semibold text-fg-strong">{title}</h3>
        <p className="mt-1.5 text-sm text-fg-muted">{detail}</p>
        {auditId !== undefined && <p className="mt-3 text-xs text-fg-faint">Recorded in the audit log (#{auditId}).</p>}
        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">Close</button>
        </div>
      </div>
    </div>
  );
}
