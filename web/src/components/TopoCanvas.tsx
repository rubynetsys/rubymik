import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { LayoutNode, LayoutSite, TopoLayout } from '../topology/layout';

/**
 * Canvas 2D topology renderer. Canvas (not SVG) is the deliberate choice for
 * scale: 500 nodes × (shape + status dot + label) is thousands of SVG DOM nodes
 * and janky pan/zoom — the exact P3 failure. Canvas draws the whole scene in one
 * pass per frame, and we further cut work with level-of-detail (clusters when
 * zoomed out, nodes+labels when zoomed in) and viewport culling. The layout is
 * computed elsewhere (pure module) so this renderer is swappable.
 *
 * Theming: canvas can't use CSS classes, so we read the P12 semantic tokens off
 * a probe element via getComputedStyle and re-read on theme change — the map
 * renders correctly in all six themes, including Glass/dark.
 */

export interface TopoCanvasHandle {
  zoomToFit: (immediate?: boolean) => void;
  focusNode: (key: string) => void;
  focusSite: (key: string) => void;
}

interface Props {
  layout: TopoLayout;
  onNodeClick: (n: LayoutNode) => void;
  onSiteClick: (s: LayoutSite) => void;
  onHover: (n: LayoutNode | null, screen: { x: number; y: number } | null) => void;
  /** Keys to render at full opacity when a focus is active; others dim. null = no focus. */
  highlight: Set<string> | null;
  themeTick: number;
}

interface View { scale: number; tx: number; ty: number }

const CLUSTER_SCALE = 0.34;   // below → collapsed site clusters
const LABEL_SCALE = 0.85;     // above → per-node labels
const NODE_R = 13;            // world radius, managed
const DISC_R = 9;

type Health = 'up' | 'warning' | 'down' | 'pending';

interface Palette {
  surface: string; sunken: string; app: string;
  fg: string; fgDim: string; fgFaint: string; border: string; borderStrong: string;
  accent: string; accentText: string;
  up: string; warning: string; danger: string; pending: string;
}

function readPalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const v = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  return {
    surface: v('--color-surface', '#ffffff'),
    sunken: v('--color-sunken', '#f1f5f9'),
    app: v('--color-app', '#f8fafc'),
    fg: v('--color-fg', '#0f172a'),
    fgDim: v('--color-fg-dim', '#475569'),
    fgFaint: v('--color-fg-faint', '#94a3b8'),
    border: v('--color-border', '#e2e8f0'),
    borderStrong: v('--color-border-strong', '#cbd5e1'),
    accent: v('--color-accent', '#e11d48'),
    accentText: v('--color-accent-text', v('--color-accent', '#e11d48')),
    up: v('--color-success-strong', v('--color-success', '#16a34a')),
    warning: v('--color-warning', '#d97706'),
    danger: v('--color-danger', '#dc2626'),
    pending: v('--color-fg-faint', '#94a3b8'),
  };
}
const healthColor = (h: Health, p: Palette) => h === 'up' ? p.up : h === 'warning' ? p.warning : h === 'down' ? p.danger : p.pending;

const TopoCanvas = forwardRef<TopoCanvasHandle, Props>(function TopoCanvas(
  { layout, onNodeClick, onSiteClick, onHover, highlight, themeTick }, ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  const target = useRef<View | null>(null);      // tween target
  const raf = useRef(0);
  const size = useRef({ w: 960, h: 620 });
  const palette = useRef<Palette | null>(null);
  const hoverKey = useRef<string | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const [, setTick] = useState(0);

  const worldToScreen = (x: number, y: number) => ({ x: x * view.current.scale + view.current.tx, y: y * view.current.scale + view.current.ty });
  const screenToWorld = (x: number, y: number) => ({ x: (x - view.current.tx) / view.current.scale, y: (y - view.current.ty) / view.current.scale });

  const fitView = useCallback((immediate = false) => {
    const { minX, minY, maxX, maxY } = layout.bbox;
    const pad = 80;
    const w = size.current.w, h = size.current.h;
    const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
    const scale = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh, 2.2);
    const tx = w / 2 - ((minX + maxX) / 2) * scale;
    const ty = h / 2 - ((minY + maxY) / 2) * scale;
    const next = { scale, tx, ty };
    if (immediate) { view.current = next; target.current = null; requestDraw(); }
    else animateTo(next);
  }, [layout]);

  const animateTo = (next: View) => {
    target.current = next;
    if (!raf.current) raf.current = requestAnimationFrame(tweenStep);
  };
  const tweenStep = () => {
    raf.current = 0;
    const t = target.current;
    if (!t) return;
    const v = view.current;
    const k = 0.22;
    v.scale += (t.scale - v.scale) * k;
    v.tx += (t.tx - v.tx) * k;
    v.ty += (t.ty - v.ty) * k;
    const done = Math.abs(t.scale - v.scale) < 1e-3 && Math.abs(t.tx - v.tx) < 0.5 && Math.abs(t.ty - v.ty) < 0.5;
    if (done) { view.current = { ...t }; target.current = null; }
    draw();
    if (target.current) raf.current = requestAnimationFrame(tweenStep);
  };

  const requestDraw = () => { if (!raf.current && !target.current) draw(); };

  useImperativeHandle(ref, () => ({
    zoomToFit: (immediate) => fitView(immediate),
    focusNode: (key) => {
      const n = layout.nodeByKey.get(key);
      if (!n) return;
      const scale = Math.max(1.1, CLUSTER_SCALE + 0.7);
      animateTo({ scale, tx: size.current.w / 2 - n.x * scale, ty: size.current.h / 2 - n.y * scale });
    },
    focusSite: (key) => {
      const s = layout.sites.find((x) => x.key === key);
      if (!s) return;
      const pad = 60;
      const scale = Math.min((size.current.w - pad * 2) / Math.max(s.w, 1), (size.current.h - pad * 2) / Math.max(s.h, 1), 1.6);
      animateTo({ scale, tx: size.current.w / 2 - s.cx * scale, ty: size.current.h / 2 - s.cy * scale });
    },
  }), [layout, fitView]);

  // ---- draw ----
  const draw = useCallback(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    if (!palette.current) palette.current = readPalette(wrap);
    const p = palette.current;
    const dpr = window.devicePixelRatio || 1;
    const w = size.current.w, h = size.current.h;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = p.app; ctx.fillRect(0, 0, w, h);

    const sc = view.current.scale;
    const inView = (sx: number, sy: number, m: number) => sx >= -m && sx <= w + m && sy >= -m && sy <= h + m;
    const dimActive = highlight !== null;
    const isLit = (key: string) => highlight === null || highlight.has(key);

    if (sc < CLUSTER_SCALE) {
      // ---------- LOD: collapsed site clusters ----------
      ctx.lineWidth = 1.5;
      for (const se of layout.siteEdges) {
        const a = layout.sites.find((s) => s.key === se.a), b = layout.sites.find((s) => s.key === se.b);
        if (!a || !b) continue;
        const pa = worldToScreen(a.cx, a.cy), pb = worldToScreen(b.cx, b.cy);
        ctx.strokeStyle = p.accent; ctx.globalAlpha = 0.35;
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const s of layout.sites) {
        const c = worldToScreen(s.cx, s.cy);
        const r = Math.max(16, Math.min(46, s.r * Math.max(sc, 0.18) * 2.2));
        if (!inView(c.x, c.y, r + 40)) continue;
        ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.fillStyle = p.surface; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = healthColor(s.worst, p); ctx.stroke();
        ctx.fillStyle = p.fg; ctx.font = `600 ${Math.round(r * 0.72)}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(s.count), c.x, c.y);
        if (sc > 0.12) {
          ctx.font = '600 12px system-ui, sans-serif'; ctx.fillStyle = p.fgDim;
          ctx.fillText(s.name, c.x, c.y + r + 13);
          if (s.worst !== 'up' && s.worst !== 'pending') {
            ctx.fillStyle = healthColor(s.worst, p); ctx.font = '600 10px system-ui, sans-serif';
            ctx.fillText(`${s.worst === 'down' ? 'down' : 'warnings'}`, c.x, c.y + r + 27);
          }
        }
      }
    } else {
      // ---------- expanded: site cells, edges, nodes ----------
      // site cells
      for (const s of layout.sites) {
        const tl = worldToScreen(s.x, s.y);
        const sw = s.w * sc, sh = s.h * sc;
        if (!inView(tl.x + sw / 2, tl.y + sh / 2, Math.max(sw, sh) / 2 + 40)) continue;
        roundRect(ctx, tl.x, tl.y, sw, sh, 16);
        ctx.fillStyle = p.surface; ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 1; ctx.strokeStyle = p.border; ctx.stroke();
        // site header
        ctx.font = '700 12px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = p.fgDim;
        ctx.fillText(`${s.name} · ${s.count}`, tl.x + 12, tl.y + 20);
        if (s.worst === 'down' || s.worst === 'warning') {
          const label = `${s.worst === 'down' ? '● down' : '● warnings'}`;
          ctx.fillStyle = healthColor(s.worst, p); ctx.font = '600 11px system-ui, sans-serif';
          ctx.fillText(label, tl.x + 12, tl.y + 36);
        }
      }
      // edges
      for (const e of layout.edges) {
        const a = layout.nodeByKey.get(e.source), b = layout.nodeByKey.get(e.target);
        if (!a || !b) continue;
        const pa = worldToScreen(a.x, a.y), pb = worldToScreen(b.x, b.y);
        if (!inView((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, Math.abs(pa.x - pb.x) / 2 + Math.abs(pa.y - pb.y) / 2 + 30)) continue;
        const lit = !dimActive || (isLit(e.source) && isLit(e.target));
        ctx.globalAlpha = lit ? (e.crossSite ? 0.7 : 0.5) : 0.08;
        ctx.strokeStyle = e.crossSite ? p.accent : p.borderStrong;
        ctx.lineWidth = e.crossSite ? 2 : 1.2;
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // nodes
      const showLabels = sc >= LABEL_SCALE;
      for (const n of layout.nodes) {
        const s = worldToScreen(n.x, n.y);
        const managed = n.kind === 'managed';
        const r = (managed ? NODE_R : DISC_R) * sc;
        if (!inView(s.x, s.y, r + 30)) continue;
        const lit = isLit(n.key);
        ctx.globalAlpha = !dimActive || lit ? 1 : 0.12;
        ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(r, 2.5), 0, Math.PI * 2);
        ctx.fillStyle = managed ? p.surface : p.sunken; ctx.fill();
        if (managed) {
          ctx.lineWidth = Math.max(1.5, 2.6 * sc); ctx.strokeStyle = healthColor(n.status, p);
          ctx.setLineDash([]); ctx.stroke();
        } else {
          ctx.lineWidth = Math.max(1, 1.4 * sc); ctx.strokeStyle = p.fgFaint;
          ctx.setLineDash([3 * sc, 2.5 * sc]); ctx.stroke(); ctx.setLineDash([]);
        }
        if (hoverKey.current === n.key) {
          ctx.lineWidth = 2; ctx.strokeStyle = p.accent; ctx.beginPath();
          ctx.arc(s.x, s.y, Math.max(r, 2.5) + 3, 0, Math.PI * 2); ctx.stroke();
        }
        if (showLabels && (!dimActive || lit)) {
          const label = n.name.length > 20 ? n.name.slice(0, 19) + '…' : n.name;
          ctx.font = `${managed ? 600 : 500} 11px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.lineWidth = 3; ctx.strokeStyle = p.app; ctx.globalAlpha = (!dimActive || lit ? 1 : 0.12) * 0.9;
          ctx.strokeText(label, s.x, s.y + r + 3);
          ctx.fillStyle = managed ? p.fg : p.fgFaint;
          ctx.fillText(label, s.x, s.y + r + 3);
        }
      }
      ctx.globalAlpha = 1;
    }
  }, [layout, highlight]);

  // redraw when layout/highlight/theme change
  useEffect(() => { palette.current = null; requestDraw(); /* eslint-disable-next-line */ }, [themeTick]);
  useEffect(() => { requestDraw(); /* eslint-disable-next-line */ }, [layout, highlight]);

  // theme changes on <html> → re-read palette
  useEffect(() => {
    const obs = new MutationObserver(() => { palette.current = null; requestDraw(); });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] });
    return () => obs.disconnect();
    // eslint-disable-next-line
  }, []);

  // sizing + DPR
  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const apply = () => {
      const rect = wrap.getBoundingClientRect();
      size.current = { w: rect.width, h: rect.height };
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      draw();
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  // fit whenever the node set identity changes (not on every live refresh)
  const fitKey = layout.nodes.length + '/' + layout.sites.length;
  useEffect(() => { fitView(true); /* eslint-disable-next-line */ }, [fitKey]);

  // ---- interaction ----
  const pick = (mx: number, my: number): LayoutNode | null => {
    if (view.current.scale < CLUSTER_SCALE) return null;
    let best: LayoutNode | null = null, bestD = Infinity;
    for (const n of layout.nodes) {
      const s = worldToScreen(n.x, n.y);
      const r = (n.kind === 'managed' ? NODE_R : DISC_R) * view.current.scale + 6;
      const d = Math.hypot(s.x - mx, s.y - my);
      if (d < r && d < bestD) { best = n; bestD = d; }
    }
    return best;
  };
  const pickSite = (mx: number, my: number): LayoutSite | null => {
    if (view.current.scale >= CLUSTER_SCALE) return null;
    for (const s of layout.sites) {
      const c = worldToScreen(s.cx, s.cy);
      const r = Math.max(16, Math.min(46, s.r * Math.max(view.current.scale, 0.18) * 2.2));
      if (Math.hypot(c.x - mx, c.y - my) < r) return s;
    }
    return null;
  };

  const relative = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const m = relative(e);
    drag.current = { x: m.x, y: m.y, tx: view.current.tx, ty: view.current.ty, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const m = relative(e);
    if (drag.current) {
      const dx = m.x - drag.current.x, dy = m.y - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
      view.current.tx = drag.current.tx + dx;
      view.current.ty = drag.current.ty + dy;
      target.current = null;
      draw();
      return;
    }
    const n = pick(m.x, m.y);
    const key = n?.key ?? null;
    if (key !== hoverKey.current) {
      hoverKey.current = key;
      onHover(n, n ? { x: m.x, y: m.y } : null);
      draw();
    } else if (n) {
      onHover(n, { x: m.x, y: m.y });
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null;
    if (!d || d.moved) return;
    const m = relative(e);
    const n = pick(m.x, m.y);
    if (n) { onNodeClick(n); return; }
    const s = pickSite(m.x, m.y);
    if (s) onSiteClick(s);
  };
  const onWheel = (e: React.WheelEvent) => {
    const m = relative(e);
    const wpt = screenToWorld(m.x, m.y);
    const factor = e.deltaY > 0 ? 1 / 1.14 : 1.14;
    const scale = Math.min(Math.max(view.current.scale * factor, 0.04), 4);
    view.current.scale = scale;
    view.current.tx = m.x - wpt.x * scale;
    view.current.ty = m.y - wpt.y * scale;
    target.current = null;
    draw();
    setTick((t) => t + 1); // surface scale to overlay (zoom indicator)
  };

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <div ref={wrapRef} className="relative h-[640px] w-full overflow-hidden rounded-xl">
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { hoverKey.current = null; onHover(null, null); draw(); }}
        onWheel={onWheel}
        role="img"
        aria-label="Network topology map"
      />
      <div className="pointer-events-none absolute bottom-2 right-3 text-[10px] font-medium text-fg-faint">
        {view.current.scale < CLUSTER_SCALE ? 'Fleet view — click a site to expand' : view.current.scale < LABEL_SCALE ? 'Zoom in for labels' : ''}
      </div>
    </div>
  );
});

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export default TopoCanvas;
