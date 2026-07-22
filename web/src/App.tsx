import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import type { AppStatus } from './types';
import { RubyDiamond } from './components/Logo';
import Layout from './components/Layout';
import Setup from './pages/Setup';
import Login from './pages/Login';
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
import { applyTheme } from './theme';
import { MeContext, type Me } from './me';

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          const meRes = await api.get<{ username: string; role: Me['role']; twoFactor: boolean; theme: string | null; accent: string | null }>('/api/me');
          setMe({ username: meRes.username, role: meRes.role ?? 'admin', twoFactor: !!meRes.twoFactor });
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

  if (status.needsSetup) return <Setup onDone={refresh} />;
  if (!status.authenticated) return <Login onDone={refresh} />;

  return (
    <MeContext.Provider value={me ?? { username: '', role: 'admin', twoFactor: false }}>
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
          <Route path="/account" element={<Account onChanged={refresh} />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </MeContext.Provider>
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
