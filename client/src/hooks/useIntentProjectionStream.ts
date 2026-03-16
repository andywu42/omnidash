/**
 * useIntentProjectionStream Hook (OMN-2096)
 *
 * Specialized hook for consuming server-side projection snapshots via
 * TanStack Query with WebSocket-driven invalidation.
 *
 * Flow:
 * 1. Fetch initial snapshot via TanStack Query on mount
 * 2. Subscribe to 'projections' on WebSocket
 * 3. On invalidation where viewId matches and cursor > local: invalidate query
 * 4. On invalidation where cursor <= local: ignore (stale)
 *
 * No polling. WS invalidation is the only trigger for re-fetches.
 * TanStack Query's invalidateQueries() naturally queues invalidations,
 * so no invalidation is dropped even when a fetch is in flight.
 */

import { useCallback, useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { queryKeys } from '@/lib/query-keys';
import type { ProjectionSnapshot } from '@shared/projection-types';

/** Re-export for consumers that previously imported from here. */
export type { ProjectionSnapshot } from '@shared/projection-types';

// ============================================================================
// Types
// ============================================================================

/** Options for {@link useIntentProjectionStream}. */
export interface UseIntentProjectionStreamOptions {
  /** Query limit for snapshot requests (default 100, max 500) */
  limit?: number;
  /** Fetch initial snapshot on mount (default true) */
  fetchOnMount?: boolean;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Return value of {@link useIntentProjectionStream}.
 * @template T - The projection payload type
 */
export interface UseIntentProjectionStreamReturn<T> {
  /** Current snapshot payload (null until first fetch completes) */
  snapshot: T | null;
  /** Current cursor position */
  cursor: number;
  /** Whether the WebSocket is connected */
  isConnected: boolean;
  /** Connection status */
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error' | 'offline';
  /** Error state */
  error: Error | null;
  /** Whether a fetch is in progress */
  isLoading: boolean;
  /** Manually trigger a snapshot refresh */
  refresh: () => void;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Consume a server-side projection snapshot via TanStack Query with
 * WebSocket-driven invalidation. No polling -- the WS subscription is
 * the sole trigger for re-fetches.
 *
 * @template T - The projection payload type (e.g. IntentProjectionPayload)
 * @param viewId - Registered projection view identifier (e.g. "intent")
 * @param options - Optional stream configuration
 * @returns Snapshot data, connection state, and a manual refresh handle
 */
export function useIntentProjectionStream<T>(
  viewId: string,
  options: UseIntentProjectionStreamOptions = {}
): UseIntentProjectionStreamReturn<T> {
  const { limit = 100, fetchOnMount = true, debug = false } = options;

  const queryClient = useQueryClient();
  const cursorRef = useRef(0);

  const log = useCallback(
    (...args: unknown[]) => {
      if (debug) {
        // eslint-disable-next-line no-console
        console.log(`[IntentProjectionStream:${viewId}]`, ...args);
      }
    },
    [debug, viewId]
  );

  // TanStack Query for snapshot fetching (no polling — WS is the only trigger)
  const {
    data,
    error: queryError,
    isLoading,
    refetch,
  } = useQuery<ProjectionSnapshot<T>, Error>({
    queryKey: queryKeys.projections.snapshot(viewId, limit),
    queryFn: async () => {
      const url = `/api/projections/${encodeURIComponent(viewId)}/snapshot?limit=${limit}`;
      log('Fetching snapshot:', url);
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Snapshot fetch failed: ${res.status} ${res.statusText}`);
      }
      return res.json() as Promise<ProjectionSnapshot<T>>;
    },
    refetchInterval: false,
    refetchOnWindowFocus: false,
    enabled: fetchOnMount,
  });

  // Track cursor from latest snapshot.
  // Apply if cursor advanced OR equal (>= not >). The equality case handles
  // the initial fetch where both local and server cursors are 0 (empty view).
  // WS invalidation already gates on strict > (see handleMessage), so duplicate
  // re-application of an identical cursor only occurs on the first mount fetch.
  useEffect(() => {
    if (data?.cursor != null && data.cursor >= cursorRef.current) {
      cursorRef.current = data.cursor;
      log('Cursor updated:', data.cursor);
    }
  }, [data?.cursor, log]);

  // Reset cursor when viewId changes so stale high-water-mark from a previous
  // view doesn't suppress the first fetch result for the new view.
  useEffect(() => {
    cursorRef.current = 0;
  }, [viewId]);

  // Handle WebSocket messages — filter for PROJECTION_INVALIDATE matching our viewId.
  // Uses queryClient.invalidateQueries() which naturally queues invalidations:
  // if a query is already fetching, TanStack Query will refetch after it completes.
  // No invalidation is ever dropped.
  const handleMessage = useCallback(
    (message: { type: string; data?: unknown; timestamp: string }) => {
      if (message.type !== 'PROJECTION_INVALIDATE') return;

      const payload = message.data as { viewId?: string; cursor?: number } | undefined;
      if (!payload || payload.viewId !== viewId) return;

      const remoteCursor = payload.cursor ?? 0;

      if (remoteCursor > cursorRef.current) {
        log('Invalidation received, remote cursor:', remoteCursor, '> local:', cursorRef.current);
        queryClient.invalidateQueries({
          queryKey: queryKeys.projections.snapshot(viewId, limit),
        });
      } else {
        log('Stale invalidation ignored, remote:', remoteCursor, 'local:', cursorRef.current);
      }
    },
    [viewId, limit, queryClient, log]
  );

  // Single WebSocket connection
  const {
    isConnected,
    connectionStatus,
    error: wsError,
    subscribe,
  } = useWebSocket({
    onOpen: () => {
      log('WebSocket connected, subscribing to projections');
      subscribe(['projections']);

      // Catch-up fetch on reconnect to bridge the disconnect gap.
      // cursorRef > 0 means we had data before, so this is a reconnect.
      if (cursorRef.current > 0) {
        log('Reconnect detected, invalidating query for catch-up');
        queryClient.invalidateQueries({
          queryKey: queryKeys.projections.snapshot(viewId, limit),
        });
      }
    },
    onMessage: handleMessage,
    debug,
  });

  // Memoize wsError -> Error conversion separately so the Error object is only
  // recreated when the wsError string itself changes.
  const wsErrorObj = useMemo(() => (wsError ? new Error(wsError) : null), [wsError]);
  const combinedError = queryError || wsErrorObj;

  return {
    snapshot: data?.payload ?? null,
    cursor: data?.cursor ?? 0,
    isConnected,
    connectionStatus,
    error: combinedError,
    isLoading,
    refresh: refetch,
  };
}
