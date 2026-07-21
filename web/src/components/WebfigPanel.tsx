import { useState } from 'react';
import { AppWindow, Cable, ExternalLink, Loader2, Radio, ShieldCheck } from 'lucide-react';
import { api } from '../api';

interface Session {
  webfigPort: number;
  transport: 'direct' | 'tunnel';
  host: string;
}

/** The router UI is served on its own port (WebFig needs web-root '/'); build the
 *  absolute URL from the browser's current hostname. */
function webfigUrl(s: Session): string {
  return `${window.location.protocol}//${window.location.hostname}:${s.webfigPort}/`;
}

/**
 * Launches the router's OWN WebFig admin UI, reverse-proxied through RubyMIK over
 * the device's transport (direct LAN or WireGuard tunnel). Pass-through auth: the
 * user logs in with the router's own credentials — RubyMIK proxies the traffic
 * and never stores or injects that login (so it can't leak through here).
 */
export default function WebfigPanel({ deviceId }: { deviceId: number }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function ensureSession(): Promise<Session | null> {
    if (session) return session;
    setLoading(true);
    setError(null);
    try {
      const s = await api.post<Session>(`/api/devices/${deviceId}/webfig/session`);
      setSession(s);
      return s;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function launchInline() {
    if (await ensureSession()) setOpen(true);
  }
  async function launchNewTab() {
    const s = await ensureSession();
    if (s) window.open(webfigUrl(s), '_blank', 'noopener,noreferrer');
  }

  const TransportBadge = session && (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
      session.transport === 'tunnel' ? 'bg-info-bg text-info-fg' : 'bg-success-bg text-success-fg'}`}>
      {session.transport === 'tunnel' ? <Radio className="h-3.5 w-3.5" /> : <Cable className="h-3.5 w-3.5" />}
      {session.transport === 'tunnel' ? `Over WireGuard tunnel · ${session.host}` : `Direct (LAN) · ${session.host}`}
    </span>
  );

  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AppWindow className="h-5 w-5 text-accent" />
          <h2 className="text-base font-bold text-fg-strong">Router Admin — WebFig</h2>
        </div>
        {TransportBadge}
      </div>

      <p className="mt-2 max-w-3xl text-sm text-fg-dim">
        Opens the router's built-in WebFig admin interface, proxied through RubyMIK over this
        device's transport — so it works even for a behind-NAT router reachable only over the
        WireGuard tunnel. You'll sign in with the <span className="font-semibold text-fg-body">router's own
        credentials</span>; RubyMIK pipes the traffic and never stores or sends that login for you.
      </p>

      <div className="mt-3 flex items-start gap-2 rounded-lg bg-sunken px-3 py-2.5 text-xs text-fg-muted">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-fg-faint" />
        <span>
          This is full administrative access to the router. Opening a session is audited (who, when,
          which device). The proxy only targets this managed device — it can't be pointed elsewhere.
        </span>
      </div>

      {error && (
        <div className="mt-3 rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">{error}</div>
      )}

      {!open && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => void launchInline()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <AppWindow className="h-4 w-4" />}
            Open Router Admin
          </button>
          <button
            onClick={() => void launchNewTab()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-4 py-2.5 text-sm font-semibold text-fg-body transition hover:border-accent-border hover:text-accent-text disabled:opacity-50"
          >
            <ExternalLink className="h-4 w-4" /> Open in new tab
          </button>
        </div>
      )}

      {open && session && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-fg-faint">
            <span>Live WebFig session — proxied through RubyMIK</span>
            <button onClick={() => void launchNewTab()} className="inline-flex items-center gap-1 font-medium text-accent-text hover:underline">
              <ExternalLink className="h-3.5 w-3.5" /> Pop out
            </button>
          </div>
          <iframe
            title="Router WebFig admin"
            src={webfigUrl(session)}
            className="h-[72vh] w-full rounded-xl border border-border-strong bg-white"
          />
        </div>
      )}
    </section>
  );
}
