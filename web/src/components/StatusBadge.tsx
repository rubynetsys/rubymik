import { CircleCheck, CircleDashed, CircleX, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react';
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
  up: { label: 'Up', Icon: CircleCheck, chip: 'bg-success-bg text-success-fg', dot: 'bg-success-strong' },
  warning: { label: 'Warning', Icon: TriangleAlert, chip: 'bg-warning-bg text-warning-fg', dot: 'bg-warning' },
  down: { label: 'Down', Icon: CircleX, chip: 'bg-danger-bg text-danger-fg', dot: 'bg-danger' },
  pending: { label: 'Pending', Icon: CircleDashed, chip: 'bg-app text-fg-dim', dot: 'bg-fg-faint' },
  rebooting: { label: 'Rebooting', Icon: RefreshCw, chip: 'bg-info-bg text-info-fg', dot: 'bg-info-fg' },
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
