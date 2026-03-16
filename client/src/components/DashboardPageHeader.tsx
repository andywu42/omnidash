/**
 * DashboardPageHeader Component
 *
 * A reusable header component for dashboard pages that includes:
 * - Title and description
 * - Last updated timestamp
 * - Connection status indicator
 * - Data source badge
 * - Refresh button
 * - Optional custom actions
 *
 * @module components/DashboardPageHeader
 */

import { type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LiveIndicator } from '@/components/LiveIndicator';
import { Clock, Database, Keyboard, Loader2, RefreshCw } from 'lucide-react';
import { formatRelativeTime } from '@/lib/date-utils';

/**
 * Keyboard shortcut definition.
 */
export interface KeyboardShortcut {
  key: string;
  description: string;
}

/**
 * Props for the DashboardPageHeader component.
 */
export interface DashboardPageHeaderProps {
  /** Page title */
  title: string;
  /** Page description */
  description?: string;
  /** Optional status badge to display next to the title (e.g., system health indicator) */
  statusBadge?: ReactNode;
  /** Last data update timestamp */
  lastUpdated?: Date | null;
  /** Whether the WebSocket/real-time connection is active */
  isConnected?: boolean;
  /** Connection status for the LiveIndicator */
  connectionStatus?: 'connecting' | 'connected' | 'disconnected' | 'error' | 'offline';
  /** Callback for refresh button click */
  onRefresh?: () => void;
  /** Whether data is currently being fetched */
  isFetching?: boolean;
  /** Whether loading is in progress (disables refresh) */
  isLoading?: boolean;
  /** Whether using mock data (shown in badge) */
  useMockData?: boolean;
  /** Keyboard shortcuts to display in tooltip */
  keyboardShortcuts?: KeyboardShortcut[];
  /** Additional action buttons to render */
  actions?: ReactNode;
  /** Optional className for the container */
  className?: string;
}

/**
 * A standardized header for dashboard pages.
 *
 * Provides consistent styling and functionality for page headers including
 * title, description, status indicators, and action buttons.
 *
 * @example
 * ```tsx
 * <DashboardPageHeader
 *   title="Registry Discovery"
 *   description="View registered nodes and live instances"
 *   lastUpdated={lastUpdated}
 *   isConnected={isConnected}
 *   connectionStatus={connectionStatus}
 *   onRefresh={handleRefresh}
 *   isFetching={isFetching}
 *   useMockData={useMockData}
 *   keyboardShortcuts={[
 *     { key: 'R', description: 'Refresh data' },
 *     { key: 'F', description: 'Focus search' },
 *   ]}
 *   actions={
 *     <Button variant="outline" size="sm">
 *       Custom Action
 *     </Button>
 *   }
 * />
 * ```
 */
export function DashboardPageHeader({
  title,
  description,
  statusBadge,
  lastUpdated,
  isConnected,
  connectionStatus,
  onRefresh,
  isFetching = false,
  isLoading = false,
  useMockData = false,
  keyboardShortcuts,
  actions,
  className,
}: DashboardPageHeaderProps) {
  return (
    <div
      className={`flex flex-col gap-4 md:flex-row md:items-center md:justify-between ${className ?? ''}`}
    >
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl md:text-2xl font-semibold">{title}</h1>
          {statusBadge}
        </div>
        {description && <p className="text-muted-foreground text-sm md:text-base">{description}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2 md:gap-4">
        {/* Last updated timestamp */}
        {lastUpdated && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Updated</span> {formatRelativeTime(lastUpdated)}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Last updated: {lastUpdated.toLocaleString()}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Live indicator (WebSocket status) */}
        {isConnected !== undefined && (
          <LiveIndicator isConnected={isConnected} connectionStatus={connectionStatus} size="sm" />
        )}

        {/* Data source badge */}
        <Badge variant={useMockData ? 'secondary' : 'default'} className="gap-1 hidden sm:flex">
          <Database className="h-3 w-3" />
          {useMockData ? 'Mock Data' : 'Live API'}
        </Badge>

        {/* Fetching indicator */}
        {isFetching && !isLoading && (
          <Badge variant="outline" className="gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="hidden sm:inline">Updating...</span>
          </Badge>
        )}

        {/* Keyboard shortcuts hint */}
        {keyboardShortcuts && keyboardShortcuts.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="hidden md:flex">
                <Keyboard className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <div className="space-y-1 text-xs">
                {keyboardShortcuts.map((shortcut) => (
                  <p key={shortcut.key}>
                    <kbd className="bg-muted px-1 rounded">{shortcut.key}</kbd>{' '}
                    {shortcut.description}
                  </p>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Custom actions */}
        {actions}

        {/* Refresh button */}
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isLoading || useMockData}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        )}
      </div>
    </div>
  );
}
