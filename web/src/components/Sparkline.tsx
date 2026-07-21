/**
 * Tiny single-series CPU trend (0–100%). Neutral ink so it never competes
 * with status colors; gaps where the device was down. 2px line per mark spec.
 */
export default function Sparkline({ points, width = 88, height = 22 }: {
  points: Array<number | null>;
  width?: number;
  height?: number;
}) {
  const known = points.filter((p): p is number => p !== null);
  if (known.length < 2) return null;

  const n = points.length;
  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * (width - 5) + 2.5);
  const y = (v: number) => height - 2.5 - (Math.min(Math.max(v, 0), 100) / 100) * (height - 5);

  const segments: string[][] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p === null) {
      if (current.length > 1) segments.push(current);
      current = [];
    } else {
      current.push(`${x(i).toFixed(1)},${y(p).toFixed(1)}`);
    }
  });
  if (current.length > 1) segments.push(current);

  let lastIdx = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (points[i] !== null) { lastIdx = i; break; }
  }

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={`CPU trend over last ${known.length} polls, latest ${points[lastIdx]}%`}
    >
      <title>{`CPU last ${known.length} polls · latest ${points[lastIdx]}%`}</title>
      {segments.map((seg, i) => (
        <polyline
          key={i}
          points={seg.join(' ')}
          fill="none"
          style={{ stroke: 'var(--color-fg-faint)' }}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {lastIdx >= 0 && (
        <circle cx={x(lastIdx)} cy={y(points[lastIdx]!)} r="2.5" style={{ fill: 'var(--color-fg-muted)' }} />
      )}
    </svg>
  );
}
