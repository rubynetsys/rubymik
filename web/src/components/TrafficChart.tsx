import { useMemo, useRef, useState } from 'react';
import { fmtRate, type TrafficPoint } from '../types';

/**
 * RX/TX rate over time. Two series, ONE axis; series colors validated for
 * CVD separation and surface contrast (#0284c7 / #e91e63); identity is
 * carried by the legend + direct end labels, not color alone.
 */
const RX_COLOR = '#0284c7';
const TX_COLOR = '#e91e63';

const W = 720;
const H = 220;
const PAD = { top: 14, right: 44, bottom: 24, left: 68 };

/** Compact axis-tick rate label (no decimals — "150 Mbps", "2 Kbps"). */
function fmtTick(bps: number): string {
  if (bps < 1000) return `${Math.round(bps)} bps`;
  if (bps < 1e6) return `${Math.round(bps / 1e3)} Kbps`;
  if (bps < 1e9) return `${Math.round(bps / 1e6)} Mbps`;
  return `${(bps / 1e9).toFixed(1)} Gbps`;
}

function niceCeil(v: number): number {
  if (v <= 0) return 1000;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) {
    if (v <= m * mag) return m * mag;
  }
  return 10 * mag;
}

export default function TrafficChart({ points }: { points: TrafficPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const model = useMemo(() => {
    const known = points.filter((p) => p.rx !== null || p.tx !== null);
    if (known.length < 2) return null;
    const t0 = Date.parse(points[0]!.t);
    const t1 = Date.parse(points[points.length - 1]!.t);
    if (!(t1 > t0)) return null;
    const yMax = niceCeil(Math.max(...known.map((p) => Math.max(p.rx ?? 0, p.tx ?? 0)), 1000));
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - Math.min(v, yMax) / yMax) * (H - PAD.top - PAD.bottom);
    const seg = (key: 'rx' | 'tx'): string[][] => {
      const segs: string[][] = [];
      let cur: string[] = [];
      for (const p of points) {
        const v = p[key];
        if (v === null) {
          if (cur.length > 1) segs.push(cur);
          cur = [];
        } else {
          cur.push(`${x(Date.parse(p.t)).toFixed(1)},${y(v).toFixed(1)}`);
        }
      }
      if (cur.length > 1) segs.push(cur);
      return segs;
    };
    const ticksY = [0.25, 0.5, 0.75, 1].map((f) => ({ v: yMax * f, py: y(yMax * f) }));
    const tickCount = 4;
    const ticksX = Array.from({ length: tickCount + 1 }, (_, i) => {
      const t = t0 + ((t1 - t0) * i) / tickCount;
      return { t, px: x(t) };
    });
    const lastRx = [...points].reverse().find((p) => p.rx !== null);
    const lastTx = [...points].reverse().find((p) => p.tx !== null);
    return { t0, t1, yMax, x, y, rxSegs: seg('rx'), txSegs: seg('tx'), ticksY, ticksX, lastRx, lastTx };
  }, [points]);

  if (!model) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg bg-zinc-50 text-sm text-zinc-500">
        Collecting samples… the graph appears after a few poll cycles.
      </div>
    );
  }

  const { x, y, rxSegs, txSegs, ticksY, ticksX } = model;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best: number | null = null;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(x(Date.parse(p.t)) - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    setHover(best);
  }

  const hoverPt = hover !== null ? points[hover] : undefined;
  const fmtTime = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="relative">
      <div className="mb-2 flex items-center gap-4 text-xs font-medium text-zinc-600">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: RX_COLOR }} /> RX (download)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: TX_COLOR }} /> TX (upload)
        </span>
        {hoverPt && (
          <span className="ml-auto tabular-nums text-zinc-500">
            {fmtTime(Date.parse(hoverPt.t))} · RX {fmtRate(hoverPt.rx)} · TX {fmtRate(hoverPt.tx)}
          </span>
        )}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Interface traffic over time, RX and TX in bits per second"
      >
        {/* recessive grid + y labels */}
        {ticksY.map(({ v, py }) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={py} y2={py} stroke="#f4f4f5" strokeWidth="1" />
            <text x={PAD.left - 8} y={py + 3} textAnchor="end" fontSize="10" fill="#a1a1aa">
              {fmtTick(v)}
            </text>
          </g>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke="#e4e4e7" strokeWidth="1" />
        {ticksX.map(({ t, px }) => (
          <text key={t} x={px} y={H - 8} textAnchor="middle" fontSize="10" fill="#a1a1aa">
            {fmtTime(t)}
          </text>
        ))}
        {/* series */}
        {rxSegs.map((s, i) => (
          <polyline key={`rx${i}`} points={s.join(' ')} fill="none" stroke={RX_COLOR} strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {txSegs.map((s, i) => (
          <polyline key={`tx${i}`} points={s.join(' ')} fill="none" stroke={TX_COLOR} strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {/* direct end labels — nudged apart when the lines converge */}
        {model.lastRx && model.lastTx && (() => {
          let yRx = y(model.lastRx.rx!) + 3;
          let yTx = y(model.lastTx.tx!) + 3;
          if (Math.abs(yRx - yTx) < 11) {
            const mid = (yRx + yTx) / 2;
            if (yRx <= yTx) {
              yRx = mid - 5.5;
              yTx = mid + 5.5;
            } else {
              yTx = mid - 5.5;
              yRx = mid + 5.5;
            }
          }
          return (
            <>
              <text x={W - PAD.right + 4} y={yRx} fontSize="10" fontWeight="600" fill={RX_COLOR}>RX</text>
              <text x={W - PAD.right + 4} y={yTx} fontSize="10" fontWeight="600" fill={TX_COLOR}>TX</text>
            </>
          );
        })()}
        {model.lastRx && !model.lastTx && (
          <text x={W - PAD.right + 4} y={y(model.lastRx.rx!) + 3} fontSize="10" fontWeight="600" fill={RX_COLOR}>RX</text>
        )}
        {!model.lastRx && model.lastTx && (
          <text x={W - PAD.right + 4} y={y(model.lastTx.tx!) + 3} fontSize="10" fontWeight="600" fill={TX_COLOR}>TX</text>
        )}
        {/* hover crosshair */}
        {hoverPt && (
          <g pointerEvents="none">
            <line
              x1={x(Date.parse(hoverPt.t))} x2={x(Date.parse(hoverPt.t))}
              y1={PAD.top} y2={H - PAD.bottom} stroke="#d4d4d8" strokeWidth="1"
            />
            {hoverPt.rx !== null && (
              <circle cx={x(Date.parse(hoverPt.t))} cy={y(hoverPt.rx)} r="3.5" fill={RX_COLOR} stroke="#fff" strokeWidth="1.5" />
            )}
            {hoverPt.tx !== null && (
              <circle cx={x(Date.parse(hoverPt.t))} cy={y(hoverPt.tx)} r="3.5" fill={TX_COLOR} stroke="#fff" strokeWidth="1.5" />
            )}
          </g>
        )}
      </svg>
    </div>
  );
}
