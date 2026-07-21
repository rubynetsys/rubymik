import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Info, Plus, Router as RouterIcon, TriangleAlert, X } from 'lucide-react';
import { api } from '../api';
import { fmtAgo, type Site, type TopoNode, type TopologyPayload } from '../types';
import ForceGraph, { type GraphEdge, type GraphNode } from '../components/ForceGraph';
import StatusBadge from '../components/StatusBadge';
import { DeviceModal } from './Devices';

const REFRESH_MS = 10_000;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export default function Topology() {
  const navigate = useNavigate();
  const [topo, setTopo] = useState<TopologyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [siteFilter, setSiteFilter] = useState<'all' | number>('all');
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState<TopoNode | null>(null);
  const [adding, setAdding] = useState<TopoNode | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      const qs = siteFilter === 'all' ? '' : `?siteId=${siteFilter}`;
      setTopo(await api.get<TopologyPayload>(`/api/topology${qs}`));
      setFetchedAt(Date.now());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [siteFilter]);

  useEffect(() => {
    void load();
    api.get<Site[]>('/api/sites').then(setSites).catch(() => {});
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    const s = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(t);
      clearInterval(s);
    };
  }, [load]);

  const graph = useMemo(() => {
    if (!topo) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    const nodes: GraphNode[] = topo.nodes.map((n) => ({
      key: n.key,
      kind: n.kind,
      label: truncate(n.name, 22),
      sub: n.kind === 'managed'
        ? (n.model ?? undefined)
        : truncate([n.board ?? n.platform ?? n.vendor, n.address].filter(Boolean).join(' · ') || (n.mac ?? ''), 30),
      status: n.status,
    }));
    const edges: GraphEdge[] = topo.edges.map((e) => {
      const parts = [e.ifaces[e.source], e.ifaces[e.target]]
        .filter((x): x is string => Boolean(x))
        .map((x) => truncate(x, 16));
      return { source: e.source, target: e.target, label: parts.join(' ↔ ') || null };
    });
    return { nodes, edges };
  }, [topo]);

  const warnings = topo?.notes.filter((n) => n.level !== 'ok') ?? [];
  const managedCount = topo?.nodes.filter((n) => n.kind === 'managed').length ?? 0;
  const discoveredCount = topo?.nodes.filter((n) => n.kind === 'discovered').length ?? 0;

  function onNodeClick(gn: GraphNode) {
    const node = topo?.nodes.find((n) => n.key === gn.key);
    if (!node) return;
    if (node.kind === 'managed' && node.deviceId !== undefined) {
      void navigate(`/devices/${node.deviceId}`);
    } else {
      setSelected(node);
    }
  }

  function tooltip(gn: GraphNode) {
    const n = topo?.nodes.find((x) => x.key === gn.key);
    if (!n) return null;
    return n.kind === 'managed' ? (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-bold text-fg-strong">{n.name}</span>
          {n.status && <StatusBadge status={n.status} />}
        </div>
        <div className="text-xs text-fg-dim">
          {[n.model, n.version && `RouterOS ${n.version}`].filter(Boolean).join(' · ') || '—'}
        </div>
        {n.siteName && <div className="text-xs text-fg-faint">Site: {n.siteName}</div>}
        <div className="text-[11px] font-medium text-accent">Click to open device view →</div>
      </div>
    ) : (
      <div className="space-y-1.5">
        <div className="text-sm font-bold text-fg-strong">{n.name}</div>
        <div className="text-xs text-fg-dim">
          {[n.platform, n.board].filter(Boolean).join(' · ') || 'Unknown device'}
        </div>
        {n.address && <div className="text-xs text-fg-dim">{n.address}</div>}
        {n.mac && <div className="font-mono text-[11px] text-fg-faint">{n.mac}</div>}
        <div className="text-[11px] font-medium text-fg-faint">Discovered (not managed) — click for options</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-fg-strong">Topology</h1>
          <p className="mt-1 text-sm text-fg-dim">
            Auto-discovered from MNDP / LLDP / CDP neighbor tables — read-only, direct sightings only.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-fg-faint">
            {fetchedAt ? `Updated ${fmtAgo(new Date(fetchedAt).toISOString())}` : ''} · refreshes with poll data
          </span>
          <select
            value={String(siteFilter)}
            onChange={(e) => setSiteFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong"
          >
            <option value="all">All sites</option>
            {(topo?.sites ?? []).map((s) => (
              <option key={s.id} value={String(s.id)}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="mt-6 rounded-2xl border border-danger-line bg-danger-bg p-6 text-sm text-danger-fg-strong">{error}</div>
      )}

      {topo && topo.nodes.length === 0 && (
        <div className="mt-6 rounded-2xl border border-border bg-surface p-12 text-center shadow-sm">
          <p className="text-sm text-fg-dim">
            {siteFilter === 'all'
              ? 'No devices to map yet — add a MikroTik first.'
              : 'No devices in this site.'}
          </p>
          <Link to="/devices" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover">
            <Plus className="h-4 w-4" /> Add a device
          </Link>
        </div>
      )}

      {topo && topo.nodes.length > 0 && (
        <div className="mt-5">
          {warnings.length > 0 && (
            <div className="mb-4 rounded-xl border border-warning-line bg-warning-bg px-4 py-3">
              <button
                onClick={() => setNotesOpen(!notesOpen)}
                className="flex w-full items-center gap-2 text-left text-sm font-semibold text-warning-fg"
              >
                <TriangleAlert className="h-4 w-4 shrink-0" />
                Neighbor discovery is limited on {warnings.length} device{warnings.length === 1 ? '' : 's'} — the map may be missing links
                <span className="ml-auto text-xs font-medium text-warning">{notesOpen ? 'hide' : 'details'}</span>
              </button>
              {notesOpen && (
                <ul className="mt-2 space-y-1.5 text-xs text-warning-fg">
                  {warnings.map((w) => (
                    <li key={w.deviceId}>{w.message} <span className="text-warning">({w.neighborCount} neighbor{w.neighborCount === 1 ? '' : 's'} currently visible)</span></li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="relative rounded-2xl border border-border bg-surface shadow-sm">
            <ForceGraph nodes={graph.nodes} edges={graph.edges} onNodeClick={onNodeClick} tooltip={tooltip} />
            {/* legend */}
            <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 rounded-lg border border-border bg-surface/95 px-3 py-2 text-[11px] font-medium text-fg-muted">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-success bg-surface" /> Managed
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-full border border-dashed border-border-strong bg-sunken" /> Discovered
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-success-strong" /> Up
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-warning" /> Warning
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-danger" /> Down
              </span>
            </div>
            {/* count chip */}
            <div className="pointer-events-none absolute right-3 top-3 rounded-lg border border-border bg-surface/95 px-3 py-1.5 text-[11px] font-medium text-fg-dim">
              {managedCount} managed · {discoveredCount} discovered · {topo.edges.length} link{topo.edges.length === 1 ? '' : 's'}
            </div>
          </div>

          {topo.edges.length === 0 && (
            <div className="mt-4 flex items-start gap-2 rounded-xl bg-sunken px-4 py-3 text-sm text-fg-muted">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-fg-faint" />
              No links discovered yet. Neighbors appear when MNDP/LLDP/CDP discovery is enabled on the
              devices' interfaces and something on those segments answers — RubyMIK only draws what the
              routers actually report, it never invents topology.
            </div>
          )}
        </div>
      )}

      {/* discovered-node side panel */}
      {selected && (
        <div className="fixed inset-y-0 right-0 z-40 w-96 overflow-y-auto border-l border-border bg-surface p-6 shadow-2xl">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-fg-faint">Discovered device</div>
              <h2 className="mt-0.5 text-lg font-bold text-fg-strong">{selected.name}</h2>
            </div>
            <button onClick={() => setSelected(null)} className="rounded-lg p-1.5 text-fg-faint hover:bg-app hover:text-fg-body">
              <X className="h-5 w-5" />
            </button>
          </div>
          <dl className="mt-4 space-y-3 text-sm">
            {([
              ['Identity', selected.identity],
              ['Platform', selected.platform],
              ['Board', selected.board],
              ['Version', selected.version],
              ['IP address', selected.address],
              ['MAC', selected.mac],
              ['Vendor', selected.vendor],
              ['Discovered by', selected.discoveredBy?.toUpperCase()],
            ] as Array<[string, string | null | undefined]>).filter(([, v]) => v).map(([k, v]) => (
              <div key={k}>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{k}</dt>
                <dd className="mt-0.5 break-all font-medium text-fg">{v}</dd>
              </div>
            ))}
            {selected.seenBy && selected.seenBy.length > 0 && (
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Seen by</dt>
                <dd className="mt-0.5 space-y-0.5">
                  {selected.seenBy.map((s, i) => (
                    <div key={i} className="text-fg-body">
                      <RouterIcon className="mr-1 inline h-3.5 w-3.5 text-fg-faint" />
                      {s.deviceName}{s.iface ? <span className="text-fg-faint"> on {s.iface}</span> : ''}
                    </div>
                  ))}
                </dd>
              </div>
            )}
          </dl>
          <div className="mt-6 border-t border-border-subtle pt-4">
            <p className="text-xs text-fg-dim">
              This device was seen in neighbor tables but isn't managed by RubyMIK. Add it with RouterOS
              credentials to monitor it (RouterOS 7.1+ with REST reachable).
            </p>
            <button
              onClick={() => { setAdding(selected); setSelected(null); }}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover"
            >
              <Plus className="h-4 w-4" /> Add this device
            </button>
          </div>
        </div>
      )}

      {adding && (
        <DeviceModal
          sites={sites}
          initial={{ name: adding.identity ?? adding.name, host: adding.address ?? '' }}
          onSitesChanged={() => api.get<Site[]>('/api/sites').then(setSites).catch(() => {})}
          onClose={() => setAdding(null)}
          onSaved={(keepOpen) => {
            if (!keepOpen) setAdding(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
