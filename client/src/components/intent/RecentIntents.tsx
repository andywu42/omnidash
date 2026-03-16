/**
 * RecentIntents Component (OMN-1458)
 *
 * Real-time streaming list of recent intent classifications.
 * Displays intent category, confidence score, and timestamp.
 *
 * Features:
 * - Initial load from /api/intents/recent
 * - WebSocket subscription for live updates
 * - Color-coded confidence badges (green >=90%, yellow 70-90%, red <70%)
 * - Smooth animations for new items
 * - Scrollable list with fixed height
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Brain, AlertCircle, Wifi, WifiOff } from 'lucide-react';
import type { IntentRecordPayload } from '@shared/intent-types';
import { getIntentBadgeClasses, getConfidenceColor, formatCategoryName } from '@/lib/intent-colors';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Duration in ms after which "new" animation state is cleared */
const NEW_ITEM_ANIMATION_DURATION_MS = 1500;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intent item for display - extends shared type with optional context
 * Re-exports the same type used by SessionTimeline for consistency
 */
export interface IntentItem extends IntentRecordPayload {
  /** Optional user context/prompt text */
  user_context?: string;
}

export interface RecentIntentsProps {
  /** Maximum number of items to display */
  limit?: number;
  /** Whether to show confidence percentage badge */
  showConfidence?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Maximum height in pixels */
  maxHeight?: number;
  /** Whether to show the card container (set false for bare list) */
  showCard?: boolean;
  /** Callback when an intent is clicked */
  onIntentClick?: (intent: IntentItem) => void;
  /**
   * Pre-fetched intent items. When provided, skips the internal API fetch
   * and the internal WebSocket connection. Use `connectionStatus` to
   * reflect the parent's data-source status in the header badge.
   */
  data?: IntentItem[];
  /**
   * External connection status from the parent data source (e.g.
   * useIntentProjectionStream). When `data` is provided this replaces
   * the internal WebSocket's connection indicator.
   */
  connectionStatus?: 'connecting' | 'connected' | 'disconnected' | 'error' | 'offline';
}

interface RecentIntentsResponse {
  ok: boolean;
  intents: IntentItem[];
  total_count: number;
  time_range_hours: number;
  execution_time_ms?: number;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return timestamp;
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading Skeleton
// ─────────────────────────────────────────────────────────────────────────────

function IntentSkeleton() {
  return (
    <div className="flex gap-3 p-3 rounded-lg border bg-card border-border">
      <div className="w-1 rounded bg-muted" />
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-12" />
        </div>
        <Skeleton className="h-4 w-32" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent Item Component
// ─────────────────────────────────────────────────────────────────────────────

interface IntentItemRowProps {
  intent: IntentItem;
  /** Whether this item is newly added via WebSocket (controls animation) */
  isNew: boolean;
  showConfidence: boolean;
  onClick?: () => void;
}

function IntentItemRow({ intent, isNew, showConfidence, onClick }: IntentItemRowProps) {
  // Use created_at from IntentRecordPayload, fallback to id for display timestamp
  const displayTimestamp = intent.created_at;

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `View details for ${intent.intent_category} intent` : undefined}
      className={cn(
        'flex gap-3 p-3 rounded-lg border bg-card border-border',
        isNew && 'animate-slide-in',
        onClick &&
          'cursor-pointer transition-all duration-200 ease-in-out hover:bg-accent/50 hover:scale-[1.01] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:scale-[0.99]'
      )}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {/* Left indicator bar - thresholds: 90%/70% to match SessionTimeline and legend */}
      <div
        className={cn(
          'w-1 rounded',
          intent.confidence >= 0.9
            ? 'bg-green-500'
            : intent.confidence >= 0.7
              ? 'bg-yellow-500'
              : 'bg-red-500'
        )}
      />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header row: timestamp + badges */}
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
            {formatTimestamp(displayTimestamp)}
          </span>

          {/* Intent category badge */}
          <Badge
            variant="outline"
            className={cn('text-xs border', getIntentBadgeClasses(intent.intent_category))}
          >
            {formatCategoryName(intent.intent_category)}
          </Badge>

          {/* Confidence badge */}
          {showConfidence && (
            <Badge
              variant="outline"
              className={cn('text-xs border', getConfidenceColor(intent.confidence))}
            >
              {(intent.confidence * 100).toFixed(0)}%
            </Badge>
          )}
        </div>

        {/* Context snippet if available */}
        {intent.user_context && (
          <div className="text-sm text-muted-foreground truncate">
            "{truncateText(intent.user_context, 60)}"
          </div>
        )}

        {/* Keywords if available and no context */}
        {!intent.user_context && intent.keywords && intent.keywords.length > 0 && (
          <div className="text-xs text-muted-foreground">
            {intent.keywords.slice(0, 3).join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function RecentIntents({
  limit = 50,
  showConfidence = true,
  className,
  maxHeight = 400,
  showCard = true,
  onIntentClick,
  data: propData,
  connectionStatus: externalConnectionStatus,
}: RecentIntentsProps) {
  const queryClient = useQueryClient();
  const [intents, setIntents] = useState<IntentItem[]>([]);

  // Track IDs of items that arrived via WebSocket (truly "new" items)
  // Only these items should animate, not items from initial API load
  const [newItemIds, setNewItemIds] = useState<Set<string>>(new Set());

  // Ref for debounced query invalidation to prevent excessive re-fetching
  const invalidateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref for animation cleanup timeouts (keyed by intent_id)
  const animationTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Track the previous propData reference so we only reset intents when the
  // array identity genuinely changes (not on every parent re-render with a
  // semantically-identical snapshot).
  const prevPropDataRef = useRef<typeof propData>(undefined);

  // Fetch initial data (skipped when propData is provided)
  const { data, isLoading, isError, error } = useQuery<RecentIntentsResponse>({
    queryKey: ['/api/intents/recent', { limit }],
    queryFn: async () => {
      const response = await fetch(`/api/intents/recent?limit=${limit}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch intents: ${response.statusText}`);
      }
      return response.json();
    },
    refetchInterval: 30000,
    enabled: propData === undefined,
  });

  // Initialize intents: prefer propData, then fall back to query response.
  //
  // Guard: only overwrite the WS-prepended state when propData reference has
  // actually changed (i.e., the parent produced a new array), not merely when
  // the parent re-rendered with the same snapshot reference.  This prevents a
  // stale propData snapshot from clobbering items that the WebSocket handler
  // already prepended to `intents`.
  useEffect(() => {
    if (propData !== undefined) {
      if (propData !== prevPropDataRef.current) {
        prevPropDataRef.current = propData;
        setIntents(propData.slice(0, limit));
      }
    } else if (data?.intents) {
      // Only seed from query data when the list is still empty so that WS
      // state accumulated before the first query result is not discarded.
      setIntents((prev) => (prev.length === 0 ? data.intents : prev));
    }
  }, [propData, data, limit]);

  // WebSocket message handler for real-time updates
  const handleMessage = useCallback(
    (message: { type: string; data?: unknown; timestamp: string }) => {
      // Handle INTENT_UPDATE events from the WebSocket (server broadcasts as INTENT_UPDATE).
      // Also accept legacy INTENT_STORED for backward compatibility.
      if (message.type === 'INTENT_UPDATE' || message.type === 'INTENT_STORED') {
        const eventData = message.data as {
          intent_id?: string;
          session_id?: string;
          session_ref?: string;
          intent_category?: string;
          confidence?: number;
          keywords?: string[];
        };

        if (eventData.intent_category) {
          const intentId =
            eventData.intent_id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

          const newIntent: IntentItem = {
            intent_id: intentId,
            session_ref: eventData.session_ref || eventData.session_id || '',
            created_at: message.timestamp,
            intent_category: eventData.intent_category,
            confidence: eventData.confidence || 0.5,
            keywords: eventData.keywords || [],
          };

          // Mark this item as "new" for animation purposes
          setNewItemIds((prev) => new Set(prev).add(intentId));

          // Schedule removal of "new" status after animation completes
          const timeoutId = setTimeout(() => {
            setNewItemIds((prev) => {
              const updated = new Set(prev);
              updated.delete(intentId);
              return updated;
            });
            animationTimeoutsRef.current.delete(intentId);
          }, NEW_ITEM_ANIMATION_DURATION_MS);

          // Track timeout for cleanup on unmount
          animationTimeoutsRef.current.set(intentId, timeoutId);

          // Prepend new intent and cap at limit.
          // Guard: when propData is provided, the parent owns the list — do not
          // mutate local state or the parent's next render will either flicker
          // (overwrite) or permanently diverge from the propData snapshot.
          if (propData === undefined) {
            setIntents((prev) => [newIntent, ...prev].slice(0, limit));
          }

          // Debounced query invalidation to prevent excessive re-fetching under high event volume
          // Clear any pending invalidation (reset debounce timer)
          if (invalidateTimeoutRef.current) {
            clearTimeout(invalidateTimeoutRef.current);
          }
          // Schedule new invalidation after 2 second debounce period
          invalidateTimeoutRef.current = setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ['/api/intents/recent'] });
            invalidateTimeoutRef.current = null;
          }, 2000);
        }
      }
    },
    [limit, queryClient, propData]
  );

  // WebSocket connection — only created when using internal fetch (no propData).
  // When propData is provided, the parent owns the data source and connection
  // status is reflected via the `connectionStatus` prop.
  const {
    isConnected: wsIsConnected,
    subscribe,
    unsubscribe,
  } = useWebSocket({
    onMessage: propData === undefined ? handleMessage : undefined,
  });

  // Derive effective connection status: prefer external (parent-provided) when
  // propData is set, otherwise use the internal WebSocket's state.
  const isConnected =
    propData !== undefined ? externalConnectionStatus === 'connected' : wsIsConnected;

  // Subscribe to intent events when connected (internal WebSocket path only)
  useEffect(() => {
    if (propData !== undefined) return; // Parent owns the data source
    if (wsIsConnected) {
      // Subscribe to 'intent' topic (matches server VALID_TOPICS)
      subscribe(['intent']);
      return () => unsubscribe(['intent']);
    }
  }, [wsIsConnected, subscribe, unsubscribe, propData]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    // Capture ref values at effect setup time for cleanup stability
    const currentAnimationTimeouts = animationTimeoutsRef.current;
    return () => {
      // Clear query invalidation timeout
      if (invalidateTimeoutRef.current) {
        clearTimeout(invalidateTimeoutRef.current);
      }
      // Clear all animation cleanup timeouts
      currentAnimationTimeouts.forEach((timeoutId) => clearTimeout(timeoutId));
      currentAnimationTimeouts.clear();
    };
  }, []);

  // Render content
  const content = (
    <>
      {/* Header with connection status */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold flex items-center gap-2">
          <Brain className="w-4 h-4" />
          Recent Intents
        </h3>
        <div className="flex items-center gap-2">
          {isConnected ? (
            <Badge variant="outline" className="text-xs gap-1 text-green-600 border-green-500/20">
              <Wifi className="w-3 h-3" />
              Live
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs gap-1 text-muted-foreground">
              <WifiOff className="w-3 h-3" />
              Offline
            </Badge>
          )}
        </div>
      </div>

      {/* Loading state — only when using internal fetch (no propData) */}
      {isLoading && propData === undefined && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <IntentSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Error state — only when using internal fetch */}
      {isError && propData === undefined && (
        <div className="p-6 text-center text-muted-foreground">
          <AlertCircle className="w-8 h-8 mx-auto mb-2 text-destructive" />
          <p className="text-sm">Failed to load intents</p>
          <p className="text-xs mt-1">{error instanceof Error ? error.message : 'Unknown error'}</p>
        </div>
      )}

      {/* Empty state */}
      {!(isLoading && propData === undefined) &&
        !(isError && propData === undefined) &&
        intents.length === 0 && (
          <div className="p-6 text-center text-muted-foreground">
            <Brain className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No intents found</p>
            <p className="text-xs mt-1">Waiting for new intent classifications...</p>
          </div>
        )}

      {/* Intent list */}
      {!(isLoading && propData === undefined) &&
        !(isError && propData === undefined) &&
        intents.length > 0 && (
          <ScrollArea className="pr-4" style={{ maxHeight: `${maxHeight}px` }}>
            <div className="space-y-2">
              {intents.map((intent, index) => (
                <IntentItemRow
                  key={`${intent.intent_id}-${intent.created_at}-${index}`}
                  intent={intent}
                  isNew={newItemIds.has(intent.intent_id)}
                  showConfidence={showConfidence}
                  onClick={onIntentClick ? () => onIntentClick(intent) : undefined}
                />
              ))}
            </div>
          </ScrollArea>
        )}
    </>
  );

  // Return with or without card wrapper
  if (!showCard) {
    return <div className={className}>{content}</div>;
  }

  return (
    <Card className={cn('p-6', className)} data-testid="recent-intents">
      {content}
    </Card>
  );
}

export default RecentIntents;
