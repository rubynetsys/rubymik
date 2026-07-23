import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, KeyRound, Loader2, Plus, ShieldOff, Trash2, UserPlus, X } from 'lucide-react';
import { api } from '../api';
import Select from '../components/Select';
import CopyButton from '../components/CopyButton';
import { useMe, type Role } from '../me';

interface User { id: number; email: string | null; username: string; role: Role; disabled: boolean; twoFactor: boolean; createdAt: string }
const ROLE_OPTS = [
  { value: 'admin', label: 'Admin — full access incl. users' },
  { value: 'editor', label: 'Editor — device read/write' },
  { value: 'viewer', label: 'Viewer — read-only' },
];

export default function Users() {
  const me = useMe();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ title: string; username: string; password: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    api.get<User[]>('/api/users').then(setUsers).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => load(), [load]);

  async function act(id: number, fn: () => Promise<unknown>) {
    setBusy(id); setError(null);
    try { await fn(); load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  const setRole = (u: User, role: Role) => act(u.id, () => api.patch(`/api/users/${u.id}`, { role }));
  const toggleDisabled = (u: User) => act(u.id, () => api.patch(`/api/users/${u.id}`, { disabled: !u.disabled }));
  const disable2fa = (u: User) => act(u.id, () => api.post(`/api/users/${u.id}/disable-2fa`, {}));
  const del = (u: User) => { if (confirm(`Delete "${u.username}"? This cannot be undone.`)) void act(u.id, () => api.del(`/api/users/${u.id}`)); };
  async function resetPassword(u: User) {
    await act(u.id, async () => {
      const r = await api.post<{ generatedPassword?: string }>(`/api/users/${u.id}/reset-password`, {});
      if (r.generatedPassword) setSecret({ title: 'New password', username: u.username, password: r.generatedPassword });
    });
  }

  if (error && !users) return <div className="mx-auto max-w-4xl rounded-2xl border border-danger-line bg-danger-bg p-6 text-sm text-danger-fg-strong">{error}</div>;
  if (!users) return <div className="mx-auto max-w-4xl"><div className="h-40 animate-pulse rounded-2xl border border-border bg-surface" /></div>;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-fg-strong">Users &amp; roles</h1>
          <p className="mt-1 text-sm text-fg-dim">Roles are enforced on the server — viewers are read-only, editors can't manage users.</p>
        </div>
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse hover:bg-accent-hover">
          <UserPlus className="h-4 w-4" /> Add user
        </button>
      </div>

      {error && <div className="mt-4 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

      <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle bg-sunken text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
              <th className="px-4 py-2.5">User</th><th className="px-3 py-2.5">Role</th><th className="px-3 py-2.5">2FA</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={`border-b border-border-subtle text-fg-body ${u.disabled ? 'opacity-55' : ''}`}>
                <td className="px-4 py-2.5 font-medium text-fg">{u.email ?? u.username}{u.username === me.username && <span className="ml-2 rounded-full bg-app px-1.5 py-0.5 text-[10px] font-semibold text-fg-muted">you</span>}</td>
                <td className="px-3 py-2.5">
                  <Select value={u.role} onChange={(v) => setRole(u, v as Role)} className="w-52" ariaLabel={`role for ${u.username}`}
                    options={ROLE_OPTS} disabled={u.username === me.username || busy === u.id} />
                </td>
                <td className="px-3 py-2.5">{u.twoFactor
                  ? <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success-fg"><Check className="h-3 w-3" /> on</span>
                  : <span className="text-xs text-fg-faint">off</span>}</td>
                <td className="px-3 py-2.5">{u.disabled
                  ? <span className="rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-semibold text-danger-fg">disabled</span>
                  : <span className="rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success-fg">active</span>}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center justify-end gap-0.5">
                    {busy === u.id && <Loader2 className="mr-1 h-4 w-4 animate-spin text-fg-faint" />}
                    <IconBtn title="Reset password" onClick={() => void resetPassword(u)}><KeyRound className="h-4 w-4" /></IconBtn>
                    {u.twoFactor && <IconBtn title="Force-disable 2FA" onClick={() => void disable2fa(u)}><ShieldOff className="h-4 w-4" /></IconBtn>}
                    {u.username !== me.username && (
                      <IconBtn title={u.disabled ? 'Enable' : 'Disable'} onClick={() => void toggleDisabled(u)}>
                        <span className={`text-xs font-semibold ${u.disabled ? 'text-success-fg' : 'text-warning-fg'}`}>{u.disabled ? 'Enable' : 'Disable'}</span>
                      </IconBtn>
                    )}
                    {u.username !== me.username && <IconBtn title="Delete" danger onClick={() => del(u)}><Trash2 className="h-4 w-4" /></IconBtn>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && <AddUserModal onClose={() => setAdding(false)} onCreated={(s) => { setAdding(false); load(); if (s) setSecret(s); }} />}
      {secret && <SecretModal secret={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function IconBtn({ children, title, onClick, danger }: { children: React.ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return <button title={title} onClick={onClick} className={`rounded-md px-2 py-1.5 text-fg-faint transition hover:bg-app ${danger ? 'hover:text-danger-fg' : 'hover:text-fg-body'}`}>{children}</button>;
}

function AddUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: { title: string; username: string; password: string } | null) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [mode, setMode] = useState<'generate' | 'type'>('generate');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  async function create() {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = { email: email.trim(), role };
      if (mode === 'type') body.password = password;
      const r = await api.post<{ email: string | null; username: string; generatedPassword?: string }>('/api/users', body);
      onCreated(r.generatedPassword ? { title: 'New account', username: r.email ?? r.username, password: r.generatedPassword } : null);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  const inputCls = 'w-full rounded-lg border border-border-strong bg-app px-3 py-2 text-sm text-fg-body outline-none focus:border-accent-border-strong';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between"><h3 className="text-lg font-bold text-fg-strong">Add user</h3><button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button></div>
        {err && <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{err}</div>}
        <label className="mt-4 block text-xs font-semibold text-fg-dim">Email
          <input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`mt-1 ${inputCls}`} placeholder="user@example.com" /></label>
        <label className="mt-3 block text-xs font-semibold text-fg-dim">Role
          <Select value={role} onChange={(v) => setRole(v as Role)} className="mt-1 w-full" ariaLabel="Role" options={ROLE_OPTS} /></label>
        <div className="mt-3 text-xs font-semibold text-fg-dim">Password
          <div className="mt-1 inline-flex overflow-hidden rounded-lg border border-border-strong">
            {(['generate', 'type'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`px-3 py-1.5 text-xs font-semibold capitalize ${mode === m ? 'bg-accent text-inverse' : 'text-fg-dim hover:bg-app'}`}>{m === 'generate' ? 'Generate' : 'Type one'}</button>
            ))}
          </div>
          {mode === 'type'
            ? <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={`mt-2 ${inputCls}`} placeholder="At least 8 characters" autoComplete="new-password" />
            : <p className="mt-2 font-normal text-fg-faint">A strong password will be generated and shown once — copy it to share with the user.</p>}
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>
          <button disabled={busy || !validEmail || (mode === 'type' && password.length < 8)} onClick={() => void create()}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover disabled:opacity-40">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create user
          </button>
        </div>
      </div>
    </div>
  );
}

function SecretModal({ secret, onClose }: { secret: { title: string; username: string; password: string }; onClose: () => void }) {
  const credRef = useRef<HTMLDivElement>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-fg-strong">{secret.title} for “{secret.username}”</h3>
        <p className="mt-1 text-sm text-fg-dim">This is shown <b>once</b>. Copy it now — it can't be retrieved later (only reset).</p>
        <div ref={credRef} className="mt-4 rounded-lg border border-border-strong bg-app p-3 font-mono text-sm">
          <div className="text-fg-dim">email: <span className="text-fg">{secret.username}</span></div>
          <div className="text-fg-dim">password: <span className="text-fg-strong">{secret.password}</span></div>
        </div>
        <div className="mt-4 flex justify-end gap-3">
          <CopyButton text={`Email: ${secret.username}\nPassword: ${secret.password}`} iconClass="h-4 w-4" getSelect={() => credRef.current}
            className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken" />
          <button onClick={onClose} className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">Done</button>
        </div>
      </div>
    </div>
  );
}
