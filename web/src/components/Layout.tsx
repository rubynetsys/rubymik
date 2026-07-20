import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Bell, Building2, LayoutDashboard, LogOut, Router as RouterIcon, ScrollText, Waypoints } from 'lucide-react';
import { api } from '../api';
import type { AlertSummary } from '../types';
import Logo from './Logo';

const NAV = [
  { to: '/', label: 'Fleet', icon: LayoutDashboard },
  { to: '/topology', label: 'Topology', icon: Waypoints },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/devices', label: 'Devices', icon: RouterIcon },
  { to: '/sites', label: 'Sites', icon: Building2 },
  { to: '/audit', label: 'Audit', icon: ScrollText },
];

const SUMMARY_REFRESH_MS = 15_000;

export default function Layout({ onLogout }: { onLogout: () => void }) {
  const [username, setUsername] = useState('');
  const [summary, setSummary] = useState<AlertSummary | null>(null);

  useEffect(() => {
    api.get<{ username: string }>('/api/me').then((me) => setUsername(me.username)).catch(() => {});
    const loadSummary = () => {
      api.get<AlertSummary>('/api/alerts/summary').then(setSummary).catch(() => {});
    };
    loadSummary();
    const t = setInterval(() => {
      if (!document.hidden) loadSummary();
    }, SUMMARY_REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  async function logout() {
    await api.post('/api/logout').catch(() => {});
    onLogout();
  }

  const badgeCls = summary && summary.firing > 0
    ? summary.critical > 0 ? 'bg-red-600' : summary.warning > 0 ? 'bg-amber-500' : 'bg-sky-500'
    : null;

  return (
    <div className="flex min-h-screen bg-zinc-100">
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-col bg-ink-900">
        <div className="px-5 py-5">
          <Logo dark />
        </div>
        <nav className="mt-2 flex-1 space-y-1 px-3">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-ruby-600/15 text-white shadow-[inset_2px_0_0_0_theme(colors.ruby.500)]'
                    : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                }`
              }
            >
              <Icon className="h-4.5 w-4.5" />
              {label}
              {label === 'Alerts' && badgeCls && (
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold text-white ${badgeCls}`}
                  title={`${summary!.firing} active alert${summary!.firing === 1 ? '' : 's'}`}
                >
                  {summary!.firing}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ruby-600 text-sm font-bold text-white">
                {(username[0] ?? '?').toUpperCase()}
              </div>
              <div className="truncate text-sm text-zinc-300">{username}</div>
            </div>
            <button
              onClick={() => void logout()}
              title="Sign out"
              className="rounded-md p-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
      <main className="ml-60 flex-1 px-8 py-8">
        <Outlet />
      </main>
    </div>
  );
}
