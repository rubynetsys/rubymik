import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';
import { api } from '../api';

/**
 * P34 — single-device RouterOS update. Read state is available for any device;
 * "Check for updates" and "Install" require a write credential (monitor-only /
 * Home Lab → 403). The install downloads + reboots + installs behind the P29
 * expected-outage dead-man; it is gated by preconditions + a name-confirm and is
 * never automatic.
 */
interface UpdateState {
  channel: string | null; installed: string | null; latest: string | null; status: string | null;
  updateAvailable: boolean | null;
  firmwareCurrent: string | null; firmwareUpgrade: string | null; firmwareUpgradeAvailable: boolean | null;
}
interface UpdateView {
  manageable: boolean; rebooting: boolean; reachable: boolean;
  state: UpdateState | null; preconditions: { ok: boolean; blockers: string[] };
}

export default function UpdatePanel({ deviceId, deviceName, manageable }: { deviceId: number; deviceName: string; manageable: boolean }) {
  const [view, setView] = useState<UpdateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [fwOpen, setFwOpen] = useState(false);

  const load = useCallback(async () => {
    try { setView(await api.get<UpdateView>(`/api/devices/${deviceId}/update`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  async function check() {
    setChecking(true); setError(null);
    try { await api.post(`/api/devices/${deviceId}/update/check`, {}); await load(); }
    catch (err) { setError((err as Error).message); }
    finally { setChecking(false); }
  }

  const st = view?.state;
  const avail = st?.updateAvailable === true;

  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body">
        <ArrowUpCircle className="h-4 w-4 text-accent" /> RouterOS update
      </h2>
      <p className="mt-1 text-sm text-fg-dim">
        Check for a new RouterOS version and install it. Installing downloads, reboots and upgrades the router — RubyMIK
        marks it “rebooting” (no false down-alert) and verifies it comes back. RubyMIK never updates on its own.
      </p>

      {error && <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg-strong">{error}</div>}
      {!view && !error && <div className="mt-3 h-16 animate-pulse rounded-lg bg-app" />}

      {view && (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
            <Field label="Installed" value={st?.installed ?? '—'} />
            <Field label="Latest" value={st?.latest ?? 'not checked'} />
            <Field label="Channel" value={st?.channel ?? '—'} />
            <Field label="Firmware" value={st?.firmwareCurrent ? (st.firmwareUpgradeAvailable ? `${st.firmwareCurrent} → ${st.firmwareUpgrade}` : st.firmwareCurrent) : '—'} />
          </dl>

          <div className="mt-3">
            {!view.reachable ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-app px-2.5 py-1 text-xs font-semibold text-fg-muted"><AlertTriangle className="h-3.5 w-3.5" /> Not reachable</span>
            ) : avail ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-bg px-2.5 py-1 text-xs font-bold text-warning-fg"><ArrowUpCircle className="h-3.5 w-3.5" /> Update available: {st?.installed} → {st?.latest}</span>
            ) : st?.updateAvailable === false ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1 text-xs font-bold text-success-fg-strong"><CheckCircle2 className="h-3.5 w-3.5" /> Up to date</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-app px-2.5 py-1 text-xs font-semibold text-fg-muted">Latest unknown — check for updates</span>
            )}
          </div>

          {manageable ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => void check()} disabled={checking}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body transition hover:border-accent-border disabled:opacity-50">
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check for updates
              </button>
              {avail && (
                <button onClick={() => setConfirmOpen(true)} disabled={!view.preconditions.ok}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-warning-line px-3.5 py-2 text-sm font-semibold text-warning-fg transition hover:bg-warning-bg disabled:opacity-50">
                  <ArrowUpCircle className="h-4 w-4" /> Install update &amp; reboot…
                </button>
              )}
            </div>
          ) : (
            <div className="mt-3 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted">Monitor-only — add a write credential (Edit device) to check or install updates.</div>
          )}

          {manageable && avail && !view.preconditions.ok && (
            <ul className="mt-2 space-y-1 text-xs text-fg-muted">
              {view.preconditions.blockers.map((b, i) => <li key={i}>• {b}</li>)}
            </ul>
          )}

          {st?.firmwareUpgradeAvailable && (
            <div className="mt-3 rounded-lg border border-warning-line bg-warning-bg/40 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-warning-fg">
                  <b>RouterBOARD firmware</b> — {st.firmwareCurrent} → {st.firmwareUpgrade} pending. This is the bootloader, upgraded separately from RouterOS.
                </div>
                {manageable && (
                  <button onClick={() => setFwOpen(true)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-warning-line px-3 py-1.5 text-xs font-semibold text-warning-fg transition hover:bg-warning-bg">
                    <ArrowUpCircle className="h-3.5 w-3.5" /> Upgrade firmware &amp; reboot…
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {confirmOpen && st && <InstallModal deviceId={deviceId} deviceName={deviceName} from={st.installed} to={st.latest} onClose={() => { setConfirmOpen(false); void load(); }} />}
      {fwOpen && st && <FirmwareModal deviceId={deviceId} deviceName={deviceName} from={st.firmwareCurrent} to={st.firmwareUpgrade} onClose={() => { setFwOpen(false); void load(); }} />}
    </section>
  );
}

function FirmwareModal({ deviceId, deviceName, from, to, onClose }: { deviceId: number; deviceName: string; from: string | null; to: string | null; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const match = text.trim() === deviceName;
  async function go() {
    setBusy(true); setResult(null);
    try {
      const r = await api.post<{ upgradingFirmware: boolean; until: string; from: string; to: string }>(`/api/devices/${deviceId}/update/firmware`, { confirm: text.trim() });
      setResult({ ok: true, msg: `Firmware upgrade issued (${r.from ?? from} → ${r.to ?? to}) — expected back by ${new Date(r.until).toLocaleTimeString()}. Watch the status badge: “Rebooting”, then “Up”.` });
    } catch (e) { setResult({ ok: false, msg: (e as Error).message }); }
    finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-warning-fg" /><h3 className="text-base font-bold text-fg-strong">Upgrade RouterBOARD firmware on {deviceName}?</h3></div>
          <button onClick={onClose} className="rounded-lg p-1 text-fg-faint hover:bg-app"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-3 rounded-lg bg-warning-bg px-3 py-2.5 text-xs text-warning-fg">
          This flashes the RouterBOARD bootloader <b>{from ?? '?'} → {to ?? '?'}</b> and reboots to apply it — the device is unreachable for a minute or two.
          A pre-upgrade snapshot is captured and RubyMIK verifies the box returns (serial + uptime reset). <b>There is no rollback of a completed firmware flash.</b>
        </div>
        {result ? (
          <div className={`mt-3 rounded-lg px-3 py-2.5 text-sm ${result.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg-strong'}`}>{result.msg}</div>
        ) : (
          <label className="mt-4 block text-xs font-semibold text-fg-dim">Type the device name to confirm
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={deviceName}
              className="mt-1 w-full rounded-lg border border-border-strong bg-app px-3 py-2 text-sm text-fg-body outline-none transition focus:border-warning-line" />
          </label>
        )}
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">{result?.ok ? 'Close' : 'Cancel'}</button>
          {!result?.ok && (
            <button disabled={!match || busy} onClick={() => void go()}
              className="inline-flex items-center gap-2 rounded-lg bg-warning px-5 py-2 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-40">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpCircle className="h-4 w-4" />} Upgrade firmware now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label}</dt><dd className="mt-0.5 font-medium text-fg">{value}</dd></div>;
}

function InstallModal({ deviceId, deviceName, from, to, onClose }: { deviceId: number; deviceName: string; from: string | null; to: string | null; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const match = text.trim() === deviceName;

  async function go() {
    setBusy(true); setResult(null);
    try {
      const r = await api.post<{ updating: boolean; until: string; from: string; to: string }>(`/api/devices/${deviceId}/update/install`, { confirm: text.trim() });
      setResult({ ok: true, msg: `Update issued (${r.from ?? from} → ${r.to ?? to}) — expected back by ${new Date(r.until).toLocaleTimeString()}. Watch the status badge: “Rebooting”, then “Up”. Re-check the version once it returns.` });
    } catch (e) { setResult({ ok: false, msg: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-warning-fg" /><h3 className="text-base font-bold text-fg-strong">Update {deviceName}?</h3></div>
          <button onClick={onClose} className="rounded-lg p-1 text-fg-faint hover:bg-app"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-3 rounded-lg bg-warning-bg px-3 py-2.5 text-xs text-warning-fg">
          This installs RouterOS <b>{from ?? '?'} → {to ?? '?'}</b>: the router downloads the packages, reboots, and upgrades — unreachable for a few minutes.
          A pre-update snapshot is captured first, and RubyMIK verifies the box returns (serial + uptime reset). <b>There is no rollback of a completed upgrade.</b>
        </div>
        {result ? (
          <div className={`mt-3 rounded-lg px-3 py-2.5 text-sm ${result.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg-strong'}`}>{result.msg}</div>
        ) : (
          <label className="mt-4 block text-xs font-semibold text-fg-dim">Type the device name to confirm
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={deviceName}
              className="mt-1 w-full rounded-lg border border-border-strong bg-app px-3 py-2 text-sm text-fg-body outline-none transition focus:border-warning-line" />
          </label>
        )}
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">{result?.ok ? 'Close' : 'Cancel'}</button>
          {!result?.ok && (
            <button disabled={!match || busy} onClick={() => void go()}
              className="inline-flex items-center gap-2 rounded-lg bg-warning px-5 py-2 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-40">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpCircle className="h-4 w-4" />} Update now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
