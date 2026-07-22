import { useState } from 'react';
import { api } from '../api';
import AuthShell, { Field, FormError, SubmitButton } from '../components/AuthShell';

export default function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true); setError(null);
    try { await api.post('/api/reset-password', { token, password }); setOk(true); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }

  if (ok) {
    return (
      <AuthShell title="Password reset" subtitle="">
        <p className="text-sm text-fg-dim">Your password has been changed and all sessions were signed out. Sign in with your new password.</p>
        <button onClick={onDone} className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">Go to sign in</button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Enter a new password for your account.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <FormError message={error} />
        <Field label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus required minLength={8} placeholder="At least 8 characters" />
        <Field label="Confirm new password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        <SubmitButton busy={busy}>Set new password</SubmitButton>
      </form>
    </AuthShell>
  );
}
