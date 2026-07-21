import type { TopoNode, TopoEdge } from '../types';

/**
 * PURE topology layout engine — no DOM, no rendering, deterministic. This is
 * the scaling core, kept entirely separate from the canvas renderer so the
 * renderer is swappable and this is unit-testable.
 *
 * Strategy (scales to hundreds across many sites):
 *   1. Assign every node to a site (managed → its own site; discovered →
 *      the site of the managed device that saw it).
 *   2. WITHIN a site: infer a tree from neighbor edges (gateway/uplink at the
 *      root) and lay it out as a tidy layered tree — uplink → core → access →
 *      edge, top to bottom. No overlap; structure is visible.
 *   3. ACROSS sites: pack each site's sub-layout into a cell on a grid, so
 *      sites never overlap and the whole canvas is used. Each site also gets a
 *      collapsed cluster super-node (for the zoomed-out level-of-detail view).
 */

export type Health = 'up' | 'warning' | 'down' | 'pending';

export interface LayoutNode {
  key: string;
  kind: 'managed' | 'discovered';
  name: string;
  status: Health;
  siteKey: string;
  layer: number;
  x: number;
  y: number;
  node: TopoNode;
}

export interface LayoutSite {
  key: string;              // String(siteId) or 'none'
  id: number | null;
  name: string;
  x: number; y: number; w: number; h: number;   // bounding box (world coords)
  cx: number; cy: number;   // cluster super-node center
  r: number;                // cluster super-node radius (scales with count)
  count: number;
  managed: number;
  discovered: number;
  worst: Health;
  nodeKeys: string[];
}

export interface LayoutEdge {
  source: string;
  target: string;
  crossSite: boolean;
}

export interface SiteEdge {
  a: string;   // site key
  b: string;   // site key
  count: number;
  worst: Health;
}

export interface TopoLayout {
  nodes: LayoutNode[];
  nodeByKey: Map<string, LayoutNode>;
  sites: LayoutSite[];
  edges: LayoutEdge[];
  siteEdges: SiteEdge[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

// World-unit tuning.
const NODE_GAP = 46;     // horizontal spacing between sibling leaves
const LAYER_GAP = 92;    // vertical spacing between hierarchy layers
const SITE_PAD = 70;     // padding inside a site cell around its tree
const SITE_GAP = 90;     // gap between site cells on the grid

const HEALTH_RANK: Record<Health, number> = { down: 3, warning: 2, up: 1, pending: 0 };
function worstOf(a: Health, b: Health): Health { return HEALTH_RANK[a] >= HEALTH_RANK[b] ? a : b; }

function statusOf(n: TopoNode): Health {
  if (n.kind !== 'managed') return 'pending';
  return (n.status as Health) ?? 'pending';
}

export function computeLayout(
  nodes: TopoNode[],
  edges: TopoEdge[],
  sites: Array<{ id: number; name: string }>,
): TopoLayout {
  const siteNameById = new Map(sites.map((s) => [s.id, s.name]));

  // managed deviceId → siteId, for attaching discovered nodes to a site.
  const deviceSite = new Map<number, number | null>();
  for (const n of nodes) if (n.kind === 'managed' && n.deviceId !== undefined) deviceSite.set(n.deviceId, n.siteId ?? null);

  const siteKeyOf = (n: TopoNode): { key: string; id: number | null; name: string } => {
    let id: number | null = null;
    let name = 'Unassigned';
    if (n.kind === 'managed') {
      id = n.siteId ?? null;
      name = n.siteName ?? (id !== null ? siteNameById.get(id) ?? `Site ${id}` : 'Unassigned');
    } else {
      const seen = n.seenBy?.[0]?.deviceId;
      if (seen !== undefined && deviceSite.has(seen)) {
        id = deviceSite.get(seen) ?? null;
        if (id !== null) name = siteNameById.get(id) ?? `Site ${id}`;
      }
    }
    return { key: id !== null ? String(id) : 'none', id, name };
  };

  // Group node keys by site.
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const siteMembers = new Map<string, { id: number | null; name: string; keys: string[] }>();
  const nodeSite = new Map<string, string>();
  for (const n of nodes) {
    const s = siteKeyOf(n);
    nodeSite.set(n.key, s.key);
    let g = siteMembers.get(s.key);
    if (!g) { g = { id: s.id, name: s.name, keys: [] }; siteMembers.set(s.key, g); }
    g.keys.push(n.key);
  }

  // Adjacency (intra-site only for tree building) + global degree.
  const adj = new Map<string, Set<string>>();
  const degree = new Map<string, number>();
  const crossSiteNodes = new Set<string>();
  for (const n of nodes) { adj.set(n.key, new Set()); degree.set(n.key, 0); }
  for (const e of edges) {
    if (!byKey.has(e.source) || !byKey.has(e.target)) continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    if (nodeSite.get(e.source) === nodeSite.get(e.target)) {
      adj.get(e.source)!.add(e.target);
      adj.get(e.target)!.add(e.source);
    } else {
      crossSiteNodes.add(e.source);
      crossSiteNodes.add(e.target);
    }
  }

  // Lay out ONE site's tree(s) into local coords (origin at 0,0). Returns local
  // node positions + local bbox.
  function layoutSite(keys: string[]): { pos: Map<string, { x: number; y: number; layer: number }>; w: number; h: number } {
    const pos = new Map<string, { x: number; y: number; layer: number }>();
    const remaining = new Set(keys);
    // Root order: border/uplink nodes first (they have cross-site edges), then
    // by descending degree — the gateway sits at the top of the tree.
    const rootOrder = [...keys].sort((a, b) => {
      const ca = crossSiteNodes.has(a) ? 1 : 0;
      const cb = crossSiteNodes.has(b) ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return (degree.get(b) ?? 0) - (degree.get(a) ?? 0);
    });

    let cursor = 0; // leaf x-cursor, in NODE_GAP units, shared across the forest
    const parentOf = new Map<string, string | null>();
    const children = new Map<string, string[]>();
    const depth = new Map<string, number>();

    // BFS forest: assign each reachable node a parent + depth.
    for (const root of rootOrder) {
      if (!remaining.has(root)) continue;
      remaining.delete(root);
      parentOf.set(root, null);
      depth.set(root, 0);
      const q = [root];
      while (q.length) {
        const cur = q.shift()!;
        // deterministic child order: by degree desc then key
        const kids = [...adj.get(cur)!].filter((k) => remaining.has(k))
          .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : 1));
        for (const k of kids) {
          remaining.delete(k);
          parentOf.set(k, cur);
          depth.set(k, (depth.get(cur) ?? 0) + 1);
          (children.get(cur) ?? children.set(cur, []).get(cur)!).push(k);
          q.push(k);
        }
      }
    }

    // Tidy-tree x assignment: leaves take sequential slots, parents center over
    // their children (post-order).
    const place = (key: string): void => {
      const kids = children.get(key) ?? [];
      const d = depth.get(key) ?? 0;
      if (kids.length === 0) {
        pos.set(key, { x: cursor * NODE_GAP, y: d * LAYER_GAP, layer: d });
        cursor += 1;
      } else {
        for (const k of kids) place(k);
        const xs = kids.map((k) => pos.get(k)!.x);
        pos.set(key, { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: d * LAYER_GAP, layer: d });
      }
    };
    for (const root of rootOrder) {
      if (parentOf.get(root) === null && !pos.has(root)) { place(root); cursor += 1; /* gap between trees */ }
    }
    // Any stragglers (shouldn't happen) get a row.
    for (const k of keys) if (!pos.has(k)) { pos.set(k, { x: cursor * NODE_GAP, y: 0, layer: 0 }); cursor += 1; }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pos.values()) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    // normalize to (0,0)
    for (const p of pos.values()) { p.x -= minX; p.y -= minY; }
    return { pos, w: maxX - minX, h: maxY - minY };
  }

  // Lay out each site locally, then pack sites on a grid sized to the largest.
  const siteKeys = [...siteMembers.keys()].sort((a, b) => {
    const na = siteMembers.get(a)!.keys.length, nb = siteMembers.get(b)!.keys.length;
    return nb - na || (a < b ? -1 : 1);
  });
  const local = new Map<string, ReturnType<typeof layoutSite>>();
  let cellW = 0, cellH = 0;
  for (const sk of siteKeys) {
    const l = layoutSite(siteMembers.get(sk)!.keys);
    local.set(sk, l);
    cellW = Math.max(cellW, l.w + SITE_PAD * 2);
    cellH = Math.max(cellH, l.h + SITE_PAD * 2);
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(siteKeys.length)));

  const outNodes: LayoutNode[] = [];
  const outSites: LayoutSite[] = [];
  const nodeByKey = new Map<string, LayoutNode>();
  let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;

  siteKeys.forEach((sk, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const cellX = col * (cellW + SITE_GAP);
    const cellY = row * (cellH + SITE_GAP);
    const l = local.get(sk)!;
    const g = siteMembers.get(sk)!;
    // center the site's tree within its cell
    const offX = cellX + (cellW - l.w) / 2;
    const offY = cellY + SITE_PAD;

    let managed = 0, discovered = 0;
    let worst: Health = 'pending';
    const nodeKeys: string[] = [];
    for (const key of g.keys) {
      const n = byKey.get(key)!;
      const p = l.pos.get(key)!;
      const st = statusOf(n);
      const ln: LayoutNode = {
        key, kind: n.kind, name: n.name, status: st, siteKey: sk, layer: p.layer,
        x: offX + p.x, y: offY + p.y, node: n,
      };
      outNodes.push(ln);
      nodeByKey.set(key, ln);
      nodeKeys.push(key);
      if (n.kind === 'managed') { managed++; worst = worstOf(worst, st); } else discovered++;
      gMinX = Math.min(gMinX, ln.x); gMaxX = Math.max(gMaxX, ln.x);
      gMinY = Math.min(gMinY, ln.y); gMaxY = Math.max(gMaxY, ln.y);
    }
    const bx = cellX, by = cellY, bw = cellW, bh = cellH;
    outSites.push({
      key: sk, id: g.id, name: g.name,
      x: bx, y: by, w: bw, h: bh,
      cx: bx + bw / 2, cy: by + bh / 2,
      r: Math.max(26, Math.min(70, 20 + Math.sqrt(managed + discovered) * 6)),
      count: g.keys.length, managed, discovered, worst, nodeKeys,
    });
  });

  // Edges (resolved by renderer from nodeByKey) + aggregated cross-site links.
  const outEdges: LayoutEdge[] = [];
  const siteEdgeMap = new Map<string, SiteEdge>();
  for (const e of edges) {
    if (!nodeByKey.has(e.source) || !nodeByKey.has(e.target)) continue;
    const sa = nodeSite.get(e.source)!, sb = nodeSite.get(e.target)!;
    const cross = sa !== sb;
    outEdges.push({ source: e.source, target: e.target, crossSite: cross });
    if (cross) {
      const a = sa < sb ? sa : sb, b = sa < sb ? sb : sa;
      const k = `${a}~${b}`;
      const w = worstOf(nodeByKey.get(e.source)!.status, nodeByKey.get(e.target)!.status);
      const ex = siteEdgeMap.get(k);
      if (ex) { ex.count++; ex.worst = worstOf(ex.worst, w); }
      else siteEdgeMap.set(k, { a, b, count: 1, worst: w });
    }
  }

  if (!Number.isFinite(gMinX)) { gMinX = gMinY = 0; gMaxX = gMaxY = 100; }
  return {
    nodes: outNodes, nodeByKey, sites: outSites, edges: outEdges,
    siteEdges: [...siteEdgeMap.values()],
    bbox: { minX: gMinX, minY: gMinY, maxX: gMaxX, maxY: gMaxY },
  };
}

/** No-overlap / hairball diagnostics — used by the in-app debug hook + tests. */
export function layoutStats(layout: TopoLayout): {
  nodes: number; sites: number; minNodeDist: number; overlaps: number; maxLayer: number;
} {
  const ns = layout.nodes;
  let minDist = Infinity;
  let overlaps = 0;
  // Bucket into a grid to keep this O(n) rather than O(n²) at 500+ nodes.
  const CELL = NODE_GAP;
  const buckets = new Map<string, LayoutNode[]>();
  const bk = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  for (const n of ns) { const k = bk(n.x, n.y); (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(n); }
  for (const n of ns) {
    const cx = Math.floor(n.x / CELL), cy = Math.floor(n.y / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const m of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (m === n || m.key <= n.key) continue;
        const d = Math.hypot(n.x - m.x, n.y - m.y);
        minDist = Math.min(minDist, d);
        if (d < NODE_GAP * 0.5) overlaps++;
      }
    }
  }
  return {
    nodes: ns.length,
    sites: layout.sites.length,
    minNodeDist: Number.isFinite(minDist) ? Math.round(minDist * 10) / 10 : -1,
    overlaps,
    maxLayer: ns.reduce((m, n) => Math.max(m, n.layer), 0),
  };
}
