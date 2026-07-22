import { useState } from 'react';
import { api } from '../api';
import AuthShell, { Field, FormError, SubmitButton } from '../components/AuthShell';

export default function Setup({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/setup', { email, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Welcome to RubyMIK"
      subtitle="First things first — create your admin account. This stays on your box; there are no cloud accounts."
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <FormError message={error} />
        <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          autoComplete="username" autoFocus required placeholder="you@example.com" />
        <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password" required minLength={8} placeholder="At least 8 characters" />
        <Field label="Confirm password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password" required />
        <SubmitButton busy={busy}>Create admin account</SubmitButton>
      </form>
    </AuthShell>
  );
}
