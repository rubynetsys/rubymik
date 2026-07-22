import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, DatabaseBackup, HardDriveDownload, KeyRound, Loader2, Play, ShieldCheck, XCircle } from 'lucide-react';
import { api } from '../api';
import type { BackupStatus, BackupEntryView, BackupLogRow, OffhostConfig, DrillResult } from '../types';

const inputCls = 'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong';
const fmtBytes = (n: number | null | undefined) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KiB` : `${(n / 1048576).toFixed(1)} MiB`);
const fmtWhen = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : '—');

export default function SelfBackup() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [list, setList] = useState<{ backups: BackupEntryView[]; log: BackupLogRow[] } | null>(null);
  const [cfg, setCfg] = useState<OffhostConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillResult | null>(null);
  const [genKey, setGenKey] = useState<{ key: string; instructions: string[]; warning: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<BackupStatus>('/api/backup/status'));
      setList(await api.get<{ backups: BackupEntryView[]; log: BackupLogRow[] }>('/api/backup/list'));
      setCfg(await api.get<OffhostConfig>('/api/backup/config'));
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function runBackup() {
    setBusy('run'); setError(null);
    try { await api.post('/api/backup/run', {}); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }
  async function runDrill() {
    setBusy('drill'); setError(null); setDrill(null);
    try { setDrill(await api.post<DrillResult>('/api/backup/restore-drill', {})); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }
  async function generateKey() {
    setBusy('genkey'); setError(null);
    try { setGenKey(await api.post<{ key: string; instructions: string[]; warning: string }>('/api/backup/genkey', {})); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  if (error && !status) return <div className="rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger-fg-strong">Could not load backup status: {error}</div>;
  if (!status) return <div className="h-40 animate-pulse rounded-2xl bg-surface" />;

  const sev = status.severity;
  const sevCls = sev === 'ok' ? 'bg-success-bg text-success-fg-strong' : sev === 'warn' ? 'bg-warning-bg text-warning-fg' : 'bg-danger-bg text-danger-fg-strong';

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-fg-strong"><DatabaseBackup className="h-6 w-6 text-accent" /> System backup</h1>
        <p className="mt-1 text-sm text-fg-dim">RubyMIK's own database — encrypted router snapshots, credentials, users/2FA and the audit trail — backed up encrypted every 6 hours, restore-tested, and loudly alarmed on failure. This is not the per-device router-config backup.</p>
      </div>

      {error && <div className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

      {/* health */}
      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold ${sevCls}`}>
              {sev === 'ok' ? <ShieldCheck className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} {sev === 'ok' ? 'Healthy' : sev === 'warn' ? 'Warning' : 'Critical'}
            </span>
            <span className="text-sm text-fg-body">{status.reason}</span>
          </div>
          {status.keyConfigured && (
            <div className="flex gap-2">
              <button disabled={busy !== null} onClick={() => void runBackup()} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy === 'run' ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDriveDownload className="h-4 w-4" />} Back up now</button>
              <button disabled={busy !== null} onClick={() => void runDrill()} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:border-accent-border disabled:opacity-50">{busy === 'drill' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run restore drill</button>
            </div>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
          <Field label="Last successful" value={fmtWhen(status.lastOkAt)} />
          <Field label="Age" value={status.ageHours != null ? `${status.ageHours.toFixed(1)} h` : '—'} />
          <Field label="Alert if older than" value={`${status.gapHours} h`} />
          <Field label="Off-host copy" value={status.offhost.enabled ? (status.offhost.lastStatus ?? 'enabled') : 'disabled'} />
        </dl>
      </section>

      {/* key setup (shown when no backup key is configured) */}
      {!status.keyConfigured && (
        <section className="rounded-2xl border border-warning-line bg-warning-bg/40 p-5">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-warning-fg"><KeyRound className="h-4 w-4" /> Backups are OFF — set up a backup key</h2>
          <p className="mt-1 text-sm text-warning-fg">Self-backups use a <b>dedicated</b> key (separate from the field-encryption key), because a backup protects the whole database — including data that isn't field-encrypted. Generate one, store it <b>off this machine</b>, add it to <code>.env</code> as <code>RUBYMIK_BACKUP_KEY</code>, and restart. A backup is unreadable without it.</p>
          {!genKey ? (
            <button disabled={busy !== null} onClick={() => void generateKey()} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy === 'genkey' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Generate backup key</button>
          ) : (
            <div className="mt-3 rounded-xl border border-danger-line bg-surface p-4">
              <div className="text-xs font-bold uppercase tracking-wide text-danger-fg-strong">Shown once — copy it now</div>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 break-all rounded-lg bg-app px-3 py-2 font-mono text-xs text-fg-strong">{genKey.key}</code>
                <button onClick={() => void navigator.clipboard?.writeText(genKey.key)} className="rounded-lg border border-border-strong p-2 hover:bg-app" title="Copy"><Copy className="h-4 w-4" /></button>
              </div>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-fg-dim">{genKey.instructions.map((s, i) => <li key={i}>{s}</li>)}</ol>
              <p className="mt-2 text-xs font-semibold text-danger-fg-strong">{genKey.warning}</p>
            </div>
          )}
        </section>
      )}

      {/* restore drill output */}
      {drill && (
        <section className={`rounded-2xl border p-5 ${drill.ok ? 'border-success-line bg-success-bg/30' : 'border-danger-line bg-danger-bg/30'}`}>
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body">{drill.ok ? <CheckCircle2 className="h-4 w-4 text-success-fg" /> : <XCircle className="h-4 w-4 text-danger-fg-strong" />} Restore drill — {drill.ok ? 'PASSED' : 'FAILED'}{drill.backup ? ` (${drill.backup})` : ''}</h2>
          <p className="mt-1 text-xs text-fg-dim">The latest backup was decrypted and restored into a throwaway scratch instance — the live database was never touched.</p>
          <ul className="mt-3 space-y-1.5">
            {drill.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2 text-sm">
                {c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-fg" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg-strong" />}
                <span><b className="font-mono text-xs">{c.name}</b> — {c.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* off-host */}
      {cfg && <OffhostCard cfg={cfg} onSaved={load} setError={setError} />}

      {/* backups + log */}
      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="text-sm font-bold uppercase tracking-wide text-fg-body">Backups ({list?.backups.length ?? 0}) · keep 28 (7 days @ 6h)</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="bg-sunken text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint"><th className="px-3 py-2">When</th><th>Kind</th><th>Size</th><th>Schema</th><th className="pr-3">sha256 (of DB)</th></tr></thead>
            <tbody>
              {(list?.backups ?? []).map((b) => (
                <tr key={b.name} className="border-t border-border-subtle">
                  <td className="px-3 py-1.5 text-fg-body">{fmtWhen(b.createdAt)}</td>
                  <td className="text-fg-dim">{b.manifest?.kind ?? '—'}</td>
                  <td className="text-fg-body">{fmtBytes(b.sizeBytes)}</td>
                  <td className="text-fg-dim">v{b.manifest?.schemaVersion ?? '?'}</td>
                  <td className="pr-3 font-mono text-[11px] text-fg-faint">{b.manifest?.sha256Plain?.slice(0, 16) ?? '—'}…</td>
                </tr>
              ))}
              {(list?.backups.length ?? 0) === 0 && <tr><td colSpan={5} className="px-3 py-3 text-center text-sm text-fg-muted">No backups yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {list && list.log.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-semibold text-fg-dim">Run log ({list.log.length})</summary>
            <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <tbody>
                  {list.log.map((r) => (
                    <tr key={r.id} className="border-t border-border-subtle">
                      <td className="px-3 py-1 text-fg-dim">{fmtWhen(r.ts)}</td>
                      <td className="text-fg-faint">{r.kind}</td>
                      <td className={r.status === 'ok' ? 'text-success-fg' : 'text-danger-fg-strong'}>{r.status}</td>
                      <td className="text-fg-faint">off-host: {r.offhost_status ?? '—'}</td>
                      <td className="pr-3 text-fg-dim">{r.detail ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label}</dt><dd className="mt-0.5 font-medium text-fg">{value}</dd></div>;
}

function OffhostCard({ cfg, onSaved, setError }: { cfg: OffhostConfig; onSaved: () => Promise<void>; setError: (s: string | null) => void }) {
  const [enabled, setEnabled] = useState(cfg.enabled);
  const [path, setPath] = useState(cfg.path ?? '');
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try { await api.put('/api/backup/config', { enabled, kind: 'path', path: path || null }); await onSaved(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function test() {
    setTestMsg(null);
    try { const r = await api.post<{ ok: boolean; detail: string }>('/api/backup/config/test', {}); setTestMsg({ ok: true, msg: r.detail }); }
    catch (e) { setTestMsg({ ok: false, msg: (e as Error).message }); }
  }
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-bold uppercase tracking-wide text-fg-body">Off-host copy</h2>
      <p className="mt-1 text-sm text-fg-dim">After each backup, copy it to a second location. v1 copies to a mounted <b>path</b> — SFTP / rclone remotes are <b className="text-warning-fg">PENDING-RAY</b> (mechanism is built; pick a destination). Keep the off-host copy on different hardware; never store it with the backup key.</p>
      <label className="mt-3 flex items-center gap-2 text-sm text-fg-body"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enable off-host copy</label>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex-1"><span className="mb-1 block text-xs font-semibold text-fg-dim">Destination path (stand-in until Ray configures a remote)</span><input className={inputCls} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/offhost/rubymik" /></label>
        <button disabled={busy} onClick={() => void save()} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">Save</button>
        <button onClick={() => void test()} className="rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app">Test target</button>
      </div>
      {testMsg && <div className={`mt-2 rounded-lg px-3 py-2 text-xs ${testMsg.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg-strong'}`}>{testMsg.msg}</div>}
    </section>
  );
}
