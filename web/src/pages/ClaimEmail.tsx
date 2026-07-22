import { useState } from 'react';
import { api } from '../api';
import AuthShell, { Field, FormError, SubmitButton } from '../components/AuthShell';

/** One-time screen for a pre-P40 account (created before email became the identity)
 *  to claim its email on next login. Pre-fills nothing. */
export default function ClaimEmail({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.post('/api/me/claim-email', { email }); onDone(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return (
    <AuthShell title="Add your email" subtitle="RubyMIK now signs you in by email. Set the email for this account — you'll use it to sign in and to recover your password.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <FormError message={error} />
        <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required placeholder="you@example.com" />
        <SubmitButton busy={busy}>Save email</SubmitButton>
      </form>
    </AuthShell>
  );
}
