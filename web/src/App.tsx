import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import type { AppStatus } from './types';
import { RubyDiamond } from './components/Logo';
import Layout from './components/Layout';
import Setup from './pages/Setup';
import Login from './pages/Login';
import Fleet from './pages/Fleet';
import Devices from './pages/Devices';
import Sites from './pages/Sites';

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.get<AppStatus>('/api/status'));
      setError(null);
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
        <p className="text-sm text-zinc-400">Cannot reach the RubyMIK server: {error}</p>
        <button
          onClick={() => void refresh()}
          className="mt-4 rounded-lg bg-ruby-600 px-4 py-2 text-sm font-semibold text-white hover:bg-ruby-500"
        >
          Retry
        </button>
      </Splash>
    );
  }

  if (!status) {
    return (
      <Splash>
        <p className="text-sm text-zinc-500">Loading…</p>
      </Splash>
    );
  }

  if (status.needsSetup) return <Setup onDone={refresh} />;
  if (!status.authenticated) return <Login onDone={refresh} />;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout onLogout={refresh} />}>
          <Route path="/" element={<Fleet />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/sites" element={<Sites />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ink-900">
      <RubyDiamond className="h-12 w-12" />
      <div className="mt-4 text-center">{children}</div>
    </div>
  );
}
