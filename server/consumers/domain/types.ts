/**
 * Domain handler types for the event-consumer decomposition [OMN-5191]
 *
 * Defines the DomainHandler interface and ConsumerContext that allow
 * domain-specific message handlers to be extracted from the monolithic
 * EventConsumer class into independent modules.
 */

import type { KafkaMessage } from 'kafkajs';
import type { EventEmitter } from 'events';
import type { z } from 'zod';
import type { EventEnvelope } from '@shared/schemas';

// Re-export all domain types that were previously in event-consumer.ts
// so downstream consumers can import from a single location.

export type NodeType = 'EFFECT' | 'COMPUTE' | 'REDUCER' | 'ORCHESTRATOR';

export type RegistrationState =
  | 'pending_registration'
  | 'accepted'
  | 'awaiting_ack'
  | 'ack_received'
  | 'active'
  | 'rejected'
  | 'ack_timed_out'
  | 'liveness_expired';

export type IntrospectionReason = 'STARTUP' | 'HEARTBEAT' | 'REQUESTED';

export interface AgentMetrics {
  agent: string;
  totalRequests: number;
  successRate: number | null;
  avgRoutingTime: number;
  avgConfidence: number;
  lastSeen: Date;
}

export interface AgentAction {
  id: string;
  correlationId: string;
  agentName: string;
  actionType: string;
  actionName: string;
  actionDetails?: any;
  debugMode?: boolean;
  durationMs: number;
  createdAt: Date;
  /** Real Kafka topic this action originated from (OMN-2196) */
  topic?: string;
  /** Hoisted tool name for tool-executed events (OMN-2196) */
  toolName?: string;
}

export interface RoutingDecision {
  id: string;
  correlationId: string;
  userRequest: string;
  selectedAgent: string;
  confidenceScore: number;
  routingStrategy: string;
  alternatives?: any;
  reasoning?: string;
  routingTimeMs: number;
  createdAt: Date;
}

export interface TransformationEvent {
  id: string;
  correlationId: string;
  sourceAgent: string;
  targetAgent: string;
  transformationDurationMs: number;
  success: boolean;
  confidenceScore: number;
  createdAt: Date;
}

export interface RegisteredNode {
  nodeId: string;
  nodeType: NodeType;
  state: RegistrationState;
  version: string;
  uptimeSeconds: number;
  lastSeen: Date;
  memoryUsageMb?: number;
  cpuUsagePercent?: number;
  endpoints?: Record<string, string>;
}

export type OnexNodeState = import('@shared/schemas').NodeState;

export interface CanonicalOnexNode {
  node_id: string;
  state: OnexNodeState;
  node_type?: string;
  node_version?: string;
  capabilities?: Record<string, unknown> | null;
  activated_at?: number;
  last_heartbeat_at?: number;
  last_introspection_at?: number;
  last_event_at: number;
  offline_at?: number;
}

export interface NodeIntrospectionEvent {
  id: string;
  nodeId: string;
  nodeType: NodeType;
  nodeVersion: string;
  endpoints: Record<string, string>;
  currentState: RegistrationState;
  reason: IntrospectionReason;
  correlationId: string;
  createdAt: Date;
}

export interface NodeHeartbeatEvent {
  id: string;
  nodeId: string;
  uptimeSeconds: number;
  activeOperationsCount: number;
  memoryUsageMb: number;
  cpuUsagePercent: number;
  createdAt: Date;
}

export interface NodeStateChangeEvent {
  id: string;
  nodeId: string;
  previousState: RegistrationState;
  newState: RegistrationState;
  reason?: string;
  createdAt: Date;
}

// ============================================================================
// Raw Kafka Event Interfaces (snake_case from Kafka)
// ============================================================================

export interface RawRoutingDecisionEvent {
  id?: string;
  correlation_id?: string;
  correlationId?: string;
  user_request?: string;
  userRequest?: string;
  selected_agent?: string;
  selectedAgent?: string;
  confidence_score?: number;
  confidenceScore?: number;
  routing_strategy?: string;
  routingStrategy?: string;
  alternatives?: Record<string, unknown>;
  reasoning?: string;
  routing_time_ms?: number;
  routingTimeMs?: number;
  timestamp?: string;
  created_at?: string;
  createdAt?: string;
}

export interface RawAgentActionEvent {
  id?: string;
  correlation_id?: string;
  correlationId?: string;
  agent_name?: string;
  agentName?: string;
  action_type?: string;
  actionType?: string;
  action_name?: string;
  actionName?: string;
  action_details?: Record<string, unknown>;
  actionDetails?: Record<string, unknown>;
  debug_mode?: boolean;
  debugMode?: boolean;
  duration_ms?: number;
  durationMs?: number;
  timestamp?: string;
  created_at?: string;
  createdAt?: string;
}

export interface RawTransformationEvent {
  id?: string;
  correlation_id?: string;
  correlationId?: string;
  source_agent?: string;
  sourceAgent?: string;
  target_agent?: string;
  targetAgent?: string;
  transformation_duration_ms?: number;
  transformationDurationMs?: number;
  success?: boolean;
  confidence_score?: number;
  confidenceScore?: number;
  timestamp?: string;
  created_at?: string;
  createdAt?: string;
}

export interface RawPerformanceMetricEvent {
  id?: string;
  correlation_id?: string;
  correlationId?: string;
  query_text?: string;
  queryText?: string;
  routing_duration_ms?: number;
  routingDurationMs?: number;
  cache_hit?: boolean;
  cacheHit?: boolean;
  candidates_evaluated?: number;
  candidatesEvaluated?: number;
  trigger_match_strategy?: string;
  triggerMatchStrategy?: string;
  timestamp?: string;
  created_at?: string;
  createdAt?: string;
}

export interface RawNodeIntrospectionEvent {
  id?: string;
  node_id?: string;
  nodeId?: string;
  node_type?: NodeType | string;
  nodeType?: NodeType | string;
  node_version?: string;
  nodeVersion?: string;
  endpoints?: Record<string, string>;
  current_state?: RegistrationState | string;
  currentState?: RegistrationState | string;
  reason?: 'STARTUP' | 'HEARTBEAT' | 'REQUESTED' | string;
  correlation_id?: string;
  correlationId?: string;
  timestamp?: string;
  created_at?: string;
  createdAt?: string;
}

export interface RawNodeHeartbeatEvent {
  id?: string;
  node_id?: string;
  nodeId?: string;
  uptime_seconds?: number;
  uptimeSeconds?: number;
  active_operations_count?: number;
  activeOperationsCount?: number;
  memory_usage_mb?: number;
  memoryUsageMb?: number;
  cpu_usage_percent?: number;
  cpuUsagePercent?: number;
  timestamp?: string;
  created_at?: string;
  createdAt?: string;
}

export interface RawNodeStateChangeEvent {
  id?: string;
  node_id?: string;
  nodeId?: string;
  previous_state?: RegistrationState | string;
  previousState?: RegistrationState | string;
  new_state?: RegistrationState | string;
  newState?: RegistrationState | string;
  reason?: string;
  timestamp?: string;
  created_at?: string;
  createdAt?: string;
}

// ============================================================================
// Intent Event Interfaces
// ============================================================================

export interface InternalIntentClassifiedEvent {
  id: string;
  correlationId: string;
  sessionId: string;
  intentType: string;
  confidence: number;
  keywords: string[];
  rawText: string;
  extractedEntities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface RawIntentClassifiedEvent {
  id?: string;
  event_type?: string;
  session_id?: string;
  sessionId?: string;
  correlation_id?: string;
  correlationId?: string;
  intent_category?: string;
  intentCategory?: string;
  intent_type?: string;
  intentType?: string;
  confidence?: number;
  keywords?: string[];
  timestamp?: string;
  raw_text?: string;
  rawText?: string;
  extracted_entities?: Record<string, unknown>;
  extractedEntities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at?: string;
  createdAt?: string;
}

export interface RawIntentStoredEvent {
  id?: string;
  correlation_id?: string;
  correlationId?: string;
  intent_id?: string;
  intentId?: string;
  intent_type?: string;
  intentType?: string;
  storage_location?: string;
  storageLocation?: string;
  timestamp?: string;
  created_at?: string;
  createdAt?: string;
  // Fields from shared IntentStoredEvent format (type guard path)
  session_ref?: string;
  intent_category?: string;
  confidence?: number;
  keywords?: string[];
  stored_at?: string;
}

export interface RawIntentQueryResponseEvent {
  query_id?: string;
  queryId?: string;
  correlation_id?: string;
  correlationId?: string;
  results?: unknown[];
  total_count?: number;
  totalCount?: number;
  timestamp?: string;
  created_at?: string;
  createdAt?: string;
}

// ============================================================================
// ConsumerContext — the seam between EventConsumer and domain handlers
// ============================================================================

/**
 * Context object passed to domain handlers, providing access to shared
 * EventConsumer state and utilities. This is the seam that allows handlers
 * to be extracted without breaking the shared state model.
 *
 * The consumer creates a ConsumerContext from its internal state and passes
 * it to each domain handler's handleEvent method.
 */
export interface ConsumerContext {
  /** Check if a correlationId has already been processed (dedup) */
  isDuplicate(correlationId: string): boolean;

  /** Emit an event on the EventConsumer EventEmitter */
  emit(event: string, ...args: unknown[]): boolean;

  /** Get the debug flag for logging */
  readonly isDebug: boolean;

  /** Parse a Kafka message into a validated ONEX event envelope */
  parseEnvelope<T>(message: KafkaMessage, payloadSchema: z.ZodSchema<T>): EventEnvelope<T> | null;

  /** Check if an event should be processed based on event ordering */
  shouldProcess(node: CanonicalOnexNode | undefined, eventEmittedAt: number): boolean;

  // --- In-memory state accessors ---

  /** Agent metrics map */
  readonly agentMetrics: Map<
    string,
    {
      count: number;
      totalRoutingTime: number;
      totalConfidence: number;
      successCount: number;
      errorCount: number;
      lastSeen: Date;
    }
  >;

  /** Recent actions buffer */
  recentActions: AgentAction[];
  readonly maxActions: number;

  /** Routing decisions buffer */
  routingDecisions: RoutingDecision[];
  readonly maxDecisions: number;

  /** Transformation events buffer */
  recentTransformations: TransformationEvent[];
  readonly maxTransformations: number;

  /** Node registry storage */
  readonly registeredNodes: Map<string, RegisteredNode>;
  readonly MAX_REGISTERED_NODES: number;
  nodeIntrospectionEvents: NodeIntrospectionEvent[];
  nodeHeartbeatEvents: NodeHeartbeatEvent[];
  nodeStateChangeEvents: NodeStateChangeEvent[];
  readonly maxNodeEvents: number;

  /** Intent event storage */
  recentIntents: InternalIntentClassifiedEvent[];
  readonly maxIntents: number;
  readonly intentDistributionWithTimestamps: Map<string, { count: number; timestamps: number[] }>;
  readonly MAX_TIMESTAMPS_PER_CATEGORY: number;

  /** Canonical ONEX node registry */
  readonly canonicalNodes: Map<string, CanonicalOnexNode>;

  /** Performance metrics */
  performanceMetrics: Array<{
    id: string;
    correlationId: string;
    queryText: string;
    routingDurationMs: number;
    cacheHit: boolean;
    candidatesEvaluated: number;
    triggerMatchStrategy: string;
    createdAt: Date;
  }>;
  performanceStats: {
    totalQueries: number;
    cacheHitCount: number;
    avgRoutingDuration: number;
    totalRoutingDuration: number;
  };
  readonly PERFORMANCE_METRICS_BUFFER_SIZE: number;

  /** Get computed agent metrics array */
  getAgentMetrics(): AgentMetrics[];

  /** Get registered nodes array */
  getRegisteredNodes(): RegisteredNode[];

  /** Sync canonical node into legacy registeredNodes */
  syncCanonicalToRegistered(canonicalNode: CanonicalOnexNode): void;

  /** Map canonical state to legacy RegistrationState */
  mapCanonicalState(state: OnexNodeState): RegistrationState;

  /** Propagate heartbeat metrics to registered node */
  propagateHeartbeatMetrics(payload: {
    node_id: string;
    uptime_seconds?: number | null;
    memory_usage_mb?: number | null;
    cpu_usage_percent?: number | null;
    active_operations_count?: number | null;
  }): void;

  /** Clean up old metrics entries */
  cleanupOldMetrics(): void;

  /** ExtractionMetricsAggregator instance */
  readonly extractionAggregator: import('../../../server/extraction-aggregator').ExtractionMetricsAggregator;
}

/**
 * A domain handler processes messages for a set of topic suffixes.
 * Each handler is registered for one or more topic suffixes and receives
 * messages routed by the EventConsumer orchestrator.
 */
export interface DomainHandler {
  /** Human-readable name for logging */
  readonly name: string;

  /**
   * Check if this handler can process the given topic suffix.
   */
  canHandle(topic: string): boolean;

  /**
   * Handle a parsed event from a Kafka message.
   *
   * @param topic - The canonical topic suffix (after environment prefix stripping)
   * @param event - The parsed JSON payload from the Kafka message
   * @param message - The raw Kafka message (for handlers that need offset/headers)
   * @param ctx - Shared context for dedup, emit, state access, etc.
   */
  handleEvent(
    topic: string,
    event: Record<string, unknown>,
    message: KafkaMessage,
    ctx: ConsumerContext
  ): Promise<void> | void;
}
