import WebSocket, { WebSocketServer } from 'ws';
import { Server as HTTPServer } from 'http';
import type { IncomingMessage } from 'http';
import { z } from 'zod';
import { getSessionMiddleware } from './auth/session-config';
import { isAuthEnabled } from './auth/oidc-client';
import {
  eventConsumer,
  type NodeIntrospectionEvent,
  type NodeHeartbeatEvent,
  type NodeStateChangeEvent,
  type RegisteredNode,
} from './event-consumer';
import {
  transformNodeIntrospectionToSnakeCase,
  transformNodeHeartbeatToSnakeCase,
  transformNodeStateChangeToSnakeCase,
  transformNodesToSnakeCase,
} from './utils/case-transform';
import { registryEventEmitter, type RegistryEvent } from './registry-events';
import {
  intentEventEmitter,
  type IntentStoredEventPayload,
  type IntentDistributionEventPayload,
  type IntentSessionEventPayload,
  type IntentRecentEventPayload,
} from './intent-events';
import { insightsEventEmitter } from './insights-events';
import { baselinesEventEmitter } from './baselines-events';
import { llmRoutingEventEmitter } from './llm-routing-events';
import { effectivenessEventEmitter } from './effectiveness-events';
import { enrichmentEventEmitter } from './enrichment-events';
import { enforcementEventEmitter } from './enforcement-events';
import { delegationEventEmitter } from './delegation-events';
import { statusEventEmitter } from './status-events';
// Wave 2 emitters (OMN-2602)
import {
  gateDecisionEventEmitter,
  epicRunEventEmitter,
  prWatchEventEmitter,
  pipelineBudgetEventEmitter,
  circuitBreakerEventEmitter,
} from './omniclaude-state-events';
import { projectionService } from './projection-bootstrap';
import { getEventBusDataSource, type EventBusEvent } from './event-bus-data-source';
import { getPlaybackDataSource } from './playback-data-source';
import { playbackEventEmitter, type PlaybackWSMessage } from './playback-events';
import { ENVIRONMENT_PREFIXES } from '@shared/topics';

/**
 * Wrap an async function so that rejections are caught and logged.
 * Node's EventEmitter does NOT await async handlers — a thrown error
 * becomes an unhandled promise rejection. This wrapper guarantees
 * that errors are caught even if future edits accidentally move code
 * outside of an inner try/catch.
 */
function safeAsyncHandler<T extends unknown[]>(
  label: string,
  fn: (...args: T) => Promise<void>
): (...args: T) => void {
  return (...args: T) => {
    fn(...args).catch((err) => {
      console.error(`[WebSocket] Unhandled error in ${label}:`, err);
    });
  };
}

/**
 * Structural tokens to strip when extracting action from ONEX canonical topics.
 * These appear in the topic path but don't carry semantic meaning for display.
 */
const ONEX_STRUCTURAL_TOKENS = new Set(['onex', 'evt', 'cmd', 'snapshot', 'intent', 'dlq']);

/**
 * Extract actionType and actionName from an ONEX canonical topic string.
 *
 * Handles variable segment counts by stripping known structural tokens and version
 * suffixes instead of relying on positional indexing.
 *
 * Examples:
 *   "dev.onex.evt.platform.node-heartbeat.v1"           → { actionType: "node-heartbeat", actionName: "onex.evt.platform.node-heartbeat.v1" }
 *   "dev.onex.evt.omniintelligence.tool-content.v1"     → { actionType: "tool-content",   actionName: "onex.evt.omniintelligence.tool-content.v1" }
 *   "onex.cmd.platform.request-introspection.v1"        → { actionType: "request-introspection", actionName: "onex.cmd.platform.request-introspection.v1" }
 *   "dev.onex.snapshot.platform.registration-snapshots.v1" → { actionType: "registration-snapshots", ... }
 */
export function extractActionFromTopic(topicParts: string[]): {
  actionType: string;
  actionName: string;
} {
  const onexIdx = topicParts.indexOf('onex');
  if (onexIdx < 0) {
    return { actionType: topicParts[0] || 'unknown', actionName: topicParts.join('.') };
  }

  // Slice from 'onex' onward for traceability name
  const onexSlice = topicParts.slice(onexIdx);
  const actionName = onexSlice.join('.');

  // Filter out structural tokens and version suffixes to find meaningful segments
  const meaningful = onexSlice.filter(
    (seg) => !ONEX_STRUCTURAL_TOKENS.has(seg) && !/^v\d+$/.test(seg)
  );

  // Last meaningful segment is the action; fallback to 'unknown'
  const actionType = meaningful.length > 0 ? meaningful[meaningful.length - 1] : 'unknown';

  return { actionType, actionName };
}

/**
 * Transform EventBusEvent from database to client-expected format
 * Maps event_type patterns to actionType/actionName for UI display
 */
interface ClientAction {
  id: string;
  correlationId: string;
  agentName: string;
  actionType: string;
  actionName: string;
  actionDetails?: any;
  durationMs: number;
  createdAt: Date;
}

function transformEventToClientAction(event: EventBusEvent): ClientAction {
  const rawEventType = event.event_type || 'unknown';

  // When event_type is just an env prefix (junk from upstream), fall back to topic name
  const eventType =
    (ENVIRONMENT_PREFIXES as readonly string[]).includes(rawEventType) && event.topic
      ? event.topic
      : rawEventType;

  // Parse event_type to derive actionType and actionName
  // Common patterns: "UserPromptSubmit", "hook.prompt.submitted", "dev.onex.cmd.producer.action.v1"
  let actionType = 'event';
  let actionName = eventType;

  if (eventType.includes('.')) {
    const parts = eventType.split('.');
    // Canonical ONEX format: {env}.onex.{kind}.{producer}.{action}.v{N}
    // or suffix: onex.{kind}.{producer}.{action}.v{N}
    const onexIdx = parts.indexOf('onex');
    if (onexIdx >= 0) {
      const extracted = extractActionFromTopic(parts);
      actionType = extracted.actionType;
      actionName = extracted.actionName;
    } else {
      // Generic dot-notation: "hook.prompt.submitted" -> type: "hook", name: "prompt.submitted"
      actionType = parts[0];
      actionName = parts.slice(1).join('.');
    }
  } else if (/[A-Z]/.test(eventType)) {
    // PascalCase format: "UserPromptSubmit" -> type: "user", name: "prompt_submit"
    const snakeCase = eventType
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '');
    const parts = snakeCase.split('_');
    if (parts.length >= 2) {
      actionType = parts[0];
      actionName = parts.slice(1).join('_');
    }
  }

  // Type guard: ensure payload is an object before accessing properties
  const payloadIsObject =
    event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload);
  const payload = payloadIsObject ? (event.payload as Record<string, unknown>) : {};

  // Extract agent name from source, payload, or canonical topic structure
  let agentName =
    (payload.agent_name as string) || (payload.agentName as string) || event.source || 'system';

  // If source is "unknown", try to extract producer from canonical topic name
  if (agentName === 'unknown' && event.topic) {
    const topicParts = event.topic.split('.');
    const onexIdx = topicParts.indexOf('onex');
    if (onexIdx >= 0 && topicParts.length >= onexIdx + 3) {
      agentName = topicParts[onexIdx + 2] || agentName; // e.g. "omniintelligence"
    }
  }

  // Extract duration from payload if available
  const durationMs =
    (payload.duration_ms as number) ||
    (payload.durationMs as number) ||
    (payload.latency_ms as number) ||
    0;

  return {
    id: event.event_id,
    correlationId: event.correlation_id || event.event_id,
    agentName,
    actionType,
    actionName,
    actionDetails: event.payload,
    durationMs,
    createdAt: new Date(event.timestamp),
  };
}

/**
 * Get real events for WebSocket INITIAL_STATE by querying PostgreSQL directly.
 *
 * EventBusDataSource writes events from 197+ Kafka topics to the DB, while
 * EventConsumer's in-memory buffer only covers ~30 topics. Querying the DB
 * ensures INITIAL_STATE includes ALL event types — not just those EventConsumer
 * tracks — so events persist across page reloads.
 *
 * Falls back to EventConsumer's in-memory buffer if the DB query fails.
 */
async function getEventsForInitialState(): Promise<{
  recentActions: ClientAction[];
  eventBusEvents: EventBusEvent[];
}> {
  // Primary path: query PostgreSQL for latest events across ALL topics
  const dataSource = getEventBusDataSource();
  if (dataSource) {
    try {
      const events = await dataSource.queryEvents({
        limit: 200,
        order_by: 'timestamp',
        order_direction: 'desc',
      });

      if (events.length > 0) {
        const recentActions = events.map(transformEventToClientAction);
        return { recentActions, eventBusEvents: events };
      }
    } catch (error) {
      console.error(
        '[WebSocket] Failed to query DB for initial state, falling back to in-memory:',
        error
      );
    }
  }

  // Fallback: use EventConsumer's in-memory buffer (covers only ~30 topics)
  const events = eventConsumer.getPreloadedEventBusEvents();
  if (events.length === 0) {
    return { recentActions: [], eventBusEvents: [] };
  }
  const recentActions = events.map(transformEventToClientAction);
  return { recentActions, eventBusEvents: events };
}

// Valid subscription topics that clients can subscribe to
const VALID_TOPICS = [
  'all',
  'metrics',
  'actions',
  'routing',
  'transformations',
  'performance',
  'errors',
  'system',
  'node-introspection',
  'node-heartbeat',
  'node-state-change',
  'node-registry',
  // Registry discovery topics (Phase 4 - OMN-1278)
  'registry',
  'registry-nodes',
  'registry-instances',
  // Intent classification events (OMN-1516)
  'intent',
  // Event Bus Monitor events (real-time Kafka events)
  'event-bus',
  // Demo playback events (OMN-1843)
  'playback',
  // Cross-repo validation events (OMN-1907)
  'validation',
  // Extraction pipeline events (OMN-1804)
  'extraction',
  // Projection invalidation events (OMN-2095/OMN-2096)
  'projections',
  // Learned insights invalidation events (OMN-2306)
  'insights',
  // Execution graph live node events (OMN-2302)
  'execution-graph',
  // LLM routing invalidation events (OMN-2279)
  'llm-routing',
  // Effectiveness metrics invalidation events (OMN-2328)
  'effectiveness',
  // Baselines ROI invalidation events (OMN-2331)
  'baselines',
  // Delegation metrics invalidation events (OMN-2284)
  'delegation',
  // Context enrichment invalidation events (OMN-2280 / OMN-2373)
  'enrichment',
  // Pattern enforcement invalidation events (OMN-2374)
  'enforcement',
  // Status dashboard invalidation events (OMN-2658)
  'status',
  // Wave 2 omniclaude state event topics (OMN-2602)
  'gate-decisions',
  'epic-run',
  'pr-watch',
  'pipeline-budget',
  'debug-escalation',
] as const;

type _ValidTopic = (typeof VALID_TOPICS)[number];

/**
 * Validates a topic string. Accepts static VALID_TOPICS entries or any
 * topic matching `projection:<viewId>` for dynamic projection views (OMN-2097).
 */
const PROJECTION_TOPIC_PATTERN = /^projection:[a-zA-Z0-9_-]+$/;

const validTopicSchema = z.union([
  z.enum(VALID_TOPICS),
  z.string().regex(PROJECTION_TOPIC_PATTERN),
]);

// Zod schema for validating WebSocket client messages
const WebSocketMessageSchema = z.object({
  action: z.enum(['subscribe', 'unsubscribe', 'ping', 'getState']),
  topics: z.union([validTopicSchema, z.array(validTopicSchema)]).optional(),
});

type _WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;

interface ClientData {
  ws: WebSocket;
  subscriptions: Set<string>;
  lastPing: Date;
  isAlive: boolean;
  missedPings: number;
}

export function setupWebSocket(httpServer: HTTPServer) {
  console.log('Initializing WebSocket server...');

  // Use noServer mode to avoid intercepting non-/ws upgrade requests (e.g.,
  // Vite HMR in dev mode). When { server, path } is used, the ws library
  // registers an 'upgrade' listener that calls abortHandshake(socket, 400)
  // for paths that don't match — this destroys the socket before Vite's HMR
  // handler can process it, causing 400 errors in development.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url || '/', `http://${request.headers.host}`);
    if (pathname === '/ws') {
      // Parse session cookie for auth check
      const sessionMiddleware = getSessionMiddleware();
      const resShim = {
        getHeader: () => undefined,
        setHeader: () => resShim,
        writeHead: () => resShim,
        end: () => {},
      } as any;

      sessionMiddleware(request as any, resShim, () => {
        const session = (request as any).session;
        if (isAuthEnabled() && (!session?.user || !session?.tokenSet)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      });
    }
    // Non-/ws paths (e.g., Vite HMR): do nothing — let other listeners handle them
  });

  // Track connected clients with their preferences
  const clients = new Map<WebSocket, ClientData>();

  /**
   * Memory Leak Prevention Strategy:
   *
   * EventConsumer listeners are SERVER-WIDE, not per-client. They broadcast to ALL connected clients.
   * This array tracks all listeners registered with EventConsumer so we can remove them when the server closes.
   *
   * Why we track listeners:
   * - EventEmitters keep references to all registered handlers
   * - Without cleanup, restarting the WebSocket server would accumulate handlers
   * - Each restart would add 6 more listeners (metricUpdate, actionUpdate, routingUpdate, error, connected, disconnected)
   * - Over time, this causes memory leaks and duplicate event handling
   *
   * Cleanup happens in wss.on('close') handler:
   * - All listeners are removed from EventConsumer
   * - eventListeners array is cleared
   * - All client connections are terminated
   * - clients Map is cleared
   *
   * Note: We do NOT remove listeners when individual clients disconnect because listeners are shared.
   * The broadcast() function filters events per-client based on their subscriptions.
   */
  const eventListeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  // Heartbeat interval (30 seconds) with tolerance for missed pings
  const HEARTBEAT_INTERVAL_MS = 30000;
  const MAX_MISSED_PINGS = 2; // Allow 2 missed pings before terminating (60s total)

  const heartbeatInterval = setInterval(() => {
    clients.forEach((clientData, ws) => {
      if (!clientData.isAlive) {
        clientData.missedPings++;
        console.log(`Client missed heartbeat (${clientData.missedPings}/${MAX_MISSED_PINGS})`);

        // Only terminate after multiple missed pings
        if (clientData.missedPings >= MAX_MISSED_PINGS) {
          console.log('Client failed multiple heartbeats, terminating connection');
          clients.delete(ws);
          return ws.terminate();
        }
      } else {
        // Reset missed pings if client responded
        clientData.missedPings = 0;
      }

      clientData.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  // Helper function to register EventConsumer listeners with cleanup tracking
  const registerEventListener = <T extends any[]>(event: string, handler: (...args: T) => void) => {
    eventConsumer.on(event, handler);
    eventListeners.push({ event, handler });
  };

  // Broadcast helper function with filtering
  const broadcast = (type: string, data: any, eventType?: string) => {
    const message = JSON.stringify({
      type,
      data,
      timestamp: new Date().toISOString(),
    });

    clients.forEach((clientData, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        // Apply subscription filtering if event type is provided
        if (eventType && clientData.subscriptions.size > 0) {
          if (!clientData.subscriptions.has(eventType) && !clientData.subscriptions.has('all')) {
            return; // Skip this client
          }
        }

        ws.send(message);
      }
    });
  };

  // Listen to EventConsumer events with automatic cleanup tracking
  registerEventListener('metricUpdate', (metrics) => {
    broadcast('AGENT_METRIC_UPDATE', metrics, 'metrics');
  });

  registerEventListener('actionUpdate', (action) => {
    broadcast('AGENT_ACTION', action, 'actions');
  });

  registerEventListener('routingUpdate', (decision) => {
    broadcast('ROUTING_DECISION', decision, 'routing');
  });

  registerEventListener('transformationUpdate', (transformation) => {
    broadcast('AGENT_TRANSFORMATION', transformation, 'transformations');
  });

  registerEventListener('performanceUpdate', ({ metric, stats }) => {
    broadcast('PERFORMANCE_METRIC', { metric, stats }, 'performance');
  });

  registerEventListener('error', (error) => {
    console.error('EventConsumer error:', error);
    broadcast(
      'ERROR',
      {
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      'errors'
    );
  });

  registerEventListener('connected', () => {
    console.log('EventConsumer connected');
    broadcast('CONSUMER_STATUS', { status: 'connected' }, 'system');
  });

  registerEventListener('disconnected', () => {
    console.log('EventConsumer disconnected');
    broadcast('CONSUMER_STATUS', { status: 'disconnected' }, 'system');
  });

  // Demo mode state events - signal clients to clear/restore their local state
  registerEventListener('stateReset', () => {
    console.log('[WebSocket] Demo mode: state reset - broadcasting DEMO_STATE_RESET');
    broadcast('DEMO_STATE_RESET', { timestamp: Date.now() }, 'all');
  });

  registerEventListener('stateRestored', () => {
    console.log('[WebSocket] Demo mode: state restored - broadcasting DEMO_STATE_RESTORED');
    broadcast('DEMO_STATE_RESTORED', { timestamp: Date.now() }, 'all');

    // After notifying clients to clear their state, send fresh initial state with restored data.
    // Query PostgreSQL for full event set (same path as connection handler) so all 197+ topics
    // are included, not just EventConsumer's ~30 topic in-memory buffer.
    // Small delay (100ms) ensures DEMO_STATE_RESTORED is processed first.
    void setTimeout(
      safeAsyncHandler('demo-restore', async () => {
        console.log('[WebSocket] Demo mode: broadcasting restored INITIAL_STATE');
        const { recentActions: realActions, eventBusEvents } = await getEventsForInitialState();
        const legacyActions = eventConsumer.getRecentActions();
        const combinedActions = realActions.length > 0 ? realActions : legacyActions;

        broadcast(
          'INITIAL_STATE',
          {
            metrics: eventConsumer.getAgentMetrics(),
            recentActions: combinedActions,
            routingDecisions: eventConsumer.getRoutingDecisions(),
            recentTransformations: eventConsumer.getRecentTransformations(),
            performanceStats: eventConsumer.getPerformanceStats(),
            health: eventConsumer.getHealthStatus(),
            registeredNodes: transformNodesToSnakeCase(eventConsumer.getRegisteredNodes()),
            nodeRegistryStats: eventConsumer.getNodeRegistryStats(),
            eventBusEvents: eventBusEvents,
          },
          'all'
        );
      }),
      100
    );
  });

  registerEventListener('stateSnapshotted', () => {
    console.log('[WebSocket] Demo mode: state snapshotted');
    // No broadcast needed - just logging for debugging
  });

  // Cross-repo validation event listener (OMN-1907)
  // Broadcasts validation lifecycle events (run-started, violations-batch, run-completed)
  // to clients subscribed to the 'validation' topic
  registerEventListener('validation-event', (data: { type: string; event: any }) => {
    // Send minimal payload - clients only need the type for query invalidation,
    // plus run_id for targeted cache updates. Full violation data stays server-side.
    broadcast('VALIDATION_EVENT', { type: data.type, run_id: data.event?.run_id }, 'validation');
  });

  // Extraction pipeline event listener (OMN-1804)
  // Invalidation-only broadcast: tells clients to re-fetch, does NOT carry data payloads.
  // PostgreSQL is the single source of truth; clients re-query API endpoints on invalidation.
  registerEventListener('extraction-event', (data: { type: string }) => {
    broadcast('EXTRACTION_INVALIDATE', { type: data.type }, 'extraction');
  });

  // Learned Insights invalidation listener (OMN-2306)
  // Tells clients to re-fetch insights data when new patterns are learned.
  // Uses insightsEventEmitter (not eventConsumer) so any module can trigger it.
  const insightsUpdateHandler = () => {
    broadcast('INSIGHTS_UPDATE', { timestamp: Date.now() }, 'insights');
  };
  insightsEventEmitter.on('insights-update', insightsUpdateHandler);

  // Baselines invalidation listener (OMN-2331)
  // Tells clients to re-fetch baselines data when a new snapshot is projected.
  // Uses baselinesEventEmitter so ReadModelConsumer can trigger it after projecting.
  const baselinesUpdateHandler = (data: { snapshotId: string }) => {
    broadcast(
      'BASELINES_UPDATE',
      { snapshotId: data.snapshotId, timestamp: Date.now() },
      'baselines'
    );
  };
  baselinesEventEmitter.on('baselines-update', baselinesUpdateHandler);

  // LLM routing invalidation listener (OMN-2279)
  // Tells clients to re-fetch LLM routing data when a new routing decision is projected.
  // Uses llmRoutingEventEmitter so ReadModelConsumer can trigger it after projecting.
  // Invalidation-only broadcast: clients re-query the /api/llm-routing/* endpoints on receipt.
  const llmRoutingInvalidateHandler = (data: { correlationId: string }) => {
    broadcast(
      'LLM_ROUTING_INVALIDATE',
      { correlationId: data.correlationId, timestamp: Date.now() },
      'llm-routing'
    );
  };
  llmRoutingEventEmitter.on('llm-routing-invalidate', llmRoutingInvalidateHandler);

  // Effectiveness invalidation listener (OMN-2328)
  // Tells clients to re-fetch effectiveness data when new measurements are projected.
  // Uses effectivenessEventEmitter so any module can trigger it without coupling to eventConsumer.
  const effectivenessUpdateHandler = () => {
    broadcast('EFFECTIVENESS_UPDATE', { timestamp: Date.now() }, 'effectiveness');
  };
  effectivenessEventEmitter.on('effectiveness-update', effectivenessUpdateHandler);

  // Context enrichment invalidation listener (OMN-2373)
  // Tells clients to re-fetch enrichment data when a new enrichment event is projected.
  // Uses enrichmentEventEmitter so ReadModelConsumer can trigger it after projecting.
  // Invalidation-only broadcast: clients re-query the /api/enrichment/* endpoints on receipt.
  const enrichmentInvalidateHandler = (data: { correlationId: string }) => {
    broadcast(
      'ENRICHMENT_INVALIDATE',
      { correlationId: data.correlationId, timestamp: Date.now() },
      'enrichment'
    );
  };
  enrichmentEventEmitter.on('enrichment-invalidate', enrichmentInvalidateHandler);

  // Pattern enforcement invalidation listener (OMN-2374)
  // Tells clients to re-fetch enforcement data when a new enforcement event is projected.
  // Uses enforcementEventEmitter so ReadModelConsumer can trigger it after projecting.
  // Invalidation-only broadcast: clients re-query the /api/enforcement/* endpoints on receipt.
  const enforcementInvalidateHandler = (data: { correlationId: string }) => {
    broadcast(
      'ENFORCEMENT_INVALIDATE',
      { correlationId: data.correlationId, timestamp: Date.now() },
      'enforcement'
    );
  };
  enforcementEventEmitter.on('enforcement-invalidate', enforcementInvalidateHandler);

  // Delegation invalidation listener (OMN-2284)
  // Tells clients to re-fetch delegation data when a new delegation event is projected.
  // Uses delegationEventEmitter so ReadModelConsumer can trigger it after projecting
  // onex.evt.omniclaude.task-delegated.v1 or delegation-shadow-comparison.v1.
  // Invalidation-only broadcast: clients re-query the /api/delegation/* endpoints on receipt.
  const delegationInvalidateHandler = (data: { correlationId: string }) => {
    broadcast(
      'DELEGATION_INVALIDATE',
      { correlationId: data.correlationId, timestamp: Date.now() },
      'delegation'
    );
  };
  delegationEventEmitter.on('delegation-invalidate', delegationInvalidateHandler);

  // Status dashboard invalidation listener (OMN-2658)
  // Tells clients to re-fetch /api/status/* when a new PR, hook, or Linear snapshot event arrives.
  const statusInvalidateHandler = (data: { source: string; timestamp: number }) => {
    broadcast('STATUS_INVALIDATE', { source: data.source, timestamp: data.timestamp }, 'status');
  };
  statusEventEmitter.on('status-invalidate', statusInvalidateHandler);

  // Wave 2 state event invalidation listeners (OMN-2602)
  // Tells clients to re-fetch Wave 2 dashboard data when events are projected.

  const gateDecisionInvalidateHandler = (data: { correlationId: string }) => {
    broadcast('GATE_DECISION_INVALIDATE', { correlationId: data.correlationId, timestamp: Date.now() }, 'gate-decisions');
  };
  gateDecisionEventEmitter.on('gate-decision-invalidate', gateDecisionInvalidateHandler);

  const epicRunInvalidateHandler = (data: { epicRunId: string }) => {
    broadcast('EPIC_RUN_INVALIDATE', { epicRunId: data.epicRunId, timestamp: Date.now() }, 'epic-run');
  };
  epicRunEventEmitter.on('epic-run-invalidate', epicRunInvalidateHandler);

  const prWatchInvalidateHandler = (data: { correlationId: string }) => {
    broadcast('PR_WATCH_INVALIDATE', { correlationId: data.correlationId, timestamp: Date.now() }, 'pr-watch');
  };
  prWatchEventEmitter.on('pr-watch-invalidate', prWatchInvalidateHandler);

  const pipelineBudgetInvalidateHandler = (data: { correlationId: string }) => {
    broadcast('PIPELINE_BUDGET_INVALIDATE', { correlationId: data.correlationId, timestamp: Date.now() }, 'pipeline-budget');
  };
  pipelineBudgetEventEmitter.on('pipeline-budget-invalidate', pipelineBudgetInvalidateHandler);

  const debugEscalationInvalidateHandler = (data: { correlationId: string }) => {
    broadcast('DEBUG_ESCALATION_INVALIDATE', { correlationId: data.correlationId, timestamp: Date.now() }, 'debug-escalation');
  };
  circuitBreakerEventEmitter.on('circuit-breaker-invalidate', debugEscalationInvalidateHandler);

  // Node Registry event listeners
  registerEventListener('nodeIntrospectionUpdate', (event: NodeIntrospectionEvent) => {
    // Transform to client-expected format (snake_case for consistency with Kafka events)
    const data = transformNodeIntrospectionToSnakeCase(event);
    broadcast('NODE_INTROSPECTION', data, 'node-introspection');
  });

  registerEventListener('nodeHeartbeatUpdate', (event: NodeHeartbeatEvent) => {
    // Transform to client-expected format
    const data = transformNodeHeartbeatToSnakeCase(event);
    broadcast('NODE_HEARTBEAT', data, 'node-heartbeat');
  });

  registerEventListener('nodeStateChangeUpdate', (event: NodeStateChangeEvent) => {
    // Transform to client-expected format
    const data = transformNodeStateChangeToSnakeCase(event);
    broadcast('NODE_STATE_CHANGE', data, 'node-state-change');
  });

  registerEventListener('nodeRegistryUpdate', (nodes: RegisteredNode[]) => {
    // Transform to client-expected format (snake_case for registered nodes)
    const data = transformNodesToSnakeCase(nodes);
    broadcast('NODE_REGISTRY_UPDATE', data, 'node-registry');
  });

  // Intent classification event listeners (OMN-1516)
  // Note: Intent events are emitted from intentEventEmitter, NOT eventConsumer
  const intentStoredHandler = (payload: IntentStoredEventPayload) => {
    broadcast('INTENT_UPDATE', payload, 'intent');
  };

  const intentDistributionHandler = (payload: IntentDistributionEventPayload) => {
    broadcast('INTENT_DISTRIBUTION', payload, 'intent');
  };

  const intentSessionHandler = (payload: IntentSessionEventPayload) => {
    broadcast('INTENT_SESSION', payload, 'intent');
  };

  const intentRecentHandler = (payload: IntentRecentEventPayload) => {
    broadcast('INTENT_RECENT', payload, 'intent');
  };

  // Register listeners on intentEventEmitter (not eventConsumer)
  intentEventEmitter.on('intentStored', intentStoredHandler);
  intentEventEmitter.on('intentDistribution', intentDistributionHandler);
  intentEventEmitter.on('intentSession', intentSessionHandler);
  intentEventEmitter.on('intentRecent', intentRecentHandler);

  // Playback event listener (OMN-1843)
  // Broadcasts playback lifecycle and progress events to clients subscribed to 'playback' topic
  const playbackHandler = (message: PlaybackWSMessage) => {
    // Broadcast with the message type (e.g., 'playback:start', 'playback:progress')
    // The full message includes status, and optionally speed/loop for change events
    broadcast(message.type, message, 'playback');
  };

  playbackEventEmitter.on('playback', playbackHandler);

  // Track playback listener for cleanup
  const playbackListeners = [
    { emitter: playbackEventEmitter, event: 'playback', handler: playbackHandler },
  ];

  // Registry Discovery event listeners (OMN-1278 Phase 4)
  // These provide granular registry events for the registry discovery dashboard
  const registryHandler = (event: RegistryEvent) => {
    // Broadcast to 'registry' topic (all registry events)
    broadcast(event.type, event, 'registry');
  };

  const registryNodesHandler = (event: RegistryEvent) => {
    // Broadcast to 'registry-nodes' topic (node-specific events)
    broadcast(event.type, event, 'registry-nodes');
  };

  const registryInstancesHandler = (event: RegistryEvent) => {
    // Broadcast to 'registry-instances' topic (instance-specific events)
    broadcast(event.type, event, 'registry-instances');
  };

  // Register registry event listeners
  registryEventEmitter.on('registry', registryHandler);
  registryEventEmitter.on('registry-nodes', registryNodesHandler);
  registryEventEmitter.on('registry-instances', registryInstancesHandler);

  // Track these listeners for cleanup (manually since they use a different emitter)
  const registryListeners = [
    { emitter: registryEventEmitter, event: 'registry', handler: registryHandler },
    { emitter: registryEventEmitter, event: 'registry-nodes', handler: registryNodesHandler },
    {
      emitter: registryEventEmitter,
      event: 'registry-instances',
      handler: registryInstancesHandler,
    },
  ];

  // Track intent event listeners for cleanup (OMN-1516)
  const intentListeners = [
    { emitter: intentEventEmitter, event: 'intentStored', handler: intentStoredHandler },
    {
      emitter: intentEventEmitter,
      event: 'intentDistribution',
      handler: intentDistributionHandler,
    },
    { emitter: intentEventEmitter, event: 'intentSession', handler: intentSessionHandler },
    { emitter: intentEventEmitter, event: 'intentRecent', handler: intentRecentHandler },
  ];

  // Event Bus data source listeners (real-time Kafka events for Event Bus Monitor)
  // These events come from eventBusDataSource which consumes from Kafka topics
  const eventBusDataSource = getEventBusDataSource();
  const eventBusListeners: Array<{
    emitter: ReturnType<typeof getEventBusDataSource>;
    event: string;
    handler: (...args: any[]) => void;
  }> = [];

  if (eventBusDataSource) {
    // Handler for real-time events from Kafka
    const eventBusEventHandler = (event: EventBusEvent) => {
      // Transform EventBusEvent to client-expected format
      const transformedEvent = {
        id: event.event_id,
        event_type: event.event_type,
        timestamp: event.timestamp,
        tenant_id: event.tenant_id,
        namespace: event.namespace,
        source: event.source,
        correlation_id: event.correlation_id,
        causation_id: event.causation_id,
        schema_ref: event.schema_ref,
        payload: event.payload,
        topic: event.topic,
        partition: event.partition,
        offset: event.offset,
        processed_at: event.processed_at.toISOString(),
      };

      broadcast('EVENT_BUS_EVENT', transformedEvent, 'event-bus');
    };

    // Handler for connection status
    const eventBusConnectedHandler = () => {
      console.log('[WebSocket] EventBusDataSource connected');
      broadcast('EVENT_BUS_STATUS', { status: 'connected' }, 'event-bus');
    };

    const eventBusDisconnectedHandler = () => {
      console.log('[WebSocket] EventBusDataSource disconnected');
      broadcast('EVENT_BUS_STATUS', { status: 'disconnected' }, 'event-bus');
    };

    const eventBusErrorHandler = (error: Error) => {
      console.error('[WebSocket] EventBusDataSource error:', error);
      broadcast(
        'EVENT_BUS_ERROR',
        { message: error.message, timestamp: new Date().toISOString() },
        'event-bus'
      );
    };

    // Register listeners
    eventBusDataSource.on('event', eventBusEventHandler);
    eventBusDataSource.on('connected', eventBusConnectedHandler);
    eventBusDataSource.on('disconnected', eventBusDisconnectedHandler);
    eventBusDataSource.on('error', eventBusErrorHandler);

    // Track for cleanup
    eventBusListeners.push(
      { emitter: eventBusDataSource, event: 'event', handler: eventBusEventHandler },
      { emitter: eventBusDataSource, event: 'connected', handler: eventBusConnectedHandler },
      { emitter: eventBusDataSource, event: 'disconnected', handler: eventBusDisconnectedHandler },
      { emitter: eventBusDataSource, event: 'error', handler: eventBusErrorHandler }
    );

    console.log('[WebSocket] EventBusDataSource listeners registered for real-time events');
  } else {
    console.error(
      '[WebSocket] EventBusDataSource not available — Kafka is not configured. Real-time event-bus subscription will not function.'
    );
  }

  // Execution graph event listener (OMN-2302)
  // Re-broadcasts AGENT_ACTION, ROUTING_DECISION, and AGENT_TRANSFORMATION events to clients
  // subscribed to the 'execution-graph' topic so the graph page can build live graphs.
  registerEventListener('actionUpdate', (action) => {
    broadcast('EXECUTION_GRAPH_EVENT', { type: 'AGENT_ACTION', data: action }, 'execution-graph');
  });

  registerEventListener('routingUpdate', (decision) => {
    broadcast(
      'EXECUTION_GRAPH_EVENT',
      { type: 'ROUTING_DECISION', data: decision },
      'execution-graph'
    );
  });

  registerEventListener('transformationUpdate', (transformation) => {
    broadcast(
      'EXECUTION_GRAPH_EVENT',
      { type: 'AGENT_TRANSFORMATION', data: transformation },
      'execution-graph'
    );
  });

  // Projection invalidation bridge (OMN-2095)
  // Bridges the server-side ProjectionService EventEmitter to WebSocket clients.
  // When a projection view applies an event, broadcast PROJECTION_INVALIDATE so
  // clients using useProjectionStream can invalidate their TanStack Query cache
  // instead of waiting for the next polling interval.
  //
  // Throttled: at high throughput (50+ events/sec from 197 topics), emitting every
  // event is wasteful. Leading-edge fires immediately for low latency; trailing-edge
  // coalesces bursts. Client polls every 2s as a fallback regardless.
  const PROJECTION_THROTTLE_MS = 150;
  const projectionThrottleState = new Map<
    string,
    { timer: NodeJS.Timeout; leadingCursor: number; latestCursor: number }
  >();

  const projectionInvalidateHandler = (data: { viewId: string; cursor: number }) => {
    const state = projectionThrottleState.get(data.viewId);

    if (state) {
      // Within throttle window — track latest cursor, timer handles trailing edge
      state.latestCursor = Math.max(state.latestCursor, data.cursor);
      return;
    }

    // Leading edge: broadcast immediately.
    // Broadcast only to the per-view topic — avoids duplicate delivery to
    // clients subscribed to 'all' (which would match both 'projections' and
    // 'projection:<viewId>' broadcast calls).
    broadcast('PROJECTION_INVALIDATE', data, `projection:${data.viewId}`);

    // Open throttle window
    const entry = {
      leadingCursor: data.cursor,
      latestCursor: data.cursor,
      timer: setTimeout(() => {
        projectionThrottleState.delete(data.viewId);
        // Trailing edge: if cursor advanced during window, send one final update
        if (entry.latestCursor > entry.leadingCursor) {
          const trailingData = { viewId: data.viewId, cursor: entry.latestCursor };
          broadcast('PROJECTION_INVALIDATE', trailingData, `projection:${data.viewId}`);
        }
      }, PROJECTION_THROTTLE_MS),
    };
    projectionThrottleState.set(data.viewId, entry);
  };
  projectionService.on('projection-invalidate', projectionInvalidateHandler);

  const projectionListeners = [
    {
      emitter: projectionService,
      event: 'projection-invalidate' as string,
      handler: projectionInvalidateHandler,
    },
  ];

  // PlaybackDataSource listener (demo/recording replay only — not a Kafka replacement)
  const playbackDataSource = getPlaybackDataSource();

  const playbackDataEventHandler = (event: EventBusEvent) => {
    // Transform to AGENT_ACTION format for client compatibility
    const action = {
      id: event.event_id,
      correlationId: event.correlation_id || event.event_id,
      agentName: (event.payload?.agentName as string) || event.source || 'playback',
      actionType: (event.payload?.actionType as string) || event.event_type,
      actionName: (event.payload?.actionName as string) || event.event_type,
      actionDetails: event.payload,
      durationMs: (event.payload?.durationMs as number) || 0,
      createdAt: new Date(event.timestamp),
    };
    broadcast('AGENT_ACTION', action, 'actions');
  };

  playbackDataSource.on('event', playbackDataEventHandler);

  // Track for cleanup
  const playbackDataSourceListeners = [
    { emitter: playbackDataSource, event: 'event', handler: playbackDataEventHandler },
  ];

  console.log('[WebSocket] PlaybackDataSource listener registered for demo playback');

  // Handle WebSocket connections
  wss.on(
    'connection',
    safeAsyncHandler('connection', async (ws: WebSocket, request: IncomingMessage) => {
      console.log('WebSocket client connected from', request.socket.remoteAddress);

      // Initialize client data
      const clientData: ClientData = {
        ws,
        subscriptions: new Set(['all']), // Subscribe to all by default
        lastPing: new Date(),
        isAlive: true,
        missedPings: 0,
      };

      clients.set(ws, clientData);

      // Entire async body wrapped in try/catch: EventEmitter does NOT await the async
      // connection handler, so any uncaught throw becomes an unhandled promise rejection.
      try {
        // Send welcome message (guard readyState in case socket closes between connect and here)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'CONNECTED',
              message: 'Connected to Omnidash real-time event stream',
              timestamp: new Date().toISOString(),
            })
          );
        }

        // Send initial state by querying PostgreSQL for latest events across ALL topics.
        // This ensures events from EventBusDataSource's 197+ topics persist across reloads.
        const { recentActions: realActions, eventBusEvents } = await getEventsForInitialState();

        // Get legacy data for backward compatibility with other dashboards
        const legacyActions = eventConsumer.getRecentActions();
        const legacyRouting = eventConsumer.getRoutingDecisions();

        // Combine real actions with legacy actions (real events take priority)
        // Real events are more recent and accurate for Event Bus Monitor
        const combinedActions = realActions.length > 0 ? realActions : legacyActions;

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'INITIAL_STATE',
              data: {
                metrics: eventConsumer.getAgentMetrics(),
                recentActions: combinedActions,
                routingDecisions: legacyRouting,
                recentTransformations: eventConsumer.getRecentTransformations(),
                performanceStats: eventConsumer.getPerformanceStats(),
                health: eventConsumer.getHealthStatus(),
                registeredNodes: transformNodesToSnakeCase(eventConsumer.getRegisteredNodes()),
                nodeRegistryStats: eventConsumer.getNodeRegistryStats(),
                eventBusEvents: eventBusEvents,
              },
              timestamp: new Date().toISOString(),
            })
          );
        }
      } catch (error) {
        console.error('[WebSocket] Error during client connection setup:', error);
      }

      // Handle pong responses
      ws.on('pong', () => {
        const client = clients.get(ws);
        if (client) {
          client.isAlive = true;
          client.lastPing = new Date();
        }
      });

      // Handle client messages (for subscriptions/filtering)
      ws.on(
        'message',
        safeAsyncHandler('message', async (data: WebSocket.Data) => {
          try {
            const rawMessage = JSON.parse(data.toString());

            // Validate message against schema
            const parseResult = WebSocketMessageSchema.safeParse(rawMessage);

            if (!parseResult.success) {
              const errorMessage = parseResult.error.errors
                .map((e) => `${e.path.join('.')}: ${e.message}`)
                .join('; ');
              console.warn('Invalid WebSocket message received:', errorMessage);
              ws.send(
                JSON.stringify({
                  type: 'ERROR',
                  message: `Invalid message: ${errorMessage}`,
                  validActions: ['subscribe', 'unsubscribe', 'ping', 'getState'],
                  validTopics: VALID_TOPICS,
                  timestamp: new Date().toISOString(),
                })
              );
              return;
            }

            const message = parseResult.data;

            switch (message.action) {
              case 'subscribe':
                handleSubscription(ws, message.topics);
                break;
              case 'unsubscribe':
                handleUnsubscription(ws, message.topics);
                break;
              case 'ping':
                ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
                break;
              case 'getState': {
                // Send current state on demand by querying PostgreSQL
                const { recentActions: realActions, eventBusEvents } =
                  await getEventsForInitialState();

                const legacyActions = eventConsumer.getRecentActions();
                const combinedActions = realActions.length > 0 ? realActions : legacyActions;

                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: 'CURRENT_STATE',
                      data: {
                        metrics: eventConsumer.getAgentMetrics(),
                        recentActions: combinedActions,
                        routingDecisions: eventConsumer.getRoutingDecisions(),
                        recentTransformations: eventConsumer.getRecentTransformations(),
                        performanceStats: eventConsumer.getPerformanceStats(),
                        health: eventConsumer.getHealthStatus(),
                        registeredNodes: transformNodesToSnakeCase(
                          eventConsumer.getRegisteredNodes()
                        ),
                        nodeRegistryStats: eventConsumer.getNodeRegistryStats(),
                        eventBusEvents: eventBusEvents,
                      },
                      timestamp: new Date().toISOString(),
                    })
                  );
                }
                break;
              }
            }
          } catch (error) {
            const errorMessage =
              error instanceof SyntaxError
                ? 'Invalid JSON format'
                : `WebSocket message handler error: ${error instanceof Error ? error.message : 'Unknown error'}`;
            console.error('[WebSocket] Message handler error:', error);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'ERROR',
                  message: errorMessage,
                  timestamp: new Date().toISOString(),
                })
              );
            }
          }
        })
      );

      // Handle client disconnection
      ws.on('close', () => {
        console.log('WebSocket client disconnected');
        clients.delete(ws);
      });

      // Handle errors
      ws.on('error', (error: Error) => {
        console.error('WebSocket client error:', error);
        clients.delete(ws);
      });
    })
  );

  // Handle subscription updates
  function handleSubscription(ws: WebSocket, topics: string | string[] | undefined) {
    const client = clients.get(ws);
    if (!client) return;

    // If no topics provided, default to subscribing to 'all'
    if (!topics) {
      client.subscriptions.add('all');
    } else {
      const topicArray = Array.isArray(topics) ? topics : [topics];
      topicArray.forEach((topic) => {
        client.subscriptions.add(topic);
      });
    }

    ws.send(
      JSON.stringify({
        type: 'SUBSCRIPTION_UPDATED',
        subscriptions: Array.from(client.subscriptions),
        timestamp: new Date().toISOString(),
      })
    );

    console.log('Client subscriptions updated:', Array.from(client.subscriptions));
  }

  // Handle unsubscription
  function handleUnsubscription(ws: WebSocket, topics: string | string[] | undefined) {
    const client = clients.get(ws);
    if (!client) return;

    // If no topics provided, unsubscribe from all (reset to default)
    if (!topics) {
      client.subscriptions.clear();
      client.subscriptions.add('all');
    } else {
      const topicArray = Array.isArray(topics) ? topics : [topics];
      topicArray.forEach((topic) => {
        client.subscriptions.delete(topic);
      });

      // If no subscriptions remain, default to 'all'
      if (client.subscriptions.size === 0) {
        client.subscriptions.add('all');
      }
    }

    ws.send(
      JSON.stringify({
        type: 'SUBSCRIPTION_UPDATED',
        subscriptions: Array.from(client.subscriptions),
        timestamp: new Date().toISOString(),
      })
    );

    console.log('Client subscriptions updated:', Array.from(client.subscriptions));
  }

  // Handle WebSocket server errors
  wss.on('error', (error: Error) => {
    console.error('WebSocket server error:', error);
  });

  /**
   * Server Shutdown Cleanup Handler
   *
   * Critical for preventing memory leaks when server restarts or closes.
   * Removes all EventConsumer listeners and terminates client connections.
   *
   * Without this cleanup:
   * - EventConsumer would retain references to closed server's handlers
   * - Multiple server restarts would accumulate listeners
   * - Memory usage would grow unbounded
   * - Events would be handled multiple times by dead handlers
   */
  wss.on('close', () => {
    console.log('WebSocket server closing, cleaning up resources...');

    // Clear heartbeat interval
    clearInterval(heartbeatInterval);

    // Remove all EventConsumer listeners to prevent memory leaks
    console.log(`Removing ${eventListeners.length} EventConsumer listeners...`);
    eventListeners.forEach(({ event, handler }) => {
      eventConsumer.removeListener(event, handler);
    });
    eventListeners.length = 0; // Clear the array

    // Remove registry event listeners
    console.log(`Removing ${registryListeners.length} registry event listeners...`);
    registryListeners.forEach(({ emitter, event, handler }) => {
      emitter.removeListener(event, handler);
    });
    registryListeners.length = 0;

    // Remove intent event listeners (OMN-1516)
    console.log(`Removing ${intentListeners.length} intent event listeners...`);
    intentListeners.forEach(({ emitter, event, handler }) => {
      emitter.removeListener(event, handler);
    });
    intentListeners.length = 0;

    // Remove playback event listeners (OMN-1843)
    console.log(`Removing ${playbackListeners.length} playback event listeners...`);
    playbackListeners.forEach(({ emitter, event, handler }) => {
      emitter.removeListener(event, handler);
    });
    playbackListeners.length = 0;

    // Remove insights event listener (OMN-2306)
    insightsEventEmitter.removeListener('insights-update', insightsUpdateHandler);

    // Remove baselines event listener (OMN-2331)
    baselinesEventEmitter.removeListener('baselines-update', baselinesUpdateHandler);

    // Remove LLM routing event listener (OMN-2279)
    llmRoutingEventEmitter.removeListener('llm-routing-invalidate', llmRoutingInvalidateHandler);

    // Remove effectiveness event listener (OMN-2328)
    effectivenessEventEmitter.removeListener('effectiveness-update', effectivenessUpdateHandler);

    // Remove enrichment event listener (OMN-2373)
    enrichmentEventEmitter.removeListener('enrichment-invalidate', enrichmentInvalidateHandler);

    // Remove enforcement event listener (OMN-2374)
    enforcementEventEmitter.removeListener('enforcement-invalidate', enforcementInvalidateHandler);

    // Remove delegation event listener (OMN-2284)
    delegationEventEmitter.removeListener('delegation-invalidate', delegationInvalidateHandler);

    // Remove status event listener (OMN-2658)
    statusEventEmitter.removeListener('status-invalidate', statusInvalidateHandler);

    // Remove Wave 2 state event listeners (OMN-2602)
    gateDecisionEventEmitter.removeListener('gate-decision-invalidate', gateDecisionInvalidateHandler);
    epicRunEventEmitter.removeListener('epic-run-invalidate', epicRunInvalidateHandler);
    prWatchEventEmitter.removeListener('pr-watch-invalidate', prWatchInvalidateHandler);
    pipelineBudgetEventEmitter.removeListener('pipeline-budget-invalidate', pipelineBudgetInvalidateHandler);
    circuitBreakerEventEmitter.removeListener('circuit-breaker-invalidate', debugEscalationInvalidateHandler);

    // Remove event bus data source listeners
    console.log(`Removing ${eventBusListeners.length} event bus data source listeners...`);
    eventBusListeners.forEach(({ emitter, event, handler }) => {
      if (emitter) {
        emitter.removeListener(event, handler);
      }
    });
    eventBusListeners.length = 0;

    // Remove projection event listeners (OMN-2095)
    console.log(`Removing ${projectionListeners.length} projection event listeners...`);
    projectionListeners.forEach(({ emitter, event, handler }) => {
      emitter.removeListener(event, handler);
    });
    projectionListeners.length = 0;

    // Clear projection throttle timers
    for (const state of projectionThrottleState.values()) {
      clearTimeout(state.timer);
    }
    projectionThrottleState.clear();

    // Remove playback data source listeners (OMN-1885)
    console.log(`Removing ${playbackDataSourceListeners.length} playback data source listeners...`);
    playbackDataSourceListeners.forEach(({ emitter, event, handler }) => {
      emitter.removeListener(event, handler);
    });
    playbackDataSourceListeners.length = 0;

    // Terminate all client connections
    console.log(`Terminating ${clients.size} client connections...`);
    clients.forEach((clientData, ws) => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    });

    // Clear clients map
    clients.clear();

    console.log('✅ WebSocket server closed, all listeners and connections cleaned up');
  });

  console.log('WebSocket server initialized at /ws');
  return wss;
}

export { transformEventToClientAction };
