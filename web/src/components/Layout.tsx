import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bell, BellRing, Building2, DatabaseBackup, Eye, LayoutDashboard, LogOut, RadioTower, Rocket, Router as RouterIcon, ScrollText, Server, Settings as SettingsIcon, ShieldCheck, UsersRound, Waypoints, Wand2, X } from 'lucide-react';
import { api } from '../api';
import type { AlertSummary, BackupStatus, UpdateStatus } from '../types';
import { useMe } from '../me';
import { useDesktopAlerts } from './NotificationChannels';
import Logo from './Logo';
import ThemePicker from './ThemePicker';

const NAV: Array<{ to: string; label: string; icon: typeof Bell; adminOnly?: boolean; writeOnly?: boolean }> = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/fleet', label: 'Fleet', icon: Server },
  { to: '/topology', label: 'Topology', icon: Waypoints },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/devices', label: 'Devices', icon: RouterIcon },
  { to: '/add-device', label: 'Add device', icon: Wand2, writeOnly: true },
  { to: '/sites', label: 'Sites', icon: Building2 },
  { to: '/remote-access', label: 'Remote Access', icon: RadioTower },
  { to: '/dns-filter', label: 'DNS Filtering', icon: ShieldCheck },
  { to: '/audit', label: 'Audit', icon: ScrollText },
];

// P40: a discoverable Settings section (admin-only). Notification channels used to be
// buried at the bottom of the Alerts page — now they have a home.
const SETTINGS_NAV: Array<{ to: string; label: string; icon: typeof Bell }> = [
  { to: '/settings/notifications', label: 'Notifications', icon: BellRing },
  { to: '/backup', label: 'Backup', icon: DatabaseBackup },
  { to: '/settings/updates', label: 'Updates', icon: Rocket },
  { to: '/users', label: 'Users', icon: UsersRound },
];

const SUMMARY_REFRESH_MS = 15_000;

export default function Layout({ onLogout }: { onLogout: () => void }) {
  const me = useMe();
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState<string | null>(() => sessionStorage.getItem('rubymik.updateDismissed'));
  useDesktopAlerts(); // browser pops for new alerts while the app is open (opt-in)

  useEffect(() => {
    const load = () => {
      api.get<AlertSummary>('/api/alerts/summary').then(setSummary).catch(() => {});
      api.get<BackupStatus>('/api/backup/status').then(setBackup).catch(() => {});
      api.get<UpdateStatus>('/api/update/status').then(setUpdate).catch(() => {});
    };
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, SUMMARY_REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  function dismissUpdate(v: string) { sessionStorage.setItem('rubymik.updateDismissed', v); setUpdateDismissed(v); }

  async function logout() {
    await api.post('/api/logout').catch(() => {});
    onLogout();
  }

  const badgeCls = summary && summary.firing > 0
    ? summary.critical > 0 ? 'bg-danger' : summary.warning > 0 ? 'bg-warning' : 'bg-info'
    : null;

  return (
    <div className="flex min-h-screen bg-app">
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-col bg-sidebar">
        <div className="px-5 py-5">
          <Logo dark />
        </div>
        <nav className="mt-2 flex-1 space-y-1 px-3">
          {NAV.filter((n) => (!n.adminOnly || me.role === 'admin') && (!n.writeOnly || me.role !== 'viewer')).map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-accent/15 text-sidebar-fg shadow-[inset_2px_0_0_0_var(--color-accent-hover)]'
                    : 'text-sidebar-idle hover:bg-sidebar-fg/10 hover:text-sidebar-hover'
                }`
              }
            >
              <Icon className="h-4.5 w-4.5" />
              {label}
              {label === 'Alerts' && badgeCls && (
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold text-inverse ${badgeCls}`}
                  title={`${summary!.firing} active alert${summary!.firing === 1 ? '' : 's'}`}
                >
                  {summary!.firing}
                </span>
              )}
            </NavLink>
          ))}
          {me.role === 'admin' && (
            <div className="pt-3">
              <div className="flex items-center gap-1.5 px-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-sidebar-idle/50">
                <SettingsIcon className="h-3 w-3" /> Settings
              </div>
              {SETTINGS_NAV.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-accent/15 text-sidebar-fg shadow-[inset_2px_0_0_0_var(--color-accent-hover)]'
                        : 'text-sidebar-idle hover:bg-sidebar-fg/10 hover:text-sidebar-hover'
                    }`}
                >
                  <Icon className="h-4.5 w-4.5" />
                  {label}
                </NavLink>
              ))}
            </div>
          )}
        </nav>
        <div className="space-y-1 border-t border-sidebar-fg/10 px-3 py-3">
          <ThemePicker />
          <div className="flex items-center justify-between px-1">
            <NavLink to="/account" title="Your account" className="flex items-center gap-2.5 overflow-hidden rounded-md p-1 hover:bg-sidebar-fg/10">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-inverse">
                {((me.email ?? me.username)[0] ?? '?').toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm text-sidebar-idle">{me.email ?? me.username}</div>
                <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-sidebar-idle/70">{me.role}</div>
              </div>
            </NavLink>
            <button
              onClick={() => void logout()}
              title="Sign out"
              className="rounded-md p-2 text-sidebar-idle transition-colors hover:bg-sidebar-fg/10 hover:text-sidebar-hover"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
      <main className="ml-60 flex-1 px-8 py-8">
        {backup && !backup.healthy && (
          <div className={`mb-5 flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-sm ${backup.severity === 'critical' ? 'border-danger-line bg-danger-bg text-danger-fg-strong' : 'border-warning-line bg-warning-bg text-warning-fg'}`}>
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span><b>Backups {backup.severity === 'critical' ? 'need attention' : 'warning'}:</b> {backup.reason}</span>
            {me.role === 'admin' && <Link to="/backup" className="ml-auto rounded-md border border-current/40 px-2.5 py-1 text-xs font-semibold hover:bg-black/5">Open backups →</Link>}
          </div>
        )}
        {update?.report?.updateAvailable && updateDismissed !== update.report.latest && (
          <div className={`mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-sm ${update.report.belowMinimum ? 'border-warning-line bg-warning-bg text-warning-fg' : 'border-info bg-info-bg text-info-fg'}`}>
            <Rocket className="h-4 w-4 shrink-0" />
            <span>
              <b>RubyMIK {update.report.latest} is available</b> — you're on {update.report.current}.
              {update.report.belowMinimum && <b> Your version is below the minimum still supported — update soon.</b>}
              {update.report.breakingAhead.length > 0 && <> Note: breaking changes in {update.report.breakingAhead.join(', ')} — read the changelog first.</>}
            </span>
            {update.report.changelogUrl && (
              <a href={update.report.changelogUrl} target="_blank" rel="noreferrer" className="rounded-md border border-current/40 px-2.5 py-1 text-xs font-semibold hover:bg-black/5">Changelog →</a>
            )}
            <code className="rounded-md bg-black/10 px-2 py-1 font-mono text-xs">{update.report.pullCommand}</code>
            {me.role === 'admin' && <Link to="/account" className="text-xs font-semibold underline decoration-current/40 underline-offset-2 hover:decoration-current">Update settings</Link>}
            <button onClick={() => dismissUpdate(update.report!.latest!)} title="Dismiss until the next version" className="ml-auto rounded-md p-1 hover:bg-black/5"><X className="h-4 w-4" /></button>
          </div>
        )}
        {me.role === 'viewer' && (
          <div className="mb-5 flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm text-fg-dim">
            <Eye className="h-4 w-4 shrink-0 text-fg-faint" />
            You're signed in as a <b className="text-fg-body">viewer</b> — read-only access. Changes are hidden and refused by the server.
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
