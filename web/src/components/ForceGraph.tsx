import { useEffect, useRef, useState } from 'react';
import { Network, Router as RouterIcon } from 'lucide-react';

/**
 * Hand-rolled force-directed graph (SVG, zero deps). Small-fleet scale:
 * O(n²) repulsion is fine for the node counts a topology map sees.
 * Positions persist across data refreshes so live status updates don't
 * reshuffle the layout.
 */

export interface GraphNode {
  key: string;
  kind: 'managed' | 'discovered';
  label: string;
  sub?: string | null;
  status?: 'up' | 'warning' | 'down' | 'pending';
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  up: 'var(--color-success-strong)',
  warning: 'var(--color-warning)',
  down: 'var(--color-danger)',
  pending: 'var(--color-fg-faint)',
};

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dragging?: boolean;
}

const W = 960;
const H = 600;

export default function ForceGraph({ nodes, edges, onNodeClick, tooltip }: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (node: GraphNode) => void;
  tooltip: (node: GraphNode) => React.ReactNode;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const bodies = useRef(new Map<string, Body>());
  const alpha = useRef(1);
  const raf = useRef(0);
  const [, setTick] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, w: W, h: H });
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ mode: 'pan' | 'node'; key?: string; startX: number; startY: number; viewX: number; viewY: number } | null>(null);

  // Seed/prune bodies when the node set changes; keep existing positions.
  useEffect(() => {
    const known = new Set(nodes.map((n) => n.key));
    for (const key of [...bodies.current.keys()]) {
      if (!known.has(key)) bodies.current.delete(key);
    }
    let added = 0;
    nodes.forEach((n, i) => {
      if (!bodies.current.has(n.key)) {
        const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
        bodies.current.set(n.key, {
          x: W / 2 + Math.cos(angle) * 120,
          y: H / 2 + Math.sin(angle) * 120,
          vx: 0,
          vy: 0,
        });
        added++;
      }
    });
    alpha.current = added > 0 || bodies.current.size <= 1 ? 1 : Math.max(alpha.current, 0.1);
  }, [nodes]);

  // Simulation loop.
  useEffect(() => {
    const step = () => {
      const bs = bodies.current;
      if (alpha.current > 0.015) {
        const arr = [...bs.entries()];
        // pairwise repulsion
        for (let i = 0; i < arr.length; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            const [, a] = arr[i]!;
            const [, b] = arr[j]!;
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            const d2 = Math.max(dx * dx + dy * dy, 64);
            const f = (14000 / d2) * alpha.current;
            const d = Math.sqrt(d2);
            dx /= d; dy /= d;
            if (!a.dragging) { a.vx += dx * f; a.vy += dy * f; }
            if (!b.dragging) { b.vx -= dx * f; b.vy -= dy * f; }
          }
        }
        // springs
        for (const e of edges) {
          const a = bs.get(e.source);
          const b = bs.get(e.target);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const f = ((d - 170) / d) * 0.06 * alpha.current * 10;
          if (!a.dragging) { a.vx += dx * f; a.vy += dy * f; }
          if (!b.dragging) { b.vx -= dx * f; b.vy -= dy * f; }
        }
        // gravity to center + integrate
        for (const [, b] of arr) {
          if (b.dragging) continue;
          b.vx += (W / 2 - b.x) * 0.012 * alpha.current;
          b.vy += (H / 2 - b.y) * 0.012 * alpha.current;
          b.vx *= 0.82;
          b.vy *= 0.82;
          b.x += b.vx;
          b.y += b.vy;
        }
        alpha.current *= 0.97;
        setTick((t) => t + 1);
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [edges]);

  function toWorld(e: { clientX: number; clientY: number }) {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: view.x + ((e.clientX - rect.left) / rect.width) * view.w,
      y: view.y + ((e.clientY - rect.top) / rect.height) * view.h,
    };
  }

  function onWheel(e: React.WheelEvent) {
    const p = toWorld(e);
    const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    const w = Math.min(Math.max(view.w * factor, 240), 3200);
    const h = w * (H / W);
    setView({
      x: p.x - ((p.x - view.x) / view.w) * w,
      y: p.y - ((p.y - view.y) / view.h) * h,
      w,
      h,
    });
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y };
  }

  function onNodePointerDown(e: React.PointerEvent, key: string) {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const b = bodies.current.get(key);
    if (b) b.dragging = true;
    drag.current = { mode: 'node', key, startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'pan') {
      const rect = svgRef.current!.getBoundingClientRect();
      setView((v) => ({
        ...v,
        x: d.viewX - ((e.clientX - d.startX) / rect.width) * v.w,
        y: d.viewY - ((e.clientY - d.startY) / rect.height) * v.h,
      }));
    } else if (d.key) {
      const b = bodies.current.get(d.key);
      if (b) {
        const p = toWorld(e);
        b.x = p.x;
        b.y = p.y;
        alpha.current = Math.max(alpha.current, 0.25);
        setTick((t) => t + 1);
      }
    }
  }

  function onPointerUp() {
    if (drag.current?.mode === 'node' && drag.current.key) {
      const b = bodies.current.get(drag.current.key);
      if (b) b.dragging = false;
    }
    drag.current = null;
  }

  const moved = useRef(false);

  const hoverNode = hover !== null ? nodes.find((n) => n.key === hover) : undefined;
  const hoverBody = hover !== null ? bodies.current.get(hover) : undefined;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className="h-[600px] w-full cursor-grab rounded-xl bg-surface active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="img"
        aria-label="Network topology map"
      >
        {/* edges */}
        {edges.map((e) => {
          const a = bodies.current.get(e.source);
          const b = bodies.current.get(e.target);
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g key={`${e.source}~${e.target}`}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-border-strong)" strokeWidth="1.5" />
              {e.label && (
                <text
                  x={mx} y={my - 5} textAnchor="middle" fontSize="9.5" fill="var(--color-fg-dim)"
                  stroke="var(--color-surface)" strokeWidth="3" paintOrder="stroke"
                >
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {/* nodes */}
        {nodes.map((n) => {
          const b = bodies.current.get(n.key);
          if (!b) return null;
          const managed = n.kind === 'managed';
          const r = managed ? 27 : 22;
          const ring = managed ? STATUS_COLOR[n.status ?? 'pending'] : 'var(--color-fg-faint)';
          return (
            <g
              key={n.key}
              transform={`translate(${b.x}, ${b.y})`}
              className="cursor-pointer"
              onPointerDown={(e) => { moved.current = false; onNodePointerDown(e, n.key); }}
              onPointerMove={() => { if (drag.current?.mode === 'node') moved.current = true; }}
              onClick={() => { if (!moved.current) onNodeClick(n); }}
              onMouseEnter={() => setHover(n.key)}
              onMouseLeave={() => setHover(null)}
            >
              <circle
                r={r}
                fill={managed ? 'var(--color-surface)' : 'var(--color-sunken)'}
                stroke={ring}
                strokeWidth={managed ? 3 : 1.8}
                strokeDasharray={managed ? undefined : '5 4'}
              />
              {managed
                ? <RouterIcon x={-11} y={-11} width={22} height={22} color="var(--color-fg-body)" strokeWidth={1.8} />
                : <Network x={-9} y={-9} width={18} height={18} color="var(--color-fg-faint)" strokeWidth={1.8} />}
              {managed && n.status && (
                <circle cx={r * 0.72} cy={-r * 0.72} r={5.5} fill={STATUS_COLOR[n.status]} stroke="var(--color-surface)" strokeWidth="2" />
              )}
              <text y={r + 15} textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--color-fg)"
                stroke="var(--color-surface)" strokeWidth="3.5" paintOrder="stroke">
                {n.label}
              </text>
              {n.sub && (
                <text y={r + 28} textAnchor="middle" fontSize="9.5" fill="var(--color-fg-dim)"
                  stroke="var(--color-surface)" strokeWidth="3" paintOrder="stroke">
                  {n.sub}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hoverNode && hoverBody && (
        <div
          className="pointer-events-none absolute z-10 w-56 rounded-xl border border-border bg-surface p-3 shadow-lg"
          style={{
            left: `${(((hoverBody.x - view.x) / view.w) * 100).toFixed(2)}%`,
            top: `calc(${(((hoverBody.y - view.y) / view.h) * 100).toFixed(2)}% + 36px)`,
            transform: 'translateX(-50%)',
          }}
        >
          {tooltip(hoverNode)}
        </div>
      )}
    </div>
  );
}
