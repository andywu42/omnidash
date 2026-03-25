/**
 * StalenessIndicator Component (OMN-6397)
 *
 * Displays "Last updated N minutes/hours/days ago" with visual severity
 * based on data freshness. Follows Carbon Design System conventions
 * (IBM Plex, density-first).
 *
 * Severity thresholds:
 * - green  (<1h)   : fresh
 * - yellow (1-6h)  : aging
 * - orange (6-24h) : stale
 * - red    (>24h)  : critical
 */

import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getStaleSeverity, formatAge, type StalenessSeverity } from '@shared/staleness-types';

interface StalenessIndicatorProps {
  /** ISO timestamp of last data update, or null if never updated */
  lastUpdated: string | null | undefined;
  /** Optional label prefix (e.g., "Patterns") */
  label?: string;
  /** Additional CSS classes */
  className?: string;
}

const SEVERITY_STYLES: Record<
  StalenessSeverity,
  { bg: string; text: string; icon: string; dot: string }
> = {
  fresh: {
    bg: 'bg-green-50 dark:bg-green-950/30',
    text: 'text-green-700 dark:text-green-400',
    icon: 'text-green-500 dark:text-green-500',
    dot: 'bg-green-500',
  },
  aging: {
    bg: 'bg-yellow-50 dark:bg-yellow-950/30',
    text: 'text-yellow-700 dark:text-yellow-400',
    icon: 'text-yellow-500 dark:text-yellow-500',
    dot: 'bg-yellow-500',
  },
  stale: {
    bg: 'bg-orange-50 dark:bg-orange-950/30',
    text: 'text-orange-700 dark:text-orange-400',
    icon: 'text-orange-500 dark:text-orange-500',
    dot: 'bg-orange-500',
  },
  critical: {
    bg: 'bg-red-50 dark:bg-red-950/30',
    text: 'text-red-700 dark:text-red-400',
    icon: 'text-red-500 dark:text-red-500',
    dot: 'bg-red-500',
  },
};

export function StalenessIndicator({ lastUpdated, label, className }: StalenessIndicatorProps) {
  const severity = getStaleSeverity(lastUpdated);
  const ageText = formatAge(lastUpdated);
  const style = SEVERITY_STYLES[severity];

  const exactTime = lastUpdated ? new Date(lastUpdated).toLocaleString() : 'No data received';

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium',
        style.bg,
        style.text,
        className
      )}
      title={`Last updated: ${exactTime}`}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
      <Clock className={cn('h-3 w-3', style.icon)} />
      <span>
        {label ? `${label}: ` : ''}
        {ageText}
      </span>
    </div>
  );
}
