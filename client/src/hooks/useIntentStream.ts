/**
 * useIntentStream Hook
 *
 * Manages WebSocket connection for real-time intent classification updates.
 * Subscribes to intent topics and maintains in-memory state for intents
 * and distribution counts.
 *
 * Part of OMN-1458: Real-time Intent Dashboard Panel
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { IntentClassifiedEvent, IntentStoredEvent } from '@shared/intent-types';
import { WS_CHANNEL_INTENTS, WS_CHANNEL_INTENTS_STORED } from '@shared/intent-types';
import { generateUUID } from '@shared/uuid';

/**
 * Default maximum number of intents to keep in memory.
 */
export const DEFAULT_MAX_INTENTS = 100;

/**
 * Default throttle interval for onIntent callback (in milliseconds).
 * Prevents excessive callback invocations and potential query invalidation spam.
 */
export const DEFAULT_ON_INTENT_THROTTLE_MS = 100;

/**
 * Multiplier for seenEventIds cleanup threshold.
 * When seenEventIds.size exceeds maxItems * this multiplier,
 * the Set is pruned to only contain IDs currently in the intents array.
 */
export const SEEN_EVENT_IDS_CLEANUP_MULTIPLIER = 3;

/**
 * Interval in milliseconds for periodic seenEventIds cleanup.
 * Ensures memory is bounded even during idle periods.
 */
export const SEEN_EVENT_IDS_CLEANUP_INTERVAL_MS = 60_000;

/**
 * Intent event types received from WebSocket
 */
export type IntentEventType =
  | 'INTENT_CLASSIFIED'
  | 'INTENT_STORED'
  | 'INTENT_DISTRIBUTION'
  | 'INTENT_SESSION'
  | 'INTENT_RECENT';

/**
 * Processed intent for display in the UI
 */
export interface ProcessedIntent {
  /** Unique identifier for deduplication */
  id: string;
  /** Session that generated this intent */
  sessionId: string;
  /** Classified category (e.g., "debugging", "code_generation") */
  category: string;
  /** Classification confidence score (0.0-1.0) */
  confidence: number;
  /** When the intent was classified */
  timestamp: Date;
  /** Correlation ID for tracing */
  correlationId: string;
  /** Raw event data for detail views */
  raw: IntentClassifiedEvent | IntentStoredEvent;
}

/**
 * Options for the useIntentStream hook
 */
export interface UseIntentStreamOptions {
  /**
   * Maximum number of intents to keep in memory
   * @default 100
   */
  maxItems?: number;

  /**
   * Whether to automatically connect on mount
   * @default true
   */
  autoConnect?: boolean;

  /**
   * Callback fired when a new intent is received.
   * This callback is throttled to prevent excessive invocations.
   * @see onIntentThrottleMs to configure throttle interval
   */
  onIntent?: (intent: ProcessedIntent) => void;

  /**
   * Throttle interval in milliseconds for onIntent callback.
   * Helps prevent query invalidation spam when receiving many events.
   * @default 100
   */
  onIntentThrottleMs?: number;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;
}

/**
 * Return type for the useIntentStream hook
 */
export interface UseIntentStreamReturn {
  /**
   * Recent intents (most recent first)
   */
  intents: ProcessedIntent[];

  /**
   * Intent category distribution counts.
   * Note: This is derived from stats.byCategory (single source of truth).
   */
  distribution: Record<string, number>;

  /**
   * Whether the WebSocket is connected
   */
  isConnected: boolean;

  /**
   * Connection error if any
   */
  error: Error | null;

  /**
   * Manually connect to WebSocket
   */
  connect: () => void;

  /**
   * Disconnect from WebSocket and stop receiving intent events.
   *
   * This function performs a full teardown:
   * 1. Unsubscribes from intent-specific topics (INTENT_UPDATE, INTENT_DISTRIBUTION)
   * 2. **Closes** the underlying WebSocket connection via closeWebSocket()
   * 3. Prevents automatic reconnection
   * 4. Resets the subscription flag
   *
   * Note: The name `disconnect` accurately reflects the full teardown behavior.
   * Unlike a simple topic unsubscribe, this closes the shared WebSocket transport.
   * To reconnect after calling disconnect(), call connect().
   *
   * @see OMN-1563 - naming evaluated; disconnect is retained as it closes the WS connection
   */
  disconnect: () => void;

  /**
   * Clear all intents and reset distribution
   */
  clearIntents: () => void;

  /**
   * Current connection status
   */
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error' | 'offline';

  /**
   * Statistics about received intents
   */
  stats: {
    totalReceived: number;
    byCategory: Record<string, number>;
    lastEventTime: Date | null;
  };
}

/**
 * Hook for managing WebSocket connection to intent classification events.
 *
 * @example Basic usage
 * ```tsx
 * const { intents, distribution, isConnected } = useIntentStream();
 *
 * return (
 *   <div>
 *     <LiveIndicator isConnected={isConnected} />
 *     <PieChart data={distribution} />
 *     <ul>
 *       {intents.map(intent => (
 *         <li key={intent.id}>{intent.category} ({intent.confidence})</li>
 *       ))}
 *     </ul>
 *   </div>
 * );
 * ```
 *
 * @example With callback
 * ```tsx
 * const { intents } = useIntentStream({
 *   onIntent: (intent) => {
 *     console.log('New intent:', intent.category);
 *     playNotificationSound();
 *   }
 * });
 * ```
 */
export function useIntentStream(options: UseIntentStreamOptions = {}): UseIntentStreamReturn {
  const {
    maxItems = DEFAULT_MAX_INTENTS,
    autoConnect = true,
    onIntent,
    onIntentThrottleMs = DEFAULT_ON_INTENT_THROTTLE_MS,
    debug = false,
  } = options;

  // State
  const [intents, setIntents] = useState<ProcessedIntent[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [stats, setStats] = useState<UseIntentStreamReturn['stats']>({
    totalReceived: 0,
    byCategory: {},
    lastEventTime: null,
  });

  // Track if we've subscribed to avoid duplicate subscriptions
  const hasSubscribed = useRef(false);

  // Track seen event IDs to deduplicate events
  const seenEventIds = useRef(new Set<string>());

  // Track current intents in a ref for cleanup operations (avoids using setState as getter)
  const intentsRef = useRef<ProcessedIntent[]>([]);

  // Track if cleanup is needed after state update
  const needsCleanupRef = useRef(false);

  // Track callback ref to avoid stale closures
  const onIntentRef = useRef(onIntent);
  useEffect(() => {
    onIntentRef.current = onIntent;
  }, [onIntent]);

  // Throttle state for onIntent callback
  const throttleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCallTimeRef = useRef<number>(0);
  const pendingIntentRef = useRef<ProcessedIntent | null>(null);

  // Keep intentsRef in sync with intents state for cleanup operations
  useEffect(() => {
    intentsRef.current = intents;
  }, [intents]);

  /**
   * Throttled callback invocation to prevent query invalidation spam.
   * Uses trailing edge: if multiple intents arrive within throttle window,
   * the callback is called with the most recent intent after the window expires.
   */
  const invokeOnIntentThrottled = useCallback(
    (intent: ProcessedIntent) => {
      const now = Date.now();
      const timeSinceLastCall = now - lastCallTimeRef.current;

      if (timeSinceLastCall >= onIntentThrottleMs) {
        // Enough time has passed, call immediately
        lastCallTimeRef.current = now;
        onIntentRef.current?.(intent);
      } else {
        // Within throttle window, schedule trailing call with latest intent
        pendingIntentRef.current = intent;

        if (!throttleTimeoutRef.current) {
          const remainingTime = onIntentThrottleMs - timeSinceLastCall;
          throttleTimeoutRef.current = setTimeout(() => {
            throttleTimeoutRef.current = null;
            lastCallTimeRef.current = Date.now();
            if (pendingIntentRef.current) {
              onIntentRef.current?.(pendingIntentRef.current);
              pendingIntentRef.current = null;
            }
          }, remainingTime);
        }
      }
    },
    [onIntentThrottleMs]
  );

  // Cleanup throttle timeout on unmount OR when throttle interval changes
  useEffect(() => {
    return () => {
      if (throttleTimeoutRef.current) {
        clearTimeout(throttleTimeoutRef.current);
        throttleTimeoutRef.current = null;
      }
    };
  }, [onIntentThrottleMs]);

  // Perform deferred cleanup of seenEventIds after state updates
  useEffect(() => {
    if (needsCleanupRef.current) {
      needsCleanupRef.current = false;
      const currentIds = new Set(intentsRef.current.map((i) => i.id));
      seenEventIds.current = currentIds;
    }
  }, [intents]);

  /**
   * Process an incoming WebSocket message into a ProcessedIntent
   */
  const processIntentEvent = useCallback(
    (
      eventData: IntentClassifiedEvent | IntentStoredEvent,
      eventType: string
    ): ProcessedIntent | null => {
      // Extract fields based on event type
      let id: string;
      let sessionId: string;
      let category: string;
      let confidence: number;
      let timestamp: string;
      let correlationId: string;

      if (eventType === 'INTENT_CLASSIFIED' || eventType === 'IntentClassified') {
        const classified = eventData as IntentClassifiedEvent;
        id = classified.correlation_id || generateUUID();
        sessionId = classified.session_id || '';
        category = classified.intent_category || 'unknown';
        confidence = classified.confidence ?? 0;
        timestamp = classified.timestamp || new Date().toISOString();
        correlationId = classified.correlation_id || id;
      } else if (eventType === 'INTENT_STORED') {
        const stored = eventData as IntentStoredEvent;
        id = stored.intent_id || stored.correlation_id || generateUUID();
        sessionId = stored.session_ref || '';
        category = stored.intent_category || 'unknown';
        confidence = stored.confidence ?? 0;
        timestamp = stored.stored_at || new Date().toISOString();
        correlationId = stored.correlation_id || id;
      } else {
        return null;
      }

      return {
        id,
        sessionId,
        category,
        confidence,
        timestamp: new Date(timestamp),
        correlationId,
        raw: eventData,
      };
    },
    []
  );

  /**
   * Validate that a WebSocket message has the expected structure.
   * Returns true if the message appears to be a valid intent event payload.
   */
  const isValidIntentEventPayload = useCallback(
    (data: unknown): data is IntentClassifiedEvent | IntentStoredEvent => {
      // Must be an object
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return false;
      }

      const obj = data as Record<string, unknown>;

      // Must have at least one of the expected identifier fields
      const hasIdentifier =
        typeof obj.correlation_id === 'string' ||
        typeof obj.intent_id === 'string' ||
        typeof obj.session_id === 'string' ||
        typeof obj.session_ref === 'string';

      // Must have a category (optional but expected)
      const hasCategory =
        typeof obj.intent_category === 'string' || obj.intent_category === undefined;

      return hasIdentifier && hasCategory;
    },
    []
  );

  /**
   * Handle incoming WebSocket messages.
   *
   * Validates message structure before processing to handle malformed events gracefully.
   * Events that fail validation are logged (in debug mode) and ignored.
   */
  const handleMessage = useCallback(
    (message: { type: string; data?: unknown; timestamp: string }) => {
      try {
        // Validate message has required structure
        if (!message || typeof message.type !== 'string') {
          if (debug) {
            // eslint-disable-next-line no-console
            console.log('[IntentStream] Skipping invalid message: missing type', message);
          }
          return;
        }

        // Check if this is an intent event
        const intentEventTypes = ['INTENT_CLASSIFIED', 'IntentClassified', 'INTENT_STORED'];

        if (!intentEventTypes.includes(message.type)) {
          return;
        }

        // Validate event data structure before processing
        if (!isValidIntentEventPayload(message.data)) {
          if (debug) {
            // eslint-disable-next-line no-console
            console.log(
              '[IntentStream] Skipping malformed event payload:',
              message.type,
              message.data
            );
          }
          return;
        }

        const eventData = message.data;

        // Process the event
        const processedIntent = processIntentEvent(eventData, message.type);
        if (!processedIntent) {
          return;
        }

        // Deduplicate events
        if (seenEventIds.current.has(processedIntent.id)) {
          if (debug) {
            // eslint-disable-next-line no-console
            console.log('[IntentStream] Skipping duplicate event:', processedIntent.id);
          }
          return;
        }
        seenEventIds.current.add(processedIntent.id);

        if (debug) {
          // eslint-disable-next-line no-console
          console.log(
            '[IntentStream] Received intent:',
            processedIntent.category,
            processedIntent.confidence
          );
        }

        // Update intents array
        setIntents((prev) => {
          const updated = [processedIntent, ...prev].slice(0, maxItems);
          return updated;
        });

        // Schedule memory cleanup if seenEventIds has grown too large
        // Cleanup is deferred to useEffect to avoid mutating refs during render
        if (seenEventIds.current.size > maxItems * SEEN_EVENT_IDS_CLEANUP_MULTIPLIER) {
          needsCleanupRef.current = true;
        }

        // Update stats (byCategory serves as the single source of truth for distribution)
        setStats((prev) => ({
          totalReceived: prev.totalReceived + 1,
          byCategory: {
            ...prev.byCategory,
            [processedIntent.category]: (prev.byCategory[processedIntent.category] || 0) + 1,
          },
          lastEventTime: new Date(),
        }));

        // Clear any previous error on successful event
        setError(null);

        // Call throttled callback if provided
        if (onIntentRef.current) {
          invokeOnIntentThrottled(processedIntent);
        }
      } catch (err) {
        if (debug) {
          console.error('[IntentStream] Error processing message:', err, message);
        }
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [debug, maxItems, processIntentEvent, invokeOnIntentThrottled, isValidIntentEventPayload]
  );

  /**
   * Handle WebSocket errors
   */
  const handleError = useCallback(
    (event: Event) => {
      setError(new Error('WebSocket connection error'));
      if (debug) {
        console.error('[IntentStream] WebSocket error:', event);
      }
    },
    [debug]
  );

  // Use the base WebSocket hook
  const {
    isConnected,
    connectionStatus,
    error: wsError,
    subscribe,
    unsubscribe,
    reconnect,
    close: closeWebSocket,
  } = useWebSocket({
    onMessage: handleMessage,
    onError: handleError,
    debug,
  });

  // Track connection state in a ref for cleanup function (avoids stale closure)
  const isConnectedRef = useRef(isConnected);
  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  // Subscribe to intent topics when connected
  useEffect(() => {
    if (!autoConnect) {
      return;
    }

    if (isConnected && !hasSubscribed.current) {
      if (debug) {
        // eslint-disable-next-line no-console
        console.log('[IntentStream] Subscribing to intent topics');
      }
      // Subscribe to both main intent topic and stored events
      subscribe([WS_CHANNEL_INTENTS, WS_CHANNEL_INTENTS_STORED]);
      hasSubscribed.current = true;
    }

    // Reset subscription flag when disconnected
    if (!isConnected) {
      hasSubscribed.current = false;
    }

    // Cleanup: unsubscribe when unmounting
    // Check both hasSubscribed flag and connection state to avoid
    // attempting unsubscribe after WebSocket has already disconnected
    return () => {
      if (hasSubscribed.current) {
        // Only attempt unsubscribe if WebSocket is still connected
        if (isConnectedRef.current) {
          if (debug) {
            // eslint-disable-next-line no-console
            console.log('[IntentStream] Unsubscribing from intent topics');
          }
          unsubscribe([WS_CHANNEL_INTENTS, WS_CHANNEL_INTENTS_STORED]);
        } else if (debug) {
          // eslint-disable-next-line no-console
          console.log('[IntentStream] Skipping unsubscribe - WebSocket already disconnected');
        }
        hasSubscribed.current = false;
      }
    };
  }, [isConnected, autoConnect, subscribe, unsubscribe, debug]);

  /**
   * Interval-based cleanup of seenEventIds to prevent memory accumulation during idle periods.
   * Runs every SEEN_EVENT_IDS_CLEANUP_INTERVAL_MS and prunes stale IDs.
   * Uses intentsRef to read current state without triggering re-renders.
   */
  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      // Only cleanup if we have accumulated more IDs than currently displayed
      if (seenEventIds.current.size > maxItems) {
        // Get current intent IDs from ref (avoids using setState as a getter)
        const currentIds = new Set(intentsRef.current.map((i) => i.id));
        seenEventIds.current = currentIds;

        if (debug) {
          // eslint-disable-next-line no-console
          console.log(
            '[IntentStream] Periodic cleanup: pruned seenEventIds to',
            currentIds.size,
            'entries'
          );
        }
      }
    }, SEEN_EVENT_IDS_CLEANUP_INTERVAL_MS);

    return () => {
      clearInterval(cleanupInterval);
    };
  }, [maxItems, debug]);

  /**
   * Clear all intents and reset state
   */
  const clearIntents = useCallback(() => {
    setIntents([]);
    setStats({
      totalReceived: 0,
      byCategory: {},
      lastEventTime: null,
    });
    seenEventIds.current.clear();
    setError(null);
  }, []);

  /**
   * Manually trigger connection
   */
  const connect = useCallback(() => {
    reconnect();
  }, [reconnect]);

  /**
   * Disconnect from the WebSocket and stop receiving intent events.
   *
   * This function performs a full teardown:
   * 1. Unsubscribes from intent-specific topics (INTENT_UPDATE, INTENT_DISTRIBUTION),
   *    if the WebSocket is still connected when called
   * 2. Closes the underlying WebSocket connection via closeWebSocket()
   * 3. Prevents automatic reconnection
   * 4. Resets the subscription flag
   *
   * The name `disconnect` is intentional: this is not merely a topic unsubscribe —
   * it closes the shared WebSocket transport used by the hook. If you only want
   * to stop receiving intent events while keeping the connection alive for other
   * subscribers, use useWebSocket directly and call unsubscribe() on the intent
   * channels instead.
   *
   * To reconnect after calling disconnect(), call connect().
   */
  const disconnect = useCallback(() => {
    if (debug) {
      // eslint-disable-next-line no-console
      console.log('[IntentStream] Disconnecting from WebSocket');
    }

    // Unsubscribe from topics if still connected
    if (hasSubscribed.current && isConnectedRef.current) {
      if (debug) {
        // eslint-disable-next-line no-console
        console.log('[IntentStream] Unsubscribing from intent topics before disconnect');
      }
      unsubscribe([WS_CHANNEL_INTENTS, WS_CHANNEL_INTENTS_STORED]);
    }

    // Reset subscription flag
    hasSubscribed.current = false;

    // Close the WebSocket connection
    closeWebSocket();
  }, [unsubscribe, closeWebSocket, debug]);

  // Combine errors from both this hook and the WebSocket hook
  const combinedError = error || (wsError ? new Error(wsError) : null);

  return {
    intents,
    distribution: stats.byCategory, // Derived from stats (single source of truth)
    isConnected,
    error: combinedError,
    connect,
    disconnect,
    clearIntents,
    connectionStatus,
    stats,
  };
}
