/**
 * Event Bus Monitor Dashboard Configuration
 *
 * Real-time Kafka event stream visualization dashboard.
 * Monitors agent and ONEX event topics via WebSocket connection to server.
 *
 * Topic constants imported from @shared/topics (single source of truth).
 */

import type { DashboardConfig } from '@/lib/dashboard-schema';
import { DashboardTheme } from '@/lib/dashboard-schema';
import {
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  SUFFIX_NODE_INTROSPECTION,
  SUFFIX_NODE_REGISTRATION,
  SUFFIX_NODE_HEARTBEAT,
  SUFFIX_REQUEST_INTROSPECTION,
  SUFFIX_CONTRACT_REGISTERED,
  SUFFIX_CONTRACT_DEREGISTERED,
  SUFFIX_NODE_REGISTRATION_INITIATED,
  SUFFIX_NODE_REGISTRATION_ACCEPTED,
  SUFFIX_NODE_REGISTRATION_REJECTED,
  SUFFIX_NODE_REGISTRATION_ACKED,
  SUFFIX_NODE_REGISTRATION_RESULT,
  SUFFIX_NODE_REGISTRATION_ACK_RECEIVED,
  SUFFIX_NODE_REGISTRATION_ACK_TIMED_OUT,
  SUFFIX_REGISTRY_REQUEST_INTROSPECTION,
  SUFFIX_FSM_STATE_TRANSITIONS,
  SUFFIX_RUNTIME_TICK,
  SUFFIX_REGISTRATION_SNAPSHOTS,
  SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
  SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
  SUFFIX_OMNICLAUDE_SESSION_STARTED,
  SUFFIX_OMNICLAUDE_SESSION_ENDED,
  SUFFIX_INTELLIGENCE_PATTERN_SCORED,
  SUFFIX_INTELLIGENCE_PATTERN_DISCOVERED,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNED,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_CMD,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_COMPLETED,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED,
  // Pattern lifecycle topics
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED,
  SUFFIX_INTELLIGENCE_PATTERN_PROMOTED,
  SUFFIX_INTELLIGENCE_PATTERN_STORED,
  SUFFIX_PATTERN_DISCOVERED,
  // Session/Agent topics
  SUFFIX_INTELLIGENCE_SESSION_OUTCOME_CMD,
  SUFFIX_AGENT_STATUS,
  // OmniClaude extended topics
  SUFFIX_OMNICLAUDE_ROUTING_DECISION,
  SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
  SUFFIX_OMNICLAUDE_MANIFEST_INJECTED,
  SUFFIX_OMNICLAUDE_PHASE_METRICS,
  SUFFIX_OMNICLAUDE_NOTIFICATION_BLOCKED,
  SUFFIX_OMNICLAUDE_NOTIFICATION_COMPLETED,
  SUFFIX_OMNICLAUDE_TRANSFORMATION_COMPLETED,
  ENVIRONMENT_PREFIXES,
  extractSuffix,
} from '@shared/topics';

/**
 * Event message schema from omnibase_infra Kafka events
 */
export interface EventMessage {
  topic: string;
  key: string | null;
  value: string; // JSON serialized
  headers: EventHeaders;
  offset: string;
  partition: number;
}

export interface EventHeaders {
  content_type: string;
  correlation_id: string;
  message_id: string;
  timestamp: string;
  source: string;
  event_type: string;
  schema_version: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  retry_count: number;
}

// ============================================================================
// Topic Constants
// ============================================================================

/**
 * Agent topics - core agent functionality events (canonical ONEX names)
 */
export const AGENT_TOPICS = [
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
] as const;

/**
 * Node registry topics - canonical ONEX suffixes for node lifecycle and health
 */
export const NODE_TOPICS = [
  SUFFIX_NODE_INTROSPECTION,
  SUFFIX_NODE_REGISTRATION,
  SUFFIX_NODE_HEARTBEAT,
  SUFFIX_REQUEST_INTROSPECTION,
  SUFFIX_REGISTRY_REQUEST_INTROSPECTION,
  SUFFIX_CONTRACT_REGISTERED,
  SUFFIX_CONTRACT_DEREGISTERED,
  SUFFIX_NODE_REGISTRATION_INITIATED,
  SUFFIX_NODE_REGISTRATION_ACCEPTED,
  SUFFIX_NODE_REGISTRATION_REJECTED,
  SUFFIX_NODE_REGISTRATION_ACKED,
  SUFFIX_NODE_REGISTRATION_RESULT,
  SUFFIX_NODE_REGISTRATION_ACK_RECEIVED,
  SUFFIX_NODE_REGISTRATION_ACK_TIMED_OUT,
  SUFFIX_REGISTRATION_SNAPSHOTS,
  SUFFIX_FSM_STATE_TRANSITIONS,
  SUFFIX_RUNTIME_TICK,
] as const;

/**
 * Intelligence pipeline topics - commands and completion events from OmniIntelligence
 */
export const INTELLIGENCE_TOPICS = [
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_CMD,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_COMPLETED,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED,
] as const;

/**
 * Pattern lifecycle topics - pattern discovery, promotion, and state transitions
 */
export const PATTERN_LIFECYCLE_TOPICS = [
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED,
  SUFFIX_INTELLIGENCE_PATTERN_PROMOTED,
  SUFFIX_INTELLIGENCE_PATTERN_STORED,
  SUFFIX_PATTERN_DISCOVERED,
] as const;

/**
 * Session/Agent topics - session outcomes and agent status
 */
export const SESSION_AGENT_TOPICS = [
  SUFFIX_INTELLIGENCE_SESSION_OUTCOME_CMD,
  SUFFIX_AGENT_STATUS,
] as const;

/**
 * OmniClaude extended topics - routing, sessions, manifests, notifications
 */
export const OMNICLAUDE_EXTENDED_TOPICS = [
  SUFFIX_OMNICLAUDE_ROUTING_DECISION,
  SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
  SUFFIX_OMNICLAUDE_MANIFEST_INJECTED,
  SUFFIX_OMNICLAUDE_PHASE_METRICS,
  SUFFIX_OMNICLAUDE_NOTIFICATION_BLOCKED,
  SUFFIX_OMNICLAUDE_NOTIFICATION_COMPLETED,
  SUFFIX_OMNICLAUDE_TRANSFORMATION_COMPLETED,
] as const;

/**
 * All monitored topics combined
 */
export const MONITORED_TOPICS = [
  ...AGENT_TOPICS,
  ...NODE_TOPICS,
  ...INTELLIGENCE_TOPICS,
  ...PATTERN_LIFECYCLE_TOPICS,
  ...SESSION_AGENT_TOPICS,
  ...OMNICLAUDE_EXTENDED_TOPICS,
] as const;

export type AgentTopic = (typeof AGENT_TOPICS)[number];
export type NodeTopic = (typeof NODE_TOPICS)[number];
export type IntelligenceTopic = (typeof INTELLIGENCE_TOPICS)[number];
export type PatternLifecycleTopic = (typeof PATTERN_LIFECYCLE_TOPICS)[number];
export type SessionAgentTopic = (typeof SESSION_AGENT_TOPICS)[number];
export type OmniclaudeExtendedTopic = (typeof OMNICLAUDE_EXTENDED_TOPICS)[number];
export type MonitoredTopic = (typeof MONITORED_TOPICS)[number];

// ============================================================================
// Topic Metadata (contract-driven, also available in dashboard config)
// ============================================================================

/**
 * Topic metadata for display labels and categorization
 */
export const TOPIC_METADATA: Record<
  string,
  { label: string; description: string; category: string }
> = {
  // Agent topics (canonical ONEX names)
  [TOPIC_OMNICLAUDE_ROUTING_DECISIONS]: {
    label: 'Routing Decisions',
    description: 'Agent selection and routing decisions with confidence scores',
    category: 'routing',
  },
  [TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION]: {
    label: 'Transformations',
    description: 'Polymorphic agent transformation events',
    category: 'transformation',
  },
  [TOPIC_OMNICLAUDE_PERFORMANCE_METRICS]: {
    label: 'Performance',
    description: 'Routing performance metrics and cache statistics',
    category: 'performance',
  },
  [TOPIC_OMNICLAUDE_AGENT_ACTIONS]: {
    label: 'Agent Actions',
    description: 'Tool calls, decisions, errors, and successes',
    category: 'actions',
  },
  actionUpdate: {
    label: 'Action Updates',
    description: 'Real-time tool call and action events from active Claude sessions',
    category: 'actions',
  },
  // Node registry topics (canonical ONEX suffixes)
  [SUFFIX_NODE_INTROSPECTION]: {
    label: 'Node Introspection',
    description: 'Node introspection events for debugging and monitoring',
    category: 'introspection',
  },
  [SUFFIX_NODE_REGISTRATION]: {
    label: 'Node Registration',
    description: 'Node registration lifecycle events',
    category: 'lifecycle',
  },
  [SUFFIX_NODE_HEARTBEAT]: {
    label: 'Heartbeat',
    description: 'Node health heartbeat signals',
    category: 'health',
  },
  [SUFFIX_REQUEST_INTROSPECTION]: {
    label: 'Introspect Cmd',
    description: 'Command telling nodes to introspect themselves',
    category: 'introspection',
  },
  [SUFFIX_CONTRACT_REGISTERED]: {
    label: 'Contract Registered',
    description: 'Contract registration events',
    category: 'lifecycle',
  },
  [SUFFIX_CONTRACT_DEREGISTERED]: {
    label: 'Contract Deregistered',
    description: 'Contract deregistration events',
    category: 'lifecycle',
  },
  [SUFFIX_NODE_REGISTRATION_INITIATED]: {
    label: 'Registration Initiated',
    description: 'Node registration initiation events',
    category: 'lifecycle',
  },
  [SUFFIX_NODE_REGISTRATION_ACCEPTED]: {
    label: 'Registration Accepted',
    description: 'Node registration acceptance events',
    category: 'lifecycle',
  },
  [SUFFIX_NODE_REGISTRATION_REJECTED]: {
    label: 'Registration Rejected',
    description: 'Node registration rejection events',
    category: 'lifecycle',
  },
  [SUFFIX_NODE_REGISTRATION_ACKED]: {
    label: 'Registration ACKed',
    description: 'Node acknowledges registration',
    category: 'lifecycle',
  },
  [SUFFIX_NODE_REGISTRATION_RESULT]: {
    label: 'Registration Result',
    description: 'Final registration result',
    category: 'lifecycle',
  },
  [SUFFIX_NODE_REGISTRATION_ACK_RECEIVED]: {
    label: 'ACK Received',
    description: 'Registration ACK received from node',
    category: 'lifecycle',
  },
  [SUFFIX_NODE_REGISTRATION_ACK_TIMED_OUT]: {
    label: 'ACK Timed Out',
    description: 'Registration ACK not received in time',
    category: 'lifecycle',
  },
  [SUFFIX_REGISTRY_REQUEST_INTROSPECTION]: {
    label: 'Registry Re-Introspect',
    description: 'Registry announces it wants nodes to re-introspect',
    category: 'introspection',
  },
  [SUFFIX_FSM_STATE_TRANSITIONS]: {
    label: 'FSM Transitions',
    description: 'FSM state transition audit trail',
    category: 'lifecycle',
  },
  [SUFFIX_RUNTIME_TICK]: {
    label: 'Runtime Tick',
    description: 'Periodic tick for timeout checks',
    category: 'health',
  },
  [SUFFIX_REGISTRATION_SNAPSHOTS]: {
    label: 'Registration Snapshots',
    description: 'Point-in-time registration state snapshots',
    category: 'snapshot',
  },
  // Intelligence pipeline topics
  [SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD]: {
    label: 'Code Analysis Cmd',
    description: 'Request code analysis from OmniIntelligence',
    category: 'intelligence',
  },
  [SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_CMD]: {
    label: 'Doc Ingestion Cmd',
    description: 'Request document ingestion from OmniIntelligence',
    category: 'intelligence',
  },
  [SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD]: {
    label: 'Pattern Learning Cmd',
    description: 'Request pattern learning from OmniIntelligence',
    category: 'intelligence',
  },
  [SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_CMD]: {
    label: 'Quality Assessment Cmd',
    description: 'Request quality assessment from OmniIntelligence',
    category: 'intelligence',
  },
  [SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED]: {
    label: 'Code Analysis Done',
    description: 'Code analysis completed successfully',
    category: 'intelligence',
  },
  [SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED]: {
    label: 'Code Analysis Failed',
    description: 'Code analysis failed',
    category: 'intelligence',
  },
  [SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_COMPLETED]: {
    label: 'Doc Ingestion Done',
    description: 'Document ingestion completed successfully',
    category: 'intelligence',
  },
  [SUFFIX_INTELLIGENCE_PATTERN_LEARNING_COMPLETED]: {
    label: 'Pattern Learning Done',
    description: 'Pattern learning completed successfully',
    category: 'intelligence',
  },
  [SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED]: {
    label: 'Quality Assessment Done',
    description: 'Quality assessment completed successfully',
    category: 'intelligence',
  },
  // Pattern lifecycle topics
  [SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITION_CMD]: {
    label: 'Lifecycle Transition Cmd',
    description: 'Request pattern lifecycle state transition',
    category: 'intelligence',
  },
  [SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED]: {
    label: 'Lifecycle Transitioned',
    description: 'Pattern lifecycle state transition completed',
    category: 'intelligence',
  },
  [SUFFIX_INTELLIGENCE_PATTERN_PROMOTED]: {
    label: 'Pattern Promoted',
    description: 'Pattern promoted to higher confidence tier',
    category: 'intelligence',
  },
  [SUFFIX_INTELLIGENCE_PATTERN_STORED]: {
    label: 'Pattern Stored',
    description: 'Pattern stored in knowledge base',
    category: 'intelligence',
  },
  [SUFFIX_PATTERN_DISCOVERED]: {
    label: 'Pattern Discovered',
    description: 'New code pattern discovered',
    category: 'intelligence',
  },
  // Session/Agent topics
  [SUFFIX_INTELLIGENCE_SESSION_OUTCOME_CMD]: {
    label: 'Session Outcome Cmd',
    description: 'Report session outcome to OmniIntelligence',
    category: 'session',
  },
  [SUFFIX_AGENT_STATUS]: {
    label: 'Agent Status',
    description: 'Agent health and status updates',
    category: 'agent',
  },
  // OmniClaude extended topics
  // Note: SUFFIX_OMNICLAUDE_ROUTING_DECISION is the same topic as
  // TOPIC_OMNICLAUDE_ROUTING_DECISIONS (already defined above).
  [SUFFIX_OMNICLAUDE_SESSION_OUTCOME]: {
    label: 'Session Outcome',
    description: 'OmniClaude session outcome summary',
    category: 'omniclaude',
  },
  [SUFFIX_OMNICLAUDE_MANIFEST_INJECTED]: {
    label: 'Manifest Injected',
    description: 'Agent manifest injected into session',
    category: 'omniclaude',
  },
  [SUFFIX_OMNICLAUDE_PHASE_METRICS]: {
    label: 'Phase Metrics',
    description: 'OmniClaude execution phase timing metrics',
    category: 'omniclaude',
  },
  [SUFFIX_OMNICLAUDE_NOTIFICATION_BLOCKED]: {
    label: 'Notification Blocked',
    description: 'Notification delivery blocked by policy',
    category: 'omniclaude',
  },
  [SUFFIX_OMNICLAUDE_NOTIFICATION_COMPLETED]: {
    label: 'Notification Completed',
    description: 'Notification delivered successfully',
    category: 'omniclaude',
  },
  [SUFFIX_OMNICLAUDE_TRANSFORMATION_COMPLETED]: {
    label: 'Transformation Done',
    description: 'Polymorphic agent transformation completed',
    category: 'omniclaude',
  },
  // Error topics
  errors: {
    label: 'Errors',
    description: 'System errors and failures',
    category: 'error',
  },
};

// ============================================================================
// Widget ID and Column Key Constants
// ============================================================================

/**
 * Widget ID for the recent-events table in eventBusDashboardConfig.
 * Declared before the config object so the config can reference this constant
 * directly — keeping string literals and their named constants in sync.
 */
export const RECENT_EVENTS_WIDGET_ID = 'table-recent-events';

/**
 * Column key for the topic cell in the recent-events table.
 * This is the data key used in the columns array and matched by
 * customCellRenderers in EventBusMonitor.tsx.
 *
 * Set to 'topicRaw' so that the table reads row.topicRaw (the raw topic
 * suffix) as the cell value. The customCellRenderer intercepts this column
 * and calls getTopicLabel() to display the friendly label — the raw value
 * never appears as plain text in the UI.
 *
 * Declared before the config object so the config can reference this constant
 * directly — keeping string literals and their named constants in sync.
 */
export const TOPIC_COLUMN_KEY = 'topicRaw';

/**
 * Dashboard configuration for Event Bus Monitor
 *
 * Contract-driven configuration including:
 * - runtime_config: Tunable parameters for event monitoring behavior
 * - topic_metadata: Display metadata for all monitored topics
 * - monitored_topics: List of Kafka topics to monitor
 */
export const eventBusDashboardConfig: DashboardConfig = {
  dashboard_id: 'event-bus-monitor',
  name: 'Event Bus Monitor',
  description: 'Real-time Kafka event stream visualization for ONEX platform',
  theme: DashboardTheme.SYSTEM,
  layout: {
    columns: 12,
    row_height: 100,
    gap: 16,
  },
  data_source: 'websocket:event-bus',
  refresh_interval_seconds: 5,

  // Runtime configuration for event monitoring behavior
  runtime_config: {
    event_monitoring: {
      // Memory impact: ~2KB per event with parsedDetails. At 2000 events ≈ 4MB.
      // Options above 2000 should be used sparingly on memory-constrained clients.
      max_events: 2000,
      max_events_options: [200, 500, 1000, 2000, 5000],
      throughput_cleanup_interval: 100,
      time_series_window_ms: 5 * 60 * 1000, // 5 minutes
      throughput_window_ms: 60 * 1000, // 1 minute
      max_breakdown_items: 50,
      periodic_cleanup_interval_ms: 10 * 1000, // 10 seconds - for responsive UX

      // Burst detection (OMN-2158)
      monitoring_window_ms: 5 * 60 * 1000, // 5 min — unified baseline for all windowed metrics
      staleness_threshold_ms: 10 * 60 * 1000, // 10 min — independent from monitoring window
      burst_window_ms: 30 * 1000, // 30s short window
      burst_throughput_multiplier: 3, // 3x baseline
      burst_throughput_min_rate: 5, // min 5 events/sec absolute
      burst_error_multiplier: 2, // 2x baseline
      burst_error_absolute_threshold: 0.05, // 5%
      burst_error_min_events: 10, // min 10 events for error rate
      burst_cooldown_ms: 15 * 1000, // 15s cooldown
    },
  },

  // Topic metadata — references the TOPIC_METADATA constant to avoid duplication.
  topic_metadata: TOPIC_METADATA,

  // List of all monitored Kafka topics
  monitored_topics: [
    ...AGENT_TOPICS,
    ...NODE_TOPICS,
    ...INTELLIGENCE_TOPICS,
    ...PATTERN_LIFECYCLE_TOPICS,
    ...SESSION_AGENT_TOPICS,
    ...OMNICLAUDE_EXTENDED_TOPICS,
  ],

  widgets: [
    // Row 1: Metric Cards (3 widgets)
    {
      widget_id: 'metric-topics-loaded',
      title: 'Topics Active',
      description: 'Topics that emitted events in the monitoring window',
      row: 0,
      col: 0,
      width: 4,
      height: 1,
      config: {
        config_kind: 'metric_card',
        metric_key: 'activeTopics',
        label: 'Topics Active',
        value_format: 'number',
        precision: 0,
        icon: 'database',
      },
    },
    {
      widget_id: 'metric-throughput',
      title: 'Events/sec',
      description: 'Average rate over the last 60 seconds',
      row: 0,
      col: 4,
      width: 4,
      height: 1,
      config: {
        config_kind: 'metric_card',
        metric_key: 'eventsPerSecond',
        label: 'Events/sec',
        value_format: 'number',
        precision: 1,
        icon: 'zap',
      },
    },
    {
      widget_id: 'metric-error-rate',
      title: 'Error Rate',
      description: 'Error rate within the monitoring window',
      row: 0,
      col: 8,
      width: 4,
      height: 1,
      config: {
        config_kind: 'metric_card',
        metric_key: 'errorRate',
        label: 'Error Rate',
        value_format: 'percent',
        precision: 2,
        icon: 'alert-triangle',
        thresholds: [
          { value: 5, severity: 'warning', label: 'Elevated errors' },
          { value: 10, severity: 'error', label: 'High error rate' },
          { value: 25, severity: 'critical', label: 'Critical error rate' },
        ],
      },
    },

    // Row 1-2: Charts
    {
      widget_id: 'chart-volume-timeline',
      title: 'Event Volume Over Time',
      row: 1,
      col: 0,
      width: 8,
      height: 2,
      config: {
        config_kind: 'chart',
        chart_type: 'area',
        data_key: 'timeSeriesData',
        series: [{ name: 'Events', data_key: 'events' }],
        stacked: false,
        show_legend: false,
        x_axis: { label: 'Time', show_grid: true },
        y_axis: { label: 'Count', min_value: 0 },
      },
    },
    {
      widget_id: 'chart-event-type-breakdown',
      title: 'Events by Type',
      row: 1,
      col: 8,
      width: 4,
      height: 2,
      config: {
        config_kind: 'chart',
        chart_type: 'bar',
        alternate_chart_type: 'donut',
        data_key: 'eventTypeBreakdownData',
        series: [{ name: 'Events', data_key: 'eventCount' }],
        show_legend: true,
        max_items: 7,
      },
    },

    // Row 3-5: Event Table (full width)
    {
      widget_id: RECENT_EVENTS_WIDGET_ID,
      title: 'Recent Events',
      description: 'Latest events from all topics',
      row: 3,
      col: 0,
      width: 12,
      height: 3,
      config: {
        config_kind: 'table',
        rows_key: 'recentEvents',
        page_size: 10,
        show_pagination: true,
        default_sort_key: 'timestamp',
        default_sort_direction: 'desc',
        striped: true,
        hover_highlight: true,
        columns: [
          { key: TOPIC_COLUMN_KEY, header: 'Topic', width: 150, sortable: true, sort_key: 'topic' },
          { key: 'eventType', header: 'Event Type', width: 130, sortable: true },
          { key: 'summary', header: 'Summary', width: 250, sortable: false },
          { key: 'source', header: 'Source', width: 120, sortable: true },
          {
            key: 'timestamp',
            header: 'Time',
            width: 180,
            sortable: true,
            sort_key: 'timestampSort',
          },
        ],
      },
    },
  ],
};

// ============================================================================
// Event Type Metadata
// ============================================================================

/**
 * Event type metadata for display labels.
 * Maps raw event type strings to human-readable short labels.
 */
export const EVENT_TYPE_METADATA: Record<string, { label: string; description?: string }> = {
  // Agent event types (canonical ONEX names)
  [TOPIC_OMNICLAUDE_ROUTING_DECISIONS]: { label: 'Routing Decision' },
  [TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION]: { label: 'Transformation' },
  routing: { label: 'Routing' },
  transformation: { label: 'Transformation' },
  performance: { label: 'Performance' },
  action: { label: 'Action' },
  error: { label: 'Error' },

  // Common raw event types (with underscores)
  tool_call: { label: 'Tool Call' },
  user: { label: 'User Action' },
  decision: { label: 'Decision' },
  success: { label: 'Success' },

  // Environment-only values that slip through (map to Unknown)
  dev: { label: 'Unknown Type' },
  staging: { label: 'Unknown Type' },
  prod: { label: 'Unknown Type' },
  production: { label: 'Unknown Type' },
  test: { label: 'Unknown Type' },

  // ONEX event types (canonical suffixes)
  [SUFFIX_OMNICLAUDE_TOOL_EXECUTED]: { label: 'Tool Executed' },
  [SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED]: { label: 'Prompt Submitted' },
  [SUFFIX_OMNICLAUDE_SESSION_STARTED]: { label: 'Session Started' },
  [SUFFIX_OMNICLAUDE_SESSION_ENDED]: { label: 'Session Ended' },
  [SUFFIX_INTELLIGENCE_PATTERN_SCORED]: { label: 'Pattern Scored' },
  [SUFFIX_INTELLIGENCE_PATTERN_DISCOVERED]: { label: 'Pattern Discovered' },
  [SUFFIX_INTELLIGENCE_PATTERN_LEARNED]: { label: 'Pattern Learned' },

  // Node lifecycle event types
  introspection: { label: 'Introspection' },
  heartbeat: { label: 'Heartbeat' },
  state_change: { label: 'State Change' },
  registry_update: { label: 'Registry Update' },

  // Canonical event-name segments (extracted from actionName by server)
  'tool-content': { label: 'Tool Content' },
  'claude-hook-event': { label: 'Claude Hook' },
  'intent-classified': { label: 'Intent Classified' },
  'intent-stored': { label: 'Intent Stored' },
  'intent-query-response': { label: 'Intent Query' },
  'session-outcome': { label: 'Session Outcome' },
  'prompt-submitted': { label: 'Prompt Submitted' },
  'session-started': { label: 'Session Started' },
  'session-ended': { label: 'Session Ended' },
  'tool-executed': { label: 'Tool Executed' },
};

/** Structural segments to skip (not meaningful for display) */
const STRUCTURAL_SEGMENTS = ['evt', 'event', 'events', 'onex', 'omnidash_analytics'];

/**
 * Convert a kebab-case or snake_case string to Title Case.
 * @example "tool-executed" → "Tool Executed"
 * @example "pattern_scored" → "Pattern Scored"
 */
function toTitleCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Extract a short label from an ONEX-style event type string.
 *
 * Patterns supported:
 * - {env}.[namespace].evt.[source].[action].v[N] → "Action"
 * - {env}.[namespace].onex.evt.[action].v[N] → "Action"
 * - Simple strings like "tool_call" → "Tool Call"
 *
 * Skips environment prefixes (dev, staging, prod) and structural segments (evt, onex).
 */
const _envPrefixPattern = ENVIRONMENT_PREFIXES.join('|');
const _onexRegex = new RegExp(`^(?:${_envPrefixPattern})\\.[^.]+\\.evt\\.[^.]+\\.([^.]+)\\.v\\d+$`);
const _onexAltRegex = new RegExp(
  `^(?:${_envPrefixPattern})\\.[^.]+\\.onex\\.evt\\.([^.]+)\\.v\\d+$`
);

function extractEventTypeLabel(eventType: string): string {
  // Pattern: {env}.*.evt.*.[action].v[N]
  const match = eventType.match(_onexRegex);

  if (match) {
    return toTitleCase(match[1]);
  }

  // Alternative pattern: {env}.*.onex.evt.[action].v[N]
  const altMatch = eventType.match(_onexAltRegex);
  if (altMatch) {
    return toTitleCase(altMatch[1]);
  }

  // Split and filter out non-meaningful segments
  const segments = eventType.split('.');
  const meaningfulSegments = segments.filter((seg) => {
    const lower = seg.toLowerCase();
    // Skip environment prefixes
    if ((ENVIRONMENT_PREFIXES as readonly string[]).includes(lower)) return false;
    // Skip structural segments
    if (STRUCTURAL_SEGMENTS.includes(lower)) return false;
    // Skip version suffixes (v1, v2, etc.)
    if (/^v\d+$/.test(lower)) return false;
    // Skip empty segments
    if (!seg.trim()) return false;
    return true;
  });

  // Take the last meaningful segment (usually the action)
  if (meaningfulSegments.length > 0) {
    const lastSegment = meaningfulSegments[meaningfulSegments.length - 1];
    return toTitleCase(lastSegment);
  }

  // Ultimate fallback: return as-is but truncated
  return eventType.length > 25 ? eventType.slice(0, 22) + '...' : eventType;
}

/** Max label length for chart axis readability */
const MAX_LABEL_LENGTH = 14;

/**
 * Get the label for an event type, with fallback to extracted label.
 * Handles internal grouping prefixes like "route:agentName".
 */
export function getEventTypeLabel(eventType: string): string {
  // Direct lookup first
  const direct = EVENT_TYPE_METADATA[eventType]?.label;
  if (direct) return direct;

  // Handle internal grouping prefixes: "route:agentName"
  const colonIdx = eventType.indexOf(':');
  if (colonIdx !== -1) {
    const value = eventType.slice(colonIdx + 1).trim();
    const label = value.charAt(0).toUpperCase() + value.slice(1);
    return label.length > MAX_LABEL_LENGTH
      ? label.slice(0, MAX_LABEL_LENGTH - 1) + '\u2026'
      : label;
  }

  return extractEventTypeLabel(eventType);
}

// ============================================================================
// Centralized Display Label (OMN-2196)
// ============================================================================

/**
 * Compute a short, human-readable display label for an event row.
 *
 * Priority chain (OMN-2196):
 *   1. Hoisted toolName (e.g. "Read", "Write", "Bash") — most specific
 *   2. actionName from parsed details
 *   3. selectedAgent prefixed with "route:" for routing events
 *   4. ONEX topic event-name segment extraction (e.g. "tool-content" from canonical topic)
 *   5. EVENT_TYPE_METADATA lookup
 *   6. Raw eventType fallback
 *
 * This centralizes the display logic that was previously scattered across
 * computeNormalizedType in EventBusMonitor.tsx and various fallback paths.
 */
export function getEventDisplayLabel(opts: {
  eventType: string;
  toolName?: string;
  actionName?: string;
  selectedAgent?: string;
  topic?: string;
}): string {
  const { eventType, toolName, actionName, selectedAgent, topic } = opts;

  // 1. Specific tool name (e.g. "Read", "Write", "Bash")
  if (toolName) return toolName;

  // 2. Action name from parsed details
  if (actionName) return actionName;

  // 3. Routing events show the selected agent
  if (selectedAgent) return `route:${selectedAgent}`;

  // 4. ONEX canonical topic: extract event-name segment
  const canonicalTopic = topic ? extractSuffix(topic) : '';
  if (canonicalTopic) {
    const segments = canonicalTopic.split('.');
    // onex.<kind>.<producer>.<event-name>.v<N> => event-name
    // Guard: trailing dots produce empty segments — toTitleCase('') yields '',
    // so only return when the result is non-empty.
    // Only the canonical 5-segment ONEX format is supported:
    //   onex.<kind>.<producer>.<event-name>.v<N>
    // Topics with extra trailing segments would extract the wrong segment;
    // this is consistent with getTopicLabel's assumption elsewhere.
    if (segments.length >= 5 && segments[0] === 'onex') {
      const label = toTitleCase(segments[segments.length - 2]);
      if (label) return label;
    }
  }

  // 5. Try the eventType through getEventTypeLabel (handles metadata + extraction)
  return getEventTypeLabel(eventType);
}

/**
 * Compute a short display label for the Event Type column.
 *
 * OMN-2196: Delegates to the centralized getEventDisplayLabel() which uses
 * the hoisted toolName from the server-side AgentAction. Falls back through
 * actionName, selectedAgent, ONEX topic segment extraction, and metadata lookup.
 *
 * Extracted from EventBusMonitor.tsx for testability.
 */
export function computeNormalizedType(
  eventType: string,
  details: {
    toolName?: string;
    actionName?: string;
    actionType?: string;
    selectedAgent?: string;
  } | null,
  topic?: string
): string {
  // Guard against bare version strings (e.g. "v1") that slip through
  if (/^v\d+$/.test(eventType)) {
    const fromDetails = details?.toolName || details?.actionName || details?.actionType;
    if (fromDetails) return fromDetails;

    // Derive a label from the topic when details are empty (OMN-2196)
    if (topic) {
      const topicLabel = getEventDisplayLabel({
        eventType,
        topic,
      });
      // getEventDisplayLabel falls back to the raw eventType ("v1") when
      // no better label is found — treat that as no improvement.
      if (topicLabel && topicLabel !== eventType) return topicLabel;
    }

    return 'unknown';
  }

  return getEventDisplayLabel({
    eventType,
    toolName: details?.toolName,
    actionName: details?.actionName,
    selectedAgent: details?.selectedAgent,
    topic,
  });
}

// ============================================================================
// Topic Matching Utilities
// ============================================================================

/**
 * Topic matching contract:
 * - Monitored topics are suffix-only (e.g. "onex.evt.platform.node-heartbeat.v1")
 * - Kafka delivers env-prefixed names (e.g. "dev.onex.evt.platform.node-heartbeat.v1")
 * - Environment prefix is dot-delimited (single segment before first relevant dot)
 * - Matching is literal string comparison — no wildcards or regex patterns
 * - Legacy flat topics (e.g. "agent-routing-decisions") have no prefix and match exactly
 */

/**
 * Check whether an event's raw topic matches a monitored suffix.
 *
 * Handles both exact match (legacy flat topics, or suffix appearing without prefix)
 * and env-prefixed match (e.g. "dev.onex.evt..." matching suffix "onex.evt...").
 *
 * Uses `endsWith("." + suffix)` to avoid false positives from partial matches
 * (e.g. suffix "v1" will NOT match "some-topic.v12").
 */
export function topicMatchesSuffix(eventTopicRaw: string, monitoredSuffix: string): boolean {
  return eventTopicRaw === monitoredSuffix || eventTopicRaw.endsWith('.' + monitoredSuffix);
}

/**
 * Normalize a potentially env-prefixed topic name to its monitored suffix form.
 *
 * Used at write boundaries (e.g. when setting filter state from EventDetailPanel)
 * so that stored filter values are always suffix-only and can be compared directly
 * with TopicSelector row keys.
 *
 * Fallback chain:
 *   1. Direct lookup in known topics list — return as-is
 *   2. Suffix match against known topics — return the matching suffix
 *   3. extractSuffix() — strip env prefix for dynamically observed topics
 *      not in the known list (e.g. 'dev.onex.cmd.omniintelligence.tool-content.v1'
 *      → 'onex.cmd.omniintelligence.tool-content.v1')
 */
export function normalizeToSuffix(
  topic: string,
  topics: readonly string[] = MONITORED_TOPICS
): string {
  // Already a monitored suffix — return as-is
  if ((topics as readonly string[]).includes(topic)) return topic;

  // Try stripping env prefix: "dev.onex.evt...." → "onex.evt...."
  for (const suffix of topics) {
    if (topicMatchesSuffix(topic, suffix)) return suffix;
  }

  // Fallback: strip env prefix even for topics not in the known list (OMN-2193).
  // This handles dynamically observed topics like
  // 'dev.onex.cmd.omniintelligence.tool-content.v1' that aren't in MONITORED_TOPICS.
  return extractSuffix(topic);
}

// ============================================================================
// Config Accessor Functions
// ============================================================================

/**
 * Get event monitoring runtime configuration with defaults.
 * Use this instead of directly accessing config.runtime_config.event_monitoring
 * to ensure all fields have values.
 */
export function getEventMonitoringConfig() {
  const config = eventBusDashboardConfig.runtime_config?.event_monitoring;
  return {
    max_events: config?.max_events ?? 50,
    max_events_options: config?.max_events_options ?? [50, 100, 200, 500, 1000],
    throughput_cleanup_interval: config?.throughput_cleanup_interval ?? 100,
    time_series_window_ms: config?.time_series_window_ms ?? 5 * 60 * 1000,
    throughput_window_ms: config?.throughput_window_ms ?? 60 * 1000,
    max_breakdown_items: config?.max_breakdown_items ?? 50,
    periodic_cleanup_interval_ms: config?.periodic_cleanup_interval_ms ?? 10 * 1000,
    // Burst detection (OMN-2158)
    monitoring_window_ms: config?.monitoring_window_ms ?? 5 * 60 * 1000,
    staleness_threshold_ms: config?.staleness_threshold_ms ?? 10 * 60 * 1000,
    burst_window_ms: config?.burst_window_ms ?? 30 * 1000,
    burst_throughput_multiplier: config?.burst_throughput_multiplier ?? 3,
    burst_throughput_min_rate: config?.burst_throughput_min_rate ?? 5,
    burst_error_multiplier: config?.burst_error_multiplier ?? 2,
    burst_error_absolute_threshold: config?.burst_error_absolute_threshold ?? 0.05,
    burst_error_min_events: config?.burst_error_min_events ?? 10,
    burst_cooldown_ms: config?.burst_cooldown_ms ?? 15 * 1000,
  };
}

/**
 * Get topic metadata from the dashboard config or the TOPIC_METADATA constant.
 *
 * Handles env-prefixed topic names (e.g. 'dev.onex.evt.platform.node-introspection.v1')
 * by stripping known environment prefixes via `extractSuffix()` and retrying the lookup.
 * Only strips the first segment when it matches a known prefix in ENVIRONMENT_PREFIXES
 * (e.g. 'dev', 'staging', 'prod'), so canonical names like 'onex.evt...' pass through
 * unmodified on the direct lookup.
 *
 * Fallback chain:
 *   1. Direct lookup (handles legacy flat names and exact canonical matches)
 *   2. Strip env prefix via extractSuffix(), retry lookup (handles 'dev.onex.evt...')
 *   3. Return undefined if no match
 *
 * Note: eventBusDashboardConfig.topic_metadata references TOPIC_METADATA directly
 * (no duplication). The config layer exists as an override point for future
 * user-configurable metadata; both are checked for forward compatibility.
 *
 * @param topic - Raw topic name, possibly env-prefixed
 * @returns Metadata object with label, description, and category, or undefined if not found
 */
export function getTopicMetadata(
  topic: string
): { label: string; description: string; category: string } | undefined {
  const configMeta = eventBusDashboardConfig.topic_metadata;

  // Direct lookup first (handles legacy flat names and exact suffix matches)
  const direct = configMeta?.[topic] ?? TOPIC_METADATA[topic];
  if (direct) return direct;

  // Try stripping a known env prefix (e.g. 'dev.onex.evt...' → 'onex.evt...').
  // extractSuffix() only strips when the first segment is in ENVIRONMENT_PREFIXES,
  // so topics that are already canonical or use legacy flat names are returned as-is.
  const suffix = extractSuffix(topic);
  if (suffix !== topic) {
    return configMeta?.[suffix] ?? TOPIC_METADATA[suffix];
  }

  return undefined;
}

/**
 * Get the display label for a topic, with fallback to a suffix-extracted short name.
 *
 * Fallback chain (OMN-2198):
 *   1. Direct metadata lookup (handles known topics)
 *   2. Extract the event-name segment from ONEX canonical format and title-case it
 *      (e.g. 'onex.evt.omniclaude.session-started.v1' → 'Session Started')
 *   3. Return the raw topic as-is (legacy flat names are already short)
 *
 * @param topic - Raw or canonical topic name (may include env prefix)
 * @returns Human-readable label
 */
export function getTopicLabel(topic: string): string {
  const meta = getTopicMetadata(topic);
  if (meta) return meta.label;

  // Try extracting a short name from ONEX canonical format
  const canonical = extractSuffix(topic);
  const segments = canonical.split('.');
  // Canonical: onex.<kind>.<producer>.<event-name>.v<N>
  if (segments.length >= 5 && segments[0] === 'onex') {
    const eventName = segments[segments.length - 2];
    return toTitleCase(eventName);
  }

  return topic;
}

/**
 * Get all monitored topics from the config.
 * Falls back to the MONITORED_TOPICS constant for completeness.
 */
export function getMonitoredTopics(): readonly string[] {
  return eventBusDashboardConfig.monitored_topics ?? MONITORED_TOPICS;
}

// ============================================================================
// Mock Data Generation
// ============================================================================

/**
 * Generate mock data for the Event Bus Monitor dashboard
 * Used for development and demonstration purposes
 */
export function generateEventBusMockData(): Record<string, unknown> {
  const now = new Date();

  // Generate time series data for charts
  const timeSeriesData = Array.from({ length: 30 }, (_, i) => {
    const timestamp = new Date(now.getTime() - (29 - i) * 60000);
    return {
      name: timestamp.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      timestamp: timestamp.toISOString(),
      introspectionEvents: Math.floor(Math.random() * 50) + 10,
      registrationEvents: Math.floor(Math.random() * 20) + 5,
      heartbeatEvents: Math.floor(Math.random() * 100) + 50,
      dlqEvents: Math.floor(Math.random() * 5),
    };
  });

  // Generate topic breakdown data
  const topicBreakdownData = MONITORED_TOPICS.map((topic) => ({
    name: TOPIC_METADATA[topic]?.label || topic,
    topic,
    eventCount:
      topic === SUFFIX_NODE_HEARTBEAT
        ? Math.floor(Math.random() * 500) + 200
        : topic === TOPIC_OMNICLAUDE_AGENT_ACTIONS
          ? Math.floor(Math.random() * 300) + 100
          : topic === TOPIC_OMNICLAUDE_ROUTING_DECISIONS
            ? Math.floor(Math.random() * 150) + 50
            : Math.floor(Math.random() * 100) + 30,
  }));

  // Calculate totals
  const totalEvents = topicBreakdownData.reduce((sum, t) => sum + t.eventCount, 0);
  const errorCount = Math.floor(totalEvents * 0.02); // ~2% error rate
  const errorRate = totalEvents > 0 ? (errorCount / totalEvents) * 100 : 0;

  // Generate recent events for table
  const recentEvents = Array.from({ length: 50 }, (_, i) => {
    const topicIndex = Math.floor(Math.random() * MONITORED_TOPICS.length);
    const topic = MONITORED_TOPICS[topicIndex];
    const eventTimestamp = new Date(now.getTime() - i * 5000);
    const priorities: Array<'low' | 'normal' | 'high' | 'critical'> = [
      'low',
      'normal',
      'normal',
      'normal',
      'high',
      'critical',
    ];
    const priority = priorities[Math.floor(Math.random() * priorities.length)];

    return {
      id: `evt-${i}-${Date.now()}`,
      topic: TOPIC_METADATA[topic]?.label || topic,
      topicRaw: topic,
      eventType: getEventTypeForTopic(topic),
      source: getRandomSource(),
      timestamp: eventTimestamp.toISOString(),
      priority,
      correlationId: generateCorrelationId(),
      payload: generatePayloadPreview(topic),
    };
  });

  // Generate live events for feed
  const liveEvents = recentEvents.slice(0, 20).map((event) => ({
    id: event.id,
    timestamp: event.timestamp,
    type: mapPriorityToSeverity(event.priority),
    severity: mapPriorityToSeverity(event.priority),
    message: `${event.eventType} from ${event.source}`,
    source: event.topicRaw,
  }));

  // Generate topic health status
  const topicHealth = MONITORED_TOPICS.map((topic) => {
    const eventCount = topicBreakdownData.find((t) => t.topic === topic)?.eventCount || 0;
    let status: string;

    if (topic === SUFFIX_NODE_HEARTBEAT || topic === TOPIC_OMNICLAUDE_AGENT_ACTIONS) {
      status = eventCount > 100 ? 'healthy' : eventCount > 50 ? 'warning' : 'error';
    } else if (topic === TOPIC_OMNICLAUDE_ROUTING_DECISIONS) {
      status = eventCount > 50 ? 'healthy' : eventCount > 20 ? 'warning' : 'offline';
    } else {
      status = eventCount > 10 ? 'healthy' : eventCount > 0 ? 'warning' : 'offline';
    }

    return {
      topicId: topic,
      topicName: TOPIC_METADATA[topic]?.label || topic,
      status,
      eventCount,
      lastEventTime: new Date(now.getTime() - Math.random() * 60000).toISOString(),
    };
  });

  return {
    // Metrics
    totalEvents,
    eventsPerSecond: Math.round((totalEvents / 3600) * 10) / 10,
    errorRate: Math.round(errorRate * 100) / 100,
    activeTopics: topicHealth.filter((t) => t.status !== 'offline').length,

    // Chart data
    timeSeriesData,
    topicBreakdownData,

    // Table data
    recentEvents,

    // Event feed
    liveEvents,

    // Status grid
    topicHealth,
  };
}

// Helper functions for mock data generation

function getEventTypeForTopic(topic: string): string {
  const eventTypes: Record<string, string[]> = {
    // Agent topics (canonical ONEX names)
    [TOPIC_OMNICLAUDE_ROUTING_DECISIONS]: [
      'routing.decision',
      'agent.selected',
      'confidence.evaluated',
    ],
    [TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION]: [
      'transformation.started',
      'transformation.completed',
      'agent.transformed',
    ],
    [TOPIC_OMNICLAUDE_PERFORMANCE_METRICS]: ['cache.hit', 'cache.miss', 'routing.timed'],
    [TOPIC_OMNICLAUDE_AGENT_ACTIONS]: [
      'tool.called',
      'decision.made',
      'action.completed',
      'error.occurred',
    ],
    // Node topics (canonical ONEX suffixes)
    [SUFFIX_NODE_INTROSPECTION]: [
      'node.introspected',
      'node.capabilities.discovered',
      'node.schema.extracted',
    ],
    [SUFFIX_NODE_REGISTRATION]: ['node.registered', 'node.validated', 'node.activated'],
    [SUFFIX_NODE_HEARTBEAT]: ['heartbeat.ping', 'heartbeat.pong', 'health.check'],
    [SUFFIX_REQUEST_INTROSPECTION]: [
      'introspection.requested',
      'registry.polling',
      'node.discovery',
    ],
  };

  const types = eventTypes[topic] || ['event.unknown'];
  return types[Math.floor(Math.random() * types.length)];
}

function getRandomSource(): string {
  const sources = [
    'node-registry',
    'orchestrator',
    'validator',
    'scheduler',
    'api-gateway',
    'event-processor',
    'introspection-service',
  ];
  return sources[Math.floor(Math.random() * sources.length)];
}

function generateCorrelationId(): string {
  return `corr-${Math.random().toString(36).substring(2, 10)}`;
}

function generatePayloadPreview(topic: string): string {
  const previews: Record<string, string[]> = {
    // Agent topics (canonical ONEX names)
    [TOPIC_OMNICLAUDE_ROUTING_DECISIONS]: [
      '{"selected_agent": "api-architect", "confidence": 0.95}',
      '{"routing_time_ms": 45, "strategy": "keyword"}',
    ],
    [TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION]: [
      '{"source": "polymorphic", "target": "api-architect"}',
      '{"transformation_duration_ms": 120, "success": true}',
    ],
    [TOPIC_OMNICLAUDE_PERFORMANCE_METRICS]: [
      '{"cache_hit": true, "candidates_evaluated": 5}',
      '{"routing_duration_ms": 23, "strategy": "semantic"}',
    ],
    [TOPIC_OMNICLAUDE_AGENT_ACTIONS]: [
      '{"action_type": "tool_call", "tool": "Read"}',
      '{"action_type": "decision", "agent": "debug"}',
    ],
    // Node topics (canonical ONEX suffixes)
    [SUFFIX_NODE_INTROSPECTION]: [
      '{"node_id": "node-123", "capabilities": [...]}',
      '{"schema_version": "1.0", "fields": [...]}',
    ],
    [SUFFIX_NODE_REGISTRATION]: [
      '{"node_id": "node-456", "status": "active"}',
      '{"registration_id": "reg-789"}',
    ],
    [SUFFIX_NODE_HEARTBEAT]: ['{"node_id": "node-123", "uptime": 3600}', '{"status": "healthy"}'],
    [SUFFIX_REQUEST_INTROSPECTION]: [
      '{"node_id": "node-789", "request_type": "introspection"}',
      '{"registry_id": "reg-001", "target_nodes": [...]}',
    ],
  };

  const options = previews[topic] || ['{"event": "unknown"}'];
  return options[Math.floor(Math.random() * options.length)];
}

function mapPriorityToSeverity(priority: string): 'info' | 'success' | 'warning' | 'error' {
  switch (priority) {
    case 'critical':
      return 'error';
    case 'high':
      return 'warning';
    case 'normal':
      return 'info';
    case 'low':
      return 'success';
    default:
      return 'info';
  }
}
