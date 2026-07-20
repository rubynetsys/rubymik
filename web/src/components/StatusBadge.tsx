import { CircleCheck, CircleDashed, CircleX, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { HealthStatus } from '../types';

/**
 * Status is never conveyed by color alone: every indicator is icon + label
 * (palette CVD-validated; pending is intentionally gray).
 */
export const STATUS_META: Record<HealthStatus, {
  label: string;
  Icon: LucideIcon;
  chip: string;
  dot: string;
}> = {
  up: { label: 'Up', Icon: CircleCheck, chip: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  warning: { label: 'Warning', Icon: TriangleAlert, chip: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  down: { label: 'Down', Icon: CircleX, chip: 'bg-red-50 text-red-700', dot: 'bg-red-600' },
  pending: { label: 'Pending', Icon: CircleDashed, chip: 'bg-zinc-100 text-zinc-500', dot: 'bg-zinc-400' },
};

export default function StatusBadge({ status }: { status: HealthStatus }) {
  const { label, Icon, chip } = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${chip}`}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}
