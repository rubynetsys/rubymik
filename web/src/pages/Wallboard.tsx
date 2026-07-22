import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { api } from '../api';
import type { Alert, FleetPayload, HealthStatus } from '../types';

/**
 * Wallboard (P28) — a deliberately single-look, full-screen dark board readable
 * from across a room. No app chrome; auto-refreshes; a device going unreachable
 * turns red without crashing (fetch errors keep the last-known snapshot).
 */
const REFRESH_MS = 10_000;

export default function Wallboard() {
  const [fleet, setFleet] = useState<FleetPayload | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(() => {
    api.get<FleetPayload>('/api/fleet').then(setFleet).catch(() => {/* keep last-known */});
    api.get<Alert[]>('/api/alerts?state=firing').then(setAlerts).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    const c = setInterval(() => setNow(new Date()), 1000);
    return () => { clearInterval(t); clearInterval(c); };
  }, [load]);

  const s = fleet?.summary ?? { total: 0, up: 0, warning: 0, down: 0, pending: 0 };
  const sites = fleet?.sites ?? [];

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[#080b10] text-slate-100">
      <style>{`@keyframes rubymik-ticker{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}`}</style>

      {/* header */}
      <header className="flex items-center justify-between px-8 py-5">
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-black tracking-tight">Ruby<span className="text-sky-400">MIK</span></span>
          <span className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Fleet wallboard</span>
        </div>
        <div className="flex items-center gap-6">
          <span className="tabular-nums text-2xl font-semibold text-slate-300">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          <Link to="/" title="Exit wallboard" className="rounded-lg border border-slate-700 p-2 text-slate-400 transition hover:border-slate-500 hover:text-slate-200"><X className="h-5 w-5" /></Link>
        </div>
      </header>

      {/* big status tiles */}
      <div className="grid flex-1 grid-cols-2 gap-6 px-8 lg:grid-cols-5">
        <BigTile label="Devices" value={s.total} color="#e2e8f0" />
        <BigTile label="Up" value={s.up} color="#34d399" />
        <BigTile label="Warning" value={s.warning} color="#fbbf24" pulse={s.warning > 0} />
        <BigTile label="Down" value={s.down} color="#f87171" pulse={s.down > 0} />
        <BigTile label="Pending" value={s.pending} color="#94a3b8" />
      </div>

      {/* per-site status band */}
      <div className="flex flex-wrap gap-3 px-8 py-4">
        {sites.map((site) => (
          <div key={String(site.id)} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2.5">
            <span className="text-base font-semibold text-slate-200">{site.name}</span>
            <div className="flex items-center gap-1">
              {[...site.devices]
                .sort((a, b) => rank(b.status) - rank(a.status))
                .map((d) => <span key={d.id} title={`${d.name}: ${d.status}`} className="h-3 w-3 rounded-full" style={{ background: colorFor(d.status) }} />)}
            </div>
          </div>
        ))}
      </div>

      {/* alert ticker */}
      <div className="h-14 shrink-0 overflow-hidden border-t border-slate-800 bg-slate-900/80">
        {alerts.length === 0 ? (
          <div className="flex h-full items-center px-8 text-lg font-semibold text-emerald-400">● All systems nominal</div>
        ) : (
          <div className="flex h-full items-center whitespace-nowrap" style={{ animation: 'rubymik-ticker 40s linear infinite', width: 'max-content' }}>
            {[0, 1].map((dup) => (
              <div key={dup} className="flex items-center">
                {alerts.map((a) => (
                  <span key={`${dup}-${a.id}`} className="mx-8 inline-flex items-center gap-2 text-lg">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.severity === 'critical' ? '#f87171' : a.severity === 'warning' ? '#fbbf24' : '#60a5fa' }} />
                    <span className="font-semibold text-slate-100">{a.deviceName}</span>
                    <span className="text-slate-400">{a.message || a.ruleLabel}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BigTile({ label, value, color, pulse }: { label: string; value: number; color: string; pulse?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-3xl border border-slate-800 bg-slate-900/40">
      <div className={`text-[7rem] font-black leading-none tabular-nums ${pulse ? 'animate-pulse' : ''}`} style={{ color }}>{value}</div>
      <div className="mt-2 text-lg font-semibold uppercase tracking-[0.2em] text-slate-400">{label}</div>
    </div>
  );
}

function rank(s: HealthStatus): number { return s === 'down' ? 3 : s === 'warning' ? 2 : s === 'pending' ? 1 : 0; }
function colorFor(s: HealthStatus): string { return s === 'up' ? '#34d399' : s === 'warning' ? '#fbbf24' : s === 'down' ? '#f87171' : '#64748b'; }
