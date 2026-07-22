import { useState } from 'react';
import { api, ApiError } from '../api';
import AuthShell, { Field, FormError, SubmitButton } from '../components/AuthShell';

export default function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/login', { username, password, ...(needsCode ? { code: code.trim() } : {}) });
      onDone();
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { needsCode?: boolean } | undefined) : undefined;
      if (body?.needsCode) {
        setError(needsCode ? 'That code is not valid — try the current one, or a recovery code.' : null);
        setNeedsCode(true);
      } else {
        setError((err as Error).message);
        setNeedsCode(false);
      }
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Sign in" subtitle="Welcome back — sign in to your RubyMIK dashboard.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <FormError message={error} />
        {!needsCode ? (
          <>
            <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value)}
              autoComplete="username" autoFocus required />
            <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password" required />
          </>
        ) : (
          <>
            <p className="text-sm text-fg-dim">Enter the 6-digit code from your authenticator app — or a one-time recovery code.</p>
            <Field label="Authentication code" value={code} onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code" autoFocus required />
          </>
        )}
        <SubmitButton busy={busy}>{needsCode ? 'Verify' : 'Sign in'}</SubmitButton>
      </form>
    </AuthShell>
  );
}
