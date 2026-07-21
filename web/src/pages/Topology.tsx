import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Info, Maximize2, Plus, Router as RouterIcon, Search, TriangleAlert, X } from 'lucide-react';
import { api } from '../api';
import Select from '../components/Select';
import { fmtAgo, type Site, type TopoNode, type TopologyPayload } from '../types';
import { computeLayout, layoutStats, type LayoutNode, type LayoutSite } from '../topology/layout';
import TopoCanvas, { type TopoCanvasHandle } from '../components/TopoCanvas';
import StatusBadge from '../components/StatusBadge';
import { DeviceModal } from './Devices';

const REFRESH_MS = 10_000;
type StatusFilter = 'all' | 'problems';
type KindFilter = 'all' | 'managed' | 'discovered';

export default function Topology() {
  const navigate = useNavigate();
  const canvas = useRef<TopoCanvasHandle>(null);
  const [topo, setTopo] = useState<TopologyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [siteFilter, setSiteFilter] = useState<'all' | number>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState<TopoNode | null>(null);
  const [adding, setAdding] = useState<TopoNode | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [hover, setHover] = useState<{ node: LayoutNode; x: number; y: number } | null>(null);
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
    const t = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    const s = setInterval(() => tick((n) => n + 1), 1000);
    return () => { clearInterval(t); clearInterval(s); };
  }, [load]);

  // Client-side filters reduce what the layout sees (the key to a readable map at scale).
  const filtered = useMemo(() => {
    const all = topo?.nodes ?? [];
    let nodes = all;
    if (kindFilter !== 'all') nodes = nodes.filter((n) => n.kind === kindFilter);
    if (statusFilter === 'problems') nodes = nodes.filter((n) => n.kind === 'managed' && (n.status === 'warning' || n.status === 'down'));
    const keep = new Set(nodes.map((n) => n.key));
    const edges = (topo?.edges ?? []).filter((e) => keep.has(e.source) && keep.has(e.target));
    return { nodes, edges };
  }, [topo, kindFilter, statusFilter]);

  const layout = useMemo(
    () => computeLayout(filtered.nodes, filtered.edges, topo?.sites ?? []),
    [filtered, topo?.sites],
  );

  // Focus = highlight the node's subtree (descendants) + its uplink path; dim the rest.
  const highlight = useMemo(() => {
    if (!focusedKey || !layout.nodeByKey.has(focusedKey)) return null;
    const adj = new Map<string, Array<{ key: string; layer: number }>>();
    for (const n of layout.nodes) adj.set(n.key, []);
    for (const e of layout.edges) {
      const a = layout.nodeByKey.get(e.source), b = layout.nodeByKey.get(e.target);
      if (!a || !b) continue;
      adj.get(a.key)!.push({ key: b.key, layer: b.layer });
      adj.get(b.key)!.push({ key: a.key, layer: a.layer });
    }
    const set = new Set<string>([focusedKey]);
    const start = layout.nodeByKey.get(focusedKey)!;
    // descendants (strictly deeper layers)
    const q = [start.key];
    while (q.length) {
      const cur = q.shift()!;
      const cl = layout.nodeByKey.get(cur)!.layer;
      for (const nb of adj.get(cur) ?? []) if (nb.layer > cl && !set.has(nb.key)) { set.add(nb.key); q.push(nb.key); }
    }
    // uplink path (follow shallowest neighbor upward to the gateway)
    let cur = start.key;
    for (let guard = 0; guard < 64; guard++) {
      const cl = layout.nodeByKey.get(cur)!.layer;
      const up = (adj.get(cur) ?? []).filter((nb) => nb.layer < cl).sort((a, b) => a.layer - b.layer)[0];
      if (!up) break;
      set.add(up.key); cur = up.key;
    }
    return set;
  }, [focusedKey, layout]);

  // expose a no-overlap / scale diagnostic for headless proofs
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__RUBYMIK_TOPO__ = {
      stats: layoutStats(layout),
      counts: { managed: layout.nodes.filter((n) => n.kind === 'managed').length, discovered: layout.nodes.filter((n) => n.kind === 'discovered').length, edges: layout.edges.length, sites: layout.sites.length },
    };
  }, [layout]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 1) return [];
    return layout.nodes.filter((n) => {
      const nd = n.node;
      return n.name.toLowerCase().includes(q)
        || (nd.identity ?? '').toLowerCase().includes(q)
        || (nd.address ?? '').toLowerCase().includes(q)
        || (nd.mac ?? '').toLowerCase().includes(q);
    }).slice(0, 7);
  }, [search, layout]);

  const warnings = topo?.notes.filter((n) => n.level !== 'ok') ?? [];
  const managedCount = topo?.nodes.filter((n) => n.kind === 'managed').length ?? 0;
  const discoveredCount = topo?.nodes.filter((n) => n.kind === 'discovered').length ?? 0;
  const shownManaged = layout.nodes.filter((n) => n.kind === 'managed').length;

  function onNodeClick(ln: LayoutNode) {
    const node = ln.node;
    setFocusedKey(ln.key);
    if (node.kind === 'managed' && node.deviceId !== undefined) void navigate(`/devices/${node.deviceId}`);
    else setSelected(node);
  }
  function jumpTo(ln: LayoutNode) {
    setSearch('');
    setFocusedKey(ln.key);
    canvas.current?.focusNode(ln.key);
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-fg-strong">Topology</h1>
          <p className="mt-1 text-sm text-fg-dim">
            Auto-discovered from MNDP / LLDP / CDP neighbor tables — read-only, direct sightings only.
            Zoom out for the fleet at a glance; click a site to dive in.
          </p>
        </div>
        <span className="text-xs text-fg-faint">
          {fetchedAt ? `Updated ${fmtAgo(new Date(fetchedAt).toISOString())}` : ''} · refreshes with poll data
        </span>
      </div>

      {error && (
        <div className="mt-6 rounded-2xl border border-danger-line bg-danger-bg p-6 text-sm text-danger-fg-strong">{error}</div>
      )}

      {topo && topo.nodes.length === 0 && (
        <div className="mt-6 rounded-2xl border border-border bg-surface p-12 text-center shadow-sm">
          <p className="text-sm text-fg-dim">
            {siteFilter === 'all' ? 'No devices to map yet — add a MikroTik first.' : 'No devices in this site.'}
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
              <button onClick={() => setNotesOpen(!notesOpen)} className="flex w-full items-center gap-2 text-left text-sm font-semibold text-warning-fg">
                <TriangleAlert className="h-4 w-4 shrink-0" />
                Neighbor discovery is limited on {warnings.length} device{warnings.length === 1 ? '' : 's'} — the map may be missing links
                <span className="ml-auto text-xs font-medium text-warning">{notesOpen ? 'hide' : 'details'}</span>
              </button>
              {notesOpen && (
                <ul className="mt-2 space-y-1.5 text-xs text-warning-fg">
                  {warnings.slice(0, 40).map((w) => (
                    <li key={w.deviceId}>{w.message} <span className="text-warning">({w.neighborCount} neighbor{w.neighborCount === 1 ? '' : 's'} visible)</span></li>
                  ))}
                  {warnings.length > 40 && <li className="text-warning">…and {warnings.length - 40} more.</li>}
                </ul>
              )}
            </div>
          )}

          {/* toolbar: search + filters + view controls */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search device / IP / MAC…"
                className="w-60 rounded-lg border border-border-strong bg-surface py-2 pl-8 pr-3 text-sm outline-none transition focus:border-accent-border-strong"
              />
              {searchResults.length > 0 && (
                <div className="absolute z-30 mt-1 w-72 overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
                  {searchResults.map((r) => (
                    <button key={r.key} onClick={() => jumpTo(r)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-sunken">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${r.kind === 'managed' ? (r.status === 'down' ? 'bg-danger' : r.status === 'warning' ? 'bg-warning' : 'bg-success-strong') : 'bg-fg-faint'}`} />
                      <span className="flex-1 truncate">
                        <span className="font-medium text-fg">{r.name}</span>
                        <span className="block truncate text-[11px] text-fg-faint">{r.node.address ?? r.node.mac ?? ''}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Select value={String(siteFilter)} onChange={(v) => { setSiteFilter(v === 'all' ? 'all' : Number(v)); setFocusedKey(null); }} ariaLabel="Filter by site" className="w-40"
              options={[{ value: 'all', label: 'All sites' }, ...(topo.sites ?? []).map((s) => ({ value: String(s.id), label: s.name }))]} />

            <div className="flex overflow-hidden rounded-lg border border-border-strong text-xs font-semibold">
              {(['all', 'problems'] as StatusFilter[]).map((f) => (
                <button key={f} onClick={() => setStatusFilter(f)}
                  className={`px-3 py-2 transition ${statusFilter === f ? 'bg-accent text-inverse' : 'bg-surface text-fg-dim hover:bg-sunken'}`}>
                  {f === 'all' ? 'All status' : 'Problems only'}
                </button>
              ))}
            </div>
            <div className="flex overflow-hidden rounded-lg border border-border-strong text-xs font-semibold">
              {(['all', 'managed', 'discovered'] as KindFilter[]).map((f) => (
                <button key={f} onClick={() => setKindFilter(f)}
                  className={`px-3 py-2 capitalize transition ${kindFilter === f ? 'bg-accent text-inverse' : 'bg-surface text-fg-dim hover:bg-sunken'}`}>
                  {f}
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-2">
              {focusedKey && (
                <button onClick={() => setFocusedKey(null)} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 py-2 text-xs font-semibold text-fg-dim transition hover:bg-sunken">
                  <X className="h-3.5 w-3.5" /> Clear focus
                </button>
              )}
              <button onClick={() => canvas.current?.zoomToFit()} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 py-2 text-xs font-semibold text-fg-dim transition hover:bg-sunken">
                <Maximize2 className="h-3.5 w-3.5" /> Fit
              </button>
            </div>
          </div>

          <div className="relative rounded-2xl border border-border bg-app shadow-sm">
            <TopoCanvas
              ref={canvas}
              layout={layout}
              onNodeClick={onNodeClick}
              onSiteClick={(s: LayoutSite) => canvas.current?.focusSite(s.key)}
              onHover={(n, s) => setHover(n && s ? { node: n, x: s.x, y: s.y } : null)}
              highlight={highlight}
              themeTick={0}
            />

            {/* hover tooltip */}
            {hover && (
              <div className="pointer-events-none absolute z-20 w-60 rounded-xl border border-border bg-surface p-3 shadow-lg"
                style={{ left: Math.min(hover.x + 14, 700), top: hover.y + 14 }}>
                <HoverCard n={hover.node} />
              </div>
            )}

            {/* legend */}
            <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface/95 px-3 py-2 text-[11px] font-medium text-fg-muted">
              <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2 border-success bg-surface" /> Managed</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border border-dashed border-border-strong bg-sunken" /> Discovered</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-success-strong" /> Up</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-warning" /> Warning</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-danger" /> Down</span>
            </div>
            {/* count chip */}
            <div className="pointer-events-none absolute right-3 top-3 rounded-lg border border-border bg-surface/95 px-3 py-1.5 text-[11px] font-medium text-fg-dim">
              {layout.sites.length} site{layout.sites.length === 1 ? '' : 's'} ·{' '}
              {statusFilter === 'problems' || kindFilter !== 'all' ? `${shownManaged}/${managedCount}` : managedCount} managed · {discoveredCount} discovered · {topo.edges.length} link{topo.edges.length === 1 ? '' : 's'}
            </div>
          </div>

          {topo.edges.length === 0 && (
            <div className="mt-4 flex items-start gap-2 rounded-xl bg-sunken px-4 py-3 text-sm text-fg-muted">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-fg-faint" />
              No links discovered yet. Neighbors appear when MNDP/LLDP/CDP discovery is enabled on the devices'
              interfaces and something on those segments answers — RubyMIK only draws what the routers actually
              report, it never invents topology.
            </div>
          )}
        </div>
      )}

      {/* discovered-node side panel (unchanged behavior) */}
      {selected && (
        <div className="fixed inset-y-0 right-0 z-40 w-96 overflow-y-auto border-l border-border bg-surface p-6 shadow-2xl">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-fg-faint">Discovered device</div>
              <h2 className="mt-0.5 text-lg font-bold text-fg-strong">{selected.name}</h2>
            </div>
            <button onClick={() => setSelected(null)} className="rounded-lg p-1.5 text-fg-faint hover:bg-app hover:text-fg-body"><X className="h-5 w-5" /></button>
          </div>
          <dl className="mt-4 space-y-3 text-sm">
            {([
              ['Identity', selected.identity], ['Platform', selected.platform], ['Board', selected.board],
              ['Version', selected.version], ['IP address', selected.address], ['MAC', selected.mac],
              ['Vendor', selected.vendor], ['Discovered by', selected.discoveredBy?.toUpperCase()],
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
            <p className="text-xs text-fg-dim">This device was seen in neighbor tables but isn't managed by RubyMIK. Add it with RouterOS credentials to monitor it (RouterOS 7.1+ with REST reachable).</p>
            <button onClick={() => { setAdding(selected); setSelected(null); }}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover">
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
          onSaved={(keepOpen) => { if (!keepOpen) setAdding(null); void load(); }}
        />
      )}
    </div>
  );
}

function HoverCard({ n }: { n: LayoutNode }) {
  const nd = n.node;
  return n.kind === 'managed' ? (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-fg-strong">{n.name}</span>
        {nd.status && <StatusBadge status={nd.status} />}
      </div>
      <div className="text-xs text-fg-dim">{[nd.model, nd.version && `RouterOS ${nd.version}`].filter(Boolean).join(' · ') || '—'}</div>
      {nd.siteName && <div className="text-xs text-fg-faint">Site: {nd.siteName}</div>}
      <div className="text-[11px] font-medium text-accent-text">Click to open device view →</div>
    </div>
  ) : (
    <div className="space-y-1.5">
      <div className="text-sm font-bold text-fg-strong">{n.name}</div>
      <div className="text-xs text-fg-dim">{[nd.platform, nd.board].filter(Boolean).join(' · ') || 'Unknown device'}</div>
      {nd.address && <div className="text-xs text-fg-dim">{nd.address}</div>}
      {nd.mac && <div className="font-mono text-[11px] text-fg-faint">{nd.mac}</div>}
      <div className="text-[11px] font-medium text-fg-faint">Discovered (not managed) — click for options</div>
    </div>
  );
}
