import { useEffect, useState } from 'react';
import { Loader2, Rocket } from 'lucide-react';
import { api } from '../api';
import type { UpdateStatus } from '../types';
import { fmtAgo } from '../types';

/** The in-app update check (version/schema, check-now, daily toggle). Shown on the
 *  Settings → Updates page. */
export default function SoftwareUpdateCard() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api.get<UpdateStatus>('/api/update/status').then(setSt).catch(() => {});
  useEffect(() => { void load(); }, []);

  async function checkNow() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post<{ status: string }>('/api/update/check', {});
      setMsg(r.status === 'ok' ? 'Checked — up to date info below.' : r.status === 'offline' ? 'Could not reach the update server (offline). Showing the last known result.' : 'Update checks are turned off.');
      await load();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function toggle(enabled: boolean) {
    setBusy(true); setMsg(null);
    try { await api.put('/api/update/config', { enabled }); await load(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  const rep = st?.report;
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body"><Rocket className="h-4 w-4 text-fg-faint" /> Software updates</h2>
      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <div className="text-fg-dim">Running <b className="font-mono text-fg-strong">v{st?.current ?? '…'}</b> · schema {st?.schemaVersion ?? '…'}</div>
          <div className="text-fg-dim">Last checked {fmtAgo(st?.lastCheckAt ?? null)}{st?.lastStatus === 'offline' ? ' (offline)' : ''}</div>
        </div>
        {rep && (
          <div className={`mt-3 rounded-lg px-3 py-2.5 text-sm ${rep.updateAvailable ? 'bg-info-bg text-info-fg' : 'bg-success-bg text-success-fg'}`}>
            {rep.updateAvailable
              ? <><b>v{rep.latest} is available.</b> {rep.breakingAhead.length > 0 && <>Breaking changes in {rep.breakingAhead.join(', ')}. </>}Update with: <code className="rounded bg-black/10 px-1.5 py-0.5 font-mono text-xs">{rep.pullCommand}</code>{rep.changelogUrl && <> · <a className="underline underline-offset-2" href={rep.changelogUrl} target="_blank" rel="noreferrer">changelog</a></>}</>
              : <>You're on the latest version.</>}
          </div>
        )}
        {msg && <div className="mt-3 rounded-lg bg-app px-3 py-2 text-sm text-fg-dim">{msg}</div>}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button disabled={busy} onClick={() => void checkNow()} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-40">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Check now
          </button>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg-body">
            <input type="checkbox" checked={st?.enabled ?? true} disabled={busy} onChange={(e) => void toggle(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
            Check for updates daily
          </label>
        </div>
        <p className="mt-3 text-xs text-fg-faint">The check fetches a small version file and compares it — nothing about this instance is ever sent, and RubyMIK never updates itself. Updating is always your call.</p>
      </div>
    </section>
  );
}
