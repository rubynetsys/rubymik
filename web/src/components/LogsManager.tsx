import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowDownUp, Info, LogIn, LogOut, Play, Plug, RefreshCw, ScrollText,
  Search, Unplug, XCircle, type LucideIcon,
} from 'lucide-react';
import { api } from '../api';
import Select from './Select';

/**
 * P29 Logs v2 — two views (Raw = exact router log; Simple = icon + plain sentence),
 * filters (severity / topic / text), and a follow/tail toggle. Read-only; works on
 * monitor-only devices. Unknown topics ALWAYS fall through verbatim — never hidden.
 */
interface LogEntry { time: string | null; topics: string | null; message: string | null }
type Severity = 'error' | 'warning' | 'info';
const REFRESH_MS = 5000;

function severityOf(topics: string | null): Severity {
  const t = (topics ?? '').toLowerCase();
  if (t.includes('critical') || t.includes('error')) return 'error';
  if (t.includes('warning')) return 'warning';
  return 'info';
}

/** Plain-language interpretation. Falls through to the raw message for anything
 *  we don't recognise, so no line is ever hidden or lost. */
function humanize(e: LogEntry): { Icon: LucideIcon; text: string } {
  const t = (e.topics ?? '').toLowerCase();
  const m = e.message ?? '';
  if (t.includes('account') && /logged in/i.test(m)) {
    const u = m.match(/user (\S+)/i)?.[1]; const via = m.match(/via (\S+)/i)?.[1];
    return { Icon: LogIn, text: `${u ?? 'Someone'} signed in${via ? ` (${via})` : ''}` };
  }
  if (t.includes('account') && /logged out/i.test(m)) {
    const u = m.match(/user (\S+)/i)?.[1];
    return { Icon: LogOut, text: `${u ?? 'Someone'} signed out` };
  }
  if (/reboot/i.test(m)) return { Icon: RefreshCw, text: 'Router rebooted' };
  if (t.includes('interface') && /link down/i.test(m)) {
    const p = m.match(/^(\S+)/)?.[1]; return { Icon: Unplug, text: `Cable/port ${p ?? ''} went down` };
  }
  if (t.includes('interface') && /link up/i.test(m)) {
    const p = m.match(/^(\S+)/)?.[1]; return { Icon: Plug, text: `Cable/port ${p ?? ''} came up` };
  }
  if (t.includes('dhcp') && /assigned/i.test(m)) return { Icon: ArrowDownUp, text: `Handed out an IP address — ${m}` };
  return { Icon: Info, text: m };
}

const SEV_META: Record<Severity, { dot: string; text: string; Icon: LucideIcon }> = {
  error: { dot: 'bg-danger', text: 'text-danger-fg', Icon: XCircle },
  warning: { dot: 'bg-warning', text: 'text-warning-fg', Icon: AlertTriangle },
  info: { dot: 'bg-fg-faint', text: 'text-fg-dim', Icon: Info },
};

export default function LogsManager({ deviceId }: { deviceId: number }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'simple' | 'raw'>('simple');
  const [sev, setSev] = useState<'all' | Severity>('all');
  const [topic, setTopic] = useState('all');
  const [search, setSearch] = useState('');
  const [tail, setTail] = useState(false);

  const load = useCallback(() => {
    api.get<{ entries: LogEntry[] }>(`/api/devices/${deviceId}/logs?limit=300`)
      .then((r) => { setEntries(r.entries); setError(null); })
      .catch((e) => setError((e as Error).message));
  }, [deviceId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!tail) return;
    const t = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [tail, load]);

  // Topics present, as a "primary topic" set for the filter dropdown.
  const topics = useMemo(() => {
    const s = new Set<string>();
    for (const e of entries ?? []) { const first = (e.topics ?? '').split(',')[0]?.trim(); if (first) s.add(first); }
    return [...s].sort();
  }, [entries]);

  const shown = useMemo(() => (entries ?? []).filter((e) => {
    if (sev !== 'all' && severityOf(e.topics) !== sev) return false;
    if (topic !== 'all' && !(e.topics ?? '').toLowerCase().includes(topic.toLowerCase())) return false;
    if (search && !((e.message ?? '') + (e.topics ?? '')).toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [entries, sev, topic, search]);

  if (error) return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load the log: {error}</div>;
  if (!entries) return <div className="h-40 animate-pulse rounded-lg bg-app" />;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-lg border border-border-strong">
          {(['simple', 'raw'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 text-xs font-semibold capitalize transition ${view === v ? 'bg-accent text-inverse' : 'text-fg-dim hover:bg-app'}`}>{v}</button>
          ))}
        </div>
        <Select value={sev} onChange={(v) => setSev(v as 'all' | Severity)} className="w-32" ariaLabel="Severity"
          options={[{ value: 'all', label: 'All severities' }, { value: 'error', label: 'Errors' }, { value: 'warning', label: 'Warnings' }, { value: 'info', label: 'Info' }]} />
        <Select value={topic} onChange={setTopic} className="w-36" ariaLabel="Topic"
          options={[{ value: 'all', label: 'All topics' }, ...topics.map((t) => ({ value: t, label: t }))]} />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
            className="w-44 rounded-lg border border-border-strong bg-app py-2 pl-8 pr-2 text-sm text-fg-body outline-none focus:border-accent-border-strong" />
        </div>
        <button onClick={() => setTail((t) => !t)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${tail ? 'border-accent-border bg-accent-subtle text-accent-text' : 'border-border-strong text-fg-dim hover:text-fg'}`}>
          {tail ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Follow
        </button>
        <button onClick={load} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-2.5 py-1.5 text-xs font-semibold text-fg-dim hover:text-fg">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <div className="text-[11px] text-fg-faint">
        <ScrollText className="mr-1 inline h-3 w-3" />{shown.length} of {entries.length} lines · newest first · the router keeps a rolling buffer (older lines age out on the device)
      </div>

      <div className="mt-2 max-h-[28rem] overflow-y-auto rounded-lg bg-sunken p-2">
        {shown.length === 0 && <div className="p-3 text-sm text-fg-faint">No matching log lines.</div>}
        {view === 'raw' ? (
          <div className="font-mono text-xs leading-5 text-fg-body">
            {shown.map((l, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 text-fg-faint">{l.time ?? ''}</span>
                <span className={`shrink-0 ${severityOf(l.topics) === 'error' ? 'text-danger-fg' : severityOf(l.topics) === 'warning' ? 'text-warning-fg' : 'text-fg-faint'}`}>{l.topics ?? ''}</span>
                <span className="break-all">{l.message ?? ''}</span>
              </div>
            ))}
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {shown.map((l, i) => {
              const s = severityOf(l.topics); const { Icon, text } = humanize(l);
              return (
                <li key={i} className="flex items-start gap-2.5 px-2 py-1.5">
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${SEV_META[s].dot}`} />
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${SEV_META[s].text}`} />
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-sm text-fg-body">{text}</div>
                    <div className="mt-0.5 text-[11px] text-fg-faint">{l.time ?? ''} · {l.topics ?? ''}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
