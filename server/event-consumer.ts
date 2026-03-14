import { Kafka, Consumer, Producer, KafkaMessage } from 'kafkajs';
import { resolveBrokers, getBrokerString } from './bus-config.js';
import { EventEmitter } from 'events';
import crypto from 'node:crypto';
import { getIntelligenceDb } from './storage';
import { sql } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import type { EventBusEvent } from './event-bus-data-source';
// Import topic constants and type utilities from shared module (single source of truth)
import {
  INTENT_CLASSIFIED_TOPIC,
  INTENT_STORED_TOPIC,
  EVENT_TYPE_NAMES,
  isIntentClassifiedEvent,
  isIntentStoredEvent,
  type IntentRecordPayload,
} from '@shared/intent-types';
// Import intentEventEmitter for WebSocket broadcasting of intent events
import { getIntentEventEmitter } from './intent-events';
// @deprecated (OMN-5030) TopicCatalogManager — retained only for legacy fallback
// path (OMNIDASH_USE_REGISTRY_DISCOVERY=false). Will be fully removed once
// registry-driven discovery is validated in production.
import { TopicCatalogManager } from './topic-catalog-manager';
// Registry-driven topic discovery (OMN-5027)
import { getTopicRegistryService } from './services/topic-registry-service';
import {
  TopicDiscoveryCoordinator,
  BOOTSTRAP_TOPICS,
} from './services/topic-discovery-coordinator';
// Import canonical topic constants
import {
  buildSubscriptionTopics,
  ENVIRONMENT_PREFIXES,
  extractSuffix,
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
  SUFFIX_NODE_INTROSPECTION,
  SUFFIX_NODE_REGISTRATION,
  SUFFIX_REQUEST_INTROSPECTION,
  SUFFIX_NODE_HEARTBEAT,
  SUFFIX_CONTRACT_REGISTERED,
  SUFFIX_CONTRACT_DEREGISTERED,
  SUFFIX_NODE_REGISTRATION_INITIATED,
  SUFFIX_NODE_REGISTRATION_ACCEPTED,
  SUFFIX_NODE_REGISTRATION_REJECTED,
  SUFFIX_REGISTRATION_SNAPSHOTS,
  SUFFIX_INTELLIGENCE_CLAUDE_HOOK,
  SUFFIX_INTELLIGENCE_TOOL_CONTENT,
  SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED,
  SUFFIX_MEMORY_INTENT_STORED,
  SUFFIX_MEMORY_INTENT_QUERY_RESPONSE,
  SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
  SUFFIX_OMNICLAUDE_SESSION_STARTED,
  SUFFIX_OMNICLAUDE_SESSION_ENDED,
  SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
  SUFFIX_OMNICLAUDE_CONTEXT_UTILIZATION,
  SUFFIX_OMNICLAUDE_AGENT_MATCH,
  SUFFIX_OMNICLAUDE_LATENCY_BREAKDOWN,
  SUFFIX_OMNICLAUDE_ROUTING_DECISION,
  SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
  SUFFIX_OMNICLAUDE_MANIFEST_INJECTED,
  SUFFIX_OMNICLAUDE_PHASE_METRICS,
  SUFFIX_OMNICLAUDE_NOTIFICATION_BLOCKED,
  SUFFIX_OMNICLAUDE_NOTIFICATION_COMPLETED,
  SUFFIX_OMNICLAUDE_TRANSFORMATION_COMPLETED,
  SUFFIX_VALIDATION_RUN_STARTED,
  SUFFIX_VALIDATION_VIOLATIONS_BATCH,
  SUFFIX_VALIDATION_RUN_COMPLETED,
  SUFFIX_VALIDATION_CANDIDATE_UPSERTED,
  SUFFIX_NODE_REGISTRATION_ACKED,
  SUFFIX_NODE_REGISTRATION_RESULT,
  SUFFIX_NODE_REGISTRATION_ACK_RECEIVED,
  SUFFIX_NODE_REGISTRATION_ACK_TIMED_OUT,
  SUFFIX_REGISTRY_REQUEST_INTROSPECTION,
  SUFFIX_FSM_STATE_TRANSITIONS,
  SUFFIX_RUNTIME_TICK,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_CMD,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_COMPLETED,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED,
  SUFFIX_INTELLIGENCE_PATTERN_PROMOTED,
  SUFFIX_INTELLIGENCE_PATTERN_STORED,
  SUFFIX_PATTERN_DISCOVERED,
  SUFFIX_INTELLIGENCE_SESSION_OUTCOME_CMD,
  SUFFIX_AGENT_STATUS,
  SUFFIX_GITHUB_PR_STATUS,
  SUFFIX_GIT_HOOK,
  SUFFIX_LINEAR_SNAPSHOT,
} from '@shared/topics';
import {
  EventEnvelopeSchema,
  NodeHeartbeatPayloadSchema,
  NodeIntrospectionPayloadSchema,
  OFFLINE_NODE_TTL_MS,
  CLEANUP_INTERVAL_MS,
  type EventEnvelope,
  type NodeState,
} from '@shared/schemas';
import {
  isValidationRunStarted,
  isValidationViolationsBatch,
  isValidationRunCompleted,
  isValidationCandidateUpserted,
} from '@shared/validation-types';
import {
  handleValidationRunStarted,
  handleValidationViolationsBatch,
  handleValidationRunCompleted,
  handleValidationCandidateUpserted,
} from './validation-routes';
import { ExtractionMetricsAggregator } from './extraction-aggregator';
import {
  isContextUtilizationEvent,
  isAgentMatchEvent,
  isLatencyBreakdownEvent,
} from '@shared/extraction-types';
import { emitEffectivenessUpdate } from './effectiveness-events';
import { effectivenessMetricsProjection } from './projection-bootstrap';
import { MonotonicMergeTracker, extractEventTimeMs, parseOffsetAsSeq } from './monotonic-merge';
import { addDecisionRecord } from './decision-records-routes';
import { isGitHubPRStatusEvent, isGitHookEvent, isLinearSnapshotEvent } from '@shared/status-types';
import { statusProjection } from './projections/status-projection';
import { emitStatusInvalidate } from './status-events';
// Kafka topic preflight: crash-loop on missing required topics (OMN-4607)
import { assertTopicsExist } from './lib/kafka-topic-preflight';

const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
const DEBUG_CANONICAL_EVENTS = process.env.DEBUG_CANONICAL_EVENTS === 'true' || isTestEnv;
const RETRY_BASE_DELAY_MS = isTestEnv ? 20 : 1000;
const RETRY_MAX_DELAY_MS = isTestEnv ? 200 : 30000;

/**
 * Kafka consumer configuration constants.
 * Extracted for maintainability and easy tuning.
 */
const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
const SQL_PRELOAD_LIMIT = 2000;

/**
 * Phase 0 hydration configuration.
 *
 * PRELOAD_WINDOW_MINUTES — Only preload events younger than this from PostgreSQL.
 *   Prevents stale events (3-7 day Kafka retention) from overwriting fresh data.
 *   Override via env: PRELOAD_WINDOW_MINUTES (default: 1440, i.e. 24 hours).
 *   60-minute default was too narrow — node-introspection events emitted once at
 *   plugin startup are missed if omnidash restarts more than 1h after omniclaude. [OMN-3333]
 *
 * MAX_PRELOAD_EVENTS — Hard cap on the number of events loaded in the fresh window.
 *   Override via env: MAX_PRELOAD_EVENTS (default: 5000).
 *
 * ENABLE_BACKFILL — When true, after the fresh preload, a second query loads older
 *   events to fill remaining capacity (up to BACKFILL_MAX_EVENTS).
 *   Off by default to avoid the exact staleness problem this fix addresses.
 *   Override via env: ENABLE_BACKFILL=true.
 *
 * BACKFILL_MAX_EVENTS — Cap for the backfill query when ENABLE_BACKFILL is true.
 *   Override via env: BACKFILL_MAX_EVENTS (default: 2000).
 */
const parsedPreloadWindow = parseInt(process.env.PRELOAD_WINDOW_MINUTES || '1440', 10);
const PRELOAD_WINDOW_MINUTES =
  Number.isFinite(parsedPreloadWindow) && parsedPreloadWindow >= 0 ? parsedPreloadWindow : 1440;

const parsedMaxPreload = parseInt(process.env.MAX_PRELOAD_EVENTS || '5000', 10);
const MAX_PRELOAD_EVENTS =
  Number.isFinite(parsedMaxPreload) && parsedMaxPreload >= 0 ? parsedMaxPreload : 5000;

const ENABLE_BACKFILL = process.env.ENABLE_BACKFILL === 'true'; // default false

const parsedBackfillMax = parseInt(process.env.BACKFILL_MAX_EVENTS || '2000', 10);
const BACKFILL_MAX_EVENTS =
  Number.isFinite(parsedBackfillMax) && parsedBackfillMax >= 0 ? parsedBackfillMax : 2000;

/**
 * Maximum number of live (Kafka-consumed) events to retain in the
 * in-memory buffer. Prevents unbounded memory growth while ensuring
 * new WebSocket clients see recent events in INITIAL_STATE.
 */
const MAX_LIVE_EVENT_BUS_EVENTS = 2000;
const PERFORMANCE_METRICS_BUFFER_SIZE = 200;
const MAX_TIMESTAMPS_PER_CATEGORY = 1000;

// Canonical ONEX topic names (no env prefix).
// Infra4 producers emit to unprefixed canonical names
// (e.g. `onex.evt.platform.node-heartbeat.v1`).
//
// ⚠️ DEPLOYMENT ORDER: Node/platform topic names below use canonical ONEX format.
// The upstream producer (omnibase_infra, omniclaude hooks) MUST be deployed
// BEFORE or SIMULTANEOUSLY with this omnidash change. If omnidash subscribes
// to the new canonical names before producers emit on them, node registry
// events (introspection, heartbeat, registration, liveness) will be silently
// lost (no error, just missing data on the Node Registry dashboard).
const TOPIC = {
  // Platform
  NODE_INTROSPECTION: SUFFIX_NODE_INTROSPECTION,
  NODE_REGISTRATION: SUFFIX_NODE_REGISTRATION,
  REQUEST_INTROSPECTION: SUFFIX_REQUEST_INTROSPECTION,
  NODE_HEARTBEAT: SUFFIX_NODE_HEARTBEAT,
  CONTRACT_REGISTERED: SUFFIX_CONTRACT_REGISTERED,
  CONTRACT_DEREGISTERED: SUFFIX_CONTRACT_DEREGISTERED,
  NODE_REGISTRATION_INITIATED: SUFFIX_NODE_REGISTRATION_INITIATED,
  NODE_REGISTRATION_ACCEPTED: SUFFIX_NODE_REGISTRATION_ACCEPTED,
  NODE_REGISTRATION_REJECTED: SUFFIX_NODE_REGISTRATION_REJECTED,
  NODE_REGISTRATION_ACKED: SUFFIX_NODE_REGISTRATION_ACKED,
  NODE_REGISTRATION_RESULT: SUFFIX_NODE_REGISTRATION_RESULT,
  NODE_REGISTRATION_ACK_RECEIVED: SUFFIX_NODE_REGISTRATION_ACK_RECEIVED,
  NODE_REGISTRATION_ACK_TIMED_OUT: SUFFIX_NODE_REGISTRATION_ACK_TIMED_OUT,
  REGISTRY_REQUEST_INTROSPECTION: SUFFIX_REGISTRY_REQUEST_INTROSPECTION,
  FSM_STATE_TRANSITIONS: SUFFIX_FSM_STATE_TRANSITIONS,
  RUNTIME_TICK: SUFFIX_RUNTIME_TICK,
  REGISTRATION_SNAPSHOTS: SUFFIX_REGISTRATION_SNAPSHOTS,
  // OmniClaude
  CLAUDE_HOOK: SUFFIX_INTELLIGENCE_CLAUDE_HOOK,
  TOOL_CONTENT: SUFFIX_INTELLIGENCE_TOOL_CONTENT,
  PROMPT_SUBMITTED: SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
  SESSION_STARTED: SUFFIX_OMNICLAUDE_SESSION_STARTED,
  SESSION_ENDED: SUFFIX_OMNICLAUDE_SESSION_ENDED,
  TOOL_EXECUTED: SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
  // Status dashboard topics (OMN-2658)
  GITHUB_PR_STATUS: SUFFIX_GITHUB_PR_STATUS,
  GIT_HOOK: SUFFIX_GIT_HOOK,
  LINEAR_SNAPSHOT: SUFFIX_LINEAR_SNAPSHOT,
} as const;

// Structured logging for intent handlers
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const currentLogLevel = LOG_LEVELS[LOG_LEVEL as keyof typeof LOG_LEVELS] ?? LOG_LEVELS.info;

const intentLogger = {
  debug: (message: string) => {
    if (currentLogLevel <= LOG_LEVELS.debug) {
      console.log(`[EventConsumer:intent:debug] ${message}`);
    }
  },
  info: (message: string) => {
    if (currentLogLevel <= LOG_LEVELS.info) {
      console.log(`[EventConsumer:intent] ${message}`);
    }
  },
  warn: (message: string) => {
    if (currentLogLevel <= LOG_LEVELS.warn) {
      console.warn(`[EventConsumer:intent:warn] ${message}`);
    }
  },
  error: (message: string, error?: unknown) => {
    // Errors always log regardless of level
    console.error(`[EventConsumer:intent:error] ${message}`, error ?? '');
  },
};

/**
 * Validate and sanitize a timestamp string.
 * Returns a valid Date object or the current date if the input is invalid.
 *
 * @param timestamp - The timestamp string to validate (ISO-8601 format expected)
 * @param fallback - Optional fallback date (defaults to current time)
 * @returns A valid Date object
 */
function sanitizeTimestamp(timestamp: string | undefined | null, fallback?: Date): Date {
  if (!timestamp) {
    return fallback ?? new Date();
  }

  // Try to parse the timestamp
  const parsed = new Date(timestamp);

  // Check if the parsed date is valid (not NaN)
  if (isNaN(parsed.getTime())) {
    intentLogger.warn(`Invalid timestamp string: "${timestamp}", using fallback`);
    return fallback ?? new Date();
  }

  // Sanity check: reject timestamps too far in the future (more than 1 day ahead)
  const maxFuture = Date.now() + 24 * 60 * 60 * 1000;
  if (parsed.getTime() > maxFuture) {
    intentLogger.warn(`Timestamp too far in future: "${timestamp}", using fallback`);
    return fallback ?? new Date();
  }

  // Sanity check: reject timestamps too far in the past (before year 2000)
  const minPast = new Date('2000-01-01').getTime();
  if (parsed.getTime() < minPast) {
    intentLogger.warn(`Timestamp too far in past: "${timestamp}", using fallback`);
    return fallback ?? new Date();
  }

  return parsed;
}

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

// ============================================================================
// Database Row Types
// These interfaces represent the raw row shapes returned by SQL queries.
// They differ from the domain interfaces above which use camelCase and
// transformed/normalized values.
// ============================================================================

/** Row type for agent_actions table query results */
// Node Registry Types
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

// Valid enum values for runtime validation
const VALID_NODE_TYPES: readonly NodeType[] = ['EFFECT', 'COMPUTE', 'REDUCER', 'ORCHESTRATOR'];
const VALID_REGISTRATION_STATES: readonly RegistrationState[] = [
  'pending_registration',
  'accepted',
  'awaiting_ack',
  'ack_received',
  'active',
  'rejected',
  'ack_timed_out',
  'liveness_expired',
];
const VALID_INTROSPECTION_REASONS: readonly IntrospectionReason[] = [
  'STARTUP',
  'HEARTBEAT',
  'REQUESTED',
];

// Runtime validation guards for enum values from external sources (e.g., Kafka)
function isValidNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && VALID_NODE_TYPES.includes(value as NodeType);
}

function isValidRegistrationState(value: unknown): value is RegistrationState {
  return (
    typeof value === 'string' && VALID_REGISTRATION_STATES.includes(value as RegistrationState)
  );
}

function isValidIntrospectionReason(value: unknown): value is IntrospectionReason {
  return (
    typeof value === 'string' && VALID_INTROSPECTION_REASONS.includes(value as IntrospectionReason)
  );
}

// Safe enum parsers with fallback defaults and logging
function parseNodeType(value: unknown, defaultValue: NodeType = 'COMPUTE'): NodeType {
  if (isValidNodeType(value)) {
    return value;
  }
  if (value !== undefined && value !== null) {
    console.warn(
      `[EventConsumer] Invalid NodeType value: "${value}", using default: "${defaultValue}"`
    );
  }
  return defaultValue;
}

function parseRegistrationState(
  value: unknown,
  defaultValue: RegistrationState = 'pending_registration'
): RegistrationState {
  if (isValidRegistrationState(value)) {
    return value;
  }
  if (value !== undefined && value !== null) {
    console.warn(
      `[EventConsumer] Invalid RegistrationState value: "${value}", using default: "${defaultValue}"`
    );
  }
  return defaultValue;
}

function parseIntrospectionReason(
  value: unknown,
  defaultValue: IntrospectionReason = 'STARTUP'
): IntrospectionReason {
  if (isValidIntrospectionReason(value)) {
    return value;
  }
  if (value !== undefined && value !== null) {
    console.warn(
      `[EventConsumer] Invalid IntrospectionReason value: "${value}", using default: "${defaultValue}"`
    );
  }
  return defaultValue;
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

// Canonical ONEX node state for event-driven updates
// Re-exported from shared schemas for backward compatibility
export type OnexNodeState = NodeState;

export interface CanonicalOnexNode {
  node_id: string;
  state: OnexNodeState;
  node_type?: string;
  node_version?: string;
  capabilities?: Record<string, unknown>;
  activated_at?: number;
  last_heartbeat_at?: number;
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
// These represent the exact structure of events as received from Kafka topics
// ============================================================================

/**
 * Raw routing decision event from Kafka (snake_case)
 * Topic: onex.evt.omniclaude.routing-decision.v1 (TOPIC_OMNICLAUDE_ROUTING_DECISIONS)
 * @deprecated Legacy comment: was "agent-routing-decisions" (flat, pre-ONEX)
 */
export interface RawRoutingDecisionEvent {
  id?: string;
  correlation_id?: string;
  correlationId?: string; // Alternative camelCase format
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

/**
 * Raw agent action event from Kafka (snake_case)
 * Topic: onex.evt.omniclaude.agent-actions.v1 (TOPIC_OMNICLAUDE_AGENT_ACTIONS)
 * @deprecated Legacy comment: was "agent-actions" (flat, pre-ONEX)
 */
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

/**
 * Raw transformation event from Kafka (snake_case)
 * Topic: onex.evt.omniclaude.agent-transformation.v1 (TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION)
 * @deprecated Legacy comment: was "agent-transformation-events" (flat, pre-ONEX)
 */
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

/**
 * Raw performance metric event from Kafka (snake_case)
 * Topic: onex.evt.omniclaude.performance-metrics.v1 (TOPIC_OMNICLAUDE_PERFORMANCE_METRICS)
 * @deprecated Legacy comment: was "router-performance-metrics" (flat, pre-ONEX)
 */
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

/**
 * Raw node introspection event from Kafka (snake_case)
 * Topics: onex.evt.platform.node-introspection.v1,
 *         onex.cmd.platform.request-introspection.v1
 */
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

/**
 * Raw node heartbeat event from Kafka (snake_case)
 * Topic: onex.evt.platform.node-heartbeat.v1
 */
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

/**
 * Raw node state change event from Kafka (snake_case)
 * Topic: onex.evt.platform.node-registration.v1
 */
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

/**
 * Internal intent classification event structure (camelCase for in-memory processing).
 * Note: This uses camelCase (intentType, correlationId) while the shared/intent-types.ts
 * IntentClassifiedEvent uses snake_case (intent_category, correlation_id, session_id).
 *
 * Aligned with shared IntentClassifiedEvent:
 * - intentType maps to intent_category (the category classification)
 * - sessionId maps to session_id (session reference)
 * - correlationId maps to correlation_id (request tracing)
 *
 * Topic: {env}.onex.evt.omniintelligence.intent-classified.v1
 */
export interface InternalIntentClassifiedEvent {
  id: string;
  correlationId: string;
  sessionId: string; // Added to align with shared IntentClassifiedEvent.session_id
  intentType: string; // Maps to shared IntentClassifiedEvent.intent_category
  confidence: number;
  rawText: string;
  extractedEntities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Raw intent classified event from Kafka (snake_case)
 * Aligned with shared/intent-types.ts IntentClassifiedEvent interface.
 *
 * NOTE: The shared interface uses snake_case (intent_category, session_id, correlation_id).
 * We support both snake_case and camelCase for backward compatibility with different producers.
 */
export interface RawIntentClassifiedEvent {
  id?: string;
  // Fields aligned with shared IntentClassifiedEvent
  event_type?: string;
  session_id?: string;
  sessionId?: string;
  correlation_id?: string;
  correlationId?: string;
  intent_category?: string; // Shared interface field name
  intentCategory?: string;
  intent_type?: string; // Legacy field name (for backward compatibility)
  intentType?: string;
  confidence?: number;
  timestamp?: string;
  // Additional fields for extended events (not in shared interface)
  raw_text?: string;
  rawText?: string;
  extracted_entities?: Record<string, unknown>;
  extractedEntities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at?: string;
  createdAt?: string;
}

/**
 * Intent stored event from Kafka
 * Topic: {env}.onex.evt.omnimemory.intent-stored.v1
 */
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
}

/**
 * Intent query response event from Kafka
 * Topic: {env}.onex.evt.omnimemory.intent-query-response.v1
 */
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

/**
 * EventConsumer class for aggregating Kafka events and emitting real-time updates.
 *
 * This class provides a centralized event consumption and aggregation layer for the
 * Omnidash dashboard. It connects to Kafka topics, processes incoming events, maintains
 * in-memory aggregations for quick access, and emits events for WebSocket broadcasting.
 *
 * @description
 * The EventConsumer follows a singleton pattern (via {@link getEventConsumer}) and handles:
 * - Agent routing decisions and performance metrics
 * - Agent actions (tool calls, decisions, errors)
 * - Agent transformations between polymorphic agents
 * - Node registry events (introspection, heartbeat, state changes)
 * - Automatic data pruning to prevent unbounded memory growth
 *
 * @extends EventEmitter
 *
 * @fires EventConsumer#metricUpdate - When agent metrics are updated
 * @fires EventConsumer#actionUpdate - When new agent action arrives
 * @fires EventConsumer#routingUpdate - When new routing decision arrives
 * @fires EventConsumer#transformationUpdate - When new transformation event arrives
 * @fires EventConsumer#performanceUpdate - When new performance metric arrives
 * @fires EventConsumer#nodeIntrospectionUpdate - When node introspection event arrives
 * @fires EventConsumer#nodeHeartbeatUpdate - When node heartbeat event arrives
 * @fires EventConsumer#nodeStateChangeUpdate - When node state change occurs
 * @fires EventConsumer#nodeRegistryUpdate - When registered nodes map is updated
 * @fires EventConsumer#error - When error occurs during processing
 * @fires EventConsumer#connected - When consumer successfully connects
 * @fires EventConsumer#disconnected - When consumer disconnects
 *
 * @example
 * ```typescript
 * const consumer = getEventConsumer();
 * if (consumer) {
 *   // Listen for metric updates
 *   consumer.on('metricUpdate', (metrics) => {
 *     console.log('Agent metrics updated:', metrics);
 *   });
 *
 *   // Start consuming events
 *   await consumer.start();
 *
 *   // Get current metrics
 *   const metrics = consumer.getAgentMetrics();
 * }
 * ```
 */
export class EventConsumer extends EventEmitter {
  private kafka: Kafka;
  private consumer: Consumer | null = null;
  private producer: Producer | null = null;
  private isRunning = false;
  private isStopping = false;

  // Data retention configuration (configurable via environment variables)
  // INTENT_RETENTION_HOURS: Number of hours to retain intent data (default: 24)
  // PRUNE_INTERVAL_HOURS: How often to run pruning in hours (default: 1)
  // Uses Number.isFinite guard to prevent NaN from reaching interval calculations.
  private readonly DATA_RETENTION_MS = (() => {
    const parsed = parseInt(process.env.INTENT_RETENTION_HOURS || '24', 10);
    return (Number.isFinite(parsed) && parsed > 0 ? parsed : 24) * 60 * 60 * 1000;
  })();
  private readonly PRUNE_INTERVAL_MS = (() => {
    const parsed = parseInt(process.env.PRUNE_INTERVAL_HOURS || '1', 10);
    return (Number.isFinite(parsed) && parsed > 0 ? parsed : 1) * 60 * 60 * 1000;
  })();
  private pruneTimer?: NodeJS.Timeout;
  private canonicalNodeCleanupInterval?: NodeJS.Timeout;

  // In-memory aggregations
  private agentMetrics = new Map<
    string,
    {
      count: number;
      totalRoutingTime: number;
      totalConfidence: number;
      successCount: number;
      errorCount: number;
      lastSeen: Date;
    }
  >();

  private recentActions: AgentAction[] = [];
  private maxActions = 1000;

  private routingDecisions: RoutingDecision[] = [];
  private maxDecisions = 1000;

  private recentTransformations: TransformationEvent[] = [];
  private maxTransformations = 100;

  // Node registry storage
  private registeredNodes = new Map<string, RegisteredNode>();
  private readonly MAX_REGISTERED_NODES = 10000;
  private nodeIntrospectionEvents: NodeIntrospectionEvent[] = [];
  private nodeHeartbeatEvents: NodeHeartbeatEvent[] = [];
  private nodeStateChangeEvents: NodeStateChangeEvent[] = [];
  private maxNodeEvents = 100;

  // Intent event storage
  private recentIntents: InternalIntentClassifiedEvent[] = [];
  private maxIntents = 100;
  // Intent distribution with timestamp tracking for proper pruning
  // Each entry tracks (count, timestamps[]) to allow time-based pruning
  private intentDistributionWithTimestamps: Map<string, { count: number; timestamps: number[] }> =
    new Map();

  // Canonical ONEX node registry (event-driven state)
  private canonicalNodes = new Map<string, CanonicalOnexNode>();

  // Extraction pipeline aggregator (OMN-1804)
  private extractionAggregator = new ExtractionMetricsAggregator();

  // Monotonic merge tracker: ensures newer event_time always wins,
  // preventing stale DB-preloaded or Kafka-replayed events from
  // overwriting fresher state. Tracks per-topic positions.
  private monotonicMerge = new MonotonicMergeTracker();

  // Monotonic arrival counter: used as a fallback seq when Kafka offset
  // is missing (e.g. in tests or playback). Ensures events received in
  // order are never rejected when they share the same millisecond timestamp.
  private arrivalSeq = 0;

  // Deduplication cache for idempotency (max 10,000 entries)
  private processedEvents = new LRUCache<string, number>({ max: 10_000 });

  // Performance metrics storage
  private performanceMetrics: Array<{
    id: string;
    correlationId: string;
    queryText: string;
    routingDurationMs: number;
    cacheHit: boolean;
    candidatesEvaluated: number;
    triggerMatchStrategy: string;
    createdAt: Date;
  }> = [];

  // Aggregated stats for quick access
  private performanceStats = {
    totalQueries: 0,
    cacheHitCount: 0,
    avgRoutingDuration: 0,
    totalRoutingDuration: 0,
  };

  // Playback event injection counters for observability
  private playbackEventsInjected: number = 0;
  private playbackEventsFailed: number = 0;

  // Topic catalog state (OMN-2315) — retained for catalog fallback path
  private catalogTopics: string[] = [];
  private catalogWarnings: string[] = [];
  private catalogSource: 'catalog' | 'fallback' = 'fallback';
  private catalogManager: TopicCatalogManager | null = null;

  // Registry-driven topic discovery (OMN-5027)
  private topicSource: 'registry' | 'catalog' | 'fallback' = 'fallback';
  private discoveryCoordinator: TopicDiscoveryCoordinator | null = null;

  // Raw event bus event rows loaded during preloadFromDatabase().
  // Exposed via getPreloadedEventBusEvents() so WebSocket INITIAL_STATE
  // can serve them from memory instead of re-querying PostgreSQL.
  private preloadedEventBusEvents: EventBusEvent[] = [];

  // Live event bus events accumulated from Kafka eachMessage handler
  // since server startup. Combined with preloadedEventBusEvents in
  // getPreloadedEventBusEvents() so new WebSocket clients always see
  // both historical (DB) and recent (Kafka) events in INITIAL_STATE.
  private liveEventBusEvents: EventBusEvent[] = [];

  // State snapshot for demo mode - stores live data while playback is active
  private stateSnapshot: {
    recentActions: AgentAction[];
    routingDecisions: RoutingDecision[];
    recentTransformations: TransformationEvent[];
    recentIntents: InternalIntentClassifiedEvent[];
    agentMetrics: Map<
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
    intentDistributionWithTimestamps: Map<string, { count: number; timestamps: number[] }>;
  } | null = null;

  constructor() {
    super(); // Initialize EventEmitter

    // Get brokers from bus-config singleton (KAFKA_BOOTSTRAP_SERVERS > KAFKA_BROKERS)
    const brokers = resolveBrokers();

    this.kafka = new Kafka({
      brokers,
      clientId: 'omnidash-event-consumer',
      connectionTimeout: 10000,
      requestTimeout: 30000,
      retry: {
        initialRetryTime: 1000,
        maxRetryTime: 30000,
        retries: 10,
      },
    });

    this.consumer = this.kafka.consumer({
      groupId: 'omnidash-consumers-v2', // Changed to force reading from beginning
    });
    this.producer = this.kafka.producer();

    // Log broker disconnects so the reconnect loop's recovery is visible in logs.
    // The loop itself handles the actual reconnect — this listener is informational only.
    // Guard against test environments where mock consumers may not expose events.DISCONNECT.
    if (this.consumer.events?.DISCONNECT) {
      this.consumer.on(this.consumer.events.DISCONNECT, () => {
        if (this.isRunning) {
          intentLogger.warn(
            '[EventConsumer] Kafka broker disconnected — reconnect loop will recover'
          );
          this.emit('brokerDisconnected');
        }
      });
    }
  }

  // ============================================================================
  // Deduplication and Event Processing Helpers
  // ============================================================================

  /**
   * Check if an event with this correlation_id has already been processed.
   * Uses LRU cache to prevent duplicate processing while bounding memory.
   */
  private isDuplicate(correlationId: string): boolean {
    if (this.processedEvents.has(correlationId)) {
      return true;
    }
    this.processedEvents.set(correlationId, Date.now());
    return false;
  }

  /**
   * Check if an event should be processed based on event ordering.
   * Returns true only if the event is newer than the node's last processed event.
   */
  private shouldProcess(node: CanonicalOnexNode | undefined, eventEmittedAt: number): boolean {
    if (!node) return true;
    return eventEmittedAt > (node.last_event_at || 0);
  }

  /**
   * Parse a Kafka message into a validated ONEX event envelope with typed payload.
   * Returns null if parsing or validation fails.
   */
  private parseEnvelope<T>(
    message: KafkaMessage,
    payloadSchema: z.ZodSchema<T>
  ): EventEnvelope<T> | null {
    try {
      const raw = JSON.parse(message.value?.toString() || '{}');
      const envelope = EventEnvelopeSchema.parse(raw);
      const payload = payloadSchema.parse(envelope.payload);
      return { ...envelope, payload };
    } catch (e) {
      console.warn('[EventConsumer] Failed to parse event envelope:', {
        error: e instanceof Error ? e.message : String(e),
        offset: message.offset,
        key: message.key?.toString(),
        valuePreview: message.value?.toString().slice(0, 200),
      });
      return null;
    }
  }

  /**
   * Validate Kafka broker reachability before starting the consumer.
   *
   * This method performs a lightweight connectivity check by creating a temporary
   * admin connection and listing topics. It's useful for health checks and
   * determining if real-time event streaming should be enabled.
   *
   * @returns Promise resolving to true if broker is reachable, false otherwise
   *
   * @example
   * ```typescript
   * const consumer = getEventConsumer();
   * if (consumer) {
   *   const isReachable = await consumer.validateConnection();
   *   if (isReachable) {
   *     await consumer.start();
   *   } else {
   *     console.log('Kafka not available, using fallback data');
   *   }
   * }
   * ```
   */
  async validateConnection(): Promise<boolean> {
    const brokerStr = getBrokerString();

    if (brokerStr === 'not configured') {
      console.error(
        '❌ KAFKA_BOOTSTRAP_SERVERS not configured - Kafka is required infrastructure. Set KAFKA_BOOTSTRAP_SERVERS in .env to connect to the Redpanda/Kafka broker.'
      );
      return false;
    }

    try {
      intentLogger.info(`Validating Kafka broker connection: ${brokerStr}`);

      const admin = this.kafka.admin();
      await admin.connect();

      // Quick health check - list topics to verify connectivity
      const topics = await admin.listTopics();
      intentLogger.info(`Kafka broker reachable: ${brokerStr} (${topics.length} topics available)`);

      await admin.disconnect();
      return true;
    } catch (error) {
      console.error(`❌ Kafka broker unreachable: ${brokerStr}`);
      console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
      console.error(
        '   Real-time event streaming is unavailable — check KAFKA_BROKERS and network connectivity.'
      );
      return false;
    }
  }

  /**
   * Connect to Kafka with exponential backoff retry logic
   * @param maxRetries - Maximum number of retry attempts (default: DEFAULT_MAX_RETRY_ATTEMPTS)
   */
  async connectWithRetry(maxRetries = DEFAULT_MAX_RETRY_ATTEMPTS): Promise<void> {
    if (!this.consumer) {
      throw new Error('Consumer not initialized');
    }

    // Connect the producer (used for startup re-introspection requests).
    // Fail-open: if connect fails, log and continue — producer is non-critical.
    if (this.producer) {
      this.producer.connect().catch((err: unknown) => {
        intentLogger.warn(
          `[EventConsumer] Producer connect failed (non-critical): ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.consumer.connect();
        intentLogger.info('Kafka consumer connected successfully');
        return;
      } catch (error) {
        const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS);
        const remaining = maxRetries - attempt - 1;

        if (remaining > 0) {
          console.warn(`⚠️ Kafka connection failed (attempt ${attempt + 1}/${maxRetries})`);
          console.warn(`   Error: ${error instanceof Error ? error.message : String(error)}`);
          console.warn(`   Retrying in ${delay}ms... (${remaining} attempts remaining)`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          console.error('❌ Kafka consumer failed after max retries');
          console.error(
            `   Final error: ${error instanceof Error ? error.message : String(error)}`
          );
          throw new Error(
            `Kafka connection failed after ${maxRetries} attempts: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  /**
   * Start the Kafka event consumer and begin processing events.
   *
   * This method performs the following operations:
   * 1. Connects to Kafka with retry logic
   * 2. Preloads historical data from PostgreSQL (if enabled)
   * 3. Subscribes to all configured Kafka topics
   * 4. Starts the message processing loop
   * 5. Initializes periodic data pruning
   *
   * @returns Promise that resolves when the consumer is started
   * @throws {Error} If connection fails after max retries
   *
   * @fires EventConsumer#connected - When successfully connected to Kafka
   * @fires EventConsumer#metricUpdate - Initial metrics after preload
   * @fires EventConsumer#actionUpdate - Initial actions after preload
   *
   * @example
   * ```typescript
   * const consumer = getEventConsumer();
   * if (consumer) {
   *   await consumer.start();
   *   console.log('Consumer is now processing events');
   * }
   * ```
   */
  async start() {
    if (this.isRunning || !this.consumer) {
      intentLogger.info('Event consumer already running or not initialized');
      return;
    }

    try {
      await this.connectWithRetry();
      intentLogger.info('Kafka consumer connected');
      this.emit('connected'); // Emit connected event

      // Preload historical data from PostgreSQL to populate dashboards on startup
      if (process.env.ENABLE_EVENT_PRELOAD !== 'false') {
        try {
          await this.preloadFromDatabase();
          intentLogger.info('Preloaded historical data from PostgreSQL');
        } catch (e) {
          // IMPORTANT: With fromBeginning: false, a fresh consumer group defaults
          // to 'latest' and skips all historical events. If the DB preload also
          // fails, the dashboard will show zero events until new Kafka messages
          // arrive. This is a known trade-off — logging at error level to ensure
          // visibility in production monitoring.
          console.error(
            '[EventConsumer] DB preload failed — dashboard may show no historical data until new Kafka events arrive:',
            e
          );
        }
      }

      // OMN-3334: Request re-introspection on startup when node registry is empty.
      //
      // omniclaude emits node-introspection events once at plugin start. If omnidash
      // restarts after that window, the registry is empty until omniclaude restarts.
      // Emitting a request-introspection command triggers running nodes to re-emit their
      // introspection events, making the Node Registry self-healing on restart.
      //
      // Fire-and-forget: per CLAUDE.md Kafka rules, never block the calling thread.
      // Fail-open: if the producer isn't ready yet, log and continue.
      if (this.registeredNodes.size === 0 && this.canonicalNodes.size === 0) {
        intentLogger.info(
          '[EventConsumer] Node registry empty after preload — requesting re-introspection [OMN-3334]'
        );
        Promise.resolve().then(async () => {
          try {
            if (!this.producer) return;
            await this.producer.send({
              topic: TOPIC.REQUEST_INTROSPECTION,
              messages: [
                {
                  value: JSON.stringify({
                    reason: 'omnidash_startup',
                    timestamp: new Date().toISOString(),
                  }),
                },
              ],
            });
            intentLogger.info('[EventConsumer] Re-introspection request emitted successfully');
          } catch (err) {
            intentLogger.warn(
              `[EventConsumer] Re-introspection request failed (non-critical): ${err instanceof Error ? err.message : String(err)}`
            );
          }
        });
      }

      // -----------------------------------------------------------------------
      // Topic Discovery (OMN-5027 — registry-driven, replaces OMN-2315 catalog)
      //
      // Two modes controlled by OMNIDASH_USE_REGISTRY_DISCOVERY:
      //   true  (default): Use TopicDiscoveryCoordinator for registry-driven
      //                    discovery via introspection events.
      //   false:           Fall back to legacy TopicCatalogManager (OMN-2315).
      //
      // Registry discovery: BOOTSTRAP_TOPICS are always subscribed. After
      // introspection events arrive and stabilize (debounce), the full topic
      // set is BOOTSTRAP_TOPICS + registry-discovered evt topics.
      // -----------------------------------------------------------------------
      const useRegistryDiscovery = process.env.OMNIDASH_USE_REGISTRY_DISCOVERY !== 'false';

      let subscriptionTopics: string[];

      if (useRegistryDiscovery) {
        // Wire TopicRegistryService to NodeRegistryProjection (OMN-5025)
        const topicRegistry = getTopicRegistryService();
        this.discoveryCoordinator = new TopicDiscoveryCoordinator(topicRegistry);

        // Phase 1: Subscribe to bootstrap topics first so introspection events flow
        await this.consumer.subscribe({
          topics: [...BOOTSTRAP_TOPICS],
          fromBeginning: false,
        });
        intentLogger.info(
          `[EventConsumer] Phase 1: Subscribed to ${BOOTSTRAP_TOPICS.length} bootstrap topics for discovery`
        );

        // Start the consumer briefly to receive introspection events
        // The discovery coordinator will stabilize after debounce
        const discoveryResult = await this.discoveryCoordinator.waitForDiscovery();

        this.topicSource = discoveryResult.source === 'registry' ? 'registry' : 'fallback';
        subscriptionTopics = discoveryResult.topics;

        if (discoveryResult.degraded) {
          intentLogger.warn(
            `[EventConsumer] Topic discovery degraded after ${discoveryResult.durationMs}ms — ` +
              `proceeding with ${discoveryResult.registryTopicCount} registry topics + bootstrap`
          );
        } else {
          intentLogger.info(
            `[EventConsumer] Topic discovery stabilized in ${discoveryResult.durationMs}ms — ` +
              `${discoveryResult.registryTopicCount} registry topics from ${discoveryResult.nodeCount} nodes`
          );
        }

        // If registry found no topics beyond bootstrap, fall back to buildSubscriptionTopics()
        // to ensure we don't miss events during initial deployment before nodes report event_bus
        if (discoveryResult.registryTopicCount === 0) {
          intentLogger.info(
            '[EventConsumer] No registry topics discovered — falling back to buildSubscriptionTopics()'
          );
          subscriptionTopics = buildSubscriptionTopics();
          this.topicSource = 'fallback';
        }
      } else {
        // Legacy path: TopicCatalogManager (OMN-2315)
        subscriptionTopics = await this.fetchCatalogTopics();
      }

      // Kafka topic preflight (OMN-4607): assert required skill-lifecycle topics
      // exist before subscribing. Crash-loop is the correct operator signal if
      // required topics are missing — do not soften to a warning.
      // These topics are required for the omninode-skill-lifecycle-consumer to
      // function; missing topics indicate the data-plane Redpanda is not seeded.
      if (!isTestEnv) {
        const preflightAdmin = this.kafka.admin();
        await assertTopicsExist(preflightAdmin, [
          'onex.evt.omniclaude.skill-started.v1',
          'onex.evt.omniclaude.skill-completed.v1',
        ]);
        intentLogger.info(
          '[EventConsumer] Kafka topic preflight passed: required skill-lifecycle topics exist'
        );
      }

      // Phase B: Subscribe at committed consumer-group offsets, NOT from the
      // beginning. Historical data is already covered by the Phase A DB preload.
      // Using fromBeginning: true would replay 3-7 days of Kafka retention,
      // causing old events to overwrite fresh dashboard state.
      //
      // DEPLOYMENT NOTE: For a fresh consumer group (no committed offsets),
      // KafkaJS defaults to 'latest', skipping messages produced while the
      // consumer was down. This is intentional — the DB preload covers history.
      // TRADE-OFF: If downtime exceeds PRELOAD_WINDOW_MINUTES, events in the
      // gap (after preload cutoff but before consumer reconnects) will be missed.
      // Phase B: Final subscription with full topic set.
      // If registry discovery was used, the consumer was already subscribed to
      // BOOTSTRAP_TOPICS in Phase 1. Re-subscribing replaces the subscription.
      await this.consumer.subscribe({
        topics: subscriptionTopics,
        fromBeginning: false,
      });
      intentLogger.info(
        `Phase B: Kafka subscription started (source=${this.topicSource}, topics=${subscriptionTopics.length})`
      );

      this.isRunning = true;

      // Start periodic pruning to prevent unbounded memory growth
      this.pruneTimer = setInterval(() => {
        this.pruneOldData();
      }, this.PRUNE_INTERVAL_MS);

      // Start periodic cleanup of stale offline canonical nodes
      this.canonicalNodeCleanupInterval = setInterval(
        () => this.cleanupStaleCanonicalNodes(),
        CLEANUP_INTERVAL_MS
      );

      intentLogger.info('Event consumer started with automatic data pruning');

      // Runtime disconnect recovery loop.
      //
      // IMPORTANT: kafkajs 2.2.4 + Redpanda compatibility (OMN-2789)
      // consumer.run() resolves its promise almost immediately (~100ms)
      // after the consumer joins the group — it does NOT block until the
      // consumer stops. The internal fetch loop continues in the background.
      //
      // We fire-and-forget consumer.run() and block on a flag-poll loop
      // instead. The .catch() handler sets consumerCrashed=true so the
      // outer while-loop can detect real failures and reconnect.
      //
      // The entire loop is wrapped in a background async IIFE so that
      // start() returns promptly and server.listen() is not blocked.
      // stop() sets this.isRunning=false to break the loop.
      (async () => {
        while (this.isRunning) {
          try {
            let consumerCrashed = false;
            let _crashError: unknown = null;
            this.consumer!.run({
              eachMessage: async ({ topic: rawTopic, partition, message }) => {
                try {
                  // Parse JSON with dedicated guard so malformed messages are
                  // logged and skipped instead of crashing the consumer.
                  // Follows the same defensive pattern used by parseEnvelope()
                  // and read-model-consumer.ts's parseMessage().

                  let event: any;
                  try {
                    event = JSON.parse(message.value?.toString() || '{}');
                  } catch (parseError) {
                    console.warn('[EventConsumer] Skipping malformed JSON message:', {
                      topic: rawTopic,
                      partition,
                      offset: message.offset,
                      error: parseError instanceof Error ? parseError.message : String(parseError),
                      valuePreview: message.value?.toString().slice(0, 50),
                    });
                    return; // skip bad message, do not re-throw
                  }

                  // Strip legacy env prefix (e.g. "dev.onex.evt..." -> "onex.evt...")
                  // so topics match canonical names used by the switch cases below.
                  // Legacy flat topics (e.g. "agent-actions") are no longer subscribed; all active
                  // topics use canonical ONEX names (onex.evt.omniclaude.*). Pass-through is retained
                  // for any historical records that may still exist in the database.
                  const topic = extractSuffix(rawTopic);

                  // Capture Kafka events into the live event bus buffer so new
                  // WebSocket clients receive recent events in INITIAL_STATE, not just
                  // the stale DB snapshot from server startup.
                  // Heartbeats are excluded: they are high-frequency infra noise that
                  // would fill the 2000-event buffer and evict real events before the
                  // client display filter can hide them.
                  if (topic !== TOPIC.NODE_HEARTBEAT) {
                    this.captureLiveEventBusEvent(event, rawTopic, partition, message);
                  }

                  // Monotonic merge gate: reject events whose timestamp is older than
                  // the last applied event for this topic. This prevents DB-preloaded
                  // or Kafka-replayed events from overwriting fresher dashboard state.
                  // Note: we still capture into the live buffer above (it has its own
                  // dedup/sort), but we skip handler processing for stale events.
                  const incomingEventTime = extractEventTimeMs(event);
                  // Use Kafka offset as primary seq; fall back to a monotonic arrival
                  // counter when offset is missing (tests, playback injection).
                  const kafkaOffset = parseOffsetAsSeq(message.offset);
                  // Use Kafka offset when a real offset string is present (including valid '0');
                  // fall back to arrival counter only when offset is missing (tests, playback).
                  const hasKafkaOffset = message.offset != null && message.offset !== '';
                  const incomingSeq = hasKafkaOffset ? kafkaOffset : ++this.arrivalSeq;
                  // Key includes partition because Kafka offsets are per-partition,
                  // not global. Without partition, two events from different partitions
                  // with the same timestamp and offset would incorrectly collide.
                  if (
                    !this.monotonicMerge.checkAndUpdate(`${topic}:${partition}`, {
                      eventTime: incomingEventTime,
                      seq: incomingSeq,
                    })
                  ) {
                    return; // stale event — already logged at debug level by the tracker
                  }

                  // Gate verbose per-event debug logging behind log level check.
                  // This avoids template string evaluation overhead on every Kafka
                  // message when debug logging is disabled (the common production case).
                  const isDebug = currentLogLevel <= LOG_LEVELS.debug;
                  if (isDebug) {
                    intentLogger.debug(`Received event from topic: ${topic}`);
                  }

                  switch (topic) {
                    // Canonical ONEX agent topics
                    case TOPIC_OMNICLAUDE_ROUTING_DECISIONS:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing routing decision for agent: ${event.selected_agent || event.selectedAgent}`
                        );
                      }
                      this.handleRoutingDecision(event);
                      break;
                    case TOPIC_OMNICLAUDE_AGENT_ACTIONS:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing action: ${event.action_type || event.actionType} from ${event.agent_name || event.agentName}`
                        );
                      }
                      this.handleAgentAction(event);
                      break;
                    case TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing transformation: ${event.source_agent || event.sourceAgent} → ${event.target_agent || event.targetAgent}`
                        );
                      }
                      this.handleTransformationEvent(event);
                      break;
                    case TOPIC_OMNICLAUDE_PERFORMANCE_METRICS:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing performance metric: ${event.routing_duration_ms || event.routingDurationMs}ms`
                        );
                      }
                      this.handlePerformanceMetric(event);
                      break;

                    // Platform node topics (canonical ONEX)
                    case TOPIC.NODE_INTROSPECTION:
                    case TOPIC.REQUEST_INTROSPECTION: {
                      // Detect envelope format to route to exactly ONE handler path.
                      // Canonical envelopes (ModelEventEnvelope from omnibase_core) carry
                      // envelope_id + envelope_timestamp + payload.  Legacy events have
                      // flat fields like node_id at the top level.  We do NOT check
                      // event_type because it is not part of EventEnvelopeSchema.
                      const isIntrospectionEnvelope = Boolean(
                        event.envelope_id && event.envelope_timestamp && event.payload
                      );
                      if (!isIntrospectionEnvelope) {
                        if (isDebug) {
                          intentLogger.debug(
                            `Processing node introspection: ${event.node_id || event.nodeId} (${event.reason || 'unknown'})`
                          );
                        }
                        this.handleNodeIntrospection(event);
                      } else {
                        if (DEBUG_CANONICAL_EVENTS) {
                          intentLogger.debug('Processing canonical node-introspection event');
                        }
                        this.handleCanonicalNodeIntrospection(message);
                      }
                      break;
                    }
                    case TOPIC.NODE_HEARTBEAT: {
                      // Detect envelope format to route to exactly ONE handler path.
                      // Canonical envelopes (ModelEventEnvelope from omnibase_core) carry
                      // envelope_id + envelope_timestamp + payload.
                      const isHeartbeatEnvelope = Boolean(
                        event.envelope_id && event.envelope_timestamp && event.payload
                      );
                      if (!isHeartbeatEnvelope) {
                        if (isDebug) {
                          intentLogger.debug(
                            `Processing node heartbeat: ${event.node_id || event.nodeId}`
                          );
                        }
                        this.handleNodeHeartbeat(event);
                      } else {
                        if (DEBUG_CANONICAL_EVENTS) {
                          intentLogger.debug('Processing canonical node-heartbeat event');
                        }
                        this.handleCanonicalNodeHeartbeat(message);
                      }
                      break;
                    }
                    case TOPIC.NODE_REGISTRATION: {
                      // Detect envelope format: canonical envelopes (ModelEventEnvelope from
                      // omnibase_core) carry envelope_id + envelope_timestamp + payload;
                      // legacy events have flat fields like node_id at the top level.
                      const isRegistrationEnvelope = Boolean(
                        event.envelope_id && event.envelope_timestamp && event.payload
                      );
                      if (!isRegistrationEnvelope) {
                        if (isDebug) {
                          intentLogger.debug(
                            `Processing node state change: ${event.node_id || event.nodeId} -> ${event.new_state || event.newState || 'active'}`
                          );
                        }
                        this.handleNodeStateChange(event);
                      } else {
                        if (DEBUG_CANONICAL_EVENTS) {
                          intentLogger.debug('Processing canonical node-registration event');
                        }
                        this.handleCanonicalNodeIntrospection(message);
                      }
                      break;
                    }
                    case TOPIC.CONTRACT_REGISTERED:
                    case TOPIC.CONTRACT_DEREGISTERED: {
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing contract lifecycle event from topic: ${topic}`
                        );
                      }
                      this.handleCanonicalNodeIntrospection(message);
                      break;
                    }
                    case TOPIC.NODE_REGISTRATION_INITIATED:
                    case TOPIC.NODE_REGISTRATION_ACCEPTED:
                    case TOPIC.NODE_REGISTRATION_REJECTED:
                    case TOPIC.NODE_REGISTRATION_ACKED:
                    case TOPIC.NODE_REGISTRATION_RESULT:
                    case TOPIC.NODE_REGISTRATION_ACK_RECEIVED:
                    case TOPIC.NODE_REGISTRATION_ACK_TIMED_OUT: {
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing node registration lifecycle event from topic: ${topic}`
                        );
                      }
                      this.handleCanonicalNodeIntrospection(message);
                      break;
                    }
                    case TOPIC.REGISTRY_REQUEST_INTROSPECTION: {
                      if (isDebug) {
                        intentLogger.debug('Processing registry-request-introspection event');
                      }
                      this.handleCanonicalNodeIntrospection(message);
                      break;
                    }
                    case TOPIC.FSM_STATE_TRANSITIONS: {
                      if (isDebug) {
                        intentLogger.debug('Processing FSM state transition event');
                      }
                      this.handleCanonicalNodeIntrospection(message);
                      break;
                    }
                    case TOPIC.RUNTIME_TICK: {
                      if (isDebug) {
                        intentLogger.debug('Processing runtime tick event');
                      }
                      this.handleCanonicalNodeIntrospection(message);
                      break;
                    }
                    case TOPIC.REGISTRATION_SNAPSHOTS: {
                      if (isDebug) {
                        intentLogger.debug('Processing registration snapshot');
                      }
                      this.handleCanonicalNodeIntrospection(message);
                      break;
                    }

                    // Intent topics (canonical names, matched after legacy prefix stripping)
                    case SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing intent classified: ${event.intent_type || event.intentType} (confidence: ${event.confidence})`
                        );
                      }
                      this.handleIntentClassified(event);
                      break;
                    case SUFFIX_MEMORY_INTENT_STORED:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing intent stored: ${event.intent_id || event.intentId}`
                        );
                      }
                      this.handleIntentStored(event);
                      break;
                    case SUFFIX_MEMORY_INTENT_QUERY_RESPONSE:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing intent query response: ${event.query_id || event.queryId}`
                        );
                      }
                      this.handleIntentQueryResponse(event);
                      break;

                    // OmniClaude hook events
                    case TOPIC.CLAUDE_HOOK:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing claude hook event: ${event.event_type || event.eventType} - ${(event.payload?.prompt || '').slice(0, 50)}...`
                        );
                      }
                      this.handleClaudeHookEvent(event);
                      break;
                    // OmniClaude lifecycle events
                    case TOPIC.PROMPT_SUBMITTED:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing prompt-submitted: ${(event.payload?.prompt_preview || '').slice(0, 50)}...`
                        );
                      }
                      this.handlePromptSubmittedEvent(event);
                      break;
                    case TOPIC.SESSION_STARTED:
                    case TOPIC.SESSION_ENDED:
                    case TOPIC.TOOL_EXECUTED:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing omniclaude event: ${event.event_type || event.eventType}`
                        );
                      }
                      this.handleOmniclaudeLifecycleEvent(event, topic);
                      break;

                    // Tool-content events from omniintelligence (tool execution records)
                    case TOPIC.TOOL_CONTENT:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing tool-content: ${(event as Record<string, string>).tool_name || 'unknown'}`
                        );
                      }
                      this.handleAgentAction({
                        action_type: 'tool',
                        agent_name: 'omniclaude',
                        action_name: (event as Record<string, string>).tool_name || 'unknown',
                        correlation_id: (event as Record<string, string>).correlation_id,
                        duration_ms: Number((event as Record<string, unknown>).duration_ms || 0),
                        timestamp: (event as Record<string, string>).timestamp,
                      } as RawAgentActionEvent);
                      break;

                    // Cross-repo validation topics (canonical names, matched after legacy prefix stripping)
                    case SUFFIX_VALIDATION_RUN_STARTED:
                      if (isValidationRunStarted(event)) {
                        if (isDebug) {
                          intentLogger.debug(`Processing validation run started: ${event.run_id}`);
                        }
                        await handleValidationRunStarted(event);
                        this.emit('validation-event', { type: 'run-started', event });
                      } else {
                        console.warn(
                          '[validation] Dropped malformed run-started event on topic',
                          topic
                        );
                      }
                      break;
                    case SUFFIX_VALIDATION_VIOLATIONS_BATCH:
                      if (isValidationViolationsBatch(event)) {
                        if (isDebug) {
                          intentLogger.debug(
                            `Processing validation violations batch: ${event.run_id} (${event.violations.length} violations)`
                          );
                        }
                        await handleValidationViolationsBatch(event);
                        this.emit('validation-event', { type: 'violations-batch', event });
                      } else {
                        console.warn(
                          '[validation] Dropped malformed violations-batch event on topic',
                          topic
                        );
                      }
                      break;
                    case SUFFIX_VALIDATION_RUN_COMPLETED:
                      if (isValidationRunCompleted(event)) {
                        if (isDebug) {
                          intentLogger.debug(
                            `Processing validation run completed: ${event.run_id} (${event.status})`
                          );
                        }
                        await handleValidationRunCompleted(event);
                        this.emit('validation-event', { type: 'run-completed', event });
                      } else {
                        console.warn(
                          '[validation] Dropped malformed run-completed event on topic',
                          topic
                        );
                      }
                      break;
                    case SUFFIX_VALIDATION_CANDIDATE_UPSERTED:
                      if (isValidationCandidateUpserted(event)) {
                        if (isDebug) {
                          intentLogger.debug(
                            `Processing validation candidate upserted: ${(event as { candidate_id: string }).candidate_id}`
                          );
                        }
                        await handleValidationCandidateUpserted(event);
                        this.emit('validation-event', { type: 'candidate-upserted', event });
                      } else {
                        console.warn(
                          '[validation] Dropped malformed candidate-upserted event on topic',
                          topic
                        );
                      }
                      break;

                    // Extraction pipeline topics (OMN-1804)
                    case SUFFIX_OMNICLAUDE_CONTEXT_UTILIZATION:
                      if (isContextUtilizationEvent(event)) {
                        await this.extractionAggregator.handleContextUtilization(event);
                        if (this.extractionAggregator.shouldBroadcast()) {
                          effectivenessMetricsProjection.reset();
                          emitEffectivenessUpdate();
                          this.emit('extraction-event', { type: 'context-utilization' });
                        }
                      } else {
                        console.warn('[extraction] Dropped malformed context-utilization event');
                      }
                      break;
                    case SUFFIX_OMNICLAUDE_AGENT_MATCH:
                      if (isAgentMatchEvent(event)) {
                        await this.extractionAggregator.handleAgentMatch(event);
                        if (this.extractionAggregator.shouldBroadcast()) {
                          effectivenessMetricsProjection.reset();
                          emitEffectivenessUpdate();
                          this.emit('extraction-event', { type: 'agent-match' });
                        }
                      } else {
                        console.warn('[extraction] Dropped malformed agent-match event');
                      }
                      break;
                    case SUFFIX_OMNICLAUDE_LATENCY_BREAKDOWN:
                      if (isLatencyBreakdownEvent(event)) {
                        await this.extractionAggregator.handleLatencyBreakdown(event);
                        if (this.extractionAggregator.shouldBroadcast()) {
                          effectivenessMetricsProjection.reset();
                          emitEffectivenessUpdate();
                          this.emit('extraction-event', { type: 'latency-breakdown' });
                        }
                      } else {
                        console.warn('[extraction] Dropped malformed latency-breakdown event');
                      }
                      break;

                    // TODO(OMN-2152): Wire event processing for these topics once read-model
                    // projections are defined. Currently consuming to test connectivity;
                    // offset advancement is intentional.

                    // Intelligence pipeline commands + completions
                    case SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD:
                    case SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_CMD:
                    case SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD:
                    case SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_CMD:
                    case SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED:
                    case SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED:
                    case SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_COMPLETED:
                    case SUFFIX_INTELLIGENCE_PATTERN_LEARNING_COMPLETED:
                    case SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing intelligence pipeline event from topic: ${topic}`
                        );
                      }
                      break;

                    // Pattern lifecycle
                    case SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITION_CMD:
                    case SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED:
                    case SUFFIX_INTELLIGENCE_PATTERN_PROMOTED:
                    case SUFFIX_INTELLIGENCE_PATTERN_STORED:
                    case SUFFIX_PATTERN_DISCOVERED:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing pattern lifecycle event from topic: ${topic}`
                        );
                      }
                      break;

                    // Session/agent status
                    case SUFFIX_INTELLIGENCE_SESSION_OUTCOME_CMD:
                    case SUFFIX_AGENT_STATUS:
                      if (isDebug) {
                        intentLogger.debug(`Processing session/agent event from topic: ${topic}`);
                      }
                      break;

                    // OmniClaude extended events (routing, sessions, manifests, notifications)
                    case SUFFIX_OMNICLAUDE_ROUTING_DECISION:
                    case SUFFIX_OMNICLAUDE_SESSION_OUTCOME:
                    case SUFFIX_OMNICLAUDE_MANIFEST_INJECTED:
                    case SUFFIX_OMNICLAUDE_PHASE_METRICS:
                    case SUFFIX_OMNICLAUDE_NOTIFICATION_BLOCKED:
                    case SUFFIX_OMNICLAUDE_NOTIFICATION_COMPLETED:
                    case SUFFIX_OMNICLAUDE_TRANSFORMATION_COMPLETED:
                      if (isDebug) {
                        intentLogger.debug(
                          `Processing omniclaude extended event from topic: ${topic}`
                        );
                      }
                      break;

                    // Status dashboard topics (OMN-2658)
                    case TOPIC.GITHUB_PR_STATUS:
                      if (isGitHubPRStatusEvent(event)) {
                        statusProjection.upsertPR(event);
                        emitStatusInvalidate('pr');
                        if (isDebug) {
                          intentLogger.debug(
                            `[status] PR upserted: ${event.repo}#${event.pr_number} (${event.ci_status})`
                          );
                        }
                      } else {
                        console.warn('[status] Dropped malformed github.pr-status event');
                      }
                      break;
                    case TOPIC.GIT_HOOK:
                      if (isGitHookEvent(event)) {
                        statusProjection.appendHook(event);
                        emitStatusInvalidate('hook');
                        if (isDebug) {
                          intentLogger.debug(
                            `[status] Hook event appended: ${event.hook} on ${event.repo}:${event.branch} (success=${event.success})`
                          );
                        }
                      } else {
                        console.warn('[status] Dropped malformed git.hook event');
                      }
                      break;
                    case TOPIC.LINEAR_SNAPSHOT:
                      if (isLinearSnapshotEvent(event)) {
                        statusProjection.replaceWorkstreams(event);
                        emitStatusInvalidate('linear');
                        if (isDebug) {
                          intentLogger.debug(
                            `[status] Linear snapshot replaced: ${event.workstreams.length} workstreams`
                          );
                        }
                      } else {
                        console.warn('[status] Dropped malformed linear.snapshot event');
                      }
                      break;

                    default:
                      intentLogger.debug(`Unhandled topic: ${topic}`);
                      break;
                  }
                } catch (error) {
                  console.error('Error processing Kafka message:', error);

                  // If error suggests a connection/broker issue, rethrow so consumer.run()
                  // rejects and the outer while-loop catch block handles reconnection cleanly.
                  // Calling connectWithRetry() here while consumer.run() is still active is
                  // unsafe — it creates undefined state for offset commits and heartbeats.
                  // NOTE: Do NOT emit 'error' here for connection errors — the outer catch at
                  // the consumer.run() level will emit it exactly once when the rethrown error
                  // surfaces there.
                  if (
                    error instanceof Error &&
                    (error.message.includes('connection') ||
                      error.message.includes('broker') ||
                      error.message.includes('network'))
                  ) {
                    throw error;
                  } else {
                    // Non-connection errors (malformed messages, business logic exceptions, etc.)
                    // are swallowed here so processing continues, but callers listening to the
                    // 'error' event must still be notified.
                    this.emit('error', error);
                  }
                }
              },
            }).catch((runErr: unknown) => {
              if (this.isRunning && !isTestEnv) {
                console.error('[EventConsumer] consumer.run() threw:', runErr);
                this.emit('error', runErr);
                consumerCrashed = true;
                _crashError = runErr;
              }
            });

            // In test env, mocks resolve consumer.run() immediately.
            // Break the loop so the test doesn't spin forever.
            if (isTestEnv) break;

            // Block while the consumer is alive. The internal kafkajs fetch
            // loop runs in the background; we just keep this loop iteration
            // from advancing. stop() sets this.isRunning=false, and the
            // .catch() above sets consumerCrashed=true on real failures.
            while (this.isRunning && !consumerCrashed) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }

            // If a real crash happened, reconnect.
            if (consumerCrashed && this.isRunning) {
              intentLogger.warn('[EventConsumer] Consumer crashed, reconnecting in 5s...');
              await new Promise((resolve) => setTimeout(resolve, 5000));
              try {
                await this.consumer?.disconnect().catch(() => {});
                await this.connectWithRetry();
                await this.consumer!.subscribe({
                  topics: subscriptionTopics,
                  fromBeginning: false,
                });
              } catch (reconnectErr) {
                console.error('[EventConsumer] Reconnect failed, will retry...', reconnectErr);
                this.emit('error', reconnectErr);
              }
            }
          } catch (outerErr) {
            if (!this.isRunning || isTestEnv) break;
            console.error('[EventConsumer] Unexpected error in consumer loop:', outerErr);
            this.emit('error', outerErr);
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        } // end while (this.isRunning)
      })().catch((err) => {
        console.error('[EventConsumer] Background consumer loop crashed:', err);
        this.emit('error', err);
      });
    } catch (error) {
      console.error('Failed to start event consumer:', error);
      this.emit('error', error); // Emit error event
      throw error;
    }
  }

  /**
   * Capture a live Kafka event into the in-memory buffer so it appears in
   * INITIAL_STATE for new WebSocket clients. This bridges the gap between
   * the one-time DB preload (which may be stale) and real-time Kafka events
   * (which previously were only broadcast to already-connected clients).
   *
   * The buffer is capped at MAX_LIVE_EVENT_BUS_EVENTS and pruned periodically
   * by pruneOldData() to prevent unbounded memory growth.
   */
  private captureLiveEventBusEvent(
    event: Record<string, unknown>,
    rawTopic: string,
    partition: number,
    message: KafkaMessage
  ): void {
    try {
      const now = new Date();
      // Use extractEventTimeMs which checks emitted_at (canonical envelopes),
      // timestamp, created_at, and createdAt in priority order. This ensures
      // canonical ONEX envelopes get their actual event time rather than now().
      const eventTimeMs = extractEventTimeMs(event);
      const eventTimestamp =
        eventTimeMs > 0 ? new Date(eventTimeMs).toISOString() : now.toISOString();

      let parsedPayload: Record<string, any>;
      if (event.payload && typeof event.payload === 'object') {
        parsedPayload = event.payload as Record<string, any>;
      } else {
        // For flat events (legacy format), the entire event IS the payload
        parsedPayload = event as Record<string, any>;
      }

      const liveEvent: EventBusEvent = {
        event_type: (event.event_type as string) || (event.eventType as string) || rawTopic,
        event_id: (event.event_id as string) || (event.eventId as string) || crypto.randomUUID(),
        timestamp: eventTimestamp,
        tenant_id: (event.tenant_id as string) || (event.tenantId as string) || '',
        namespace: (event.namespace as string) || '',
        source: (event.source as string) || '',
        correlation_id:
          (event.correlation_id as string) || (event.correlationId as string) || undefined,
        causation_id: (event.causation_id as string) || (event.causationId as string) || undefined,
        schema_ref: (event.schema_ref as string) || (event.schemaRef as string) || '',
        payload: parsedPayload,
        topic: rawTopic,
        partition,
        offset: message.offset || '0',
        processed_at: now,
        stored_at: now,
      };

      this.liveEventBusEvents.push(liveEvent);

      // Cap the buffer to prevent unbounded memory growth.
      // splice(0, excess) removes oldest entries in-place, avoiding O(n) array copies.
      if (this.liveEventBusEvents.length > MAX_LIVE_EVENT_BUS_EVENTS) {
        const excess = this.liveEventBusEvents.length - MAX_LIVE_EVENT_BUS_EVENTS;
        this.liveEventBusEvents.splice(0, excess);
      }
    } catch (err) {
      // Non-critical — don't let capture failures affect event processing.
      // Log at debug level so systematic issues (e.g. serialization bugs)
      // are visible in diagnostic output without flooding production logs.
      console.debug('[EventConsumer] captureLiveEventBusEvent failed:', err);
    }
  }

  private async preloadFromDatabase() {
    try {
      const preloadStart = Date.now();

      // ── Phase A: Fresh preload ─────────────────────────────────────────
      // Query event_bus_events for events within the configured time window.
      // Uses parameterized interval to prevent SQL injection, a stable
      // tie-break (id DESC) for deterministic ordering when timestamps
      // collide, and caps results at MAX_PRELOAD_EVENTS.
      const cutoffDate = new Date(Date.now() - PRELOAD_WINDOW_MINUTES * 60 * 1000);
      const result = await getIntelligenceDb().execute(
        sql`SELECT event_type, event_id, timestamp, tenant_id, namespace, source,
               correlation_id, causation_id, schema_ref, payload, topic,
               partition, "offset", processed_at, stored_at
        FROM event_bus_events
        WHERE timestamp >= ${cutoffDate}
        ORDER BY timestamp DESC, id DESC
        LIMIT ${MAX_PRELOAD_EVENTS}`
      );

      const rows = Array.isArray(result) ? result : result?.rows || result || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        intentLogger.info(
          `Phase A: Preload returned 0 events (window=${PRELOAD_WINDOW_MINUTES}min, limit=${MAX_PRELOAD_EVENTS})`
        );
        return;
      }

      // ── Phase A logging: Timestamp range diagnostics ───────────────────
      const timestamps = (rows as Array<Record<string, unknown>>)
        .map((r) => r.timestamp as string)
        .filter(Boolean);
      const oldest = timestamps[timestamps.length - 1] || 'N/A';
      const newest = timestamps[0] || 'N/A';
      intentLogger.info(
        `Phase A: Preload loaded ${rows.length} events, oldest=${oldest}, newest=${newest}, window=${PRELOAD_WINDOW_MINUTES}min`
      );

      // ── Optional backfill of older events ──────────────────────────────
      // When ENABLE_BACKFILL=true, load older events beyond the fresh
      // window to fill remaining capacity. Off by default to avoid the
      // exact staleness problem this fix addresses.
      let backfillRows: Array<Record<string, unknown>> = [];
      if (ENABLE_BACKFILL && rows.length < MAX_PRELOAD_EVENTS) {
        const remainingCapacity = Math.min(BACKFILL_MAX_EVENTS, MAX_PRELOAD_EVENTS - rows.length);
        const backfillResult = await getIntelligenceDb().execute(
          sql`SELECT event_type, event_id, timestamp, tenant_id, namespace, source,
                 correlation_id, causation_id, schema_ref, payload, topic,
                 partition, "offset", processed_at, stored_at
          FROM event_bus_events
          WHERE timestamp < ${cutoffDate}
          ORDER BY timestamp DESC, id DESC
          LIMIT ${remainingCapacity}`
        );
        const rawBackfill = Array.isArray(backfillResult)
          ? backfillResult
          : backfillResult?.rows || backfillResult || [];
        if (Array.isArray(rawBackfill)) {
          backfillRows = rawBackfill as Array<Record<string, unknown>>;
        }
        intentLogger.info(
          `Phase A (backfill): Loaded ${backfillRows.length} older events (cap=${remainingCapacity})`
        );
      }

      // Combine fresh + backfill rows (fresh first, already newest-to-oldest)
      const allRows = [...(rows as Array<Record<string, unknown>>), ...backfillRows];

      // Store raw rows as EventBusEvent objects for INITIAL_STATE delivery.
      // The rows are already sorted newest-first (ORDER BY timestamp DESC, id DESC)
      // which matches the order expected by the WebSocket client.
      // Uses per-row try/catch so a single malformed payload doesn't prevent
      // all events from being served via WebSocket INITIAL_STATE.
      this.preloadedEventBusEvents = [];
      for (const row of allRows) {
        try {
          let parsedPayload: Record<string, any>;
          try {
            parsedPayload = (
              typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {}
            ) as Record<string, any>;
          } catch {
            parsedPayload = {};
          }
          this.preloadedEventBusEvents.push({
            event_type: (row.event_type as string) || '',
            event_id: (row.event_id as string) || '',
            timestamp: (row.timestamp as string) || '',
            tenant_id: (row.tenant_id as string) || '',
            namespace: (row.namespace as string) || '',
            source: (row.source as string) || '',
            correlation_id: row.correlation_id as string | undefined,
            causation_id: row.causation_id as string | undefined,
            schema_ref: (row.schema_ref as string) || '',
            payload: parsedPayload,
            topic: (row.topic as string) || '',
            partition: (row.partition as number) || 0,
            offset: String(row.offset || '0'),
            processed_at: row.processed_at ? new Date(row.processed_at as string) : new Date(),
            stored_at: row.stored_at ? new Date(row.stored_at as string) : undefined,
          });
        } catch {
          // Skip malformed rows — don't let one bad row prevent all INITIAL_STATE events
        }
      }

      // Replay in chronological order (oldest first) so newest ends up on top
      const chronological = (
        allRows as Array<{
          topic: string;
          payload: unknown;
          timestamp: string;
          partition: number | null;
        }>
      )
        .slice()
        .reverse();

      let injected = 0;
      const topicCounts = new Map<string, number>();

      for (const row of chronological) {
        try {
          const event =
            typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {};

          // Strip legacy env prefix (e.g. "dev.onex.evt..." -> "onex.evt...") so topics
          // match canonical names used by injectPlaybackEvent handlers.
          // Legacy flat topics (e.g. "agent-actions") are no longer subscribed; all active
          // topics use canonical ONEX names (onex.evt.omniclaude.*). Pass-through is retained
          // for any historical records that may still exist in the database.
          const topic = extractSuffix(row.topic);

          this.injectPlaybackEvent(
            topic,
            event as Record<string, unknown>,
            row.partition ?? undefined
          );
          injected++;
          topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
        } catch {
          // Skip rows with malformed JSON or events that fail injection
        }
      }

      // Build a concise summary grouped by topic
      const topSummary = [...topicCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([t, n]) => `${t}(${n})`)
        .join(', ');

      const preloadMs = Date.now() - preloadStart;
      intentLogger.info(
        `Phase A complete: Injected ${injected}/${allRows.length} events in ${preloadMs}ms — ${topSummary}`
      );

      // Emit initial snapshots for WebSocket clients
      this.emit('metricUpdate', this.getAgentMetrics());
      const lastAction = this.recentActions[this.recentActions.length - 1];
      if (lastAction) this.emit('actionUpdate', lastAction);
      const lastRouting = this.routingDecisions[0];
      if (lastRouting) this.emit('routingUpdate', lastRouting);
      const lastTransform = this.recentTransformations[0];
      if (lastTransform) this.emit('transformationUpdate', lastTransform);
    } catch (error) {
      console.error('[EventConsumer] Error during preloadFromDatabase:', error);
      // Don't throw - allow server to continue even if preload fails
    }
  }

  private handleRoutingDecision(event: RawRoutingDecisionEvent): void {
    const agent = event.selected_agent || event.selectedAgent;
    if (!agent) {
      console.warn('[EventConsumer] Routing decision missing agent name, skipping');
      return;
    }

    const existing = this.agentMetrics.get(agent) || {
      count: 0,
      totalRoutingTime: 0,
      totalConfidence: 0,
      successCount: 0,
      errorCount: 0,
      lastSeen: new Date(),
    };

    existing.count++;
    existing.totalRoutingTime += event.routing_time_ms || event.routingTimeMs || 0;
    existing.totalConfidence += event.confidence_score || event.confidenceScore || 0;
    existing.lastSeen = new Date();

    this.agentMetrics.set(agent, existing);
    intentLogger.debug(
      `Updated metrics for ${agent}: ${existing.count} requests, avg confidence ${(existing.totalConfidence / existing.count).toFixed(2)}`
    );

    // Cleanup old entries (older than 24h)
    this.cleanupOldMetrics();

    // Emit update event for WebSocket broadcast
    this.emit('metricUpdate', this.getAgentMetrics());

    // Store routing decision
    const decision: RoutingDecision = {
      id: event.id || crypto.randomUUID(),
      correlationId: event.correlation_id || event.correlationId || '',
      userRequest: event.user_request || event.userRequest || '',
      selectedAgent: agent,
      confidenceScore: event.confidence_score || event.confidenceScore || 0,
      routingStrategy: event.routing_strategy || event.routingStrategy || '',
      alternatives: event.alternatives,
      reasoning: event.reasoning,
      routingTimeMs: event.routing_time_ms || event.routingTimeMs || 0,
      createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
    };

    this.routingDecisions.unshift(decision);

    // Keep only last N decisions
    if (this.routingDecisions.length > this.maxDecisions) {
      this.routingDecisions = this.routingDecisions.slice(0, this.maxDecisions);
    }

    // Feed the Why This Happened panel's in-memory buffer (OMN-2469)
    addDecisionRecord({
      decision_id: decision.id,
      session_id: decision.correlationId,
      decided_at: decision.createdAt.toISOString(),
      decision_type: 'route_select',
      selected_candidate: decision.selectedAgent,
      candidates_considered: Array.isArray(event.alternatives)
        ? (event.alternatives as Array<{ id?: string; name?: string }>).map((alt) => {
            const altId = String(alt?.id ?? alt?.name ?? '');
            return {
              id: altId,
              eliminated: false,
              selected: altId === decision.selectedAgent,
            };
          })
        : [],
      constraints_applied: [],
      tie_breaker: null,
      agent_rationale: decision.reasoning ?? null,
    });

    // Emit routing update
    this.emit('routingUpdate', decision);
  }

  /**
   * Normalize actionType and agentName when upstream producers set junk values.
   * Extracts meaningful segments from canonical actionName when raw fields are
   * env prefixes (e.g. "dev") or "unknown".
   */
  private static normalizeActionFields(
    rawActionType: string,
    rawAgentName: string,
    actionName: string
  ): { actionType: string; agentName: string } {
    const isJunkType =
      !rawActionType ||
      (ENVIRONMENT_PREFIXES as readonly string[]).includes(rawActionType) ||
      /^v\d+$/.test(rawActionType) ||
      /^\d+\.\d+(\.\d+)?$/.test(rawActionType);
    const isJunkAgent = !rawAgentName || rawAgentName === 'unknown';

    let actionType = rawActionType;
    let agentName = rawAgentName;

    // Parse canonical actionName (supports env-prefixed or suffix-only forms).
    // Find the "onex" segment anywhere in the dot-separated name so we handle
    // both "onex.evt.producer.event-name.v1" and "dev.onex.evt.producer.event-name.v1"
    // without depending on ENVIRONMENT_PREFIXES being exhaustive.
    if (isJunkType || isJunkAgent) {
      const parts = actionName.split('.');
      const onexIdx = parts.indexOf('onex');
      // Format: [env].onex.<kind>.<producer>.<event-name>[.v<N>]
      // Minimum 4 segments from onex: onex + kind + producer + event-name
      if (onexIdx >= 0 && parts.length >= onexIdx + 4) {
        if (isJunkType) actionType = parts[onexIdx + 3] || rawActionType; // e.g. "tool-content"
        if (isJunkAgent) agentName = parts[onexIdx + 2] || rawAgentName; // e.g. "omniintelligence"
      } else if (onexIdx >= 0 && parts.length === onexIdx + 3) {
        // 3-part: onex.<kind>.<event-name> (rare, missing producer)
        if (isJunkType) actionType = parts[onexIdx + 2] || rawActionType;
        // No producer segment available for agentName
      }
    }

    return { actionType, agentName };
  }

  private handleAgentAction(event: RawAgentActionEvent): void {
    const rawActionType = event.action_type || event.actionType || '';
    const rawAgentName = event.agent_name || event.agentName || '';
    const actionName = event.action_name || event.actionName || '';
    const { actionType, agentName } = EventConsumer.normalizeActionFields(
      rawActionType,
      rawAgentName,
      actionName
    );

    const action: AgentAction = {
      id: event.id || crypto.randomUUID(),
      correlationId: event.correlation_id || event.correlationId || '',
      agentName,
      actionType,
      actionName,
      actionDetails: event.action_details || event.actionDetails,
      debugMode: event.debug_mode || event.debugMode,
      durationMs: event.duration_ms || event.durationMs || 0,
      createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
    };

    this.recentActions.unshift(action);
    intentLogger.debug(
      `Added action to queue: ${action.actionName} (${action.agentName}), queue size: ${this.recentActions.length}`
    );

    // Track success/error rates per agent
    if (action.agentName && (action.actionType === 'success' || action.actionType === 'error')) {
      const existing = this.agentMetrics.get(action.agentName) || {
        count: 0,
        totalRoutingTime: 0,
        totalConfidence: 0,
        successCount: 0,
        errorCount: 0,
        lastSeen: new Date(),
      };

      if (action.actionType === 'success') {
        existing.successCount++;
      } else if (action.actionType === 'error') {
        existing.errorCount++;
      }

      existing.lastSeen = new Date();
      this.agentMetrics.set(action.agentName, existing);

      intentLogger.debug(
        `Updated ${action.agentName} success/error: ${existing.successCount}/${existing.errorCount}`
      );

      // Emit metric update since success rate changed
      this.emit('metricUpdate', this.getAgentMetrics());
    }

    // Keep only last N actions
    if (this.recentActions.length > this.maxActions) {
      this.recentActions = this.recentActions.slice(0, this.maxActions);
    }

    // Emit update event for WebSocket broadcast
    this.emit('actionUpdate', action);
  }

  /**
   * Handle OmniClaude hook events (prompt submissions, tool executions).
   * These events are emitted by omniclaude via the UserPromptSubmit hook
   * and represent real-time user interactions with Claude Code.
   */
  private handleClaudeHookEvent(event: {
    event_type?: string;
    eventType?: string;
    session_id?: string;
    sessionId?: string;
    correlation_id?: string;
    correlationId?: string;
    timestamp_utc?: string;
    timestampUtc?: string;
    payload?: { prompt?: string; [key: string]: unknown };
  }): void {
    const eventType = event.event_type || event.eventType || 'unknown';
    const prompt = event.payload?.prompt || '';
    const truncatedPrompt = prompt.length > 100 ? prompt.slice(0, 100) + '...' : prompt;

    // Convert to AgentAction format for dashboard display
    const action: AgentAction = {
      id: crypto.randomUUID(),
      correlationId: event.correlation_id || event.correlationId || '',
      agentName: 'omniclaude',
      actionType: 'prompt',
      actionName: eventType,
      actionDetails: {
        prompt: truncatedPrompt,
        sessionId: event.session_id || event.sessionId,
        eventType,
      },
      debugMode: false,
      durationMs: 0,
      createdAt: new Date(event.timestamp_utc || event.timestampUtc || Date.now()),
    };

    this.recentActions.unshift(action);
    intentLogger.debug(
      `Added claude hook event: ${eventType} - "${truncatedPrompt.slice(0, 30)}...", queue size: ${this.recentActions.length}`
    );

    // Keep only last N actions
    if (this.recentActions.length > this.maxActions) {
      this.recentActions = this.recentActions.slice(0, this.maxActions);
    }

    // Emit update event for WebSocket broadcast
    this.emit('actionUpdate', action);
  }

  /**
   * Handle prompt-submitted events from omniclaude lifecycle topics.
   * These are the canonical ONEX events emitted when user submits a prompt.
   */
  private handlePromptSubmittedEvent(event: {
    event_type?: string;
    eventType?: string;
    // Top-level fields (new flat format)
    session_id?: string;
    sessionId?: string;
    correlation_id?: string;
    correlationId?: string;
    prompt_preview?: string;
    promptPreview?: string;
    prompt?: string;
    prompt_length?: number;
    promptLength?: number;
    emitted_at?: string;
    emittedAt?: string;
    // Nested payload (old format)
    payload?: {
      session_id?: string;
      sessionId?: string;
      correlation_id?: string;
      correlationId?: string;
      prompt_preview?: string;
      promptPreview?: string;
      prompt_length?: number;
      promptLength?: number;
      emitted_at?: string;
      emittedAt?: string;
    };
  }): void {
    // Support both nested payload (old format) and flat structure (new format)
    const payload = event.payload || {};
    const promptPreview =
      payload.prompt_preview ||
      payload.promptPreview ||
      event.prompt_preview ||
      event.promptPreview ||
      event.prompt ||
      '';

    // Extract fields from either payload (old) or top-level (new)
    const correlationId =
      payload.correlation_id ||
      payload.correlationId ||
      event.correlation_id ||
      event.correlationId ||
      '';
    const sessionId =
      payload.session_id || payload.sessionId || event.session_id || event.sessionId || '';
    // Preserve zero-length prompts: use explicit promptLength if provided (including 0),
    // otherwise compute from promptPreview. This ensures promptLength: 0 is valid.
    const explicitPromptLength =
      payload.prompt_length ?? payload.promptLength ?? event.prompt_length ?? event.promptLength;
    const promptLength = explicitPromptLength ?? promptPreview.length;
    const emittedAt =
      payload.emitted_at || payload.emittedAt || event.emitted_at || event.emittedAt;

    const action: AgentAction = {
      id: crypto.randomUUID(),
      correlationId,
      agentName: 'omniclaude',
      actionType: 'prompt',
      actionName: 'UserPromptSubmit',
      actionDetails: {
        prompt: promptPreview,
        promptLength,
        sessionId,
      },
      debugMode: false,
      durationMs: 0,
      createdAt: new Date(emittedAt || Date.now()),
    };

    this.recentActions.unshift(action);
    intentLogger.debug(
      `Added prompt-submitted: "${promptPreview.slice(0, 30)}...", queue size: ${this.recentActions.length}`
    );

    if (this.recentActions.length > this.maxActions) {
      this.recentActions = this.recentActions.slice(0, this.maxActions);
    }

    this.emit('actionUpdate', action);
  }

  /**
   * Handle omniclaude lifecycle events (session-started, session-ended, tool-executed).
   *
   * OMN-2196: Hoists `topic` (real Kafka topic) and `toolName` (strict extraction
   * from payload) onto the AgentAction so downstream consumers (projection-bootstrap,
   * EventBusMonitor) can display specific tool names instead of generic "tool_call".
   */
  private handleOmniclaudeLifecycleEvent(
    event: {
      event_type?: string;
      eventType?: string;
      payload?: Record<string, unknown>;
    },
    topic: string
  ): void {
    // Derive eventType with fallback guard for malformed topics (OMN-2196).
    // topic.split('.').slice(-2, -1)[0] can return '' for single-segment topics.
    const rawEventType = event.event_type || event.eventType;
    const segmentFallback = topic.split('.').slice(-2, -1)[0];
    const eventType = rawEventType || segmentFallback || topic;
    const payload = event.payload || {};

    // OMN-2196: Extract toolName from payload, checking all known key variants.
    // Matches client-side extractParsedDetails keys for consistency.
    // Runtime typeof guards ensure non-string values (numbers, objects) are ignored.
    // `tool` is last because it's the most ambiguous key — non-tool lifecycle
    // events (e.g. session-started) may carry a `tool` field for other purposes.
    const toolName =
      (typeof payload.toolName === 'string' ? payload.toolName : undefined) ||
      (typeof payload.tool_name === 'string' ? payload.tool_name : undefined) ||
      (typeof payload.functionName === 'string' ? payload.functionName : undefined) ||
      (typeof payload.function_name === 'string' ? payload.function_name : undefined) ||
      (typeof payload.tool === 'string' ? payload.tool : undefined);

    const action: AgentAction = {
      id: crypto.randomUUID(),
      correlationId: (payload.correlation_id || payload.correlationId || '') as string,
      agentName: 'omniclaude',
      actionType: eventType.includes('tool') ? 'tool_call' : 'lifecycle',
      actionName: eventType,
      actionDetails: {
        sessionId: payload.session_id || payload.sessionId,
        ...payload,
      },
      debugMode: false,
      durationMs: (payload.duration_ms || payload.durationMs || 0) as number,
      createdAt: new Date(
        (payload.emitted_at || payload.emittedAt || Date.now()) as string | number
      ),
      topic,
      // Converts empty string to undefined so client fallback logic activates
      toolName: toolName || undefined,
    };

    this.recentActions.unshift(action);
    intentLogger.debug(
      `Added omniclaude lifecycle: ${eventType}${toolName ? ` (tool: ${toolName})` : ''}, queue size: ${this.recentActions.length}`
    );

    if (this.recentActions.length > this.maxActions) {
      this.recentActions = this.recentActions.slice(0, this.maxActions);
    }

    this.emit('actionUpdate', action);
  }

  private handleTransformationEvent(event: RawTransformationEvent): void {
    const transformation: TransformationEvent = {
      id: event.id || crypto.randomUUID(),
      correlationId: event.correlation_id || event.correlationId || '',
      sourceAgent: event.source_agent || event.sourceAgent || '',
      targetAgent: event.target_agent || event.targetAgent || '',
      transformationDurationMs:
        event.transformation_duration_ms || event.transformationDurationMs || 0,
      success: event.success ?? true,
      confidenceScore: event.confidence_score || event.confidenceScore || 0,
      createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
    };

    this.recentTransformations.unshift(transformation);
    intentLogger.debug(
      `Added transformation to queue: ${transformation.sourceAgent} -> ${transformation.targetAgent}, queue size: ${this.recentTransformations.length}`
    );

    // Keep only last N transformations
    if (this.recentTransformations.length > this.maxTransformations) {
      this.recentTransformations = this.recentTransformations.slice(0, this.maxTransformations);
    }

    // Emit update event for WebSocket broadcast
    this.emit('transformationUpdate', transformation);
  }

  private handlePerformanceMetric(event: RawPerformanceMetricEvent): void {
    try {
      const metric = {
        id: event.id || crypto.randomUUID(),
        correlationId: event.correlation_id || event.correlationId || '',
        queryText: event.query_text || event.queryText || '',
        routingDurationMs: event.routing_duration_ms || event.routingDurationMs || 0,
        cacheHit: event.cache_hit ?? event.cacheHit ?? false,
        candidatesEvaluated: event.candidates_evaluated || event.candidatesEvaluated || 0,
        triggerMatchStrategy:
          event.trigger_match_strategy || event.triggerMatchStrategy || 'unknown',
        createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
      };

      // Store in memory (limit to PERFORMANCE_METRICS_BUFFER_SIZE recent)
      this.performanceMetrics.unshift(metric);
      if (this.performanceMetrics.length > PERFORMANCE_METRICS_BUFFER_SIZE) {
        this.performanceMetrics = this.performanceMetrics.slice(0, PERFORMANCE_METRICS_BUFFER_SIZE);
      }

      // Update aggregated stats
      this.performanceStats.totalQueries++;
      if (metric.cacheHit) {
        this.performanceStats.cacheHitCount++;
      }
      this.performanceStats.totalRoutingDuration += metric.routingDurationMs;
      this.performanceStats.avgRoutingDuration =
        this.performanceStats.totalRoutingDuration / this.performanceStats.totalQueries;

      // Emit for WebSocket broadcast
      this.emit('performanceUpdate', {
        metric,
        stats: { ...this.performanceStats },
      });

      intentLogger.debug(
        `Processed performance metric: ${metric.routingDurationMs}ms, cache hit: ${metric.cacheHit}, strategy: ${metric.triggerMatchStrategy}`
      );
    } catch (error) {
      console.error('[EventConsumer] Error processing performance metric:', error);
    }
  }

  private handleNodeIntrospection(event: RawNodeIntrospectionEvent): void {
    try {
      const nodeId = event.node_id || event.nodeId;
      if (!nodeId) {
        console.warn('[EventConsumer] Node introspection missing node_id, skipping');
        return;
      }

      const introspectionEvent: NodeIntrospectionEvent = {
        id: event.id || crypto.randomUUID(),
        nodeId,
        nodeType: parseNodeType(event.node_type || event.nodeType, 'COMPUTE'),
        nodeVersion: event.node_version || event.nodeVersion || '1.0.0',
        endpoints: event.endpoints || {},
        currentState: parseRegistrationState(
          event.current_state || event.currentState,
          'pending_registration'
        ),
        reason: parseIntrospectionReason(event.reason, 'STARTUP'),
        correlationId: event.correlation_id || event.correlationId || '',
        createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
      };

      // Store introspection event
      this.nodeIntrospectionEvents.unshift(introspectionEvent);
      if (this.nodeIntrospectionEvents.length > this.maxNodeEvents) {
        this.nodeIntrospectionEvents = this.nodeIntrospectionEvents.slice(0, this.maxNodeEvents);
      }

      // Update or create registered node
      const existingNode = this.registeredNodes.get(nodeId);
      const node: RegisteredNode = {
        nodeId,
        nodeType: introspectionEvent.nodeType,
        state: introspectionEvent.currentState,
        version: introspectionEvent.nodeVersion,
        uptimeSeconds: existingNode?.uptimeSeconds || 0,
        lastSeen: introspectionEvent.createdAt,
        memoryUsageMb: existingNode?.memoryUsageMb,
        cpuUsagePercent: existingNode?.cpuUsagePercent,
        endpoints: introspectionEvent.endpoints,
      };

      // Evict oldest node if at capacity and this is a new node
      if (
        this.registeredNodes.size >= this.MAX_REGISTERED_NODES &&
        !this.registeredNodes.has(nodeId)
      ) {
        let oldestNodeId: string | null = null;
        let oldestTime = Infinity;
        const nodeEntries = Array.from(this.registeredNodes.entries());
        for (const [id, n] of nodeEntries) {
          const lastSeenTime = new Date(n.lastSeen).getTime();
          if (lastSeenTime < oldestTime) {
            oldestTime = lastSeenTime;
            oldestNodeId = id;
          }
        }
        if (oldestNodeId) {
          this.registeredNodes.delete(oldestNodeId);
          intentLogger.debug(`Evicted oldest node ${oldestNodeId} to make room for ${nodeId}`);
        }
      }

      this.registeredNodes.set(nodeId, node);

      // Emit events
      this.emit('nodeIntrospectionUpdate', introspectionEvent);
      this.emit('nodeRegistryUpdate', this.getRegisteredNodes());

      intentLogger.debug(
        `Processed node introspection: ${nodeId} (${introspectionEvent.nodeType}, ${introspectionEvent.reason})`
      );
    } catch (error) {
      console.error('[EventConsumer] Error processing node introspection:', error);
    }
  }

  private handleNodeHeartbeat(event: RawNodeHeartbeatEvent): void {
    try {
      const nodeId = event.node_id || event.nodeId;
      if (!nodeId) {
        console.warn('[EventConsumer] Node heartbeat missing node_id, skipping');
        return;
      }

      const heartbeatEvent: NodeHeartbeatEvent = {
        id: event.id || crypto.randomUUID(),
        nodeId,
        uptimeSeconds: event.uptime_seconds || event.uptimeSeconds || 0,
        activeOperationsCount: event.active_operations_count || event.activeOperationsCount || 0,
        memoryUsageMb: event.memory_usage_mb || event.memoryUsageMb || 0,
        cpuUsagePercent: event.cpu_usage_percent || event.cpuUsagePercent || 0,
        createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
      };

      // Store heartbeat event
      this.nodeHeartbeatEvents.unshift(heartbeatEvent);
      if (this.nodeHeartbeatEvents.length > this.maxNodeEvents) {
        this.nodeHeartbeatEvents = this.nodeHeartbeatEvents.slice(0, this.maxNodeEvents);
      }

      // Update registered node if exists
      const existingNode = this.registeredNodes.get(nodeId);
      if (existingNode) {
        this.registeredNodes.set(nodeId, {
          ...existingNode,
          uptimeSeconds: heartbeatEvent.uptimeSeconds,
          lastSeen: heartbeatEvent.createdAt,
          memoryUsageMb: heartbeatEvent.memoryUsageMb,
          cpuUsagePercent: heartbeatEvent.cpuUsagePercent,
        });
      }

      // Emit events
      this.emit('nodeHeartbeatUpdate', heartbeatEvent);
      this.emit('nodeRegistryUpdate', this.getRegisteredNodes());

      intentLogger.debug(
        `Processed node heartbeat: ${nodeId} (CPU: ${heartbeatEvent.cpuUsagePercent}%, Mem: ${heartbeatEvent.memoryUsageMb}MB)`
      );
    } catch (error) {
      console.error('[EventConsumer] Error processing node heartbeat:', error);
    }
  }

  private handleNodeStateChange(event: RawNodeStateChangeEvent): void {
    try {
      const nodeId = event.node_id || event.nodeId;
      if (!nodeId) {
        console.warn('[EventConsumer] Node state change missing node_id, skipping');
        return;
      }

      const stateChangeEvent: NodeStateChangeEvent = {
        id: event.id || crypto.randomUUID(),
        nodeId,
        previousState: parseRegistrationState(
          event.previous_state || event.previousState,
          'pending_registration'
        ),
        newState: parseRegistrationState(event.new_state || event.newState, 'active'),
        reason: event.reason,
        createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
      };

      // Store state change event
      this.nodeStateChangeEvents.unshift(stateChangeEvent);
      if (this.nodeStateChangeEvents.length > this.maxNodeEvents) {
        this.nodeStateChangeEvents = this.nodeStateChangeEvents.slice(0, this.maxNodeEvents);
      }

      // Update registered node if exists
      const existingNode = this.registeredNodes.get(nodeId);
      if (existingNode) {
        this.registeredNodes.set(nodeId, {
          ...existingNode,
          state: stateChangeEvent.newState,
          lastSeen: stateChangeEvent.createdAt,
        });
      }

      // Emit events
      this.emit('nodeStateChangeUpdate', stateChangeEvent);
      this.emit('nodeRegistryUpdate', this.getRegisteredNodes());

      intentLogger.debug(
        `Processed node state change: ${nodeId} (${stateChangeEvent.previousState} -> ${stateChangeEvent.newState})`
      );
    } catch (error) {
      console.error('[EventConsumer] Error processing node state change:', error);
    }
  }

  private handleIntentClassified(event: RawIntentClassifiedEvent): void {
    try {
      // Validate event_type matches shared IntentClassifiedEvent interface
      // Use EVENT_TYPE_NAMES.INTENT_CLASSIFIED from shared module for consistency
      if (event.event_type && event.event_type !== EVENT_TYPE_NAMES.INTENT_CLASSIFIED) {
        intentLogger.warn(
          `Unexpected event_type: expected "${EVENT_TYPE_NAMES.INTENT_CLASSIFIED}", got "${event.event_type}". Processing anyway for backward compatibility.`
        );
      }

      // Use intent_category (shared interface) with fallback to intent_type (legacy)
      const intentType =
        event.intent_category ||
        event.intentCategory ||
        event.intent_type ||
        event.intentType ||
        'unknown';

      // Validate and sanitize timestamp
      const createdAt = sanitizeTimestamp(
        event.timestamp || event.created_at || event.createdAt,
        new Date()
      );

      const intentEvent: InternalIntentClassifiedEvent = {
        id: event.id || crypto.randomUUID(),
        correlationId: event.correlation_id || event.correlationId || '',
        sessionId: event.session_id || event.sessionId || '', // Added for shared interface alignment
        intentType,
        confidence: event.confidence ?? 0,
        rawText: event.raw_text || event.rawText || '',
        extractedEntities: event.extracted_entities || event.extractedEntities,
        metadata: event.metadata,
        createdAt,
      };

      // Store in recent intents
      this.recentIntents.unshift(intentEvent);
      if (this.recentIntents.length > this.maxIntents) {
        this.recentIntents = this.recentIntents.slice(0, this.maxIntents);
      }

      // Update intent distribution with timestamp tracking for proper pruning
      // Use event timestamp (not current time) for accurate distribution tracking
      const existing = this.intentDistributionWithTimestamps.get(intentType);
      const eventTimestamp = createdAt.getTime();
      if (existing) {
        existing.count++;
        existing.timestamps.push(eventTimestamp);
        // Cap timestamps array to prevent unbounded growth
        if (existing.timestamps.length > MAX_TIMESTAMPS_PER_CATEGORY) {
          existing.timestamps = existing.timestamps.slice(-MAX_TIMESTAMPS_PER_CATEGORY);
        }
      } else {
        this.intentDistributionWithTimestamps.set(intentType, {
          count: 1,
          timestamps: [eventTimestamp],
        });
      }

      // Emit event for WebSocket broadcast (legacy EventEmitter pattern)
      this.emit('intent-event', {
        topic: INTENT_CLASSIFIED_TOPIC,
        payload: intentEvent,
        timestamp: new Date().toISOString(),
      });

      // OMN-4957: Emit intentUpdate so projection-bootstrap wires intent events
      // through the same consumerEventNames pipeline as other event types.
      this.emit('intentUpdate', {
        ...intentEvent,
        topic: INTENT_CLASSIFIED_TOPIC,
        type: 'intent-classified',
        actionType: 'intent-classified',
        timestamp: new Date().toISOString(),
      });

      // Forward to IntentEventEmitter for new WebSocket subscription pattern
      // Use type guard for validation before emitting
      if (isIntentClassifiedEvent(event)) {
        // Convert to IntentRecordPayload format for consistent broadcasting
        const intentRecordPayload: IntentRecordPayload = {
          intent_id: intentEvent.id,
          session_ref: intentEvent.sessionId || '',
          intent_category: intentType,
          confidence: intentEvent.confidence,
          keywords: [], // IntentClassifiedEvent doesn't include keywords; set empty array
          created_at: createdAt.toISOString(),
        };
        getIntentEventEmitter().emitIntentStored(intentRecordPayload);
        intentLogger.debug(
          `Forwarded intent classified to IntentEventEmitter: ${intentRecordPayload.intent_id}`
        );
      }

      intentLogger.info(
        `Processed intent classified: ${intentType} (confidence: ${intentEvent.confidence}, session: ${intentEvent.sessionId || 'unknown'})`
      );
    } catch (error) {
      // Preserve full error context from the event for debugging
      const errorContext = {
        eventId: event.id ?? 'unknown',
        correlationId: event.correlation_id ?? event.correlationId ?? 'unknown',
        sessionId: event.session_id ?? event.sessionId ?? 'unknown',
        intentCategory: event.intent_category ?? event.intentCategory ?? 'unknown',
        intentType: event.intent_type ?? event.intentType ?? 'unknown',
        confidence: event.confidence ?? 'unknown',
        timestamp: event.timestamp ?? event.created_at ?? event.createdAt ?? 'unknown',
        eventType: event.event_type ?? 'unknown',
      };

      intentLogger.error(
        `Error processing intent classified event. Context: ${JSON.stringify(errorContext)}`,
        error
      );

      // Emit error event with full context for observability
      // Preserve stack trace and original error details for debugging
      this.emit('error', {
        type: 'intent-classification-error',
        context: errorContext,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        originalError: error,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private handleIntentStored(event: RawIntentStoredEvent): void {
    try {
      const intentEventId = event.id || crypto.randomUUID();
      // Validate and sanitize timestamp
      const createdAt = sanitizeTimestamp(
        event.timestamp || event.created_at || event.createdAt,
        new Date()
      );

      // Emit event for WebSocket broadcast (legacy EventEmitter pattern)
      this.emit('intent-event', {
        topic: INTENT_STORED_TOPIC,
        payload: {
          id: intentEventId,
          intentId: event.intent_id || event.intentId,
          intentType: event.intent_type || event.intentType,
          storageLocation: event.storage_location || event.storageLocation,
          correlationId: event.correlation_id || event.correlationId,
          createdAt,
        },
        timestamp: new Date().toISOString(),
      });

      // OMN-4957: Emit intentUpdate so projection-bootstrap wires intent events
      // through the same consumerEventNames pipeline as other event types.
      this.emit('intentUpdate', {
        id: intentEventId,
        topic: INTENT_STORED_TOPIC,
        type: 'intent-stored',
        actionType: 'intent-stored',
        intentId: event.intent_id || event.intentId,
        intentType: event.intent_type || event.intentType,
        timestamp: new Date().toISOString(),
      });

      // Forward to IntentEventEmitter for new WebSocket subscription pattern
      // Use type guard for validation - if event matches SharedIntentStoredEvent format
      if (isIntentStoredEvent(event)) {
        // Type guard narrows event to SharedIntentStoredEvent with all required fields
        const intentRecordPayload: IntentRecordPayload = {
          intent_id: event.intent_id,
          session_ref: event.session_ref,
          intent_category: event.intent_category,
          confidence: event.confidence,
          keywords: event.keywords || [],
          created_at: event.stored_at,
        };
        getIntentEventEmitter().emitIntentStored(intentRecordPayload);
        intentLogger.debug(
          `Forwarded intent stored to IntentEventEmitter: ${intentRecordPayload.intent_id}`
        );
      } else {
        // Legacy format - create minimal IntentRecordPayload from available fields
        const intentId = event.intent_id || event.intentId || crypto.randomUUID();
        const intentRecordPayload: IntentRecordPayload = {
          intent_id: intentId,
          session_ref: 'unknown', // Sentinel value for legacy events without session tracking
          intent_category: event.intent_type || event.intentType || 'unknown',
          confidence: 0, // Not available in legacy format
          keywords: [],
          created_at: createdAt.toISOString(),
        };
        getIntentEventEmitter().emitIntentStored(intentRecordPayload);
        intentLogger.debug(
          `Forwarded legacy intent stored to IntentEventEmitter: ${intentRecordPayload.intent_id}`
        );
      }

      intentLogger.info(`Processed intent stored: ${event.intent_id || event.intentId}`);
    } catch (error) {
      // Preserve full error context from the event for debugging
      const errorContext = {
        eventId: event.id ?? 'unknown',
        intentId: event.intent_id ?? event.intentId ?? 'unknown',
        correlationId: event.correlation_id ?? event.correlationId ?? 'unknown',
        intentType: event.intent_type ?? event.intentType ?? 'unknown',
        storageLocation: event.storage_location ?? event.storageLocation ?? 'unknown',
        timestamp: event.timestamp ?? event.created_at ?? event.createdAt ?? 'unknown',
      };

      intentLogger.error(
        `Error processing intent stored event. Context: ${JSON.stringify(errorContext)}`,
        error
      );

      // Emit error event with full context for observability
      // Preserve stack trace and original error details for debugging
      this.emit('error', {
        type: 'intent-stored-error',
        context: errorContext,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        originalError: error,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private handleIntentQueryResponse(event: RawIntentQueryResponseEvent): void {
    try {
      // Validate and sanitize timestamp
      const createdAt = sanitizeTimestamp(
        event.timestamp || event.created_at || event.createdAt,
        new Date()
      );

      // Emit event for WebSocket broadcast
      this.emit('intent-query-response', {
        query_id: event.query_id || event.queryId,
        correlation_id: event.correlation_id || event.correlationId,
        payload: {
          queryId: event.query_id || event.queryId,
          correlationId: event.correlation_id || event.correlationId,
          results: event.results || [],
          totalCount: event.total_count || event.totalCount || 0,
          createdAt,
        },
      });

      intentLogger.info(`Processed intent query response: ${event.query_id || event.queryId}`);
    } catch (error) {
      // Preserve full error context from the event for debugging
      const errorContext = {
        queryId: event.query_id ?? event.queryId ?? 'unknown',
        correlationId: event.correlation_id ?? event.correlationId ?? 'unknown',
        totalCount: event.total_count ?? event.totalCount ?? 'unknown',
        resultsCount: event.results?.length ?? 0,
        timestamp: event.timestamp ?? event.created_at ?? event.createdAt ?? 'unknown',
      };

      intentLogger.error(
        `Error processing intent query response. Context: ${JSON.stringify(errorContext)}`,
        error
      );

      // Emit error event with full context for observability
      // Preserve stack trace and original error details for debugging
      this.emit('error', {
        type: 'intent-query-response-error',
        context: errorContext,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        originalError: error,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ============================================================================
  // Canonical ONEX Event Handlers (OMN-1279)
  // These handlers use the new event envelope format with proper deduplication
  // ============================================================================

  /**
   * Map a canonical OnexNodeState ('ACTIVE' | 'PENDING' | 'OFFLINE') to the
   * legacy RegistrationState used by the registeredNodes map and WebSocket
   * consumers.
   */
  private mapCanonicalState(state: OnexNodeState): RegistrationState {
    const stateMap: Record<string, RegistrationState> = {
      ACTIVE: 'active',
      PENDING: 'pending_registration',
      OFFLINE: 'liveness_expired',
    };
    return stateMap[state] || 'pending_registration';
  }

  /**
   * Sync a canonical node into the legacy registeredNodes map so that
   * getRegisteredNodes() reflects canonical state for WebSocket consumers.
   *
   * Preserves existing RegisteredNode data (nodeType, version, metrics,
   * endpoints) when available, and overlays the canonical state and timestamp.
   */
  private syncCanonicalToRegistered(canonicalNode: CanonicalOnexNode): void {
    const existing = this.registeredNodes.get(canonicalNode.node_id);

    // Normalize the node type from the canonical node, falling back to the
    // existing registered value and then to COMPUTE (OMN-4098).
    const rawType = canonicalNode.node_type ?? existing?.nodeType;
    const validTypes: NodeType[] = ['EFFECT', 'COMPUTE', 'REDUCER', 'ORCHESTRATOR'];
    let nodeType: NodeType = 'COMPUTE';
    if (typeof rawType === 'string') {
      const upper = rawType.toUpperCase() as NodeType;
      if (validTypes.includes(upper)) nodeType = upper;
    }

    const node: RegisteredNode = {
      nodeId: canonicalNode.node_id,
      nodeType,
      state: this.mapCanonicalState(canonicalNode.state),
      version: canonicalNode.node_version ?? existing?.version ?? '1.0.0',
      uptimeSeconds: existing?.uptimeSeconds ?? 0,
      lastSeen: new Date(canonicalNode.last_event_at || Date.now()),
      memoryUsageMb: existing?.memoryUsageMb,
      cpuUsagePercent: existing?.cpuUsagePercent,
      endpoints: existing?.endpoints ?? {},
    };

    this.registeredNodes.set(canonicalNode.node_id, node);
  }

  /**
   * Handle canonical node-heartbeat events.
   * Updates the last_heartbeat_at timestamp for the node.
   */
  private handleCanonicalNodeHeartbeat(message: KafkaMessage): void {
    const envelope = this.parseEnvelope(message, NodeHeartbeatPayloadSchema);
    if (!envelope) return;
    if (this.isDuplicate(envelope.correlation_id)) {
      return; // Silent skip for heartbeats (high frequency)
    }

    const { payload, envelope_timestamp } = envelope;
    const emittedAtMs = new Date(envelope_timestamp).getTime();

    const node = this.canonicalNodes.get(payload.node_id);
    if (!node) {
      // Node not registered yet, create a pending entry
      this.canonicalNodes.set(payload.node_id, {
        node_id: payload.node_id,
        state: 'PENDING',
        last_heartbeat_at: emittedAtMs,
        last_event_at: emittedAtMs,
      });

      // Sync into legacy registeredNodes so getRegisteredNodes() reflects this update
      this.syncCanonicalToRegistered(this.canonicalNodes.get(payload.node_id)!);

      // Propagate heartbeat metrics to the registered node so dashboard
      // displays current values (syncCanonicalToRegistered only preserves
      // existing metrics; we must overlay the payload data explicitly).
      this.propagateHeartbeatMetrics(payload);

      // Emit nodeHeartbeatUpdate with real timestamp so MonotonicMergeTracker
      // accepts the update (sentinel-0 seed path would be rejected). (OMN-3541)
      const newNodeHeartbeatEvent: NodeHeartbeatEvent = {
        id: envelope.correlation_id ?? crypto.randomUUID(),
        nodeId: payload.node_id,
        uptimeSeconds: payload.uptime_seconds ?? 0,
        activeOperationsCount: payload.active_operations_count ?? 0,
        memoryUsageMb: payload.memory_usage_mb ?? 0,
        cpuUsagePercent: payload.cpu_usage_percent ?? 0,
        createdAt: new Date(emittedAtMs),
      };
      this.emit('nodeHeartbeatUpdate', newNodeHeartbeatEvent);

      // Emit dashboard event so newly discovered nodes appear immediately
      this.emit('nodeRegistryUpdate', this.getRegisteredNodes());
      return;
    }

    if (!this.shouldProcess(node, emittedAtMs)) {
      return; // Stale heartbeat, skip
    }

    // Update heartbeat timestamp (immutable update)
    this.canonicalNodes.set(payload.node_id, {
      ...node,
      last_heartbeat_at: emittedAtMs,
      last_event_at: emittedAtMs,
    });

    // Sync into legacy registeredNodes so getRegisteredNodes() reflects this update
    this.syncCanonicalToRegistered(this.canonicalNodes.get(payload.node_id)!);

    // Propagate heartbeat metrics to the registered node so dashboard
    // displays current values (syncCanonicalToRegistered only preserves
    // existing metrics; we must overlay the payload data explicitly).
    this.propagateHeartbeatMetrics(payload);

    // Emit nodeHeartbeatUpdate with the real envelope timestamp so the
    // NodeRegistryProjection's MonotonicMergeTracker accepts the update.
    // Without this, nodeRegistryUpdate routes through node-registry-seed which
    // uses MISSING_TIMESTAMP_SENTINEL_MS (epoch 0), causing the merge tracker
    // to reject updates when the DB preload already recorded real timestamps.
    // (OMN-3541)
    const heartbeatEvent: NodeHeartbeatEvent = {
      id: envelope.correlation_id ?? crypto.randomUUID(),
      nodeId: payload.node_id,
      uptimeSeconds: payload.uptime_seconds ?? 0,
      activeOperationsCount: payload.active_operations_count ?? 0,
      memoryUsageMb: payload.memory_usage_mb ?? 0,
      cpuUsagePercent: payload.cpu_usage_percent ?? 0,
      createdAt: new Date(emittedAtMs),
    };
    this.emit('nodeHeartbeatUpdate', heartbeatEvent);

    // Emit dashboard event for WebSocket broadcast
    this.emit('nodeRegistryUpdate', this.getRegisteredNodes());
  }

  /**
   * Propagate heartbeat payload metrics (uptime, memory, CPU) into the legacy
   * registeredNodes map. syncCanonicalToRegistered preserves existing metric
   * values but does not update them from the canonical payload. This method
   * fills that gap so canonical heartbeat events update the dashboard.
   */
  private propagateHeartbeatMetrics(payload: {
    node_id: string;
    uptime_seconds?: number;
    memory_usage_mb?: number;
    cpu_usage_percent?: number;
    active_operations_count?: number;
  }): void {
    const regNode = this.registeredNodes.get(payload.node_id);
    if (!regNode) return;

    this.registeredNodes.set(payload.node_id, {
      ...regNode,
      uptimeSeconds: payload.uptime_seconds ?? regNode.uptimeSeconds,
      memoryUsageMb: payload.memory_usage_mb ?? regNode.memoryUsageMb,
      cpuUsagePercent: payload.cpu_usage_percent ?? regNode.cpuUsagePercent,
    });
  }

  /**
   * Handle canonical node-introspection events.
   * Updates node metadata in the canonical registry.
   */
  private handleCanonicalNodeIntrospection(message: KafkaMessage): void {
    const envelope = this.parseEnvelope(message, NodeIntrospectionPayloadSchema);
    if (!envelope) return;
    if (this.isDuplicate(envelope.correlation_id)) {
      if (DEBUG_CANONICAL_EVENTS) {
        intentLogger.debug(
          `Duplicate node-introspection event, skipping: ${envelope.correlation_id}`
        );
      }
      return;
    }

    const { payload, envelope_timestamp } = envelope;
    const emittedAtMs = new Date(envelope_timestamp).getTime();

    const existing = this.canonicalNodes.get(payload.node_id);
    if (existing && !this.shouldProcess(existing, emittedAtMs)) {
      if (DEBUG_CANONICAL_EVENTS) {
        intentLogger.debug(`Stale node-introspection event, skipping: ${payload.node_id}`);
      }
      return;
    }

    // Normalize node_version: Python may send a { major, minor, patch } object (OMN-4098)
    const rawVersion = payload.node_version;
    let nodeVersion: string | undefined;
    if (typeof rawVersion === 'string') {
      nodeVersion = rawVersion;
    } else if (rawVersion != null && typeof rawVersion === 'object') {
      const sv = rawVersion as { major?: number; minor?: number; patch?: number };
      nodeVersion = `${sv.major ?? 0}.${sv.minor ?? 0}.${sv.patch ?? 0}`;
    }

    // Resolve state: use payload.current_state when non-null, otherwise keep existing (OMN-4098)
    const resolvedState: OnexNodeState =
      payload.current_state != null
        ? (payload.current_state as OnexNodeState)
        : (existing?.state ?? 'PENDING');

    // Update or create canonical node
    const node: CanonicalOnexNode = existing
      ? {
          ...existing,
          state: resolvedState,
          node_type: payload.node_type ?? existing.node_type,
          node_version: nodeVersion ?? existing.node_version,
          capabilities: payload.capabilities || existing.capabilities,
          last_event_at: emittedAtMs,
        }
      : {
          node_id: payload.node_id,
          state: resolvedState,
          node_type: payload.node_type,
          node_version: nodeVersion,
          capabilities: payload.capabilities,
          last_event_at: emittedAtMs,
        };

    this.canonicalNodes.set(payload.node_id, node);

    // Sync into legacy registeredNodes so getRegisteredNodes() reflects this update
    this.syncCanonicalToRegistered(this.canonicalNodes.get(payload.node_id)!);

    // Emit dashboard event for WebSocket broadcast
    this.emit('nodeRegistryUpdate', this.getRegisteredNodes());

    if (DEBUG_CANONICAL_EVENTS) {
      intentLogger.debug(`Canonical node-introspection processed: ${payload.node_id}`);
    }
  }

  private cleanupOldMetrics() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const entries = Array.from(this.agentMetrics.entries());
    for (const [agent, metrics] of entries) {
      if (metrics.lastSeen < cutoff) {
        this.agentMetrics.delete(agent);
      }
    }
  }

  /**
   * Prune old data from in-memory arrays to prevent unbounded memory growth
   * Removes events older than DATA_RETENTION_MS (24 hours by default)
   */
  private pruneOldData(): void {
    const cutoff = Date.now() - this.DATA_RETENTION_MS;

    // Prune recent actions
    const actionsBefore = this.recentActions.length;
    this.recentActions = this.recentActions.filter((action) => {
      const timestamp = new Date(action.createdAt).getTime();
      return timestamp > cutoff;
    });
    const actionsRemoved = actionsBefore - this.recentActions.length;

    // Prune routing decisions
    const decisionsBefore = this.routingDecisions.length;
    this.routingDecisions = this.routingDecisions.filter((decision) => {
      const timestamp = new Date(decision.createdAt).getTime();
      return timestamp > cutoff;
    });
    const decisionsRemoved = decisionsBefore - this.routingDecisions.length;

    // Prune transformations
    const transformationsBefore = this.recentTransformations.length;
    this.recentTransformations = this.recentTransformations.filter((transformation) => {
      const timestamp = new Date(transformation.createdAt).getTime();
      return timestamp > cutoff;
    });
    const transformationsRemoved = transformationsBefore - this.recentTransformations.length;

    // Prune performance metrics
    const metricsBefore = this.performanceMetrics.length;
    this.performanceMetrics = this.performanceMetrics.filter((metric) => {
      const timestamp = new Date(metric.createdAt).getTime();
      return timestamp > cutoff;
    });
    const metricsRemoved = metricsBefore - this.performanceMetrics.length;

    // Prune node introspection events
    const introspectionBefore = this.nodeIntrospectionEvents.length;
    this.nodeIntrospectionEvents = this.nodeIntrospectionEvents.filter((event) => {
      const timestamp = new Date(event.createdAt).getTime();
      return timestamp > cutoff;
    });
    const introspectionRemoved = introspectionBefore - this.nodeIntrospectionEvents.length;

    // Prune node heartbeat events
    const heartbeatBefore = this.nodeHeartbeatEvents.length;
    this.nodeHeartbeatEvents = this.nodeHeartbeatEvents.filter((event) => {
      const timestamp = new Date(event.createdAt).getTime();
      return timestamp > cutoff;
    });
    const heartbeatRemoved = heartbeatBefore - this.nodeHeartbeatEvents.length;

    // Prune node state change events
    const stateChangeBefore = this.nodeStateChangeEvents.length;
    this.nodeStateChangeEvents = this.nodeStateChangeEvents.filter((event) => {
      const timestamp = new Date(event.createdAt).getTime();
      return timestamp > cutoff;
    });
    const stateChangeRemoved = stateChangeBefore - this.nodeStateChangeEvents.length;

    // Prune stale registered nodes (not seen in 24 hours)
    const nodesBefore = this.registeredNodes.size;
    const nodeEntries = Array.from(this.registeredNodes.entries());
    for (const [nodeId, node] of nodeEntries) {
      const lastSeenTime = new Date(node.lastSeen).getTime();
      if (lastSeenTime < cutoff) {
        this.registeredNodes.delete(nodeId);
      }
    }
    const nodesRemoved = nodesBefore - this.registeredNodes.size;

    // Prune live event bus events (used for INITIAL_STATE freshness)
    const liveEventsBefore = this.liveEventBusEvents.length;
    this.liveEventBusEvents = this.liveEventBusEvents.filter((event) => {
      const timestamp = new Date(event.timestamp).getTime();
      return timestamp > cutoff;
    });
    const liveEventsRemoved = liveEventsBefore - this.liveEventBusEvents.length;

    // Also prune stale preloaded events so INITIAL_STATE stays fresh
    const preloadedBefore = this.preloadedEventBusEvents.length;
    this.preloadedEventBusEvents = this.preloadedEventBusEvents.filter((event) => {
      const timestamp = new Date(event.timestamp).getTime();
      return timestamp > cutoff;
    });
    const preloadedEventsRemoved = preloadedBefore - this.preloadedEventBusEvents.length;

    // Prune intent events
    const intentsBefore = this.recentIntents.length;
    this.recentIntents = this.recentIntents.filter((intent) => {
      const timestamp = new Date(intent.createdAt).getTime();
      return timestamp > cutoff;
    });
    const intentsRemoved = intentsBefore - this.recentIntents.length;

    // Prune intent distribution with proper timestamp-based pruning
    // This prevents unbounded memory growth in the distribution map
    let distributionEntriesPruned = 0;
    const distributionEntries = Array.from(this.intentDistributionWithTimestamps.entries());
    for (const [intentType, data] of distributionEntries) {
      // Filter out timestamps older than cutoff
      const validTimestamps = data.timestamps.filter((ts: number) => ts > cutoff);

      if (validTimestamps.length === 0) {
        // No valid timestamps - remove the entire entry
        this.intentDistributionWithTimestamps.delete(intentType);
        distributionEntriesPruned++;
      } else if (validTimestamps.length < data.timestamps.length) {
        // Some timestamps pruned - update the entry
        const removed = data.timestamps.length - validTimestamps.length;
        this.intentDistributionWithTimestamps.set(intentType, {
          count: data.count - removed,
          timestamps: validTimestamps,
        });
      }
    }

    // Log pruning statistics if anything was removed
    const totalRemoved =
      actionsRemoved +
      decisionsRemoved +
      transformationsRemoved +
      metricsRemoved +
      introspectionRemoved +
      heartbeatRemoved +
      stateChangeRemoved +
      nodesRemoved +
      liveEventsRemoved +
      preloadedEventsRemoved +
      intentsRemoved +
      distributionEntriesPruned;
    if (totalRemoved > 0) {
      intentLogger.info(
        `Pruned old data: ${actionsRemoved} actions, ${decisionsRemoved} decisions, ${transformationsRemoved} transformations, ${metricsRemoved} metrics, ${introspectionRemoved + heartbeatRemoved + stateChangeRemoved} node events, ${nodesRemoved} stale nodes, ${liveEventsRemoved + preloadedEventsRemoved} event bus events, ${intentsRemoved} intents, ${distributionEntriesPruned} distribution entries (total: ${totalRemoved})`
      );
    }
  }

  /**
   * Clean up stale offline nodes from the canonical registry.
   * Removes nodes with state='OFFLINE' and offline_at older than OFFLINE_NODE_TTL_MS.
   * This prevents unbounded memory growth from nodes that go offline and never come back.
   */
  private cleanupStaleCanonicalNodes(): void {
    const now = Date.now();
    let removedCount = 0;

    for (const [nodeId, node] of this.canonicalNodes) {
      if (
        node.state === 'OFFLINE' &&
        node.offline_at &&
        now - node.offline_at > OFFLINE_NODE_TTL_MS
      ) {
        this.canonicalNodes.delete(nodeId);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      intentLogger.info(
        `Cleaned up ${removedCount} stale offline canonical nodes (TTL: ${OFFLINE_NODE_TTL_MS / 1000}s)`
      );
    }
  }

  // Public getters for API endpoints

  /**
   * Get aggregated metrics for all active agents.
   *
   * Returns metrics for agents that have been active within the last 24 hours,
   * including request counts, success rates, routing times, and confidence scores.
   *
   * @returns Array of agent metrics, sorted by agent name
   *
   * @example
   * ```typescript
   * const consumer = getEventConsumer();
   * const metrics = consumer?.getAgentMetrics() ?? [];
   *
   * metrics.forEach(metric => {
   *   console.log(`${metric.agent}: ${metric.totalRequests} requests, ${metric.successRate}% success`);
   * });
   * ```
   */
  getAgentMetrics(): AgentMetrics[] {
    const now = new Date();
    // Extended window to show historical data (was 5 minutes, now 24 hours)
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    return (
      Array.from(this.agentMetrics.entries())
        // Filter to only agents active in last 24 hours
        .filter(([_, data]) => data.lastSeen >= twentyFourHoursAgo)
        .map(([agent, data]) => {
          // Calculate success rate if we have success/error events
          const totalOutcomes = data.successCount + data.errorCount;
          let successRate: number | null = null;

          if (totalOutcomes > 0) {
            // Use actual success/error tracking if available
            successRate = data.successCount / totalOutcomes;
          } else {
            // Fallback: Use confidence score as proxy for success rate
            // High confidence (>0.85) = likely successful routing
            const avgConfidence = data.totalConfidence / data.count;
            successRate = avgConfidence; // Direct mapping: 0.85 confidence = 85% success rate
          }

          return {
            agent,
            totalRequests: data.count,
            successRate,
            avgRoutingTime: data.totalRoutingTime / data.count,
            avgConfidence: data.totalConfidence / data.count,
            lastSeen: data.lastSeen,
          };
        })
    );
  }

  /**
   * Get playback event injection statistics for observability.
   *
   * Tracks the number of events successfully injected via playback
   * and the number that failed during processing. These counters
   * are reset when `resetState()` is called (e.g., on demo restart).
   *
   * @returns Object containing playback injection statistics
   *
   * @example
   * ```typescript
   * const stats = consumer.getPlaybackStats();
   * console.log(`Injected: ${stats.injected}, Failed: ${stats.failed}, Success Rate: ${stats.successRate}%`);
   * ```
   */
  getPlaybackStats(): { injected: number; failed: number; successRate: number } {
    const total = this.playbackEventsInjected;
    const failed = this.playbackEventsFailed;
    // Success rate as percentage (0-100), return 0 when no events (not 100%)
    // because there's no data to compute a success rate from
    const successRate = total > 0 ? ((total - failed) / total) * 100 : 0;

    return {
      injected: total,
      failed: failed,
      successRate: Math.round(successRate * 100) / 100, // Round to 2 decimal places
    };
  }

  /**
   * Get recent agent actions from the in-memory buffer.
   *
   * Actions are stored in reverse chronological order (newest first).
   * The buffer maintains up to 100 actions by default.
   *
   * @param limit - Optional maximum number of actions to return. If not specified, returns all buffered actions.
   * @returns Array of agent actions, newest first
   *
   * @example
   * ```typescript
   * // Get last 10 actions
   * const recentActions = consumer.getRecentActions(10);
   *
   * // Get all buffered actions
   * const allActions = consumer.getRecentActions();
   * ```
   */
  getRecentActions(limit?: number): AgentAction[] {
    if (limit && limit > 0) {
      return this.recentActions.slice(0, limit);
    }
    return this.recentActions;
  }

  /**
   * Get combined event bus events from both the DB preload AND live Kafka
   * consumption since server startup.
   *
   * Merges preloaded (historical) and live (real-time) events, deduplicates
   * by event_id, sorts newest-first, and caps at SQL_PRELOAD_LIMIT.
   * This ensures new WebSocket clients always receive fresh INITIAL_STATE
   * that reflects the CURRENT state of the system, not just a stale DB snapshot.
   *
   * @returns Array of EventBusEvent objects, newest-first, up to SQL_PRELOAD_LIMIT
   */
  getPreloadedEventBusEvents(): EventBusEvent[] {
    // If no live events, return preloaded capped at SQL_PRELOAD_LIMIT
    // (fast path for startup). The preloaded buffer can be as large as
    // MAX_PRELOAD_EVENTS (5000), but this method's contract caps at SQL_PRELOAD_LIMIT (2000).
    if (this.liveEventBusEvents.length === 0) {
      return this.preloadedEventBusEvents.slice(0, SQL_PRELOAD_LIMIT);
    }

    // Merge and deduplicate by event_id across both buffers.
    // Live events take priority (iterated first) over preloaded ones.
    const seen = new Set<string>();
    const merged: EventBusEvent[] = [];

    for (const event of this.liveEventBusEvents) {
      if (!seen.has(event.event_id)) {
        seen.add(event.event_id);
        merged.push(event);
      }
    }

    for (const event of this.preloadedEventBusEvents) {
      if (!seen.has(event.event_id)) {
        seen.add(event.event_id);
        merged.push(event);
      }
    }

    // Sort newest-first with stable tie-break by offset (seq) DESC.
    // This ensures deterministic ordering when multiple events share the
    // same timestamp (common during batch preload or burst ingestion).
    merged.sort((a, b) => {
      const timeDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      if (timeDiff !== 0) return timeDiff;
      // Stable tie-break: higher offset = newer
      return parseInt(b.offset || '0', 10) - parseInt(a.offset || '0', 10);
    });

    return merged.slice(0, SQL_PRELOAD_LIMIT);
  }

  /**
   * Get actions for a specific agent within a time window.
   *
   * Filters the in-memory action buffer by agent name and time range.
   * Useful for generating agent-specific activity reports.
   *
   * @param agentName - The name of the agent to filter by
   * @param timeWindow - Time window string: '1h' (default), '24h', or '7d'
   * @returns Array of actions matching the agent and time criteria
   *
   * @example
   * ```typescript
   * // Get actions for 'polymorphic-agent' in the last hour
   * const hourlyActions = consumer.getActionsByAgent('polymorphic-agent', '1h');
   *
   * // Get actions for 'code-quality-analyzer' in the last 24 hours
   * const dailyActions = consumer.getActionsByAgent('code-quality-analyzer', '24h');
   * ```
   */
  getActionsByAgent(agentName: string, timeWindow: string = '1h'): AgentAction[] {
    // Parse time window
    let windowMs: number;
    switch (timeWindow) {
      case '1h':
        windowMs = 60 * 60 * 1000;
        break;
      case '24h':
        windowMs = 24 * 60 * 60 * 1000;
        break;
      case '7d':
        windowMs = 7 * 24 * 60 * 60 * 1000;
        break;
      default:
        windowMs = 60 * 60 * 1000; // Default to 1h
    }

    const since = new Date(Date.now() - windowMs);

    return this.recentActions.filter(
      (action) => action.agentName === agentName && action.createdAt >= since
    );
  }

  /**
   * Get routing decisions with optional filtering.
   *
   * Routing decisions track which agent was selected to handle each user request,
   * including confidence scores, alternatives considered, and routing time.
   *
   * @param filters - Optional filters to apply
   * @param filters.agent - Filter by selected agent name
   * @param filters.minConfidence - Filter by minimum confidence score (0-1)
   * @returns Array of routing decisions matching the filters, newest first
   *
   * @example
   * ```typescript
   * // Get all routing decisions
   * const allDecisions = consumer.getRoutingDecisions();
   *
   * // Get decisions for a specific agent
   * const agentDecisions = consumer.getRoutingDecisions({ agent: 'api-architect' });
   *
   * // Get high-confidence decisions
   * const confidentDecisions = consumer.getRoutingDecisions({ minConfidence: 0.9 });
   *
   * // Combine filters
   * const filtered = consumer.getRoutingDecisions({
   *   agent: 'code-quality-analyzer',
   *   minConfidence: 0.85
   * });
   * ```
   */
  getRoutingDecisions(filters?: { agent?: string; minConfidence?: number }): RoutingDecision[] {
    let decisions = this.routingDecisions;

    if (filters?.agent) {
      decisions = decisions.filter((d) => d.selectedAgent === filters.agent);
    }

    if (filters?.minConfidence !== undefined) {
      decisions = decisions.filter((d) => d.confidenceScore >= filters.minConfidence!);
    }

    return decisions;
  }

  /**
   * Get recent agent transformation events.
   *
   * Transformation events track when the polymorphic agent transforms into
   * specialized agents during task execution. Includes timing and success status.
   *
   * @param limit - Maximum number of transformations to return (default: 50)
   * @returns Array of transformation events, newest first
   *
   * @example
   * ```typescript
   * // Get last 10 transformations
   * const transformations = consumer.getRecentTransformations(10);
   *
   * transformations.forEach(t => {
   *   console.log(`${t.sourceAgent} -> ${t.targetAgent}: ${t.success ? 'OK' : 'Failed'}`);
   * });
   * ```
   */
  getRecentTransformations(limit: number = 50): TransformationEvent[] {
    return this.recentTransformations.slice(0, limit);
  }

  /**
   * Get recent router performance metrics.
   *
   * Performance metrics track routing latency, cache hit rates,
   * candidates evaluated, and trigger match strategies used.
   *
   * @param limit - Maximum number of metrics to return (default: 100)
   * @returns Array of performance metric objects, newest first
   *
   * @example
   * ```typescript
   * const metrics = consumer.getPerformanceMetrics(50);
   *
   * const avgLatency = metrics.reduce((sum, m) => sum + m.routingDurationMs, 0) / metrics.length;
   * console.log(`Average routing latency: ${avgLatency.toFixed(2)}ms`);
   * ```
   */
  getPerformanceMetrics(limit: number = 100): Array<any> {
    return this.performanceMetrics.slice(0, limit);
  }

  /**
   * Get aggregated performance statistics.
   *
   * Returns summary statistics computed from all processed performance metrics,
   * including total queries, cache hit rate, and average routing duration.
   *
   * @returns Performance statistics object
   * @property {number} totalQueries - Total number of routing queries processed
   * @property {number} cacheHitCount - Number of queries served from cache
   * @property {number} avgRoutingDuration - Average routing time in milliseconds
   * @property {number} totalRoutingDuration - Sum of all routing times
   * @property {number} cacheHitRate - Cache hit rate as percentage (0-100)
   *
   * @example
   * ```typescript
   * const stats = consumer.getPerformanceStats();
   *
   * console.log(`Total queries: ${stats.totalQueries}`);
   * console.log(`Cache hit rate: ${stats.cacheHitRate.toFixed(1)}%`);
   * console.log(`Avg routing time: ${stats.avgRoutingDuration.toFixed(2)}ms`);
   * ```
   */
  getPerformanceStats() {
    return {
      ...this.performanceStats,
      cacheHitRate:
        this.performanceStats.totalQueries > 0
          ? (this.performanceStats.cacheHitCount / this.performanceStats.totalQueries) * 100
          : 0,
    };
  }

  /**
   * Get the health status of the event consumer.
   *
   * Returns current operational status including whether the consumer is running,
   * counts of processed events, and current timestamp.
   *
   * @returns Health status object
   * @property {string} status - 'healthy' if running, 'unhealthy' otherwise
   * @property {number} eventsProcessed - Number of unique agents tracked
   * @property {number} recentActionsCount - Number of actions in buffer
   * @property {number} registeredNodesCount - Number of registered ONEX nodes
   * @property {string} timestamp - ISO 8601 timestamp of the check
   *
   * @example
   * ```typescript
   * const health = consumer.getHealthStatus();
   *
   * if (health.status === 'healthy') {
   *   console.log(`Processing events for ${health.eventsProcessed} agents`);
   * } else {
   *   console.warn('Event consumer is not running');
   * }
   * ```
   */
  getHealthStatus() {
    return {
      status: this.isRunning ? 'healthy' : 'unhealthy',
      eventsProcessed: this.agentMetrics.size,
      recentActionsCount: this.recentActions.length,
      registeredNodesCount: this.registeredNodes.size,
      monotonicMergeRejections: this.monotonicMerge.rejectedCount,
      monotonicMergeTrackedTopics: this.monotonicMerge.trackedKeyCount,
      timestamp: new Date().toISOString(),
    };
  }

  // Node Registry getters
  getRegisteredNodes(): RegisteredNode[] {
    return Array.from(this.registeredNodes.values());
  }

  getRegisteredNode(nodeId: string): RegisteredNode | undefined {
    return this.registeredNodes.get(nodeId);
  }

  getNodeIntrospectionEvents(limit?: number): NodeIntrospectionEvent[] {
    if (limit && limit > 0) {
      return this.nodeIntrospectionEvents.slice(0, limit);
    }
    return this.nodeIntrospectionEvents;
  }

  getNodeHeartbeatEvents(limit?: number): NodeHeartbeatEvent[] {
    if (limit && limit > 0) {
      return this.nodeHeartbeatEvents.slice(0, limit);
    }
    return this.nodeHeartbeatEvents;
  }

  getNodeStateChangeEvents(limit?: number): NodeStateChangeEvent[] {
    if (limit && limit > 0) {
      return this.nodeStateChangeEvents.slice(0, limit);
    }
    return this.nodeStateChangeEvents;
  }

  getNodeRegistryStats() {
    const nodes = this.getRegisteredNodes();
    const activeNodes = nodes.filter((n) => n.state === 'active').length;
    const pendingNodes = nodes.filter((n) =>
      ['pending_registration', 'awaiting_ack', 'ack_received', 'accepted'].includes(n.state)
    ).length;
    const failedNodes = nodes.filter((n) =>
      ['rejected', 'liveness_expired', 'ack_timed_out'].includes(n.state)
    ).length;

    // Count by node type
    const typeDistribution = nodes.reduce(
      (acc, node) => {
        acc[node.nodeType] = (acc[node.nodeType] || 0) + 1;
        return acc;
      },
      {} as Record<NodeType, number>
    );

    return {
      totalNodes: nodes.length,
      activeNodes,
      pendingNodes,
      failedNodes,
      typeDistribution,
    };
  }

  // Intent getters

  /**
   * Get recent intent classification events from the in-memory buffer.
   *
   * @param limit - Maximum number of intents to return (default: 50)
   * @returns Array of intent classification events, newest first
   */
  getRecentIntents(limit: number = 50): InternalIntentClassifiedEvent[] {
    return this.recentIntents.slice(0, limit);
  }

  /**
   * Get the distribution of intent types.
   *
   * @returns Object mapping intent types to their counts
   */
  getIntentDistribution(): Record<string, number> {
    const distribution: Record<string, number> = {};
    const entries = Array.from(this.intentDistributionWithTimestamps.entries());
    for (const [intentType, data] of entries) {
      distribution[intentType] = data.count;
    }
    return distribution;
  }

  /**
   * Get intent statistics summary.
   *
   * @returns Object with total count and type distribution
   */
  getIntentStats() {
    const distribution = this.getIntentDistribution();
    const totalIntents = Object.values(distribution).reduce((sum, count) => sum + count, 0);
    const topIntentTypes = Object.entries(distribution)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    return {
      totalIntents,
      recentIntentsCount: this.recentIntents.length,
      typeDistribution: distribution,
      topIntentTypes,
    };
  }

  // ============================================================================
  // Demo Mode State Reset
  // ============================================================================

  /**
   * Reset all in-memory state for demo mode.
   * Clears cached events so demo playback starts with a clean slate.
   */
  resetState(): void {
    const previousCounts = {
      actions: this.recentActions.length,
      decisions: this.routingDecisions.length,
      transformations: this.recentTransformations.length,
      intents: this.recentIntents.length,
      agentMetrics: this.agentMetrics.size,
      performanceMetrics: this.performanceMetrics.length,
      intentDistribution: this.intentDistributionWithTimestamps.size,
      playbackInjected: this.playbackEventsInjected,
      playbackFailed: this.playbackEventsFailed,
    };

    // Clear primary event arrays
    this.recentActions = [];
    this.routingDecisions = [];
    this.recentTransformations = [];
    this.recentIntents = [];

    // Clear all demo-visible caches (aggregated metrics and distributions)
    this.agentMetrics.clear();
    this.performanceMetrics = [];
    this.performanceStats = {
      totalQueries: 0,
      cacheHitCount: 0,
      avgRoutingDuration: 0,
      totalRoutingDuration: 0,
    };
    this.intentDistributionWithTimestamps.clear();

    // Reset playback counters for fresh demo state
    this.playbackEventsInjected = 0;
    this.playbackEventsFailed = 0;

    // Reset monotonic merge tracker and arrival counter so replayed events are accepted from scratch
    this.monotonicMerge.reset();
    this.arrivalSeq = 0;

    intentLogger.info(
      `State reset for demo mode. Cleared: ` +
        `${previousCounts.actions} actions, ` +
        `${previousCounts.decisions} routing decisions, ` +
        `${previousCounts.transformations} transformations, ` +
        `${previousCounts.intents} intents, ` +
        `${previousCounts.agentMetrics} agent metrics, ` +
        `${previousCounts.performanceMetrics} performance metrics, ` +
        `${previousCounts.intentDistribution} intent distribution entries, ` +
        `${previousCounts.playbackInjected} playback events (${previousCounts.playbackFailed} failed)`
    );

    this.emit('stateReset');
  }

  /**
   * Snapshot current state before demo playback.
   * Captures all in-memory data so it can be restored when playback stops.
   * Call this BEFORE resetState() when starting demo mode.
   */
  snapshotState(): void {
    // Deep clone arrays (they contain objects, so we need proper copies)
    this.stateSnapshot = {
      recentActions: [...this.recentActions],
      routingDecisions: [...this.routingDecisions],
      recentTransformations: [...this.recentTransformations],
      recentIntents: [...this.recentIntents],
      agentMetrics: new Map(this.agentMetrics),
      performanceMetrics: [...this.performanceMetrics],
      performanceStats: { ...this.performanceStats },
      intentDistributionWithTimestamps: new Map(
        Array.from(this.intentDistributionWithTimestamps.entries()).map(([k, v]) => [
          k,
          { count: v.count, timestamps: [...v.timestamps] },
        ])
      ),
    };

    intentLogger.info(
      `State snapshot created for demo mode. Captured: ` +
        `${this.stateSnapshot.recentActions.length} actions, ` +
        `${this.stateSnapshot.routingDecisions.length} routing decisions, ` +
        `${this.stateSnapshot.recentTransformations.length} transformations, ` +
        `${this.stateSnapshot.recentIntents.length} intents`
    );

    this.emit('stateSnapshotted');
  }

  /**
   * Restore state from snapshot after demo playback ends.
   * Call this when stopping demo mode to bring back live data.
   * @returns true if state was restored, false if no snapshot exists
   */
  restoreState(): boolean {
    if (!this.stateSnapshot) {
      intentLogger.warn('No state snapshot to restore - live data may have been lost');
      return false;
    }

    // Restore all state from snapshot
    this.recentActions = this.stateSnapshot.recentActions;
    this.routingDecisions = this.stateSnapshot.routingDecisions;
    this.recentTransformations = this.stateSnapshot.recentTransformations;
    this.recentIntents = this.stateSnapshot.recentIntents;
    this.agentMetrics = this.stateSnapshot.agentMetrics;
    this.performanceMetrics = this.stateSnapshot.performanceMetrics;
    this.performanceStats = this.stateSnapshot.performanceStats;
    this.intentDistributionWithTimestamps = this.stateSnapshot.intentDistributionWithTimestamps;

    intentLogger.info(
      `State restored from snapshot. Restored: ` +
        `${this.recentActions.length} actions, ` +
        `${this.routingDecisions.length} routing decisions, ` +
        `${this.recentTransformations.length} transformations, ` +
        `${this.recentIntents.length} intents`
    );

    // Clear the snapshot (it's been used)
    this.stateSnapshot = null;

    // Reset playback counters
    this.playbackEventsInjected = 0;
    this.playbackEventsFailed = 0;

    this.emit('stateRestored');
    return true;
  }

  /**
   * Check if a state snapshot exists.
   * Useful for UI to know if restore is possible.
   */
  hasStateSnapshot(): boolean {
    return this.stateSnapshot !== null;
  }

  // ============================================================================
  // Canonical ONEX Node Registry Getters (OMN-1279)
  // ============================================================================

  /**
   * Get all canonical ONEX nodes from the event-driven registry.
   * These nodes use the new ONEX event envelope format.
   */
  getCanonicalNodes(): CanonicalOnexNode[] {
    return Array.from(this.canonicalNodes.values());
  }

  /**
   * Get a specific canonical node by ID.
   */
  getCanonicalNode(nodeId: string): CanonicalOnexNode | undefined {
    return this.canonicalNodes.get(nodeId);
  }

  /**
   * Get statistics for the canonical node registry.
   */
  getCanonicalNodeStats(): {
    totalNodes: number;
    activeNodes: number;
    pendingNodes: number;
    offlineNodes: number;
  } {
    const nodes = this.getCanonicalNodes();
    return {
      totalNodes: nodes.length,
      activeNodes: nodes.filter((n) => n.state === 'ACTIVE').length,
      pendingNodes: nodes.filter((n) => n.state === 'PENDING').length,
      offlineNodes: nodes.filter((n) => n.state === 'OFFLINE').length,
    };
  }

  /**
   * Stop the Kafka event consumer and clean up resources.
   *
   * This method gracefully shuts down the consumer by:
   * 1. Clearing the periodic pruning timer
   * 2. Stopping the consumer (finishes in-flight messages)
   * 3. Disconnecting from Kafka
   * 4. Emitting a 'disconnected' event
   *
   * @returns Promise that resolves when the consumer is stopped
   *
   * @fires EventConsumer#disconnected - When successfully disconnected
   * @fires EventConsumer#error - If an error occurs during disconnection
   *
   * @example
   * ```typescript
   * const consumer = getEventConsumer();
   * if (consumer) {
   *   await consumer.stop();
   *   console.log('Consumer stopped successfully');
   * }
   * ```
   */
  async stop() {
    // Guard against concurrent stop() calls: if a stop is already in progress,
    // return early rather than relying on isRunning (which is cleared mid-stop,
    // leaving a window where isRunning=false but disconnect() hasn't run yet).
    // isRunning is set inside the consumer loop body; a connect()-but-not-yet-run window
    // where isRunning=false is accepted — callers must not rely on stop() for cleanup in that gap.
    if (!this.consumer || !this.isRunning || this.isStopping) {
      return;
    }

    this.isStopping = true;

    try {
      // Clear pruning timer
      if (this.pruneTimer) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = undefined;
      }

      // Clear canonical node cleanup timer
      if (this.canonicalNodeCleanupInterval) {
        clearInterval(this.canonicalNodeCleanupInterval);
        this.canonicalNodeCleanupInterval = undefined;
      }

      // Stop the consumer first to finish processing in-flight messages,
      // then disconnect the underlying client. This ordering prevents
      // unhandled rejections from disconnect racing with message processing.
      if (typeof this.consumer.stop === 'function') {
        try {
          await this.consumer.stop();
        } catch (stopError) {
          // Log but continue to disconnect — stop() may fail if consumer
          // was never fully started (e.g., subscription failed).
          console.warn('[EventConsumer] consumer.stop() failed:', stopError);
        }
      }

      this.isRunning = false;
      await this.consumer.disconnect();

      // Disconnect the startup re-introspection producer (OMN-3334).
      if (this.producer) {
        await this.producer.disconnect().catch((err) => {
          console.warn('[EventConsumer] Error disconnecting producer:', err);
        });
        this.producer = null;
      }

      // Stop the catalog manager (its own consumer/producer pair).
      if (this.catalogManager) {
        await this.catalogManager.stop().catch((err) => {
          console.warn('[EventConsumer] Error stopping catalog manager:', err);
        });
        this.catalogManager = null;
      }

      intentLogger.info('Event consumer stopped');
      this.emit('disconnected'); // Emit disconnected event
    } catch (error) {
      console.error('Error stopping Kafka consumer:', error);
      this.isRunning = false;
      this.emit('error', error); // Emit error event
    } finally {
      this.isStopping = false;
    }
  }

  // ============================================================================
  // Topic Catalog Bootstrap (OMN-2315)
  // ============================================================================

  /**
   * Attempt to fetch the topic list from the platform topic-catalog service.
   *
   * Creates a TopicCatalogManager, bootstraps it (subscribe + publish query),
   * and waits for either a catalog response or a timeout.  On success the
   * discovered topics are stored and 'catalogSource' is set to 'catalog'.
   * On timeout/error the hardcoded buildSubscriptionTopics() list is returned
   * and 'catalogSource' is reset to 'fallback'.
   *
   * Catalog state (catalogSource, catalogTopics, catalogWarnings) is reset at
   * the start of every call so that a second bootstrap attempt after an
   * in-process restart never returns stale data from a prior successful run.
   *
   * Wire catalog-changed events so future catalog updates adjust subscriptions.
   */
  private async fetchCatalogTopics(): Promise<string[]> {
    // Reset stale state from any prior bootstrap attempt
    this.catalogSource = 'fallback';
    this.catalogTopics = [];
    this.catalogWarnings = [];

    try {
      const manager = new TopicCatalogManager();
      this.catalogManager = manager;

      const topics = await new Promise<string[]>((resolve) => {
        manager.once('catalogReceived', (event) => {
          this.catalogTopics = event.topics;
          this.catalogWarnings = event.warnings;
          this.catalogSource = 'catalog';

          if (event.warnings.length > 0) {
            console.warn(`[EventConsumer] Topic catalog warnings: ${event.warnings.join('; ')}`);
            this.emit('catalogWarnings', event.warnings);
          }

          // Wire the ongoing catalog-changed event for dynamic add/remove.
          // Only wired on the success path so a stopped manager is never referenced.
          manager.on('catalogChanged', (event) => {
            this.handleCatalogChanged(event.topicsAdded, event.topicsRemoved);
          });

          resolve(event.topics);
        });

        manager.once('catalogTimeout', () => {
          intentLogger.info(
            '[EventConsumer] Topic catalog timed out — using fallback subscription topics'
          );
          // Stop the catalog manager connections on timeout — it will not receive
          // a response, so its consumer/producer are no longer needed.
          manager.stop().catch((stopErr) => {
            console.warn('[EventConsumer] Error stopping catalog manager after timeout:', stopErr);
          });
          this.catalogManager = null;
          resolve(buildSubscriptionTopics());
        });

        // Non-blocking: errors from bootstrap should not crash the consumer startup.
        manager.bootstrap().catch((err) => {
          console.warn('[EventConsumer] Topic catalog bootstrap error:', err);
          // Clean up the partially-started manager before falling back.
          manager.stop().catch((stopErr) => {
            console.warn(
              '[EventConsumer] Error stopping catalog manager after bootstrap error:',
              stopErr
            );
          });
          this.catalogManager = null;
          resolve(buildSubscriptionTopics());
        });
      });

      return topics;
    } catch (err) {
      console.warn(
        '[EventConsumer] Topic catalog manager failed to initialise — using fallback topics:',
        err
      );
      return buildSubscriptionTopics();
    }
  }

  /**
   * Handle a catalog-changed delta event.
   *
   * NOTE: KafkaJS does not support adding new topic subscriptions to a running
   * consumer without stopping and restarting it.  Rather than incur that churn
   * on every catalog change event, we record the updated topic set and log the
   * delta.  A full subscription update would require consumer restart which is
   * left as a future improvement.  The current consumer continues serving the
   * originally subscribed topics; added topics will be included on next restart.
   */
  private handleCatalogChanged(topicsAdded: string[], topicsRemoved: string[]): void {
    if (topicsAdded.length === 0 && topicsRemoved.length === 0) return;

    // Update in-memory catalog state
    const currentSet = new Set(this.catalogTopics);
    for (const t of topicsAdded) currentSet.add(t);
    for (const t of topicsRemoved) currentSet.delete(t);
    this.catalogTopics = [...currentSet];

    console.log(
      `[EventConsumer] Catalog changed: +${topicsAdded.length} topics, -${topicsRemoved.length} topics. ` +
        `Updated set has ${this.catalogTopics.length} entries. ` +
        `Note: subscription changes take effect on next server restart.`
    );

    this.emit('catalogChanged', { topicsAdded, topicsRemoved });
  }

  /**
   * Return the current catalog/discovery status for the REST endpoint.
   */
  public getCatalogStatus(): {
    topics: string[];
    warnings: string[];
    source: 'registry' | 'catalog' | 'fallback';
    instanceUuid: string | null;
  } {
    // Registry-driven path (OMN-5027)
    if (this.topicSource === 'registry' && this.discoveryCoordinator) {
      return {
        topics: this.discoveryCoordinator.getCurrentTopics(),
        warnings: this.catalogWarnings,
        source: 'registry',
        instanceUuid: null,
      };
    }

    // Legacy catalog path
    return {
      topics: this.catalogSource === 'catalog' ? this.catalogTopics : buildSubscriptionTopics(),
      warnings: this.catalogWarnings,
      source: this.catalogSource,
      instanceUuid: this.catalogManager?.instanceUuid ?? null,
    };
  }

  /**
   * Inject a playback event into the consumer pipeline.
   * This allows recorded events to flow through the same handlers as live Kafka events,
   * ensuring the dashboard sees playback events identically to live events.
   */
  public injectPlaybackEvent(
    topic: string,
    event: Record<string, unknown>,
    partition?: number
  ): void {
    intentLogger.debug(`[Playback] Injecting event for topic: ${topic}`);

    try {
      // Monotonic merge gate: reject events older than the last applied.
      // Use topic:partition key to match the live Kafka key space so that
      // preloaded events and live events share the same merge cursors.
      // When partition is unavailable (demo playback), fall back to topic-only.
      const incomingEventTime = extractEventTimeMs(event);
      const mergeKey = partition != null ? `${topic}:${partition}` : topic;
      // DB rows and playback events don't have Kafka offsets; use arrival counter
      // so events with the same timestamp (common in batch preload) are accepted
      // in arrival order.
      if (
        !this.monotonicMerge.checkAndUpdate(mergeKey, {
          eventTime: incomingEventTime,
          seq: ++this.arrivalSeq,
        })
      ) {
        return; // stale event — already logged at debug level by the tracker
      }

      // Track successful injection attempts for observability
      this.playbackEventsInjected++;

      switch (topic) {
        case TOPIC.PROMPT_SUBMITTED:
        case 'prompt-submitted':
          this.handlePromptSubmittedEvent(
            event as Parameters<typeof this.handlePromptSubmittedEvent>[0]
          );
          break;

        case TOPIC_OMNICLAUDE_ROUTING_DECISIONS:
        case 'routing-decision':
          this.handleRoutingDecision(event as RawRoutingDecisionEvent);
          break;

        case TOPIC_OMNICLAUDE_AGENT_ACTIONS:
        case 'action':
          this.handleAgentAction(event as RawAgentActionEvent);
          break;

        case TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION:
        case 'transformation':
          this.handleTransformationEvent(event as RawTransformationEvent);
          break;

        case TOPIC.TOOL_EXECUTED:
        case 'tool-executed':
          this.handleOmniclaudeLifecycleEvent(
            event as Parameters<typeof this.handleOmniclaudeLifecycleEvent>[0],
            TOPIC.TOOL_EXECUTED
          );
          break;

        case TOPIC.SESSION_STARTED:
        case 'session-started':
          this.handleOmniclaudeLifecycleEvent(
            event as Parameters<typeof this.handleOmniclaudeLifecycleEvent>[0],
            TOPIC.SESSION_STARTED
          );
          break;

        case TOPIC.SESSION_ENDED:
        case 'session-ended':
          this.handleOmniclaudeLifecycleEvent(
            event as Parameters<typeof this.handleOmniclaudeLifecycleEvent>[0],
            TOPIC.SESSION_ENDED
          );
          break;

        // Tool-content events from omniintelligence (tool execution records)
        case TOPIC.TOOL_CONTENT:
          this.handleAgentAction({
            action_type: 'tool',
            agent_name: 'omniclaude',
            action_name: (event as Record<string, string>).tool_name || 'unknown',
            correlation_id: (event as Record<string, string>).correlation_id,
            duration_ms: Number((event as Record<string, unknown>).duration_ms || 0),
            timestamp: (event as Record<string, string>).timestamp,
          } as RawAgentActionEvent);
          break;

        case SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED:
        case 'intent-classified':
          // Route through the same handler as live Kafka events for consistent state updates
          this.handleIntentClassified(event as RawIntentClassifiedEvent);
          break;

        case TOPIC_OMNICLAUDE_PERFORMANCE_METRICS:
        case 'performance-metric':
          // Route through the same handler as live Kafka events for consistent state updates
          this.handlePerformanceMetric(event as RawPerformanceMetricEvent);
          break;

        case TOPIC.NODE_HEARTBEAT:
          // DB-preloaded heartbeat events arrive as flat payloads (envelope already unwrapped
          // by EventBusDataSource). Route to the legacy flat handler so the node appears in
          // registeredNodes and the projection receives a node-registry-seed via Bridge 1.
          this.handleNodeHeartbeat(event as RawNodeHeartbeatEvent);
          break;

        case TOPIC.NODE_INTROSPECTION:
        case TOPIC.REQUEST_INTROSPECTION:
          // Same as heartbeat: flat payload from DB preload — use flat handler path.
          this.handleNodeIntrospection(event as RawNodeIntrospectionEvent);
          break;

        case TOPIC.NODE_REGISTRATION:
          // Registration events carry node state changes. Treat as state-change for replay.
          this.handleNodeStateChange(event as RawNodeStateChangeEvent);
          break;

        default:
          intentLogger.debug(`Unknown playback topic: ${topic}, emitting as generic event`);
          this.emit('playbackEvent', { topic, event });
      }
    } catch (error) {
      // Track failed injection attempts for observability
      this.playbackEventsFailed++;

      // Log errors gracefully but continue playback - don't crash on malformed events
      const errorMessage = error instanceof Error ? error.message : String(error);
      intentLogger.warn(`[Playback] Failed to process event for topic ${topic}: ${errorMessage}`);
      // Emit error event for observability but don't re-throw
      this.emit('playbackError', {
        topic,
        event,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

// ============================================================================
// Lazy Initialization Pattern (prevents startup crashes)
// ============================================================================

let eventConsumerInstance: EventConsumer | null = null;
let initializationError: Error | null = null;

/**
 * Get EventConsumer singleton with lazy initialization
 *
 * This pattern prevents the application from crashing at module load time
 * when KAFKA_BROKERS is absent. Note: a missing KAFKA_BROKERS is a
 * misconfiguration error — Kafka is required infrastructure. A null return
 * from this function means the application is not connected to Kafka and
 * is in a degraded/error state.
 *
 * @returns EventConsumer instance or null if initialization failed (error state)
 *
 * @example
 * ```typescript
 * const consumer = getEventConsumer();
 * if (!consumer) {
 *   return res.status(503).json({ error: 'Event consumer not available - check KAFKA_BROKERS configuration' });
 * }
 * const metrics = consumer.getAgentMetrics();
 * ```
 */
export function getEventConsumer(): EventConsumer | null {
  // Return cached instance if already initialized
  if (eventConsumerInstance) {
    return eventConsumerInstance;
  }

  // Return null if we previously failed to initialize
  if (initializationError) {
    return null;
  }

  // Attempt lazy initialization
  try {
    eventConsumerInstance = new EventConsumer();
    return eventConsumerInstance;
  } catch (error) {
    initializationError = error instanceof Error ? error : new Error(String(error));
    console.error('❌ EventConsumer initialization failed:', initializationError.message);
    console.error(
      '   Kafka is required infrastructure. Set KAFKA_BROKERS in .env to connect to the Redpanda/Kafka broker.'
    );
    console.error(
      '   Real-time event streaming is unavailable — this is an error state, not normal operation.'
    );
    return null;
  }
}

/**
 * Check if EventConsumer is available.
 *
 * Triggers lazy initialization if not yet done, then returns true if the
 * singleton was successfully initialized and false if initialization failed
 * (e.g. KAFKA_BROKERS not configured). Safe to call at any time — no prior
 * call to `getEventConsumer()` is required.
 *
 * @remarks
 * **Side effect**: Triggers lazy initialization of the singleton if not yet
 * initialized. Calling this function is equivalent to calling
 * `getEventConsumer()` plus a null check — both are safe to call at any
 * point.
 *
 * **Behavioral change from pre-lazy-init code**: Previously, `isEventConsumerAvailable()`
 * returned `true` optimistically before any initialization attempt (the old code checked a
 * simple boolean flag that started as `true`). The current implementation triggers lazy
 * initialization as a side effect on the first call. It returns `true` only after successful
 * initialization completes, and `false` if initialization failed (e.g. KAFKA_BROKERS missing
 * or the EventConsumer constructor threw). Callers that previously relied on the optimistic
 * `true` return before initialization must be updated to treat `false` as "Kafka unavailable".
 *
 * @performance Avoid calling in per-request hot paths (e.g. health-check
 * endpoints polled frequently, per-request middleware). On the **first call**,
 * lazy initialization runs the `EventConsumer` constructor, which reads
 * environment variables and allocates KafkaJS client and consumer objects —
 * synchronous work, but non-trivial on the first invocation. No network I/O
 * occurs during construction; broker connections are established only when
 * `start()` is called. On **subsequent calls** (after initialization is
 * cached), the cost is negligible — a null check on a module-level variable.
 * Still, the semantic intent of this function is an initialization probe, not
 * a cheap boolean predicate; callers on hot paths should cache the result
 * after the first successful initialization and avoid calling this function
 * on every request.
 *
 * @returns `true` if initialization succeeded; `false` if Kafka is not configured or
 *   initialization failed. **Note**: triggers lazy initialization on first call.
 */
export function isEventConsumerAvailable(): boolean {
  // SIDE EFFECT: The first call to this function triggers lazy initialization of the
  // EventConsumer singleton (via getEventConsumer()). Subsequent calls are cheap.
  //
  // RETURN VALUE AMBIGUITY: A return value of `false` has two distinct meanings:
  //   (a) Initialization was just triggered for the first time and the constructor threw
  //       (e.g. KAFKA_BROKERS is missing). This is a permanent failure — retrying will
  //       always return false because initializationError is cached.
  //   (b) This function has never been called before AND initialization is about to run —
  //       but construction is synchronous, so this case collapses into (a): by the time
  //       this function returns, initialization has either succeeded (returns true) or
  //       failed (returns false, error cached). There is no "not yet initialized" window
  //       where false means "try again later".
  //
  // In summary: false always means "Kafka is unavailable" — either because KAFKA_BROKERS
  // is not configured or because the constructor threw. Callers do NOT need to poll; a
  // single false return is definitive. To diagnose the root cause, call getEventConsumerError().
  //
  // SIDE EFFECT WARNING (startup): If early initialization at a predictable point is
  // desired (e.g. to surface misconfiguration at server startup rather than on the first
  // request), call this function (or getEventConsumer()) once explicitly in server/index.ts
  // or routes.ts after route registration.
  getEventConsumer();
  return eventConsumerInstance !== null;
}

/**
 * Get the initialization error if EventConsumer failed to initialize
 * @returns Error object or null if no error
 */
export function getEventConsumerError(): Error | null {
  return initializationError;
}

/**
 * Proxy that delegates all property access to the lazily-initialized EventConsumer.
 * Returns stub implementations that log errors when Kafka is not configured.
 */
export const eventConsumer = new Proxy({} as EventConsumer, {
  get(target, prop) {
    const instance = getEventConsumer();
    if (!instance) {
      // Return dummy implementations that log errors
      if (prop === 'validateConnection') {
        return async () => {
          console.error(
            '❌ EventConsumer not available - KAFKA_BROKERS is not configured. Kafka is required infrastructure.'
          );
          return false;
        };
      }
      if (prop === 'start') {
        // Throw asynchronously to match the real async start() signature and ensure
        // callers that await start() surface the error rather than silently getting undefined.
        return async (..._args: unknown[]) => {
          throw new Error(
            '[EventConsumer] start called before initialization — Kafka is not configured or could not be reached'
          );
        };
      }
      if (prop === 'stop') {
        // Intentionally silent — stop() during shutdown when Kafka was never configured
        // is a benign no-op and should not emit misleading error-level log entries.
        return async (..._args: unknown[]) => {};
      }
      if (prop === 'getHealthStatus') {
        return () => ({
          status: 'unhealthy',
          eventsProcessed: 0,
          recentActionsCount: 0,
          registeredNodesCount: 0,
          timestamp: new Date().toISOString(),
        });
      }
      if (
        prop === 'getAgentMetrics' ||
        prop === 'getRecentActions' ||
        prop === 'getRoutingDecisions' ||
        prop === 'getRecentTransformations' ||
        prop === 'getPerformanceMetrics' ||
        prop === 'getRegisteredNodes' ||
        prop === 'getNodeIntrospectionEvents' ||
        prop === 'getNodeHeartbeatEvents' ||
        prop === 'getNodeStateChangeEvents' ||
        prop === 'getRecentIntents' ||
        prop === 'getCanonicalNodes' ||
        prop === 'getPreloadedEventBusEvents'
      ) {
        return () => [];
      }
      if (prop === 'getIntentDistribution') {
        return () => ({});
      }
      if (prop === 'getIntentStats') {
        return () => ({
          totalIntents: 0,
          recentIntentsCount: 0,
          typeDistribution: {},
          topIntentTypes: [],
        });
      }
      if (prop === 'getNodeRegistryStats') {
        return () => ({
          totalNodes: 0,
          activeNodes: 0,
          pendingNodes: 0,
          failedNodes: 0,
          typeDistribution: {},
        });
      }
      if (prop === 'getCanonicalNodeStats') {
        return () => ({
          totalNodes: 0,
          activeNodes: 0,
          pendingNodes: 0,
          offlineNodes: 0,
        });
      }
      if (prop === 'getRegisteredNode' || prop === 'getCanonicalNode') {
        return () => undefined;
      }
      if (prop === 'getPerformanceStats') {
        return () => ({
          totalQueries: 0,
          cacheHitCount: 0,
          avgRoutingDuration: 0,
          totalRoutingDuration: 0,
          cacheHitRate: 0,
        });
      }
      if (prop === 'getActionsByAgent') {
        return () => [];
      }
      /**
       * No-Kafka fallback: getCatalogStatus returns a safe default shape when
       * Kafka is not configured and no real EventConsumer instance exists.
       */
      if (prop === 'getCatalogStatus') {
        return () => ({
          topics: [] as string[],
          warnings: [] as string[],
          source: 'fallback' as const,
          instanceUuid: null,
        });
      }
      // For event emitter methods, return no-op functions
      if (prop === 'on' || prop === 'once' || prop === 'emit' || prop === 'removeListener') {
        return (...args: unknown[]) => {
          if (prop === 'on' || prop === 'once') {
            // Listener was NOT registered — Kafka is unavailable so no events will fire.
            // Warn rather than error: listener registration before start is a normal init
            // ordering pattern and does not indicate a bug in the caller.
            console.warn(
              `[EventConsumer] .${prop}() called on stub proxy (event: "${String(args[0])}") — ` +
                'Kafka is not initialized; listener was NOT registered. ' +
                'Set KAFKA_BROKERS in .env to enable real event delivery.'
            );
          } else if (prop === 'removeListener') {
            // No-op: there is nothing to remove because on/once stubs never registered a
            // real listener. Warn rather than error: teardown cleanup (e.g. React useEffect
            // return) is a normal pattern, not a bug.
            console.warn(
              `[EventConsumer] .removeListener() called on stub proxy (event: "${String(args[0])}") — ` +
                'no-op because Kafka is not initialized and no listener was ever registered.'
            );
          } else if (prop === 'emit') {
            // No-op: no real EventEmitter exists to dispatch to. Log at error level —
            // emitting to an unavailable bus is more serious; the event was silently dropped.
            console.error(
              `[EventConsumer] .emit() called on stub proxy (event: "${String(args[0])}") — ` +
                'no-op because Kafka is not initialized; event was not dispatched.'
            );
            // EventEmitter.emit() returns boolean (true if listeners were called).
            // Return false — no listeners exist because Kafka is not initialized.
            return false;
          }
          return eventConsumer; // Return proxy for chaining (on/once/removeListener return `this`)
        };
      }
      return undefined;
    }
    // Delegate to actual instance
    // Type assertion needed for Proxy property access - TypeScript doesn't fully support dynamic property access in Proxies
    const value = instance[prop as keyof EventConsumer];
    // Bind methods to the instance to preserve 'this' context
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(instance);
    }
    return value;
  },
});
