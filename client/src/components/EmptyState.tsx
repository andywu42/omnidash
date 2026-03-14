/**
 * EmptyState Component
 *
 * Displays a helpful empty state message when there's no data to show.
 * Used for both "no data registered" and "no filter results" scenarios.
 *
 * Part of OMN-1278: Contract-Driven Dashboard - Registry Discovery (Phase 5)
 */

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Database,
  Filter,
  Search,
  Server,
  AlertCircle,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';

export type EmptyStateVariant = 'no-data' | 'no-results' | 'error' | 'loading';

export interface EmptyStateProps {
  /**
   * The variant determines the default icon and messaging
   */
  variant?: EmptyStateVariant;

  /**
   * Custom icon to display
   */
  icon?: LucideIcon;

  /**
   * Title text
   */
  title?: string;

  /**
   * Description text
   */
  description?: string;

  /**
   * Primary action button
   */
  action?: {
    label: string;
    onClick: () => void;
    icon?: LucideIcon;
  };

  /**
   * Secondary action button
   */
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };

  /**
   * Additional CSS classes
   */
  className?: string;

  /**
   * Size variant
   * @default 'default'
   */
  size?: 'sm' | 'default' | 'lg';
}

// Default configurations for each variant
const VARIANT_CONFIGS: Record<
  EmptyStateVariant,
  { icon: LucideIcon; title: string; description: string }
> = {
  'no-data': {
    icon: Database,
    title: 'No nodes registered',
    description: 'Register nodes to the discovery service to see them appear here.',
  },
  'no-results': {
    icon: Search,
    title: 'No matching results',
    description: "Try adjusting your filters or search terms to find what you're looking for.",
  },
  error: {
    icon: AlertCircle,
    title: 'Unable to load data',
    description: 'There was an error fetching the data. Please try again.',
  },
  loading: {
    icon: Server,
    title: 'Loading...',
    description: 'Fetching node registry data.',
  },
};

/**
 * EmptyState displays a centered message with icon when there's no content to show.
 *
 * @example No data state
 * ```tsx
 * <EmptyState
 *   variant="no-data"
 *   action={{ label: 'Register Node', onClick: handleRegister }}
 * />
 * ```
 *
 * @example No filter results
 * ```tsx
 * <EmptyState
 *   variant="no-results"
 *   action={{ label: 'Clear Filters', onClick: clearFilters, icon: Filter }}
 * />
 * ```
 *
 * @example Custom configuration
 * ```tsx
 * <EmptyState
 *   icon={Server}
 *   title="No servers found"
 *   description="Add servers to your network to monitor them."
 *   action={{ label: 'Add Server', onClick: handleAdd }}
 * />
 * ```
 */
export function EmptyState({
  variant = 'no-data',
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
  size = 'default',
}: EmptyStateProps) {
  const config = VARIANT_CONFIGS[variant];
  const Icon = icon || config.icon;
  const displayTitle = title || config.title;
  const displayDescription = description || config.description;

  // Size-based styling
  const sizeClasses = {
    sm: {
      container: 'py-8',
      icon: 'h-8 w-8',
      title: 'text-sm',
      description: 'text-xs',
    },
    default: {
      container: 'py-12',
      icon: 'h-12 w-12',
      title: 'text-base',
      description: 'text-sm',
    },
    lg: {
      container: 'py-16',
      icon: 'h-16 w-16',
      title: 'text-lg',
      description: 'text-base',
    },
  };

  const sizes = sizeClasses[size];

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        sizes.container,
        className
      )}
    >
      {/* Icon with subtle background */}
      <div className="rounded-full bg-muted/50 p-4 mb-4">
        <Icon className={cn(sizes.icon, 'text-muted-foreground')} />
      </div>

      {/* Title */}
      <h3 className={cn('font-medium text-foreground mb-1', sizes.title)}>{displayTitle}</h3>

      {/* Description */}
      <p className={cn('text-muted-foreground max-w-sm mb-4', sizes.description)}>
        {displayDescription}
      </p>

      {/* Actions */}
      {(action || secondaryAction) && (
        <div className="flex items-center gap-3">
          {action && (
            <Button
              onClick={action.onClick}
              size={size === 'sm' ? 'sm' : 'default'}
              className="gap-2"
            >
              {action.icon && <action.icon className="h-4 w-4" />}
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <Button
              variant="ghost"
              onClick={secondaryAction.onClick}
              size={size === 'sm' ? 'sm' : 'default'}
            >
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Specialized empty state for registry-specific scenarios
 */
export function RegistryEmptyState({
  hasFilters,
  onClearFilters,
  onRefresh,
  className,
}: {
  hasFilters: boolean;
  onClearFilters?: () => void;
  onRefresh?: () => void;
  className?: string;
}) {
  if (hasFilters) {
    return (
      <EmptyState
        variant="no-results"
        icon={Filter}
        title="No nodes match your filters"
        description="Try adjusting your filter criteria or clear all filters to see all registered nodes."
        action={
          onClearFilters
            ? { label: 'Clear Filters', onClick: onClearFilters, icon: Filter }
            : undefined
        }
        secondaryAction={onRefresh ? { label: 'Refresh', onClick: onRefresh } : undefined}
        className={className}
      />
    );
  }

  return (
    <EmptyState
      variant="no-data"
      icon={Server}
      title="No nodes registered yet"
      description="This dashboard auto-configures based on registered nodes. Once nodes are registered with the discovery service, they will appear here automatically."
      action={onRefresh ? { label: 'Refresh', onClick: onRefresh, icon: RefreshCw } : undefined}
      className={className}
    />
  );
}

/**
 * DataSourceEmptyState — Shown when a page has no data because its upstream
 * producer has not yet run (OMN-4969). Includes data-testid="empty-state"
 * for automated verification.
 */
export function DataSourceEmptyState({
  sourceName,
  producerName,
  instructions,
  className,
}: {
  /** Human-readable name of the data source (e.g., "Epic Pipeline Events") */
  sourceName: string;
  /** Name of the skill or service that produces the data */
  producerName: string;
  /** Brief instruction for how to populate the page */
  instructions: string;
  className?: string;
}) {
  return (
    <div data-testid="empty-state">
      <EmptyState
        variant="no-data"
        title={`No ${sourceName} data yet`}
        description={`Producer: ${producerName}. ${instructions}`}
        className={className}
      />
    </div>
  );
}

export default EmptyState;
