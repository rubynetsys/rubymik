/**
 * Health rules — simple and honest (documented in the README):
 *   down    → the most recent poll attempt failed
 *   warning → up, but CPU ≥ 85% or memory ≥ 90%
 *   up      → reachable, metrics under thresholds
 *   pending → added but not polled yet
 */

export const CPU_WARN_PCT = 85;
export const MEM_WARN_PCT = 90;

export type Health = 'up' | 'warning' | 'down' | 'pending';

export interface HealthInput {
  state: string | null;
  last_error: string | null;
  cpu_load: number | null;
  mem_total: number | null;
  mem_free: number | null;
}

export function computeHealth(row: HealthInput): { status: Health; reasons: string[] } {
  if (row.state === null) return { status: 'pending', reasons: ['Not polled yet'] };
  if (row.state === 'down') {
    return { status: 'down', reasons: [row.last_error ?? 'Unreachable'] };
  }
  const reasons: string[] = [];
  if (row.cpu_load !== null && row.cpu_load >= CPU_WARN_PCT) reasons.push(`High CPU (${row.cpu_load}%)`);
  const memUsedPct = row.mem_total && row.mem_free !== null
    ? ((row.mem_total - row.mem_free) / row.mem_total) * 100
    : null;
  if (memUsedPct !== null && memUsedPct >= MEM_WARN_PCT) reasons.push(`High memory (${memUsedPct.toFixed(0)}%)`);
  return reasons.length > 0 ? { status: 'warning', reasons } : { status: 'up', reasons: [] };
}
