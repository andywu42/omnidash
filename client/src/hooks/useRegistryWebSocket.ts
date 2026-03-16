/**
 * useRegistryWebSocket Hook
 *
 * Manages WebSocket connection for registry discovery real-time updates.
 * Automatically subscribes to registry topics and invalidates queries
 * when relevant events are received.
 *
 * Part of OMN-1278: Contract-Driven Dashboard - Registry Discovery (Phase 4)
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from './useWebSocket';
import type { ProjectedNode } from '@shared/schemas';
import {
  ProjectedNodeSchema,
  WsNodeHeartbeatPayloadSchema,
  WsNodeBecameActivePayloadSchema,
  WsNodeLivenessExpiredPayloadSchema,
  WsNodeIntrospectionPayloadSchema,
  OFFLINE_NODE_TTL_MS,
  CLEANUP_INTERVAL_MS,
} from '@shared/schemas';

/**
 * Generate a correlation ID for event deduplication.
 * crypto.randomUUID() is available in all modern browsers (Chrome 92+, Safari 15.4+, Firefox 95+).
 */
function generateCorrelationId(): string {
  return crypto.randomUUID();
}

/**
 * Default maximum number of recent events to keep in memory.
 * Used as the default value for the maxRecentEvents option.
 */
export const DEFAULT_MAX_RECENT_EVENTS = 50;

/**
 * Multiplier for seenEventIds cleanup threshold.
 * When seenEventIds.size exceeds maxRecentEvents * this multiplier,
 * the Set is pruned to only contain IDs currently in recentEvents.
 *
 * Why 5? With DEFAULT_MAX_RECENT_EVENTS=50 and multiplier=5:
 * - Cleanup triggers at 250 seen IDs
 * - At typical rates (1-5 events/sec), this provides 50-250 seconds of dedup history
 * - Memory overhead: ~250 UUIDs x 36 bytes = ~9KB (negligible)
 *
 * Trade-off: Higher values extend the deduplication window (catches duplicates
 * arriving later) but use more memory. Lower values save memory but may miss
 * duplicates that arrive after the window closes. Value of 5 balances memory
 * efficiency with practical deduplication needs for WebSocket event streams.
 */
export const SEEN_EVENT_IDS_CLEANUP_MULTIPLIER = 5;

/**
 * Topics to subscribe for registry events.
 * Includes both legacy registry topic and new canonical node events.
 */
export const REGISTRY_TOPICS = ['registry', 'registry-nodes'] as const;

/**
 * Registry event types as defined in the WebSocket Event Spec v1.2
 *
 * BOUNDED SET: This union type defines exactly 11 known event types.
 * The eventsByType stats object is bounded by this finite set, preventing
 * memory leaks in long-running sessions. Only events matching these types
 * are processed and counted.
 *
 * OMN-1279 additions: NODE_ACTIVATED, NODE_OFFLINE, NODE_INTROSPECTION, NODE_DISCOVERED
 */
export type RegistryEventType =
  | 'NODE_REGISTERED'
  | 'NODE_STATE_CHANGED'
  | 'NODE_HEARTBEAT'
  | 'NODE_DEREGISTERED'
  | 'INSTANCE_HEALTH_CHANGED'
  | 'INSTANCE_ADDED'
  | 'INSTANCE_REMOVED'
  | 'NODE_ACTIVATED'
  | 'NODE_OFFLINE'
  | 'NODE_INTROSPECTION'
  | 'NODE_DISCOVERED';

/**
 * Registry event types for message filtering.
 * BOUNDED SET: Exactly 11 known event types to prevent unbounded memory growth.
 * Only events matching these types are processed and counted.
 */
export const REGISTRY_EVENT_TYPES: RegistryEventType[] = [
  'NODE_REGISTERED',
  'NODE_STATE_CHANGED',
  'NODE_HEARTBEAT',
  'NODE_DEREGISTERED',
  'INSTANCE_HEALTH_CHANGED',
  'INSTANCE_ADDED',
  'INSTANCE_REMOVED',
  'NODE_ACTIVATED',
  'NODE_OFFLINE',
  'NODE_INTROSPECTION',
  'NODE_DISCOVERED',
];

/**
 * Registry event structure received from WebSocket
 */
export interface RegistryEvent {
  type: RegistryEventType;
  timestamp: string;
  correlation_id: string;
  payload: Record<string, unknown>;
}

/**
 * Recent event for display in the event feed
 */
export interface RecentRegistryEvent {
  id: string;
  type: RegistryEventType;
  timestamp: Date;
  payload: Record<string, unknown>;
  correlationId: string;
}

/**
 * Options for the useRegistryWebSocket hook
 */
export interface UseRegistryWebSocketOptions {
  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Maximum number of recent events to keep in memory
   * @default 50
   */
  maxRecentEvents?: number;

  /**
   * Whether to automatically subscribe when connected
   * @default true
   */
  autoSubscribe?: boolean;

  /**
   * Callback fired when a registry event is received
   */
  onEvent?: (event: RegistryEvent) => void;
}

/**
 * Return type for the useRegistryWebSocket hook
 */
export interface UseRegistryWebSocketReturn {
  /**
   * Whether the WebSocket is connected
   */
  isConnected: boolean;

  /**
   * Current connection status
   */
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error' | 'offline';

  /**
   * Connection error message if any
   */
  error: string | null;

  /**
   * Recent registry events (most recent first)
   */
  recentEvents: RecentRegistryEvent[];

  /**
   * Projected node states updated in real-time from WebSocket events (OMN-1279)
   * Key: node_id, Value: ProjectedNode state
   */
  projectedNodes: Map<string, ProjectedNode>;

  /**
   * Clear all recent events
   */
  clearEvents: () => void;

  /**
   * Manually reconnect the WebSocket
   */
  reconnect: () => void;

  /**
   * Statistics about received events
   */
  stats: {
    totalEventsReceived: number;
    eventsByType: Record<RegistryEventType, number>;
    lastEventTime: Date | null;
  };
}

/**
 * Hook for managing WebSocket connection to registry discovery events.
 *
 * @example Basic usage
 * ```tsx
 * const { isConnected, recentEvents } = useRegistryWebSocket();
 *
 * return (
 *   <div>
 *     <LiveIndicator isConnected={isConnected} />
 *     <ul>
 *       {recentEvents.map(event => (
 *         <li key={event.id}>{event.type}</li>
 *       ))}
 *     </ul>
 *   </div>
 * );
 * ```
 *
 * @example With event callback
 * ```tsx
 * const { isConnected } = useRegistryWebSocket({
 *   onEvent: (event) => {
 *     console.log('Received event:', event);
 *   }
 * });
 * ```
 */
export function useRegistryWebSocket(
  options: UseRegistryWebSocketOptions = {}
): UseRegistryWebSocketReturn {
  const {
    debug = false,
    maxRecentEvents = DEFAULT_MAX_RECENT_EVENTS,
    autoSubscribe = true,
    onEvent,
  } = options;

  const queryClient = useQueryClient();
  const [recentEvents, setRecentEvents] = useState<RecentRegistryEvent[]>([]);
  const [stats, setStats] = useState<UseRegistryWebSocketReturn['stats']>({
    totalEventsReceived: 0,
    eventsByType: {} as Record<RegistryEventType, number>,
    lastEventTime: null,
  });

  // OMN-1279: Track projected nodes locally for real-time updates
  const [projectedNodes, setProjectedNodes] = useState<Map<string, ProjectedNode>>(new Map());

  /**
   * Update a single projected node state (OMN-1279)
   * Creates new node if not exists, merges updates into existing node.
   * Uses Zod schema validation to ensure type safety when creating new nodes.
   */
  const updateNode = useCallback((nodeId: string, updates: Partial<ProjectedNode>) => {
    setProjectedNodes((prev) => {
      const newMap = new Map(prev);
      const existing = newMap.get(nodeId);
      if (existing) {
        newMap.set(nodeId, { ...existing, ...updates });
      } else {
        // Create new node with updates - use defaults for required fields
        // Validate with Zod schema to ensure type safety
        const newNodeData = {
          node_id: nodeId,
          state: 'PENDING' as const,
          last_event_at: Date.now(),
          ...updates,
        };
        const parsed = ProjectedNodeSchema.safeParse(newNodeData);
        if (parsed.success) {
          newMap.set(nodeId, parsed.data);
        } else {
          // Log validation error but don't crash - skip creating invalid node
          // This can happen if nodeId is not a valid UUID (relaxed WebSocket payloads)
          console.warn(
            '[RegistryWebSocket] Invalid node data, skipping:',
            parsed.error.flatten().fieldErrors
          );
        }
      }
      return newMap;
    });
  }, []);

  // Track if we've subscribed to avoid duplicate subscriptions
  const hasSubscribed = useRef(false);

  // Track seen event IDs to deduplicate events (server may send same event on multiple topics)
  const seenEventIds = useRef(new Set<string>());

  // Track callback ref to avoid stale closures
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  /**
   * Handle incoming WebSocket messages.
   *
   * Wrapped in try-catch to prevent malformed events from crashing the component.
   * WebSocket messages from external sources may have unexpected structure,
   * invalid timestamps, or missing fields that could cause runtime errors.
   */
  const handleMessage = useCallback(
    (message: { type: string; data?: RegistryEvent; timestamp: string }) => {
      try {
        // Check if this is a registry event (uses module-level constant for efficiency)
        if (!REGISTRY_EVENT_TYPES.includes(message.type as RegistryEventType)) {
          return;
        }

        const eventType = message.type as RegistryEventType;
        const eventData = message.data as RegistryEvent | undefined;

        // Create the event object
        const event: RegistryEvent = eventData || {
          type: eventType,
          timestamp: message.timestamp,
          correlation_id: generateCorrelationId(),
          payload: {},
        };

        // Deduplicate events - server may broadcast same event on multiple topics
        // (e.g., 'registry' and 'registry-nodes' both receive NODE_* events)
        const correlationId = event.correlation_id;
        if (correlationId && seenEventIds.current.has(correlationId)) {
          if (debug) {
            // eslint-disable-next-line no-console
            console.log('[RegistryWebSocket] Skipping duplicate event:', correlationId);
          }
          return;
        }
        if (correlationId) {
          seenEventIds.current.add(correlationId);
        }

        if (debug) {
          // eslint-disable-next-line no-console
          console.log('[RegistryWebSocket] Received event:', eventType, eventData);
        }

        // Update recent events
        setRecentEvents((prev) => {
          const newEvent: RecentRegistryEvent = {
            id: event.correlation_id || generateCorrelationId(),
            type: event.type,
            timestamp: new Date(event.timestamp),
            payload: event.payload,
            correlationId: event.correlation_id,
          };

          const updated = [newEvent, ...prev].slice(0, maxRecentEvents);

          // Memory cleanup: prevent unbounded growth of seenEventIds
          // When Set exceeds threshold, prune to only current event IDs
          // This ensures deduplication continues to work for visible events while
          // preventing memory leaks in long-running sessions
          if (seenEventIds.current.size > maxRecentEvents * SEEN_EVENT_IDS_CLEANUP_MULTIPLIER) {
            const currentIds = new Set(updated.map((e) => e.id));
            seenEventIds.current = currentIds;
          }

          return updated;
        });

        // Update stats
        // NOTE: eventsByType is bounded to max 11 keys (one per RegistryEventType).
        // This prevents memory leaks in long-running sessions since only events
        // passing the registryEventTypes.includes() check above reach this point.
        setStats((prev) => ({
          totalEventsReceived: prev.totalEventsReceived + 1,
          eventsByType: {
            ...prev.eventsByType,
            [eventType]: (prev.eventsByType[eventType] || 0) + 1,
          },
          lastEventTime: new Date(),
        }));

        // Call event callback if provided
        onEventRef.current?.(event);

        // Invalidate relevant queries based on event type
        // OMN-1279: Handle new event types with local state updates
        switch (eventType) {
          case 'NODE_REGISTERED':
          case 'NODE_STATE_CHANGED':
          case 'NODE_DEREGISTERED':
            // Node-level changes - full refetch
            queryClient.invalidateQueries({ queryKey: ['registry-discovery'] });
            queryClient.invalidateQueries({ queryKey: ['registry'] });
            break;

          case 'INSTANCE_HEALTH_CHANGED':
          case 'INSTANCE_ADDED':
          case 'INSTANCE_REMOVED':
            // Instance-level changes - full refetch
            queryClient.invalidateQueries({ queryKey: ['registry-discovery'] });
            queryClient.invalidateQueries({ queryKey: ['registry'] });
            break;

          case 'NODE_HEARTBEAT': {
            // OMN-1279: Update local projected node state for heartbeats
            // Heartbeats are frequent - update local state without full refetch
            const heartbeatParsed = WsNodeHeartbeatPayloadSchema.safeParse(event.payload);
            if (!heartbeatParsed.success) {
              if (debug) {
                console.warn(
                  '[RegistryWebSocket] Invalid heartbeat payload:',
                  heartbeatParsed.error
                );
              }
              break;
            }
            const heartbeatPayload = heartbeatParsed.data;
            if (heartbeatPayload.node_id) {
              updateNode(heartbeatPayload.node_id, {
                last_heartbeat_at: heartbeatPayload.last_heartbeat_at || Date.now(),
              });
            }
            break;
          }

          case 'NODE_ACTIVATED': {
            // OMN-1279: Node has completed activation - update local state
            const activatedParsed = WsNodeBecameActivePayloadSchema.safeParse(event.payload);
            if (!activatedParsed.success) {
              if (debug) {
                console.warn(
                  '[RegistryWebSocket] Invalid activated payload:',
                  activatedParsed.error
                );
              }
              break;
            }
            const activatedPayload = activatedParsed.data;
            if (activatedPayload.node_id) {
              const emittedAt = new Date(event.timestamp).getTime();
              updateNode(activatedPayload.node_id, {
                state: 'ACTIVE',
                capabilities: activatedPayload.capabilities,
                activated_at: emittedAt,
                last_heartbeat_at: emittedAt,
                last_event_at: emittedAt,
              });
            }
            // Invalidate queries to refetch full data for UI sync
            queryClient.invalidateQueries({ queryKey: ['registry-discovery'] });
            queryClient.invalidateQueries({ queryKey: ['registry'] });
            break;
          }

          case 'NODE_OFFLINE': {
            // OMN-1279: Node has gone offline - update local state
            const offlineParsed = WsNodeLivenessExpiredPayloadSchema.safeParse(event.payload);
            if (!offlineParsed.success) {
              if (debug) {
                console.warn('[RegistryWebSocket] Invalid offline payload:', offlineParsed.error);
              }
              break;
            }
            const offlinePayload = offlineParsed.data;
            if (offlinePayload.node_id) {
              const emittedAt = new Date(event.timestamp).getTime();
              updateNode(offlinePayload.node_id, {
                state: 'OFFLINE',
                offline_at: emittedAt,
                last_event_at: emittedAt,
              });
            }
            queryClient.invalidateQueries({ queryKey: ['registry-discovery'] });
            queryClient.invalidateQueries({ queryKey: ['registry'] });
            break;
          }

          case 'NODE_INTROSPECTION': {
            // OMN-1279: Node introspection received - update capabilities
            const introspectionParsed = WsNodeIntrospectionPayloadSchema.safeParse(event.payload);
            if (!introspectionParsed.success) {
              if (debug) {
                console.warn(
                  '[RegistryWebSocket] Invalid introspection payload:',
                  introspectionParsed.error
                );
              }
              break;
            }
            const introspectionPayload = introspectionParsed.data;
            if (introspectionPayload.node_id) {
              const emittedAt = new Date(event.timestamp).getTime();
              updateNode(introspectionPayload.node_id, {
                state: 'PENDING',
                capabilities: introspectionPayload.capabilities,
                last_event_at: emittedAt,
              });
            }
            queryClient.invalidateQueries({ queryKey: ['registry-discovery'] });
            queryClient.invalidateQueries({ queryKey: ['registry'] });
            break;
          }
        }
      } catch (err) {
        // Log error in debug mode but don't propagate - component should remain stable
        if (debug) {
          console.error('[RegistryWebSocket] Error processing message:', err, message);
        }
      }
    },
    [debug, maxRecentEvents, queryClient, updateNode]
  );

  const { isConnected, connectionStatus, error, subscribe, unsubscribe, reconnect } = useWebSocket({
    onMessage: handleMessage,
    debug,
  });

  // Subscribe to registry topics when connected
  useEffect(() => {
    if (isConnected && autoSubscribe && !hasSubscribed.current) {
      if (debug) {
        // eslint-disable-next-line no-console
        console.log('[RegistryWebSocket] Subscribing to registry topics:', REGISTRY_TOPICS);
      }
      // OMN-1279: Subscribe to both registry topics for complete event coverage
      subscribe([...REGISTRY_TOPICS]);
      hasSubscribed.current = true;
    }

    // Reset subscription flag when disconnected
    if (!isConnected) {
      hasSubscribed.current = false;
    }

    // Cleanup: unsubscribe when unmounting or when autoSubscribe changes
    return () => {
      if (hasSubscribed.current && isConnected) {
        if (debug) {
          // eslint-disable-next-line no-console
          console.log('[RegistryWebSocket] Unsubscribing from registry topics');
        }
        unsubscribe([...REGISTRY_TOPICS]);
        hasSubscribed.current = false;
      }
    };
  }, [isConnected, autoSubscribe, subscribe, unsubscribe, debug]);

  // Periodic cleanup of stale offline nodes to prevent unbounded memory growth
  // Removes nodes that have been OFFLINE for longer than OFFLINE_NODE_TTL_MS
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setProjectedNodes((prev) => {
        const newMap = new Map(prev);
        let cleaned = 0;

        for (const [nodeId, node] of prev) {
          // Only clean up nodes that are OFFLINE and have been offline for longer than threshold
          if (
            node.state === 'OFFLINE' &&
            node.offline_at &&
            now - node.offline_at > OFFLINE_NODE_TTL_MS
          ) {
            newMap.delete(nodeId);
            cleaned++;
          }
        }

        if (cleaned > 0) {
          if (debug) {
            // eslint-disable-next-line no-console
            console.log(`[RegistryWebSocket] Cleaned up ${cleaned} stale offline nodes`);
          }
          return newMap;
        }

        // Return previous reference if nothing changed to avoid unnecessary re-renders
        return prev;
      });
    }, CLEANUP_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [debug]);

  /**
   * Clear all recent events, projected nodes, and reset stats.
   * This provides a manual reset mechanism for long-running sessions,
   * though eventsByType is already bounded to 11 keys (one per RegistryEventType).
   */
  const clearEvents = useCallback(() => {
    setRecentEvents([]);
    // Reset all stats including eventsByType counts
    setStats({
      totalEventsReceived: 0,
      eventsByType: {} as Record<RegistryEventType, number>,
      lastEventTime: null,
    });
    // Also clear seen event IDs to allow re-processing if needed
    seenEventIds.current.clear();
    // OMN-1279: Clear projected nodes state
    setProjectedNodes(new Map());
  }, []);

  return {
    isConnected,
    connectionStatus,
    error,
    recentEvents,
    projectedNodes,
    clearEvents,
    reconnect,
    stats,
  };
}
