import Logo from './Logo';

/** Centered card on the dark ink background — shared by Setup and Login. */
export default function AuthShell({ title, subtitle, children }: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-sidebar px-4">
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(60rem 32rem at 50% -10%, color-mix(in srgb, var(--color-accent-hover) 16%, transparent), transparent 60%)' }}
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo dark size="lg" />
        </div>
        <div className="rounded-2xl bg-surface p-7 shadow-2xl">
          <h1 className="text-lg font-bold text-fg-strong">{title}</h1>
          <p className="mt-1 text-sm text-fg-dim">{subtitle}</p>
          <div className="mt-5">{children}</div>
        </div>
        <p className="mt-6 text-center text-xs text-fg-muted">
          Self-hosted MikroTik monitoring · MIT licensed
        </p>
      </div>
    </div>
  );
}

export function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-dim">{label}</span>
      <input
        {...props}
        className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm text-fg-strong outline-none transition focus:border-accent-border-strong focus:ring-2 focus:ring-accent-border-strong/20"
      />
    </label>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover disabled:opacity-60"
    >
      {busy ? 'Please wait…' : children}
    </button>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-accent-border bg-accent-subtle px-3 py-2 text-sm text-accent-text">
      {message}
    </div>
  );
}
