import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, DatabaseBackup, Download, HardDriveDownload, Loader2, Lock, Play, ShieldCheck, ShieldOff, XCircle } from 'lucide-react';
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
  const [provideVal, setProvideVal] = useState('');

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
  async function keyAction(name: string, fn: () => Promise<unknown>) {
    setBusy(name); setError(null);
    try { await fn(); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }
  const enableBackups = () => keyAction('enable', () => api.post('/api/backup/enable', {}));
  const toggleStrict = (strict: boolean) => keyAction('strict', () => api.post('/api/backup/strict', { strict }));
  const provideKey = () => keyAction('provide', async () => { await api.post('/api/backup/provide-key', { key: provideVal.trim() }); setProvideVal(''); });

  if (error && !status) return <div className="rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger-fg-strong">Could not load backup status: {error}</div>;
  if (!status) return <div className="h-40 animate-pulse rounded-2xl bg-surface" />;

  const sev = status.severity;
  const sevCls = sev === 'ok' ? 'bg-success-bg text-success-fg-strong' : sev === 'warn' ? 'bg-warning-bg text-warning-fg' : 'bg-danger-bg text-danger-fg-strong';
  const key = status.key ?? { enabled: status.keyConfigured, source: (status.keyConfigured ? 'file' : 'none') as 'file' | 'none', tier: (status.keyConfigured ? 'convenience' : 'none') as 'convenience' | 'none', needsKey: false };

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

      {/* P44 — key management: one-click enable · protection tier · download · strict off-server */}
      {key.needsKey ? (
        <section className="rounded-2xl border border-warning-line bg-warning-bg/40 p-5">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-warning-fg"><Lock className="h-4 w-4" /> Strict mode — provide your recovery key</h2>
          <p className="mt-1 text-sm text-warning-fg">This install keeps the backup key <b>off the server</b> (strict mode). Paste your recovery key (the contents of <code>rubymik-recovery-key.txt</code>) to resume backups — it's held in memory only.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input value={provideVal} onChange={(e) => setProvideVal(e.target.value)} placeholder="64 hex characters" className={`${inputCls} flex-1 font-mono`} />
            <button disabled={busy !== null || provideVal.trim().length < 64} onClick={() => void provideKey()} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy === 'provide' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Provide key'}</button>
          </div>
        </section>
      ) : !key.enabled ? (
        <section className="rounded-2xl border border-warning-line bg-warning-bg/40 p-5">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-warning-fg"><ShieldOff className="h-4 w-4" /> Backups are OFF</h2>
          <p className="mt-1 text-sm text-warning-fg">Turn on encrypted database backups. RubyMIK generates the key, stores it in <code>/data</code>, and starts backing up immediately — no configuration.</p>
          <button disabled={busy !== null} onClick={() => void enableBackups()} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-50">{busy === 'enable' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Enable backups</button>
        </section>
      ) : key.source === 'env' ? (
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body"><Lock className="h-4 w-4" /> Key protection — environment (advanced)</h2>
          <p className="mt-1 text-sm text-fg-dim">The backup key is set via <code>RUBYMIK_BACKUP_KEY</code> (advanced). Manage it in your environment — the in-app controls are disabled while it's set.</p>
        </section>
      ) : (
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body">{key.tier === 'strict' ? <Lock className="h-4 w-4 text-success-fg" /> : <ShieldCheck className="h-4 w-4 text-success-fg" />} Key protection — {key.tier === 'strict' ? 'strict (off server)' : 'protected'}</h2>
          {key.tier === 'strict' ? (
            <p className="mt-1 text-sm text-fg-dim">The key is held <b>in memory only</b> — never stored beside the database. On restart you'll be asked to provide it again. Maximum protection.</p>
          ) : (
            <p className="mt-1 text-sm text-fg-dim"><b className="text-fg-body">Protected.</b> Backups are encrypted with a key in <code>/data</code> — this guards against partial leaks and off-host copy interception, but the key sits beside the database, so it does <b>not</b> protect against full-volume theft. <b className="text-fg-body">For maximum protection, download your recovery key</b> and switch to strict mode.</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a href="/api/backup/recovery-key" download className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:border-accent-border"><Download className="h-4 w-4" /> Download recovery key</a>
            {key.tier === 'strict'
              ? <button disabled={busy !== null} onClick={() => void toggleStrict(false)} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app disabled:opacity-50">{busy === 'strict' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Store key on server</button>
              : <button disabled={busy !== null} onClick={() => void toggleStrict(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-semibold text-fg-body hover:bg-app disabled:opacity-50">{busy === 'strict' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Remove key from server (strict)</button>}
          </div>
          {key.tier !== 'strict' && <p className="mt-2 text-xs text-fg-faint">Strict mode holds the key in memory only — you'll re-enter it here after every restart. <b>Download it first</b>, or you'll be locked out of your backups.</p>}
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
