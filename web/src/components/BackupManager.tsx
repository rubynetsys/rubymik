import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Download, GitCompare, Loader2,
  RotateCcw, ShieldAlert, Save, X,
} from 'lucide-react';
import { api } from '../api';
import { fmtAgo, fmtBytes, type Backup, type BackupsView, type DiffResult, type RestoreOutcome } from '../types';

export default function BackupManager({ deviceId }: { deviceId: number }) {
  const [view, setView] = useState<BackupsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'backup'>(null);
  const [sel, setSel] = useState<number[]>([]);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [outcome, setOutcome] = useState<{ title: string; result: string; detail: string; auditId?: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.get<BackupsView>(`/api/devices/${deviceId}/backups`));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [deviceId]);

  useEffect(() => { void load(); }, [load]);

  async function backupNow() {
    setBusy('backup');
    try {
      await api.post(`/api/devices/${deviceId}/backups`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function toggle(id: number) {
    setSel((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-2));
  }

  async function showDiff() {
    if (sel.length !== 2) return;
    const [a, b] = [...sel].sort((x, y) => x - y); // older id first
    try {
      setDiff(await api.get<DiffResult>(`/api/devices/${deviceId}/backups/diff?a=${a}&b=${b}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error && !view) return <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800">Could not load backups: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-zinc-100" />;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button onClick={() => void backupNow()} disabled={busy !== null}
          className="inline-flex items-center gap-2 rounded-lg bg-ruby-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ruby-500 disabled:opacity-50">
          {busy === 'backup' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Back up now
        </button>
        <button onClick={() => void showDiff()} disabled={sel.length !== 2}
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-ruby-400 hover:text-ruby-700 disabled:opacity-40">
          <GitCompare className="h-4 w-4" /> Diff selected {sel.length === 2 ? '(2)' : ''}
        </button>
        <span className="text-xs text-zinc-400">
          {view.manageable
            ? 'Restore available (this device has a write credential).'
            : 'Monitor-only — backups work; restore is disabled (a write).'}
        </span>
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}

      {view.backups.length === 0 ? (
        <div className="rounded-lg bg-zinc-50 px-3 py-2.5 text-sm text-zinc-500">
          No backups yet. Click “Back up now”, or wait for the scheduled backup.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                <th className="px-3 py-2 w-8"></th>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">RouterOS</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2 text-right">Size</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {view.backups.map((b) => (
                <tr key={b.id} className="border-b border-zinc-50 text-zinc-700">
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={sel.includes(b.id)} onChange={() => toggle(b.id)}
                      className="h-4 w-4 accent-ruby-600" />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-zinc-800">{new Date(b.createdAt).toLocaleString()}</div>
                    <div className="text-[11px] text-zinc-400">{fmtAgo(b.createdAt)}</div>
                  </td>
                  <td className="px-3 py-2 text-zinc-500">{b.version ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${b.source === 'manual' ? 'bg-sky-50 text-sky-700' : 'bg-zinc-100 text-zinc-600'}`}>{b.source}</span>
                    {b.format === 'snapshot' && <span className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-500" title="Read-only GET snapshot (not restorable)">snapshot</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500" title={`${b.rawBytes} B raw`}>
                    {fmtBytes(b.gzBytes)} <span className="text-[10px] text-zinc-400">gz</span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <a href={`/api/devices/backups/${b.id}/download`} title="Download .rsc"
                        className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700">
                        <Download className="h-4 w-4" />
                      </a>
                      {view.manageable && b.format === 'export' && (
                        <button title="Restore this backup" onClick={() => setRestoring(b)}
                          className="rounded-md p-1.5 text-zinc-400 transition hover:bg-amber-50 hover:text-amber-700">
                          <RotateCcw className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {diff && <DiffModal diff={diff} onClose={() => setDiff(null)} />}
      {restoring && (
        <RestoreModal deviceId={deviceId} backup={restoring} onClose={() => setRestoring(null)}
          onDone={(o) => { setRestoring(null); setOutcome({ title: `Restore backup #${restoring.id}`, ...o }); void load(); }} />
      )}
      {outcome && <OutcomeModal {...outcome} onClose={() => setOutcome(null)} />}
    </div>
  );
}

function DiffModal({ diff, onClose }: { diff: DiffResult; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4" onMouseDown={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-zinc-900">Config diff</h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              #{diff.from.id} ({new Date(diff.from.createdAt).toLocaleString()}) → #{diff.to.id} ({new Date(diff.to.createdAt).toLocaleString()})
              {' · '}<span className="font-semibold text-emerald-700">+{diff.added}</span> <span className="font-semibold text-red-700">−{diff.removed}</span>
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-4 flex-1 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-5">
          {diff.added === 0 && diff.removed === 0 && <div className="text-zinc-400">No differences.</div>}
          {diff.lines.filter((l) => l.t !== ' ').length === 0 && diff.lines.length > 0 && <div className="text-zinc-400">Only unchanged lines.</div>}
          {diff.lines.map((l, i) => (
            l.t === ' ' ? null : (
              <div key={i} className={l.t === '+' ? 'text-emerald-400' : 'text-red-400'}>
                <span className="select-none opacity-60">{l.t} </span>{l.s || ' '}
              </div>
            )
          ))}
        </div>
      </div>
    </div>
  );
}

function RestoreModal({ deviceId, backup, onClose, onDone }: {
  deviceId: number; backup: Backup; onClose: () => void; onDone: (o: RestoreOutcome) => void;
}) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Diff the target backup against the newest backup (proxy for "current").
  useEffect(() => {
    api.get<{ backups: Backup[] }>(`/api/devices/${deviceId}/backups`).then((v) => {
      const newest = v.backups[0];
      if (newest && newest.id !== backup.id) {
        api.get<DiffResult>(`/api/devices/${deviceId}/backups/diff?a=${backup.id}&b=${newest.id}`).then(setDiff).catch(() => {});
      }
    }).catch(() => {});
  }, [deviceId, backup.id]);

  async function doRestore() {
    setBusy(true);
    setErr(null);
    try {
      const o = await api.post<RestoreOutcome>(`/api/devices/${deviceId}/backups/${backup.id}/restore`, {});
      onDone(o);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4" onMouseDown={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-zinc-900">Restore backup #{backup.id}</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>This replaces the device configuration</strong> with the backup from{' '}
            {new Date(backup.createdAt).toLocaleString()} (RouterOS {backup.version ?? '?'}, {backup.model ?? '?'} {backup.serial ?? ''}).
            The current config is snapshotted first; if the management path is lost, RubyMIK auto-reverts. Runs through the audited safe-apply pipeline.
          </span>
        </div>
        {diff && (
          <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-5">
            <div className="mb-1 text-zinc-400">newest backup → this backup ({diff.added + diff.removed} changed lines):</div>
            {diff.lines.filter((l) => l.t !== ' ').slice(0, 200).map((l, i) => (
              <div key={i} className={l.t === '+' ? 'text-emerald-400' : 'text-red-400'}><span className="opacity-60">{l.t} </span>{l.s || ' '}</div>
            ))}
          </div>
        )}
        {err && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
        <div className="mt-4 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50">Cancel</button>
          <button onClick={() => void doRestore()} disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            Restore configuration
          </button>
        </div>
      </div>
    </div>
  );
}

const RESULT_META: Record<string, { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  applied: { label: 'Restored & verified', cls: 'text-emerald-700 bg-emerald-50', Icon: CheckCircle2 },
  rolled_back: { label: 'Auto-rolled back (dead-man fired)', cls: 'text-amber-700 bg-amber-50', Icon: RotateCcw },
  rollback_failed: { label: 'Rollback failed', cls: 'text-red-700 bg-red-50', Icon: AlertTriangle },
  failed: { label: 'Failed', cls: 'text-red-700 bg-red-50', Icon: AlertTriangle },
};

function OutcomeModal({ title, result, detail, auditId, onClose }: { title: string; result: string; detail: string; auditId?: number; onClose: () => void }) {
  const m = RESULT_META[result] ?? RESULT_META.failed;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className={`mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${m.cls}`}><m.Icon className="h-4 w-4" /> {m.label}</div>
        <h3 className="text-base font-semibold text-zinc-900">{title}</h3>
        <p className="mt-1.5 text-sm text-zinc-600">{detail}</p>
        {auditId !== undefined && <p className="mt-3 text-xs text-zinc-400">Recorded in the audit log (#{auditId}).</p>}
        <div className="mt-5 flex justify-end"><button onClick={onClose} className="rounded-lg bg-ruby-600 px-5 py-2 text-sm font-semibold text-white hover:bg-ruby-500">Close</button></div>
      </div>
    </div>
  );
}
