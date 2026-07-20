import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, RotateCcw, ScrollText, ShieldX } from 'lucide-react';
import { api } from '../api';
import { fmtAgo, type AuditEntry, type Site } from '../types';

const REFRESH_MS = 15_000;

const RESULT: Record<AuditEntry['result'], { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  applied: { label: 'Applied', cls: 'bg-emerald-50 text-emerald-700', Icon: CheckCircle2 },
  rolled_back: { label: 'Rolled back', cls: 'bg-amber-50 text-amber-700', Icon: RotateCcw },
  rollback_failed: { label: 'Rollback failed', cls: 'bg-red-50 text-red-700', Icon: AlertTriangle },
  failed: { label: 'Failed', cls: 'bg-red-50 text-red-700', Icon: AlertTriangle },
  rejected: { label: 'Rejected', cls: 'bg-zinc-100 text-zinc-600', Icon: ShieldX },
};

export default function Audit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteFilter, setSiteFilter] = useState<'all' | number>('all');

  const load = useCallback(async () => {
    const qs = siteFilter === 'all' ? '' : `?siteId=${siteFilter}`;
    try {
      setEntries(await api.get<AuditEntry[]>(`/api/audit${qs}`));
    } catch {
      /* transient */
    }
  }, [siteFilter]);

  useEffect(() => {
    void load();
    api.get<Site[]>('/api/sites').then(setSites).catch(() => {});
    const t = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Config audit</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Every configuration write — who, what, before → after, and the outcome. Read-only history.
          </p>
        </div>
        <select
          value={String(siteFilter)}
          onChange={(e) => setSiteFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-ruby-500"
        >
          <option value="all">All sites</option>
          {sites.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
        </select>
      </div>

      <div className="mt-6">
        {!entries ? (
          <div className="h-32 animate-pulse rounded-2xl border border-zinc-200 bg-white" />
        ) : entries.length === 0 ? (
          <div className="rounded-2xl border border-zinc-200 bg-white p-12 shadow-sm">
            <div className="mx-auto flex max-w-md flex-col items-center text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100">
                <ScrollText className="h-7 w-7 text-zinc-400" />
              </div>
              <h2 className="mt-4 text-lg font-semibold text-zinc-900">No config changes yet</h2>
              <p className="mt-1.5 text-sm text-zinc-500">
                When you make a write (e.g. a DHCP reservation), it appears here with its full before/after and result.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {entries.map((e) => {
              const r = RESULT[e.result];
              return (
                <div key={e.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${r.cls}`}>
                      <r.Icon className="h-3.5 w-3.5" /> {r.label}
                    </span>
                    <span className="font-mono text-xs text-zinc-400">{e.action}</span>
                    <span className="font-semibold text-zinc-900">{e.summary}</span>
                    <span className="ml-auto text-xs text-zinc-400">
                      {e.deviceId ? (
                        <Link to={`/devices/${e.deviceId}`} className="text-ruby-700 hover:underline">{e.deviceName}</Link>
                      ) : e.deviceName}
                      {' · '}{e.actor} · {fmtAgo(e.createdAt)}
                    </span>
                  </div>
                  {e.detail && <div className="mt-2 text-sm text-zinc-600">{e.detail}</div>}
                  {(e.before != null || e.after != null) && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {e.before != null && (
                        <div className="rounded-lg bg-zinc-50 p-2.5">
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">before</div>
                          <pre className="overflow-x-auto text-[11px] leading-4 text-zinc-600">{JSON.stringify(e.before, null, 1)}</pre>
                        </div>
                      )}
                      {e.after != null && (
                        <div className="rounded-lg bg-zinc-50 p-2.5">
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">after</div>
                          <pre className="overflow-x-auto text-[11px] leading-4 text-zinc-800">{JSON.stringify(e.after, null, 1)}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
