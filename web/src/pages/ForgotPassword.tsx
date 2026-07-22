import { useState } from 'react';
import { api } from '../api';
import AuthShell, { Field, FormError, SubmitButton } from '../components/AuthShell';

export default function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { smtpConfigured: boolean }>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ ok: boolean; smtpConfigured: boolean }>('/api/forgot-password', { email });
      setDone({ smtpConfigured: r.smtpConfigured });
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (done) {
    return (
      <AuthShell title="Check your email" subtitle="">
        {done.smtpConfigured ? (
          <p className="text-sm text-fg-dim">
            If an account exists for <b className="text-fg-body">{email || 'that address'}</b>, a password-reset link is on its way.
            The link is valid for 30 minutes and can be used once.
          </p>
        ) : (
          <div className="space-y-3 text-sm text-fg-dim">
            <p>This RubyMIK doesn't have email (SMTP) configured, so it can't send a reset link.</p>
            <p className="text-fg-body font-medium">Self-hosted recovery — reset from the server's shell:</p>
            <code className="block break-all rounded-lg border border-border-strong bg-app px-3 py-2 font-mono text-xs text-fg-strong">docker exec -it rubymik node scripts/reset-admin.mjs</code>
            <p>It resets a chosen account, prints a new password once, and invalidates its sessions. (To send reset emails instead, set up SMTP in Settings → Notifications.)</p>
          </div>
        )}
        <button onClick={onBack} className="mt-5 text-sm font-semibold text-accent hover:underline">← Back to sign in</button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset your password" subtitle="Enter your email and we'll send a reset link — if email is set up on this instance.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <FormError message={error} />
        <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required placeholder="you@example.com" />
        <SubmitButton busy={busy}>Send reset link</SubmitButton>
        <button type="button" onClick={onBack} className="w-full text-center text-sm font-semibold text-accent hover:underline">← Back to sign in</button>
      </form>
    </AuthShell>
  );
}
