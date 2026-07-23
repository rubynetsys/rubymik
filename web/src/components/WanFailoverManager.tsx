import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Radio, ShieldCheck, Split, Trash2, X, Zap } from 'lucide-react';
import { api, ApiError } from '../api';
import Select from './Select';
import type {
  WanFailoverView, WanFailoverSpec, WanLegInput, WanPreview, WanPlanObject, WanState, WanSourceType,
} from '../types';

const STATE_UI: Record<WanState, { label: string; cls: string; dot: string }> = {
  primary:     { label: 'On primary WAN', cls: 'bg-success-bg text-success-fg',        dot: 'bg-success-fg' },
  failover:    { label: 'On backup WAN',  cls: 'bg-warning-bg text-warning-fg',        dot: 'bg-warning-fg' },
  'both-down': { label: 'Both WANs down', cls: 'bg-danger-bg text-danger-fg-strong',   dot: 'bg-danger-fg' },
  none:        { label: 'Not configured', cls: 'bg-app text-fg-dim',                   dot: 'bg-fg-faint' },
};

// Kept in step with the server defaults (netwan.ts): NOT common client-DNS 1.1.1.1 / 8.8.8.8,
// so the probe host-route can't blackhole a site's DNS.
const DEFAULT_PROBE_WAN1 = '1.0.0.1';
const DEFAULT_PROBE_WAN2 = '8.8.4.4';
const emptyLeg = (probe: string): WanLegInput => ({ interface: '', sourceType: 'dhcp', gateway: '', probeTarget: probe });
const emptySpec = (): WanFailoverSpec => ({ wan1: emptyLeg(DEFAULT_PROBE_WAN1), wan2: emptyLeg(DEFAULT_PROBE_WAN2), mode: 'fresh', markRouterTraffic: false });

export default function WanFailoverManager({ deviceId, deviceName, interfaces = [] }: { deviceId: number; deviceName: string; interfaces?: string[] }) {
  const [view, setView] = useState<WanFailoverView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardMsg, setGuardMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WanFailoverSpec | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<WanFailoverView>(`/api/devices/${deviceId}/wan-failover`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setGuardMsg(null); setError(null);
    try {
      const o = await fn() as { result?: string; detail?: string };
      if (o?.result === 'rolled_back') setError(`Change auto-rolled back: ${o.detail ?? 'management became unreachable'}.`);
      await load();
    } catch (err) {
      const body = err instanceof ApiError ? err.body as { wanFailoverMgmtGuard?: boolean } | undefined : undefined;
      if (body?.wanFailoverMgmtGuard) setGuardMsg((err as Error).message);
      else setError((err as Error).message);
    } finally { setBusy(null); }
  }

  const teardown = () => act('teardown', () => api.post(`/api/devices/${deviceId}/wan-failover/teardown`, {}));

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load WAN failover: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;

  const st = STATE_UI[view.state];
  const primary = view.routes.find((r) => r.comment.includes('default-primary'));
  const backup = view.routes.find((r) => r.comment.includes('default-backup'));

  return (
    <div>
      {/* management context — same posture banner as the other net-feature managers */}
      <div className="mb-3 flex items-start gap-2 rounded-lg bg-info-bg px-3 py-2.5 text-sm text-info-fg">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>RubyMIK reaches this router on <b>{view.mgmt.mgmtScheme}:{view.mgmt.mgmtPort}</b> at <b>{view.mgmt.mgmtIp}</b>{view.mgmt.mgmtInterface ? <> via <b>{view.mgmt.mgmtInterface}</b></> : null}. The management path is never route-marked, and the only verified-reachable default route can't be deleted from under you.</span>
      </div>

      {/* timer honesty — the router does the failover; our timers only gate alerts */}
      <div className="mb-3 flex items-start gap-2 rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-dim">
        <Zap className="mt-0.5 h-4 w-4 shrink-0 text-fg-faint" />
        <span><b className="text-fg-body">The router does the failover itself</b> — RouterOS <span className="font-mono text-[12px]">check-gateway</span> switches to the backup WAN on its own timing (typically <b>~20–30s</b>). RubyMIK's alert timers only control <i>when you're notified</i>; they don't change how fast traffic moves.</span>
      </div>

      {guardMsg && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning-line bg-warning-bg px-3 py-2.5 text-sm text-warning-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span><b>Refused by the WAN failover guard.</b> {guardMsg}</span>
          <button onClick={() => setGuardMsg(null)} className="ml-auto rounded p-0.5 hover:bg-warning-line/40"><X className="h-4 w-4" /></button>
        </div>
      )}
      {error && <div className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

      {/* status chip */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${st.cls}`}>
          <span className={`h-2 w-2 rounded-full ${st.dot}`} /> {st.label}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-fg-faint"><Radio className="h-3.5 w-3.5" /> live — from this read, not the poller</span>
      </div>

      {!view.configured ? (
        <div className="rounded-xl border border-border-subtle bg-sunken p-5 text-center">
          <Split className="mx-auto h-8 w-8 text-fg-faint" />
          <p className="mt-2 text-sm font-semibold text-fg-body">No dual-WAN failover configured</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-fg-dim">Set up a primary + backup WAN with recursive-route failover. RubyMIK previews the exact routes, NAT and mangle it will create, then applies them behind a snapshot.</p>
          {view.manageable ? (
            <button onClick={() => setWizard(emptySpec())} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">
              <Split className="h-4 w-4" /> Set up WAN failover
            </button>
          ) : (
            <p className="mt-3 text-xs text-fg-faint">This device is monitor-only — add a write credential to configure failover.</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* the two WAN legs, as the router currently sees them */}
          <div className="grid gap-3 sm:grid-cols-2">
            <LegCard title="Primary WAN" distance="1" row={primary} accent />
            <LegCard title="Backup WAN" distance="2" row={backup} />
          </div>

          <details className="rounded-lg border border-border-subtle">
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-fg-dim">Managed objects ({view.routes.length} routes · {view.nat.length} NAT · {view.mangle.length} mangle)</summary>
            <div className="border-t border-border-subtle p-3">
              <ObjTable rows={view.routes.map((r) => ({ a: r.comment.replace('RUBYMIK-WAN ', ''), b: `${r.dst} → ${r.gateway}`, c: r.active ? 'active' : 'inactive', ok: r.active }))} cols={['route', 'dst → gateway', 'state']} />
            </div>
          </details>

          {/* auto-maintenance note — the DHCP-gateway reconcile the poller runs */}
          <div className="flex items-start gap-2 rounded-lg bg-sunken px-3 py-2.5 text-xs text-fg-dim">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-faint" />
            <span>RubyMIK maintains these routes automatically when your DHCP gateway changes — a renewed lease that moves the gateway is reconciled on the next poll (snapshotted and audited), so failover keeps working.</span>
          </div>

          {view.manageable && (
            <div className="flex items-center gap-3 pt-1">
              <button onClick={() => setWizard(emptySpec())} className="rounded-lg border border-border-strong px-3 py-1.5 text-sm font-semibold text-fg-body hover:border-accent-border hover:text-accent-text">Reconfigure…</button>
              <button onClick={teardown} disabled={busy != null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-danger-line px-3 py-1.5 text-sm font-semibold text-danger-fg hover:bg-danger-bg disabled:opacity-50">
                {busy === 'teardown' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Tear down
              </button>
              <span className="text-xs text-fg-faint">Teardown removes only the RUBYMIK-WAN objects and restores the original default.</span>
            </div>
          )}
        </div>
      )}

      {wizard && (
        <FailoverWizard deviceId={deviceId} deviceName={deviceName} interfaces={interfaces} initial={wizard}
          onClose={() => setWizard(null)} onApplied={() => { setWizard(null); void load(); }} />
      )}
    </div>
  );
}

function LegCard({ title, distance, row, accent }: { title: string; distance: string; row?: { gateway: string; active: boolean; checkGateway: string } | undefined; accent?: boolean }) {
  const active = row?.active ?? false;
  return (
    <div className={`rounded-xl border p-3 ${accent ? 'border-accent-border/50' : 'border-border-subtle'}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-fg-dim">{title}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${active ? 'bg-success-bg text-success-fg' : 'bg-app text-fg-dim'}`}>{active ? 'reachable' : 'down'}</span>
      </div>
      <div className="mt-1.5 font-mono text-sm text-fg-body">via {row?.gateway || '—'}</div>
      <div className="mt-0.5 text-[11px] text-fg-faint">distance {distance} · check-gateway {row?.checkGateway || 'ping'}</div>
    </div>
  );
}

function ObjTable({ rows, cols }: { rows: { a: string; b: string; c: string; ok?: boolean }[]; cols: [string, string, string] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
          <th className="pb-1 pr-3">{cols[0]}</th><th className="pb-1 pr-3">{cols[1]}</th><th className="pb-1">{cols[2]}</th>
        </tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} className="border-t border-border-subtle text-fg-dim">
            <td className="py-1.5 pr-3 font-mono text-[12px] text-fg-body">{r.a}</td>
            <td className="py-1.5 pr-3 font-mono text-[11px]">{r.b}</td>
            <td className={`py-1.5 text-[11px] font-semibold ${r.ok == null ? '' : r.ok ? 'text-success-fg' : 'text-fg-faint'}`}>{r.c}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// ── wizard: spec → preview (exact changes) → typed confirm → apply ──
const SRC: { value: WanSourceType; label: string }[] = [
  { value: 'dhcp', label: 'DHCP (auto)' }, { value: 'static', label: 'Static gateway' }, { value: 'pppoe', label: 'PPPoE' },
];
const MODES: { value: 'fresh' | 'adopt' | 'replace'; label: string }[] = [
  { value: 'fresh', label: 'Fresh — no existing default to reuse' },
  { value: 'adopt', label: 'Adopt — reuse the existing default as WAN1' },
  { value: 'replace', label: 'Replace — retire the existing default (tagged)' },
];

function FailoverWizard({ deviceId, deviceName, interfaces, initial, onClose, onApplied }: {
  deviceId: number; deviceName: string; interfaces: string[]; initial: WanFailoverSpec; onClose: () => void; onApplied: () => void;
}) {
  const [spec, setSpec] = useState<WanFailoverSpec>(initial);
  const [preview, setPreview] = useState<WanPreview | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState<'' | 'preview' | 'apply'>('');
  const [error, setError] = useState<string | null>(null);

  const phrase = `FAILOVER ${deviceName}`;
  const setLeg = (leg: 'wan1' | 'wan2', patch: Partial<WanLegInput>) => { setSpec((s) => ({ ...s, [leg]: { ...s[leg], ...patch } })); setPreview(null); };
  const ifOpts = useMemo(() => [{ value: '', label: 'select…' }, ...interfaces.map((n) => ({ value: n, label: n }))], [interfaces]);

  async function doPreview() {
    setBusy('preview'); setError(null);
    try { setPreview(await api.post<WanPreview>(`/api/devices/${deviceId}/wan-failover/preview`, { spec })); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }
  async function doApply() {
    setBusy('apply'); setError(null);
    try {
      const o = await api.post(`/api/devices/${deviceId}/wan-failover`, { spec }) as { result?: string; detail?: string };
      if (o?.result === 'applied') { onApplied(); return; }
      setError(`Not applied (${o?.result}): ${o?.detail ?? 'see audit log'}.`);
    } catch (err) {
      const body = err instanceof ApiError ? err.body as { wanCollision?: boolean; wanFailoverMgmtGuard?: boolean } | undefined : undefined;
      setError(body?.wanCollision ? `Collision: ${(err as Error).message}` : (err as Error).message);
    } finally { setBusy(''); }
  }

  const a = preview?.analysis;
  const dns = preview?.dnsCollisions ?? [];
  const canApply = preview != null && a?.ok === true && confirmText.trim() === phrase && busy === '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-auto rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-fg-strong">Set up dual-WAN failover</h3>
            <p className="mt-0.5 text-sm text-fg-dim">Recursive-route failover: a primary and a backup WAN, with the router switching automatically via <span className="font-mono text-[12px]">check-gateway</span>.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {(['wan1', 'wan2'] as const).map((leg) => (
            <div key={leg} className="rounded-xl border border-border-subtle p-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-dim">{leg === 'wan1' ? 'Primary WAN (distance 1)' : 'Backup WAN (distance 2)'}</div>
              <label className="text-xs font-semibold text-fg-dim">Interface
                <Select value={spec[leg].interface} onChange={(v) => setLeg(leg, { interface: v })} className="mt-1 w-full" ariaLabel={`${leg} interface`} options={ifOpts} />
              </label>
              <label className="mt-2 block text-xs font-semibold text-fg-dim">Source
                <Select value={spec[leg].sourceType} onChange={(v) => setLeg(leg, { sourceType: v as WanSourceType })} className="mt-1 w-full" ariaLabel={`${leg} source`} options={SRC} />
              </label>
              <label className="mt-2 block text-xs font-semibold text-fg-dim">Gateway {spec[leg].sourceType === 'dhcp' && <span className="font-normal text-fg-faint">(auto-resolved; pre-fill the current one)</span>}
                <input value={spec[leg].gateway} onChange={(e) => setLeg(leg, { gateway: e.target.value })} placeholder={spec[leg].sourceType === 'pppoe' ? spec[leg].interface || 'pppoe-out' : '192.168.88.1'}
                  className="mt-1 w-full rounded-lg border border-border-strong bg-app px-2.5 py-2 font-mono text-sm text-fg-body" />
              </label>
              <label className="mt-2 block text-xs font-semibold text-fg-dim">Probe target
                <input value={spec[leg].probeTarget} onChange={(e) => setLeg(leg, { probeTarget: e.target.value })} placeholder={leg === 'wan1' ? DEFAULT_PROBE_WAN1 : DEFAULT_PROBE_WAN2}
                  className="mt-1 w-full rounded-lg border border-border-strong bg-app px-2.5 py-2 font-mono text-sm text-fg-body" />
              </label>
            </div>
          ))}
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold text-fg-dim">Existing default route
            <Select value={spec.mode} onChange={(v) => { setSpec((s) => ({ ...s, mode: v as WanFailoverSpec['mode'] })); setPreview(null); }} className="mt-1 w-full" ariaLabel="mode" options={MODES} />
          </label>
          <label className="flex items-end gap-2 pb-2 text-xs font-semibold text-fg-dim">
            <input type="checkbox" checked={spec.markRouterTraffic} onChange={(e) => { setSpec((s) => ({ ...s, markRouterTraffic: e.target.checked })); setPreview(null); }} className="h-4 w-4" />
            Also mark router-originated traffic (optional)
          </label>
        </div>

        {error && <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

        {/* exact-change preview */}
        {preview && (
          <div className="mt-4 rounded-xl border border-border-subtle">
            <div className="border-b border-border-subtle bg-sunken px-3 py-2 text-xs font-bold uppercase tracking-wide text-fg-dim">Exact changes — {preview.plan.all.length} objects{preview.plan.patches.length ? ` + ${preview.plan.patches.length} pppoe patch` : ''}</div>
            <div className="max-h-56 overflow-auto p-3">
              <PlanList objs={preview.plan.all} patches={preview.plan.patches} />
            </div>
            {(a && (!a.ok || a.masqueradeOnlyWan1 || a.requiresModeChoice)) || dns.length > 0 ? (
              <div className="space-y-1.5 border-t border-border-subtle p-3">
                {!a?.ok && a?.messages.map((m, i) => <Warn key={`m${i}`} danger>{m}</Warn>)}
                {a?.requiresModeChoice && a.ok && <Warn>An existing default route is present — choose <b>Adopt</b> or <b>Replace</b> above.</Warn>}
                {a?.masqueradeOnlyWan1 && <Warn>An existing masquerade covers WAN1 only — RubyMIK will add masquerade for both WANs.</Warn>}
                {dns.map((c, i) => <Warn key={`d${i}`}>{c.wan.toUpperCase()} probe <span className="font-mono">{c.probe}</span> is also handed to clients as DNS — pick a different probe target so a WAN failure can't blackhole DNS.</Warn>)}
              </div>
            ) : null}
          </div>
        )}

        {/* typed confirm */}
        {preview && a?.ok && (
          <div className="mt-4 rounded-lg bg-sunken p-3">
            <label className="text-xs font-semibold text-fg-dim">Type <span className="font-mono text-fg-body">{phrase}</span> to apply
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={phrase}
                className="mt-1 w-full rounded-lg border border-border-strong bg-app px-2.5 py-2 font-mono text-sm text-fg-body" />
            </label>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>
          <button onClick={doPreview} disabled={busy !== ''}
            className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:border-accent-border hover:text-accent-text disabled:opacity-50">
            {busy === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {preview ? 'Re-preview' : 'Preview changes'}
          </button>
          <button onClick={doApply} disabled={!canApply}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-40">
            {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Split className="h-4 w-4" />} Apply failover
          </button>
        </div>
      </div>
    </div>
  );
}

function Warn({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  return (
    <div className={`flex items-start gap-1.5 text-xs ${danger ? 'text-danger-fg' : 'text-warning-fg'}`}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{children}</span>
    </div>
  );
}

function summarize(o: WanPlanObject): string {
  const b = o.body;
  if (o.menu === '/routing/table') return `table ${b.name}`;
  if (o.menu === '/ip/route') return `${b['dst-address']}${b.gateway ? ` via ${b.gateway}` : ''}${b['check-gateway'] ? ` check-gateway=${b['check-gateway']}` : ''}${b.distance ? ` distance=${b.distance}` : ''}${b['routing-table'] ? ` table=${b['routing-table']}` : ''}${b.scope ? ` scope=${b.scope}` : ''}`;
  if (o.menu === '/ip/firewall/nat') return `${b.chain} ${b.action}${b['out-interface'] ? ` out=${b['out-interface']}` : ''}`;
  if (o.menu === '/ip/firewall/mangle') return `${b.chain} ${b.action}${b['in-interface'] ? ` in=${b['in-interface']}` : ''}${b['new-connection-mark'] ? ` mark=${b['new-connection-mark']}` : ''}${b['new-routing-mark'] ? ` route-mark=${b['new-routing-mark']}` : ''}`;
  return JSON.stringify(b);
}

function PlanList({ objs, patches }: { objs: WanPlanObject[]; patches: { menu: string; note: string }[] }) {
  return (
    <ul className="space-y-1 font-mono text-[11px] text-fg-dim">
      {objs.map((o, i) => (
        <li key={i} className="flex gap-2">
          <span className="w-32 shrink-0 text-fg-faint">{o.menu.replace('/ip/', '').replace('/routing/', '')}</span>
          <span className="text-fg-body">{summarize(o)}</span>
        </li>
      ))}
      {patches.map((p, i) => (
        <li key={`p${i}`} className="flex gap-2 text-warning-fg">
          <span className="w-32 shrink-0">patch</span><span>{p.note}</span>
        </li>
      ))}
    </ul>
  );
}
