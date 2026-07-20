import { useState } from 'react';
import { api } from '../api';
import AuthShell, { Field, FormError, SubmitButton } from '../components/AuthShell';

export default function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/login', { username, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Sign in" subtitle="Welcome back — sign in to your RubyMIK dashboard.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <FormError message={error} />
        <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value)}
          autoComplete="username" autoFocus required />
        <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password" required />
        <SubmitButton busy={busy}>Sign in</SubmitButton>
      </form>
    </AuthShell>
  );
}
