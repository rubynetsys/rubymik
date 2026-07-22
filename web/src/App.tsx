import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import type { AppStatus } from './types';
import { RubyDiamond } from './components/Logo';
import Layout from './components/Layout';
import Setup from './pages/Setup';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import ClaimEmail from './pages/ClaimEmail';
import Fleet from './pages/Fleet';
import Topology from './pages/Topology';
import Alerts from './pages/Alerts';
import Devices from './pages/Devices';
import DeviceDetail from './pages/DeviceDetail';
import Sites from './pages/Sites';
import RemoteAccess from './pages/RemoteAccess';
import Onboard from './pages/Onboard';
import Provision from './pages/Provision';
import AddDevice from './pages/AddDevice';
import Dashboard from './pages/Dashboard';
import Wallboard from './pages/Wallboard';
import Users from './pages/Users';
import SelfBackup from './pages/SelfBackup';
import Account from './pages/Account';
import Audit from './pages/Audit';
import Notifications from './pages/Notifications';
import Updates from './pages/Updates';
import { applyTheme } from './theme';
import { MeContext, type Me } from './me';

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publicView, setPublicView] = useState<'login' | 'forgot'>('login');

  const refresh = useCallback(async () => {
    try {
      const st = await api.get<AppStatus>('/api/status');
      setStatus(st);
      setError(null);
      // Apply the effective theme: the user's own override wins, else the
      // install default. (The inline script already painted the cached choice.)
      const def = st.installDefault ?? { theme: 'ruby-light', accent: null };
      if (st.authenticated) {
        try {
          const meRes = await api.get<{ email: string | null; username: string; needsEmailClaim: boolean; role: Me['role']; twoFactor: boolean; theme: string | null; accent: string | null }>('/api/me');
          setMe({ email: meRes.email, username: meRes.username, needsEmailClaim: !!meRes.needsEmailClaim, role: meRes.role ?? 'admin', twoFactor: !!meRes.twoFactor });
          applyTheme(meRes.theme ?? def.theme, meRes.accent ?? def.accent);
        } catch { setMe(null); applyTheme(def.theme, def.accent); }
      } else {
        setMe(null);
        applyTheme(def.theme, def.accent);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) {
    return (
      <Splash>
        <p className="text-sm text-fg-faint">Cannot reach the RubyMIK server: {error}</p>
        <button
          onClick={() => void refresh()}
          className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover"
        >
          Retry
        </button>
      </Splash>
    );
  }

  if (!status) {
    return (
      <Splash>
        <p className="text-sm text-fg-dim">Loading…</p>
      </Splash>
    );
  }

  // P41: a persistent demo banner (env-flag driven) on EVERY screen, incl. login.
  const demoBar = status.demoBanner ? <DemoBar text={status.demoBanner} /> : null;
  const withBar = (el: React.ReactNode) => <>{demoBar}{el}</>;

  if (status.needsSetup) return withBar(<Setup onDone={refresh} />);
  if (!status.authenticated) {
    // Public password-reset link (emailed): /reset-password?token=… works without a session.
    const token = new URLSearchParams(window.location.search).get('token');
    if (window.location.pathname.startsWith('/reset-password') && token) {
      return withBar(<ResetPassword token={token} onDone={() => { window.history.replaceState({}, '', '/'); setPublicView('login'); void refresh(); }} />);
    }
    if (publicView === 'forgot') return withBar(<ForgotPassword onBack={() => setPublicView('login')} />);
    return withBar(<Login onDone={refresh} onForgot={() => setPublicView('forgot')} demoCredentials={status.demoCredentials ?? null} />);
  }
  if (me?.needsEmailClaim) return withBar(<ClaimEmail onDone={refresh} />);

  return (
    <MeContext.Provider value={me ?? { email: null, username: '', needsEmailClaim: false, role: 'admin', twoFactor: false }}>
    {demoBar}
    <BrowserRouter>
      <Routes>
        {/* Wallboard is full-screen with no app chrome, so it lives OUTSIDE Layout. */}
        <Route path="/wallboard" element={<Wallboard />} />
        <Route element={<Layout onLogout={refresh} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/fleet" element={<Fleet />} />
          <Route path="/topology" element={<Topology />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/add-device" element={<AddDevice />} />
          <Route path="/add-device/existing" element={<Onboard />} />
          <Route path="/add-device/new" element={<Provision />} />
          {/* old single-purpose routes now redirect into the unified flow */}
          <Route path="/onboard" element={<Navigate to="/add-device/existing" replace />} />
          <Route path="/provision" element={<Navigate to="/add-device/new" replace />} />
          <Route path="/devices/:id" element={<DeviceDetail />} />
          <Route path="/sites" element={<Sites />} />
          <Route path="/remote-access" element={<RemoteAccess />} />
          <Route path="/users" element={<Users />} />
          <Route path="/backup" element={<SelfBackup />} />
          <Route path="/settings/notifications" element={<Notifications />} />
          <Route path="/settings/updates" element={<Updates />} />
          <Route path="/account" element={<Account onChanged={refresh} />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </MeContext.Provider>
  );
}

function DemoBar({ text }: { text: string }) {
  return (
    <div className="sticky top-0 z-[100] flex items-center justify-center gap-2 border-b border-warning-line bg-warning-bg px-4 py-2 text-center text-sm font-semibold text-warning-fg">
      <span aria-hidden>⚠</span> {text}
    </div>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-sidebar">
      <RubyDiamond className="h-12 w-12" />
      <div className="mt-4 text-center">{children}</div>
    </div>
  );
}
