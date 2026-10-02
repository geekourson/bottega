/**
 * TaskStatusPill.tsx - compact task status label (multi-repo epics extra).
 */

import { cn } from '../../lib/utils';
import type { TaskStatus } from '../../../shared/types/db';

const STATUS_STYLES: Record<TaskStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-gray-500/10 text-gray-600 dark:text-gray-400' },
  in_progress: { label: 'In Progress', className: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400' },
  in_review: { label: 'In Review', className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  completed: { label: 'Completed', className: 'bg-green-500/10 text-green-600 dark:text-green-400' },
};

export default function TaskStatusPill({ status, className }: { status: TaskStatus; className?: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.pending;
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap', style.className, className)}>
      {style.label}
    </span>
  );
}
