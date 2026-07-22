import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, KeyRound, Loader2, Rocket, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { api } from '../api';
import type { UpdateStatus } from '../types';
import { fmtAgo } from '../types';
import { useMe } from '../me';

export default function Account({ onChanged }: { onChanged: () => void }) {
  const me = useMe();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-fg-strong">Your account</h1>
        <p className="mt-1 text-sm text-fg-dim">Signed in as <b>{me.username}</b> · role <b>{me.role}</b></p>
      </header>
      <PasswordCard />
      <TwoFactorCard enabled={me.twoFactor} onChanged={onChanged} />
      {me.role === 'admin' && <SoftwareUpdateCard />}
    </div>
  );
}

function Card({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-fg-body"><Icon className="h-4 w-4 text-fg-faint" /> {title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
const inputCls = 'w-full rounded-lg border border-border-strong bg-app px-3 py-2 text-sm text-fg-body outline-none focus:border-accent-border-strong';

function PasswordCard() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit() {
    setBusy(true); setMsg(null);
    try {
      await api.put('/api/me/password', { currentPassword: cur, newPassword: next });
      setMsg({ ok: true, text: 'Password changed. Your other sessions have been signed out.' });
      setCur(''); setNext('');
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  return (
    <Card icon={KeyRound} title="Password">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-fg-dim">Current password
          <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} className={`mt-1 ${inputCls}`} autoComplete="current-password" /></label>
        <label className="block text-xs font-semibold text-fg-dim">New password
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} className={`mt-1 ${inputCls}`} placeholder="At least 8 characters" autoComplete="new-password" /></label>
      </div>
      {msg && <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg-strong'}`}>{msg.text}</div>}
      <button disabled={busy || cur.length < 1 || next.length < 8} onClick={() => void submit()}
        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-40">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Change password
      </button>
    </Card>
  );
}

function SoftwareUpdateCard() {
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
    <Card icon={Rocket} title="Software updates">
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
      {msg && <div className="mt-3 rounded-lg bg-surface px-3 py-2 text-sm text-fg-dim">{msg}</div>}
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
    </Card>
  );
}

function TwoFactorCard({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [disablePw, setDisablePw] = useState('');

  useEffect(() => {
    if (!setup) { setQr(null); return; }
    QRCode.toDataURL(setup.uri, { margin: 1, width: 200 }).then(setQr).catch(() => setQr(null));
  }, [setup]);

  async function begin() {
    setBusy(true); setErr(null);
    try { setSetup(await api.post<{ secret: string; uri: string }>('/api/me/2fa/begin', {})); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function enable() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/me/2fa/enable', { code: code.trim() });
      setCodes(r.recoveryCodes); setSetup(null); setCode(''); onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true); setErr(null);
    try { await api.post('/api/me/2fa/disable', { password: disablePw }); setDisablePw(''); onChanged(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (codes) {
    return (
      <Card icon={ShieldCheck} title="Two-factor authentication">
        <div className="rounded-lg bg-success-bg px-3 py-2 text-sm font-medium text-success-fg">Two-factor is now on. Save these recovery codes.</div>
        <p className="mt-3 text-sm text-fg-dim">Each code works <b>once</b> if you lose your authenticator. They're shown only now.</p>
        <div className="mt-2 grid grid-cols-2 gap-1.5 rounded-lg border border-border-strong bg-app p-3 font-mono text-sm text-fg-strong">
          {codes.map((c) => <div key={c}>{c}</div>)}
        </div>
        <div className="mt-3 flex gap-3">
          <button onClick={() => navigator.clipboard?.writeText(codes.join('\n'))} className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken"><Copy className="h-4 w-4" /> Copy codes</button>
          <button onClick={() => setCodes(null)} className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">Done</button>
        </div>
      </Card>
    );
  }

  if (enabled) {
    return (
      <Card icon={ShieldCheck} title="Two-factor authentication">
        <div className="flex items-center gap-2 text-sm font-medium text-success-fg"><Check className="h-4 w-4" /> Enabled — a code is required at login.</div>
        {err && <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{err}</div>}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block text-xs font-semibold text-fg-dim">Confirm your password to turn off
            <input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} className={`mt-1 ${inputCls} w-64`} autoComplete="current-password" /></label>
          <button disabled={busy || disablePw.length < 1} onClick={() => void disable()} className="inline-flex items-center gap-1.5 rounded-lg border border-danger-line px-4 py-2 text-sm font-semibold text-danger-fg-strong hover:bg-danger-bg disabled:opacity-40"><ShieldOff className="h-4 w-4" /> Turn off 2FA</button>
        </div>
      </Card>
    );
  }

  return (
    <Card icon={Smartphone} title="Two-factor authentication">
      {!setup ? (
        <>
          <p className="text-sm text-fg-dim">Add a second step at login using an authenticator app (Google Authenticator, Authy, 1Password…).</p>
          {err && <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{err}</div>}
          <button disabled={busy} onClick={() => void begin()} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-40">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Set up 2FA
          </button>
        </>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          <div className="flex items-center justify-center rounded-lg bg-white p-2">{qr ? <img src={qr} alt="2FA QR code" width={200} height={200} /> : <div className="h-[200px] w-[200px] animate-pulse rounded bg-app" />}</div>
          <div>
            <p className="text-sm text-fg-dim">Scan the QR with your authenticator, or enter this key by hand:</p>
            <code className="mt-1 block break-all rounded bg-app px-2 py-1.5 font-mono text-xs text-fg-strong">{setup.secret}</code>
            {err && <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{err}</div>}
            <label className="mt-3 block text-xs font-semibold text-fg-dim">Enter the 6-digit code to confirm
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} className={`mt-1 ${inputCls} font-mono tracking-widest`} placeholder="123456" inputMode="numeric" /></label>
            <div className="mt-3 flex gap-2">
              <button disabled={busy || code.length !== 6} onClick={() => void enable()} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Enable</button>
              <button onClick={() => { setSetup(null); setErr(null); }} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
