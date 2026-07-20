import Logo from './Logo';

/** Centered card on the dark ink background — shared by Setup and Login. */
export default function AuthShell({ title, subtitle, children }: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink-900 px-4">
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(60rem 32rem at 50% -10%, rgba(233,30,99,0.16), transparent 60%)' }}
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo dark size="lg" />
        </div>
        <div className="rounded-2xl bg-white p-7 shadow-2xl">
          <h1 className="text-lg font-bold text-zinc-900">{title}</h1>
          <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
          <div className="mt-5">{children}</div>
        </div>
        <p className="mt-6 text-center text-xs text-zinc-600">
          Self-hosted MikroTik monitoring · MIT licensed
        </p>
      </div>
    </div>
  );
}

export function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
      <input
        {...props}
        className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-ruby-500 focus:ring-2 focus:ring-ruby-500/20"
      />
    </label>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full rounded-lg bg-ruby-600 py-2.5 text-sm font-semibold text-white transition hover:bg-ruby-500 disabled:opacity-60"
    >
      {busy ? 'Please wait…' : children}
    </button>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-ruby-200 bg-ruby-50 px-3 py-2 text-sm text-ruby-800">
      {message}
    </div>
  );
}
