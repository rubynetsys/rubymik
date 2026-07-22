import { useMemo, useRef, useState } from 'react';

/**
 * CPU% + Memory% over time. Two series on ONE fixed 0–100% axis; series colors
 * validated for CVD separation and surface contrast; identity is carried by the
 * legend + direct end labels, never color alone. Gaps (device down) break the line.
 */
export interface MetricPoint { t: string; cpu: number | null; mem: number | null }

const CPU_COLOR = 'var(--color-accent-hover)';
const MEM_COLOR = 'var(--color-info-2)';

const W = 720;
const H = 200;
const PAD = { top: 14, right: 40, bottom: 24, left: 40 };

export default function MetricChart({ points }: { points: MetricPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const model = useMemo(() => {
    const known = points.filter((p) => p.cpu !== null || p.mem !== null);
    if (known.length < 2) return null;
    const t0 = Date.parse(points[0]!.t);
    const t1 = Date.parse(points[points.length - 1]!.t);
    if (!(t1 > t0)) return null;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - Math.min(Math.max(v, 0), 100) / 100) * (H - PAD.top - PAD.bottom);
    const seg = (key: 'cpu' | 'mem'): string[][] => {
      const segs: string[][] = [];
      let cur: string[] = [];
      for (const p of points) {
        const v = p[key];
        if (v === null) { if (cur.length > 1) segs.push(cur); cur = []; }
        else cur.push(`${x(Date.parse(p.t)).toFixed(1)},${y(v).toFixed(1)}`);
      }
      if (cur.length > 1) segs.push(cur);
      return segs;
    };
    const ticksY = [0, 25, 50, 75, 100].map((v) => ({ v, py: y(v) }));
    const ticksX = Array.from({ length: 5 }, (_, i) => { const t = t0 + ((t1 - t0) * i) / 4; return { t, px: x(t) }; });
    const lastCpu = [...points].reverse().find((p) => p.cpu !== null);
    const lastMem = [...points].reverse().find((p) => p.mem !== null);
    return { t0, t1, x, y, cpuSegs: seg('cpu'), memSegs: seg('mem'), ticksY, ticksX, lastCpu, lastMem };
  }, [points]);

  if (!model) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg bg-sunken text-sm text-fg-dim">
        Collecting samples… the graph appears after a few poll cycles.
      </div>
    );
  }

  const { x, y, cpuSegs, memSegs, ticksY, ticksX } = model;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best: number | null = null; let bestDist = Infinity;
    points.forEach((p, i) => { const d = Math.abs(x(Date.parse(p.t)) - px); if (d < bestDist) { bestDist = d; best = i; } });
    setHover(best);
  }

  const hoverPt = hover !== null ? points[hover] : undefined;
  const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);

  return (
    <div className="relative">
      <div className="mb-2 flex items-center gap-4 text-xs font-medium text-fg-muted">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: CPU_COLOR }} /> CPU</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: MEM_COLOR }} /> Memory</span>
        {hoverPt && (
          <span className="ml-auto tabular-nums text-fg-dim">
            {fmtTime(Date.parse(hoverPt.t))} · CPU {pct(hoverPt.cpu)} · Mem {pct(hoverPt.mem)}
          </span>
        )}
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        role="img" aria-label="CPU and memory utilisation over time, in percent">
        {ticksY.map(({ v, py }) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={py} y2={py} stroke="var(--color-app)" strokeWidth="1" />
            <text x={PAD.left - 6} y={py + 3} textAnchor="end" fontSize="10" fill="var(--color-fg-faint)">{v}</text>
          </g>
        ))}
        {ticksX.map(({ t, px }) => (
          <text key={t} x={px} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--color-fg-faint)">{fmtTime(t)}</text>
        ))}
        {cpuSegs.map((s, i) => (
          <polyline key={`c${i}`} points={s.join(' ')} fill="none" stroke={CPU_COLOR} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {memSegs.map((s, i) => (
          <polyline key={`m${i}`} points={s.join(' ')} fill="none" stroke={MEM_COLOR} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {model.lastCpu && <text x={W - PAD.right + 4} y={y(model.lastCpu.cpu!) + 3} fontSize="10" fontWeight="600" fill={CPU_COLOR}>CPU</text>}
        {model.lastMem && <text x={W - PAD.right + 4} y={y(model.lastMem.mem!) + 3} fontSize="10" fontWeight="600" fill={MEM_COLOR}>Mem</text>}
        {hoverPt && (
          <g pointerEvents="none">
            <line x1={x(Date.parse(hoverPt.t))} x2={x(Date.parse(hoverPt.t))} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--color-border-strong)" strokeWidth="1" />
            {hoverPt.cpu !== null && <circle cx={x(Date.parse(hoverPt.t))} cy={y(hoverPt.cpu)} r="3.5" fill={CPU_COLOR} stroke="var(--color-surface)" strokeWidth="1.5" />}
            {hoverPt.mem !== null && <circle cx={x(Date.parse(hoverPt.t))} cy={y(hoverPt.mem)} r="3.5" fill={MEM_COLOR} stroke="var(--color-surface)" strokeWidth="1.5" />}
          </g>
        )}
      </svg>
    </div>
  );
}
