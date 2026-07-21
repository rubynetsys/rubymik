import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Lock, Radio, RotateCcw, ShieldAlert, Signal, Wifi, WifiOff, X } from 'lucide-react';
import { api } from '../api';
import Select from './Select';
import type { ApplyOutcome, WirelessIface, WirelessView } from '../types';

const inputCls = 'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong';

export default function WirelessManager({ deviceId }: { deviceId: number }) {
  const [view, setView] = useState<WirelessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ title: string; result: string; detail: string; auditId?: number } | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<WirelessView>(`/api/devices/${deviceId}/wireless`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load wireless: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;

  // Capability-honest: a device with no radio says so, no fake config UI.
  if (view.stack === 'none') {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-sunken px-4 py-4 text-sm text-fg-muted">
        <WifiOff className="h-5 w-5 shrink-0 text-fg-faint" />
        This device has no wireless hardware — nothing to configure.
      </div>
    );
  }

  const ro = !view.manageable;
  const stackLabel = view.stack === 'wifi' ? 'Modern (wifiwave2 · /interface/wifi)' : 'Legacy (/interface/wireless)';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-subtle px-2.5 py-1 text-xs font-semibold text-accent-text">
          <Radio className="h-3.5 w-3.5" /> Stack: {stackLabel}
        </span>
        {view.capsmanManaged && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-info-bg px-2.5 py-1 text-xs font-semibold text-info-fg">
            CAPsMAN-managed — config flows through the controller
          </span>
        )}
      </div>

      {ro && (
        <div className="flex items-center gap-2 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted">
          <Lock className="h-4 w-4" /> Monitor-only — showing wireless read-only. Add a write credential (Edit device) to configure it.
        </div>
      )}

      {view.interfaces.map((iface) => (
        <IfaceCard key={iface.id} iface={iface} ro={ro} deviceId={deviceId} onOutcome={setOutcome} reload={load} />
      ))}

      {view.clients.length > 0 && (
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-fg-dim"><Signal className="h-3.5 w-3.5" /> Connected clients ({view.clients.length})</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <tbody>
                {view.clients.map((c, i) => (
                  <tr key={i} className="border-b border-border-subtle last:border-0">
                    {Object.values(c).map((v, j) => <td key={j} className="px-3 py-1.5 text-fg-body">{v ?? '—'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {outcome && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOutcome(null)}>
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                {outcome.result === 'applied' ? <CheckCircle2 className="h-5 w-5 text-success-fg" /> : <ShieldAlert className="h-5 w-5 text-warning-fg" />}
                <h3 className="text-base font-bold text-fg-strong">{outcome.title}: {outcome.result}</h3>
              </div>
              <button onClick={() => setOutcome(null)} className="rounded-lg p-1 text-fg-faint hover:bg-app"><X className="h-4 w-4" /></button>
            </div>
            <p className="mt-2 text-sm text-fg-dim">{outcome.detail}</p>
            {outcome.auditId && <p className="mt-2 text-xs text-fg-faint">Audit #{outcome.auditId} · snapshot → apply → verify → audit</p>}
          </div>
        </div>
      )}
    </div>
  );
}

type SetOutcome = (o: { title: string; result: string; detail: string; auditId?: number }) => void;
const WIDTHS = ['20mhz', '20/40mhz', '20/40/80mhz', '20/40/80/160mhz', '40mhz', '80mhz', '160mhz'];
const BANDS: Record<'wifi' | 'wireless', string[]> = {
  wifi: ['2ghz-ax', '2ghz-n', '2ghz-g', '5ghz-ax', '5ghz-ac', '5ghz-n', '5ghz-a'],
  wireless: ['2ghz-b/g/n', '2ghz-onlyn', '5ghz-a/n/ac', '5ghz-onlyn', '5ghz-onlyac'],
};

function IfaceCard({ iface, ro, deviceId, onOutcome, reload }: { iface: WirelessIface; ro: boolean; deviceId: number; onOutcome: SetOutcome; reload: () => Promise<void> }) {
  const [ssid, setSsid] = useState(iface.ssid ?? '');
  const [enabled, setEnabled] = useState(!iface.disabled);
  const [pass, setPass] = useState('');
  const [wpa3, setWpa3] = useState(iface.authTypes.some((t) => t.includes('wpa3')));
  const [band, setBand] = useState(iface.band ?? '');
  const [freq, setFreq] = useState(iface.frequency ?? '');
  const [width, setWidth] = useState(iface.width ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const stack: 'wifi' | 'wireless' = iface.securityProfile === null ? 'wifi' : 'wireless';

  async function put(kind: string, path: string, body: Record<string, unknown>, title: string) {
    setBusy(kind); setErr(null);
    try {
      const o = await api.put<ApplyOutcome>(`/api/devices/${deviceId}/wireless/${iface.id}/${path}`, body);
      onOutcome({ title, result: o.result, detail: o.detail, auditId: o.auditId });
      setPass('');
      await reload();
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      if (/force:true/i.test(msg) && confirm(`${msg}\n\nProceed anyway?`)) {
        try { const o = await api.put<ApplyOutcome>(`/api/devices/${deviceId}/wireless/${iface.id}/${path}`, { ...body, force: true }); onOutcome({ title, result: o.result, detail: o.detail, auditId: o.auditId }); setPass(''); await reload(); }
        catch (e2) { setErr((e2 as Error).message); }
      }
    } finally { setBusy(null); }
  }

  return (
    <section className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {iface.disabled ? <WifiOff className="h-4 w-4 text-fg-faint" /> : <Wifi className="h-4 w-4 text-accent" />}
          <span className="font-bold text-fg-strong">{iface.name}</span>
          <span className="text-xs text-fg-dim">{iface.mode ?? '—'}{iface.running ? ' · running' : ''}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {iface.authTypes.length > 0
            ? <span className="rounded-full bg-success-bg px-2 py-0.5 font-semibold text-success-fg">{iface.authTypes.join('+')}{iface.hasPassphrase ? ' · passphrase set' : ''}</span>
            : <span className="rounded-full bg-warning-bg px-2 py-0.5 font-semibold text-warning-fg">open / no security</span>}
        </div>
      </div>

      {iface.carriesManagement && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          RubyMIK appears to manage this device over <b>this</b> wireless interface. Changes here could sever access — you'll be asked to confirm.
        </div>
      )}

      {ro ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
          <Meta label="SSID" value={iface.ssid ?? '—'} />
          <Meta label="Band" value={iface.band ?? '—'} />
          <Meta label="Frequency" value={iface.frequency ?? '—'} />
          <Meta label="Width" value={iface.width ?? '—'} />
        </dl>
      ) : (
        <div className="mt-3 space-y-3">
          {err && <div className="rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{err}</div>}

          {/* SSID + enable */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1"><span className="mb-1 block text-xs font-semibold text-fg-dim">SSID (network name)</span>
              <input className={inputCls} value={ssid} onChange={(e) => setSsid(e.target.value)} maxLength={32} /></label>
            <label className="flex items-center gap-2 pb-2 text-sm text-fg-body">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
            <button disabled={busy !== null} onClick={() => void put('ssid', 'ssid', { ssid, enabled }, 'Set SSID')}
              className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse transition hover:bg-accent-hover disabled:opacity-50">Save SSID</button>
          </div>

          {/* Security */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1"><span className="mb-1 block text-xs font-semibold text-fg-dim">New WPA2/WPA3 passphrase (8–63, never shown)</span>
              <input className={inputCls} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={iface.hasPassphrase ? '•••••••• (set — enter to change)' : 'not set'} /></label>
            <label className="flex items-center gap-2 pb-2 text-sm text-fg-body">
              <input type="checkbox" checked={wpa3} onChange={(e) => setWpa3(e.target.checked)} /> WPA3</label>
            <button disabled={busy !== null || pass.length < 8}
              onClick={() => void put('security', 'security', { passphrase: pass, authTypes: stack === 'wifi' ? (wpa3 ? ['wpa2-psk', 'wpa3-psk'] : ['wpa2-psk']) : ['wpa2-psk'] }, 'Set Wi-Fi security')}
              className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse transition hover:bg-accent-hover disabled:opacity-50">Set security</button>
          </div>

          {/* Band / channel */}
          <div className="flex flex-wrap items-end gap-2">
            <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Band</span>
              <Select className={inputCls} value={band} onChange={setBand} ariaLabel="Band"
                options={[{ value: '', label: '(unchanged)' }, ...BANDS[stack].map((b) => ({ value: b, label: b }))]} /></label>
            <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Frequency (MHz)</span>
              <input className={`${inputCls} w-28`} value={freq} onChange={(e) => setFreq(e.target.value)} placeholder="auto" /></label>
            <label><span className="mb-1 block text-xs font-semibold text-fg-dim">Width</span>
              <Select className={inputCls} value={width} onChange={setWidth} ariaLabel="Width"
                options={[{ value: '', label: '(unchanged)' }, ...WIDTHS.map((w) => ({ value: w, label: w }))]} /></label>
            <button disabled={busy !== null} onClick={() => void put('channel', 'channel', { band: band || undefined, frequency: freq || null, width: width || undefined }, 'Set Wi-Fi channel')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body transition hover:border-accent-border hover:text-accent-text disabled:opacity-50">
              <RotateCcw className="h-3.5 w-3.5" /> Save channel</button>
          </div>
        </div>
      )}
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-fg" title={value}>{value}</dd>
    </div>
  );
}
