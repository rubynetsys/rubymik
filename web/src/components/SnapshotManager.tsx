import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Camera, Download, Eye, GitCompare, Loader2, Lock, X } from 'lucide-react';
import { api } from '../api';
import { fmtAgo, fmtBytes, type SnapshotContent, type SnapshotDiff, type SnapshotMeta, type SnapshotsView } from '../types';

const TRIGGER: Record<string, { label: string; cls: string }> = {
  pre_write: { label: 'pre-write', cls: 'bg-info-bg text-info-fg' },
  post_write: { label: 'post-write', cls: 'bg-info-bg text-info-fg' },
  manual: { label: 'manual', cls: 'bg-accent-subtle text-accent-text' },
  scheduled: { label: 'scheduled', cls: 'bg-app text-fg-muted' },
};

export default function SnapshotManager({ deviceId }: { deviceId: number }) {
  const [view, setView] = useState<SnapshotsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<number[]>([]);
  const [diff, setDiff] = useState<SnapshotDiff | null>(null);
  const [content, setContent] = useState<SnapshotContent | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.get<SnapshotsView>(`/api/devices/${deviceId}/snapshots`)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [deviceId]);
  useEffect(() => { void load(); }, [load]);

  async function snapshotNow() {
    setBusy(true);
    try { await api.post(`/api/devices/${deviceId}/snapshots`); await load(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  function toggle(id: number) { setSel((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(-2)); }
  async function showDiff() {
    if (sel.length !== 2) return;
    const [a, b] = [...sel].sort((x, y) => x - y); // older id first
    try { setDiff(await api.get<SnapshotDiff>(`/api/devices/${deviceId}/snapshots/diff?a=${a}&b=${b}`)); }
    catch (err) { setError((err as Error).message); }
  }
  async function viewOne(id: number) {
    try { setContent(await api.get<SnapshotContent>(`/api/devices/${deviceId}/snapshots/${id}`)); }
    catch (err) { setError((err as Error).message); }
  }

  if (error && !view) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load snapshots: {error}</div>;
  if (!view) return <div className="h-24 animate-pulse rounded-lg bg-app" />;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button onClick={() => void snapshotNow()} disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse transition hover:bg-accent-hover disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} Snapshot now
        </button>
        <button onClick={() => void showDiff()} disabled={sel.length !== 2}
          className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body transition hover:border-accent-border hover:text-accent-text disabled:opacity-40">
          <GitCompare className="h-4 w-4" /> Diff selected {sel.length === 2 ? '(2)' : ''}
        </button>
        <span className="inline-flex items-center gap-1 text-xs text-fg-faint"><Lock className="h-3 w-3" /> encrypted at rest · view / diff / download only (no restore)</span>
      </div>

      {view.lastFailure && (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Last {view.lastFailure.trigger.replace('_', '-')} capture failed ({fmtAgo(view.lastFailure.createdAt)}): {view.lastFailure.reason}</span>
        </div>
      )}
      {error && <div className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

      {view.snapshots.length === 0 ? (
        <div className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-dim">
          No snapshots yet. They’re captured automatically before/after every config change, plus daily — or click “Snapshot now”.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle bg-sunken text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
                <th className="px-3 py-2 w-8"></th>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Trigger</th>
                <th className="px-3 py-2">Operation</th>
                <th className="px-3 py-2 text-right">Size</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {view.snapshots.map((s) => (
                <tr key={s.id} className="border-b border-border-subtle text-fg-body">
                  <td className="px-3 py-2"><input type="checkbox" checked={sel.includes(s.id)} onChange={() => toggle(s.id)} className="h-4 w-4 accent-accent" /></td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-fg">{new Date(s.capturedAt).toLocaleString()}</div>
                    <div className="text-[11px] text-fg-faint">{fmtAgo(s.capturedAt)}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${(TRIGGER[s.trigger] ?? TRIGGER.manual).cls}`}>{(TRIGGER[s.trigger] ?? TRIGGER.manual).label}</span>
                    {s.outcome && <span className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${s.outcome === 'applied' ? 'bg-success-bg text-success-fg' : 'bg-warning-bg text-warning-fg'}`}>{s.outcome}</span>}
                    {s.isDuplicate && <span className="ml-1 rounded-full bg-app px-2 py-0.5 text-[10px] font-semibold text-fg-dim" title="Identical to the previous snapshot — stored as a pointer, no duplicate blob">dup</span>}
                    {s.format === 'snapshot' && <span className="ml-1 rounded-full bg-app px-2 py-0.5 text-[10px] font-semibold text-fg-dim" title="Read-only GET reconstruction (monitor-only device)">read-only</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-fg-dim">{s.operation ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-fg-dim">{fmtBytes(s.sizeBytes)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button title="View config" onClick={() => void viewOne(s.id)} className="rounded-md p-1.5 text-fg-faint transition hover:bg-app hover:text-fg-body"><Eye className="h-4 w-4" /></button>
                      <a href={`/api/devices/${deviceId}/snapshots/${s.id}/download`} title="Download .rsc" className="rounded-md p-1.5 text-fg-faint transition hover:bg-app hover:text-fg-body"><Download className="h-4 w-4" /></a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {diff && <DiffModal diff={diff} onClose={() => setDiff(null)} />}
      {content && <ContentModal content={content} onClose={() => setContent(null)} />}
    </div>
  );
}

function metaLabel(m: SnapshotMeta) { return `#${m.id} ${m.trigger.replace('_', '-')}${m.operation ? ` · ${m.operation}` : ''}`; }

function DiffModal({ diff, onClose }: { diff: SnapshotDiff; onClose: () => void }) {
  const changed = diff.diff.lines.filter((l) => l.t !== ' ');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-fg-strong">Config diff</h3>
            <p className="mt-0.5 text-xs text-fg-dim">
              {metaLabel(diff.a)} → {metaLabel(diff.b)}{' · '}
              <span className="font-semibold text-success-fg">+{diff.diff.added}</span> <span className="font-semibold text-danger-fg">−{diff.diff.removed}</span>
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-4 flex-1 overflow-auto rounded-lg bg-sidebar2 p-3 font-mono text-xs leading-5">
          {changed.length === 0 && <div className="text-fg-faint">No differences (identical config).</div>}
          {diff.diff.lines.map((l, i) => (l.t === ' ' ? null : (
            <div key={i} className={l.t === '+' ? 'text-success' : 'text-danger'}><span className="select-none opacity-60">{l.t} </span>{l.s || ' '}</div>
          )))}
        </div>
      </div>
    </div>
  );
}

function ContentModal({ content, onClose }: { content: SnapshotContent; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-fg-strong">Snapshot {metaLabel(content.meta)}</h3>
            <p className="mt-0.5 text-xs text-fg-dim">{new Date(content.meta.capturedAt).toLocaleString()} · {content.meta.identity ?? '?'} · RouterOS {content.meta.version ?? '?'} · {content.meta.format === 'export' ? 'canonical export (show-sensitive)' : 'read-only reconstruction'}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button>
        </div>
        <pre className="mt-4 flex-1 overflow-auto rounded-lg bg-sidebar2 p-3 font-mono text-xs leading-5 text-fg-body whitespace-pre">{content.content}</pre>
      </div>
    </div>
  );
}
