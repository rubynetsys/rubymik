import { useState } from 'react';
import { AlertTriangle, Loader2, Power, X } from 'lucide-react';
import { api } from '../api';

/**
 * P29 — reboot the router behind an expected-outage dead-man. Monitor-only devices
 * can't reboot (the button is hidden AND the server 403s). Rebooting requires typing
 * the device name to confirm. There is no rollback for a reboot.
 */
export default function RebootPanel({ deviceId, deviceName, manageable }: {
  deviceId: number; deviceName: string; manageable: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body">
        <Power className="h-4 w-4 text-danger-fg" /> Reboot
      </h2>
      <p className="mt-1 text-sm text-fg-dim">
        Restart the router. It goes offline for a minute or two — RubyMIK marks it “rebooting” (no false
        down-alert) and confirms when it's back (serial + uptime reset verified). There is no undo.
      </p>
      {manageable ? (
        <button onClick={() => setOpen(true)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-danger-line px-3.5 py-2 text-sm font-semibold text-danger-fg-strong transition hover:bg-danger-bg">
          <Power className="h-4 w-4" /> Reboot router…
        </button>
      ) : (
        <div className="mt-3 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted">
          Monitor-only — add a write credential (Edit device) to reboot.
        </div>
      )}
      {open && <RebootModal deviceId={deviceId} deviceName={deviceName} onClose={() => setOpen(false)} />}
    </section>
  );
}

function RebootModal({ deviceId, deviceName, onClose }: { deviceId: number; deviceName: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const match = text.trim() === deviceName;

  async function go() {
    setBusy(true); setResult(null);
    try {
      const r = await api.post<{ rebooting: boolean; until: string }>(`/api/devices/${deviceId}/reboot`, { confirm: text.trim() });
      setResult({ ok: true, msg: `Reboot issued — expected back by ${new Date(r.until).toLocaleTimeString()}. Watch the status badge at the top: it shows “Rebooting”, then “Up” once the router returns and is verified.` });
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-danger-fg" /><h3 className="text-base font-bold text-fg-strong">Reboot {deviceName}?</h3></div>
          <button onClick={onClose} className="rounded-lg p-1 text-fg-faint hover:bg-app"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2.5 text-xs text-danger-fg-strong">
          This restarts the router immediately and it will be unreachable for a minute or two. A reboot can, rarely,
          fail to come back — <b>there is no rollback</b>. RubyMIK captures a pre-reboot snapshot, then waits for the
          device to return and verifies its serial number and that the uptime reset.
        </div>
        {result ? (
          <div className={`mt-3 rounded-lg px-3 py-2.5 text-sm ${result.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg-strong'}`}>{result.msg}</div>
        ) : (
          <label className="mt-4 block text-xs font-semibold text-fg-dim">Type the device name to confirm
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={deviceName}
              className="mt-1 w-full rounded-lg border border-border-strong bg-app px-3 py-2 text-sm text-fg-body outline-none transition focus:border-danger-line" />
          </label>
        )}
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">
            {result?.ok ? 'Close' : 'Cancel'}
          </button>
          {!result?.ok && (
            <button disabled={!match || busy} onClick={() => void go()}
              className="inline-flex items-center gap-2 rounded-lg bg-danger px-5 py-2 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-40">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />} Reboot now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
