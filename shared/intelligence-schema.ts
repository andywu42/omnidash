import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  bigint,
  serial,
  numeric,
  boolean,
  doublePrecision,
  real,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createInsertSchema } from 'drizzle-zod';

/**
 * Agent Routing Decisions Table
 * Tracks all routing decisions made by the polymorphic agent system
 * with confidence scoring and performance metrics
 */
export const agentRoutingDecisions = pgTable(
  'agent_routing_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: uuid('correlation_id').notNull(),
    // OMN-4821: Changed from uuid to text — session IDs are application-level
    // identifiers (e.g. "session-abc123"), not UUIDs. uuid type caused INSERT
    // failures when non-UUID text values were written by the read-model-consumer.
    sessionId: text('session_id'),
    // OMN-4081: user_request, routing_strategy, routing_time_ms are nullable.
    // The omniclaude producer emits prompt_preview (not user_request) and
    // routing_policy (not routing_strategy); the read-model-consumer applies
    // safe fallbacks (OMN-3320). The DB constraint is dropped so future
    // producers that omit these fields do not cause constraint violations.
    userRequest: text('user_request'),
    userRequestHash: text('user_request_hash'),
    contextSnapshot: jsonb('context_snapshot'),
    selectedAgent: text('selected_agent').notNull(),
    confidenceScore: numeric('confidence_score', { precision: 5, scale: 4 }).notNull(),
    routingStrategy: text('routing_strategy'),
    triggerConfidence: numeric('trigger_confidence', { precision: 5, scale: 4 }),
    contextConfidence: numeric('context_confidence', { precision: 5, scale: 4 }),
    capabilityConfidence: numeric('capability_confidence', { precision: 5, scale: 4 }),
    historicalConfidence: numeric('historical_confidence', { precision: 5, scale: 4 }),
    alternatives: jsonb('alternatives'),
    reasoning: text('reasoning'),
    routingTimeMs: integer('routing_time_ms'),
    cacheHit: boolean('cache_hit').default(false),
    selectionValidated: boolean('selection_validated').default(false),
    actualSuccess: boolean('actual_success'), // @deprecated Use executionSucceeded instead
    executionSucceeded: boolean('execution_succeeded'),
    actualQualityScore: numeric('actual_quality_score', { precision: 5, scale: 4 }),
    createdAt: timestamp('created_at').defaultNow(),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_agent_routing_decisions_correlation').on(table.correlationId),
    index('idx_ard_selected_agent').on(table.selectedAgent),
    index('idx_ard_created_at').on(table.createdAt),
    index('idx_ard_correlation_id').on(table.correlationId),
  ]
);

/**
 * Agent Actions Table
 * Tracks all actions executed by agents for observability
 * and debugging purposes
 */
export const agentActions = pgTable(
  'agent_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: uuid('correlation_id').notNull(),
    agentName: text('agent_name').notNull(),
    actionType: text('action_type').notNull(),
    actionName: text('action_name').notNull(),
    actionDetails: jsonb('action_details').default({}),
    debugMode: boolean('debug_mode').default(true),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at').defaultNow(),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_agent_actions_correlation').on(table.correlationId),
    index('idx_aa_agent_name').on(table.agentName),
    index('idx_aa_created_at').on(table.createdAt),
    index('idx_aa_correlation_id').on(table.correlationId),
  ]
);

// Export Zod schemas for validation
export const insertAgentRoutingDecisionSchema = createInsertSchema(agentRoutingDecisions);
export const insertAgentActionSchema = createInsertSchema(agentActions);

/**
 * Agent Transformation Events Table
 * Tracks polymorphic agent transformations between roles
 */
export const agentTransformationEvents = pgTable(
  'agent_transformation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceAgent: text('source_agent').notNull(),
    targetAgent: text('target_agent').notNull(),
    transformationReason: text('transformation_reason'),
    confidenceScore: numeric('confidence_score', { precision: 5, scale: 4 }),
    transformationDurationMs: integer('transformation_duration_ms'),
    success: boolean('success').default(true),
    createdAt: timestamp('created_at').defaultNow(),
    projectPath: text('project_path'),
    projectName: text('project_name'),
    claudeSessionId: text('claude_session_id'),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_ate_source_target_created').on(
      table.sourceAgent,
      table.targetAgent,
      table.createdAt
    ),
    index('idx_ate_created_at').on(table.createdAt),
  ]
);

export const insertAgentTransformationEventSchema = createInsertSchema(agentTransformationEvents);

/**
 * Agent Manifest Injections Table
 * Tracks manifest generation with pattern discovery metrics
 * and intelligence query performance
 */
export const agentManifestInjections = pgTable(
  'agent_manifest_injections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: uuid('correlation_id').notNull(),
    routingDecisionId: uuid('routing_decision_id'),
    agentName: text('agent_name').notNull(),
    manifestVersion: text('manifest_version').notNull(),
    generationSource: text('generation_source').notNull(),
    isFallback: boolean('is_fallback').default(false),
    patternsCount: integer('patterns_count').default(0),
    infrastructureServices: integer('infrastructure_services').default(0),
    debugIntelligenceSuccesses: integer('debug_intelligence_successes').default(0),
    debugIntelligenceFailures: integer('debug_intelligence_failures').default(0),
    queryTimes: jsonb('query_times').notNull(),
    totalQueryTimeMs: integer('total_query_time_ms').notNull(),
    fullManifestSnapshot: jsonb('full_manifest_snapshot').notNull(),
    agentExecutionSuccess: boolean('agent_execution_success'),
    agentExecutionTimeMs: integer('agent_execution_time_ms'),
    agentQualityScore: numeric('agent_quality_score', { precision: 5, scale: 4 }),
    createdAt: timestamp('created_at').defaultNow(),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    index('idx_ami_created_at').on(table.createdAt),
    index('idx_ami_agent_name').on(table.agentName),
  ]
);

// Export Zod schemas for validation
export const insertAgentManifestInjectionSchema = createInsertSchema(agentManifestInjections);

/**
 * Pattern Lineage Nodes Table
 * Tracks code patterns discovered and their lineage
 */
export const patternLineageNodes = pgTable(
  'pattern_lineage_nodes',
  {
    id: uuid('id').primaryKey(),
    patternId: varchar('pattern_id', { length: 255 }).notNull(),
    patternName: varchar('pattern_name', { length: 255 }).notNull(),
    patternType: varchar('pattern_type', { length: 100 }).notNull(),
    patternVersion: varchar('pattern_version', { length: 50 }).notNull(),
    lineageId: uuid('lineage_id').notNull(),
    generation: integer('generation').notNull(),
    patternData: jsonb('pattern_data').notNull(),
    metadata: jsonb('metadata'),
    correlationId: uuid('correlation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }),
    language: varchar('language', { length: 50 }),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    index('idx_pln_created_at').on(table.createdAt),
    index('idx_pln_language').on(table.language),
  ]
);

/**
 * Pattern Lineage Edges Table
 * Tracks relationships between patterns
 */
export const patternLineageEdges = pgTable(
  'pattern_lineage_edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceNodeId: uuid('source_node_id').notNull(),
    targetNodeId: uuid('target_node_id').notNull(),
    edgeType: text('edge_type').notNull(),
    edgeWeight: numeric('edge_weight', { precision: 10, scale: 6 }),
    transformationType: text('transformation_type'),
    metadata: jsonb('metadata'),
    correlationId: uuid('correlation_id'),
    createdAt: timestamp('created_at').defaultNow(),
    createdBy: text('created_by'),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    index('idx_ple_source').on(table.sourceNodeId),
    index('idx_ple_target').on(table.targetNodeId),
  ]
);

// Export Zod schemas for validation
export const insertPatternLineageNodeSchema = createInsertSchema(patternLineageNodes);
export const insertPatternLineageEdgeSchema = createInsertSchema(patternLineageEdges);

/**
 * Pattern Quality Metrics Table
 * Tracks quality scores and confidence metrics for patterns
 */
export const patternQualityMetrics = pgTable('pattern_quality_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  patternId: uuid('pattern_id').notNull().unique(),
  qualityScore: doublePrecision('quality_score').notNull(),
  confidence: doublePrecision('confidence').notNull(),
  measurementTimestamp: timestamp('measurement_timestamp', { withTimezone: true })
    .notNull()
    .defaultNow(),
  version: text('version').default('1.0.0'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  projectedAt: timestamp('projected_at').defaultNow(),
});

export const insertPatternQualityMetricsSchema = createInsertSchema(patternQualityMetrics);

/**
 * Pattern Learning Artifacts Table
 * Stores complete PATLEARN output objects as JSONB for dashboard consumption.
 *
 * Design: Projection table, not normalized. UI reads directly from stored shape.
 */
export const patternLearningArtifacts = pgTable(
  'pattern_learning_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patternId: uuid('pattern_id').notNull(),
    patternName: varchar('pattern_name', { length: 255 }).notNull(),
    patternType: varchar('pattern_type', { length: 100 }).notNull(),
    language: varchar('language', { length: 50 }),

    // Lifecycle (indexed for filtering)
    lifecycleState: text('lifecycle_state').notNull().default('candidate'),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }),

    // Composite score (indexed for sorting)
    compositeScore: numeric('composite_score', { precision: 10, scale: 6 }).notNull(),

    // Evidence tier for promotion gating (migration 0014)
    evidenceTier: text('evidence_tier').notNull().default('unmeasured'),

    // JSONB fields for full evidence
    scoringEvidence: jsonb('scoring_evidence').notNull(),
    signature: jsonb('signature').notNull(),
    metrics: jsonb('metrics').default({}),
    metadata: jsonb('metadata').default({}),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    // Index for lifecycle state filtering (WHERE lifecycle_state = ?)
    index('idx_patlearn_lifecycle_state').on(table.lifecycleState),
    // Index for composite score sorting (ORDER BY composite_score DESC)
    index('idx_patlearn_composite_score').on(table.compositeScore),
    // Index for state change time filtering (promotions/deprecations)
    index('idx_patlearn_state_changed_at').on(table.stateChangedAt),
    // Index for created_at sorting
    index('idx_patlearn_created_at').on(table.createdAt),
    // Index for updated_at sorting
    index('idx_patlearn_updated_at').on(table.updatedAt),
    // Compound index for filtered sorts (WHERE lifecycle_state = ? ORDER BY composite_score)
    index('idx_patlearn_lifecycle_score').on(table.lifecycleState, table.compositeScore),
  ]
);

export const insertPatternLearningArtifactSchema = createInsertSchema(patternLearningArtifacts);

/**
 * ONEX Compliance Stamps Table
 * Tracks ONEX architectural compliance status for files
 */
export const onexComplianceStamps = pgTable('onex_compliance_stamps', {
  id: uuid('id').primaryKey().defaultRandom(),
  filePath: text('file_path').notNull(),
  complianceStatus: text('compliance_status').notNull(), // 'compliant', 'non_compliant', 'pending'
  complianceScore: numeric('compliance_score', { precision: 5, scale: 4 }),
  nodeType: text('node_type'), // 'effect', 'compute', 'reducer', 'orchestrator'
  violations: jsonb('violations').default([]),
  metadata: jsonb('metadata').default({}),
  correlationId: uuid('correlation_id'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  projectedAt: timestamp('projected_at').defaultNow(),
});

// Export Zod schemas for validation
export const insertOnexComplianceStampSchema = createInsertSchema(onexComplianceStamps);

// Export TypeScript types
export type AgentRoutingDecision = typeof agentRoutingDecisions.$inferSelect;
export type InsertAgentRoutingDecision = typeof agentRoutingDecisions.$inferInsert;
export type AgentAction = typeof agentActions.$inferSelect;
export type InsertAgentAction = typeof agentActions.$inferInsert;
export type AgentTransformationEvent = typeof agentTransformationEvents.$inferSelect;
export type InsertAgentTransformationEvent = typeof agentTransformationEvents.$inferInsert;
export type AgentManifestInjection = typeof agentManifestInjections.$inferSelect;
export type InsertAgentManifestInjection = typeof agentManifestInjections.$inferInsert;
export type PatternLineageNode = typeof patternLineageNodes.$inferSelect;
export type InsertPatternLineageNode = typeof patternLineageNodes.$inferInsert;
export type PatternLineageEdge = typeof patternLineageEdges.$inferSelect;
export type InsertPatternLineageEdge = typeof patternLineageEdges.$inferInsert;
export type PatternLearningArtifact = typeof patternLearningArtifacts.$inferSelect;
export type InsertPatternLearningArtifact = typeof patternLearningArtifacts.$inferInsert;
export type OnexComplianceStamp = typeof onexComplianceStamps.$inferSelect;
export type InsertOnexComplianceStamp = typeof onexComplianceStamps.$inferInsert;

/**
 * Document Metadata Table
 * Tracks documents in the knowledge base with access statistics
 */
export const documentMetadata = pgTable('document_metadata', {
  id: uuid('id').primaryKey().defaultRandom(),
  repository: text('repository').notNull(),
  filePath: text('file_path').notNull(),
  status: text('status').notNull().default('active'),
  contentHash: text('content_hash'),
  sizeBytes: integer('size_bytes'),
  mimeType: text('mime_type'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  deletedAt: timestamp('deleted_at'),
  accessCount: integer('access_count').notNull().default(0),
  lastAccessedAt: timestamp('last_accessed_at'),
  vectorId: text('vector_id'),
  graphId: text('graph_id'),
  metadata: jsonb('metadata').notNull().default({}),
  projectedAt: timestamp('projected_at').defaultNow(),
});

/**
 * Document Access Log Table
 * Tracks document access events for analytics
 */
export const documentAccessLog = pgTable('document_access_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull(),
  accessedAt: timestamp('accessed_at').defaultNow(),
  accessType: text('access_type').notNull(),
  correlationId: uuid('correlation_id'),
  sessionId: uuid('session_id'),
  queryText: text('query_text'),
  relevanceScore: numeric('relevance_score', { precision: 10, scale: 6 }),
  responseTimeMs: integer('response_time_ms'),
  metadata: jsonb('metadata').notNull().default({}),
  projectedAt: timestamp('projected_at').defaultNow(),
});

// Export Zod schemas for validation
export const insertDocumentMetadataSchema = createInsertSchema(documentMetadata);
export const insertDocumentAccessLogSchema = createInsertSchema(documentAccessLog);

/**
 * Node Service Registry Table
 * Tracks service discovery and health status for platform monitoring
 */
export const nodeServiceRegistry = pgTable('node_service_registry', {
  id: uuid('id').primaryKey().defaultRandom(),
  serviceName: text('service_name').notNull().unique(),
  serviceUrl: text('service_url').notNull(),
  serviceType: text('service_type'), // e.g., 'api', 'database', 'cache', 'queue'
  healthStatus: text('health_status').notNull().default('unknown'), // 'healthy', 'degraded', 'unhealthy'
  lastHealthCheck: timestamp('last_health_check'),
  healthCheckIntervalSeconds: integer('health_check_interval_seconds').default(60),
  metadata: jsonb('metadata').default({}),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  projectedAt: timestamp('projected_at').defaultNow(),
});

// Export Zod schema for validation
export const insertNodeServiceRegistrySchema = createInsertSchema(nodeServiceRegistry);

/**
 * Task Completion Metrics Table
 * Tracks task completion statistics for developer productivity analysis
 */
export const taskCompletionMetrics = pgTable('task_completion_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at').defaultNow(),
  correlationId: uuid('correlation_id'),
  taskType: text('task_type'),
  taskDescription: text('task_description'),
  completionTimeMs: integer('completion_time_ms').notNull(),
  success: boolean('success').default(true),
  agentName: text('agent_name'),
  metadata: jsonb('metadata').default({}),
  projectedAt: timestamp('projected_at').defaultNow(),
});

// Export Zod schema for validation
export const insertTaskCompletionMetricsSchema = createInsertSchema(taskCompletionMetrics);

// Export TypeScript types
export type TaskCompletionMetric = typeof taskCompletionMetrics.$inferSelect;
export type InsertTaskCompletionMetric = typeof taskCompletionMetrics.$inferInsert;
export type DocumentMetadata = typeof documentMetadata.$inferSelect;
export type InsertDocumentMetadata = typeof documentMetadata.$inferInsert;
export type DocumentAccessLog = typeof documentAccessLog.$inferSelect;
export type InsertDocumentAccessLog = typeof documentAccessLog.$inferInsert;
export type NodeServiceRegistry = typeof nodeServiceRegistry.$inferSelect;
export type InsertNodeServiceRegistry = typeof nodeServiceRegistry.$inferInsert;

/**
 * API Response Interfaces for Pattern Lineage
 */

/**
 * Pattern Summary
 * Overview metrics for pattern discovery and analysis
 */
export interface PatternSummary {
  total_patterns: number;
  languages: number;
  unique_executions: number;
}

/**
 * Recent Pattern
 * Individual pattern record with execution context
 */
export interface RecentPattern {
  pattern_name: string;
  pattern_version: string;
  language: string | null;
  created_at: Date;
  correlation_id: string;
}

/**
 * Language Breakdown
 * Pattern distribution by programming language
 */
export interface LanguageBreakdown {
  language: string;
  pattern_count: number;
}

/**
 * API Response Interfaces for Learned Patterns (OMN-2924)
 *
 * learnedPatterns table removed — canonical data source is now pattern_learning_artifacts.
 * These interfaces are preserved for backwards compatibility with the /api/patterns endpoint.
 */

/**
 * Pattern List Item
 * Individual pattern in paginated list response
 */
export interface PatternListItem {
  id: string;
  name: string; // domain_id
  signature: string; // pattern_signature
  status: 'candidate' | 'provisional' | 'validated' | 'deprecated';
  confidence: number;
  quality_score: number;
  usage_count_rolling_20: number;
  success_rate_rolling_20: number | null; // null when sample_size is 0
  sample_size_rolling_20: number;
  created_at: string;
  updated_at: string;
}

/**
 * Paginated Patterns Response
 */
export interface PaginatedPatternsResponse {
  patterns: PatternListItem[];
  total: number;
  limit: number;
  offset: number;
}

// ============================================================================
// Pattern Extraction Pipeline Tables (OMN-1804 / OMN-1890)
//
// These tables track extraction pipeline observability: injection effectiveness,
// latency breakdowns, and pattern hit rates. They exist in PostgreSQL but are
// currently empty — the pipeline lights up when omniclaude producers start emitting.
// ============================================================================

/**
 * Injection Effectiveness Table
 * Tracks per-session extraction outcomes: utilization scores, agent match quality,
 * and per-stage latency breakdowns for the inject → route → retrieve pipeline.
 */
export const injectionEffectiveness = pgTable(
  'injection_effectiveness',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    cohort: text('cohort').notNull(),
    injectionOccurred: boolean('injection_occurred').notNull().default(false),
    agentName: text('agent_name'),
    detectionMethod: text('detection_method'),
    utilizationScore: numeric('utilization_score', { precision: 10, scale: 6 }),
    utilizationMethod: text('utilization_method'),
    agentMatchScore: numeric('agent_match_score', { precision: 10, scale: 6 }),
    userVisibleLatencyMs: integer('user_visible_latency_ms'),
    sessionOutcome: text('session_outcome'),
    routingTimeMs: integer('routing_time_ms'),
    retrievalTimeMs: integer('retrieval_time_ms'),
    injectionTimeMs: integer('injection_time_ms'),
    patternsCount: integer('patterns_count'),
    cacheHit: boolean('cache_hit').default(false),
    eventType: text('event_type'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    index('idx_ie_session_id').on(table.sessionId),
    index('idx_ie_created_at').on(table.createdAt),
    index('idx_ie_injection_occurred').on(table.injectionOccurred),
    index('idx_ie_cohort').on(table.cohort),
    uniqueIndex('uq_ie_session_correlation_type').on(
      table.sessionId,
      table.correlationId,
      table.eventType
    ),
  ]
);

export const insertInjectionEffectivenessSchema = createInsertSchema(injectionEffectiveness);
export type InjectionEffectivenessRow = typeof injectionEffectiveness.$inferSelect;
export type InsertInjectionEffectiveness = typeof injectionEffectiveness.$inferInsert;

/**
 * Latency Breakdowns Table
 * Per-prompt latency decomposition across the extraction pipeline stages.
 * Supports percentile queries (P50/P95/P99) via PERCENTILE_CONT in SQL.
 */
export const latencyBreakdowns = pgTable(
  'latency_breakdowns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    promptId: uuid('prompt_id').notNull(),
    routingTimeMs: integer('routing_time_ms'),
    retrievalTimeMs: integer('retrieval_time_ms'),
    injectionTimeMs: integer('injection_time_ms'),
    userVisibleLatencyMs: integer('user_visible_latency_ms'),
    cohort: text('cohort').notNull(),
    cacheHit: boolean('cache_hit').default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    index('idx_lb_session_id').on(table.sessionId),
    index('idx_lb_created_at').on(table.createdAt),
    index('idx_lb_cohort').on(table.cohort),
    uniqueIndex('uq_lb_session_prompt_cohort').on(table.sessionId, table.promptId, table.cohort),
  ]
);

export const insertLatencyBreakdownSchema = createInsertSchema(latencyBreakdowns);
export type LatencyBreakdownRow = typeof latencyBreakdowns.$inferSelect;
export type InsertLatencyBreakdown = typeof latencyBreakdowns.$inferInsert;

/**
 * Pattern Hit Rates Table
 * Tracks which patterns were matched/utilized during extraction,
 * with utilization scores and methods for hit-rate analysis.
 */
export const patternHitRates = pgTable(
  'pattern_hit_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    patternId: uuid('pattern_id').notNull(),
    utilizationScore: numeric('utilization_score', { precision: 10, scale: 6 }),
    utilizationMethod: text('utilization_method'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  // DEPLOYMENT: These indexes require `npm run db:push` against the intelligence DB.
  // Drizzle's push will skip indexes that already exist.
  (table) => [
    index('idx_phr_session_id').on(table.sessionId),
    index('idx_phr_pattern_id').on(table.patternId),
    index('idx_phr_created_at').on(table.createdAt),
    uniqueIndex('uq_phr_session_pattern').on(table.patternId, table.sessionId),
  ]
);

export const insertPatternHitRateSchema = createInsertSchema(patternHitRates);
export type PatternHitRateRow = typeof patternHitRates.$inferSelect;
export type InsertPatternHitRate = typeof patternHitRates.$inferInsert;

// ============================================================================
// Projection Watermarks (consumer progress tracking)
//
// Tracks per-topic/partition consumer offsets so the read-model consumer can
// resume from the last successfully projected event after a restart.
// ============================================================================

/**
 * Projection Watermarks Table
 * Tracks consumer progress for each Kafka topic/partition projection.
 * The projection_name key is formatted as "topic:partition".
 */
export const projectionWatermarks = pgTable('projection_watermarks', {
  projectionName: text('projection_name').primaryKey(),
  lastOffset: bigint('last_offset', { mode: 'number' }).notNull().default(0),
  lastEventId: uuid('last_event_id'),
  lastProjectedAt: timestamp('last_projected_at').defaultNow(),
  eventsProjected: bigint('events_projected', { mode: 'number' }).notNull().default(0),
  errorsCount: bigint('errors_count', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const insertProjectionWatermarkSchema = createInsertSchema(projectionWatermarks);
export type ProjectionWatermark = typeof projectionWatermarks.$inferSelect;
export type InsertProjectionWatermark = typeof projectionWatermarks.$inferInsert;

// ============================================================================
// Cross-Repo Validation Tables (OMN-1907)
//
// These tables live in the omnidash_analytics read-model database.
// To create them, run:
//   npm run db:push
// or apply the SQL migration manually against omnidash_analytics.
// ============================================================================

/**
 * Validation Runs Table
 * Tracks cross-repo validation run lifecycle from started -> completed.
 * Populated by Kafka events consumed from ONEX validation topics.
 */
export const validationRuns = pgTable(
  'validation_runs',
  {
    runId: text('run_id').primaryKey(),
    repos: jsonb('repos').notNull().$type<string[]>(),
    validators: jsonb('validators').notNull().$type<string[]>(),
    triggeredBy: text('triggered_by'),
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    totalViolations: integer('total_violations').notNull().default(0),
    violationsBySeverity: jsonb('violations_by_severity')
      .notNull()
      .default({})
      .$type<Record<string, number>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    index('idx_validation_runs_status').on(table.status),
    index('idx_validation_runs_started_at').on(table.startedAt),
    index('idx_validation_runs_repos_gin').using('gin', table.repos),
  ]
);

/**
 * Validation Violations Table
 * Individual violations discovered during a validation run.
 * Linked to a run via run_id. batch_index tracks Kafka batch origin
 * to enable idempotent replay.
 */
export const validationViolations = pgTable(
  'validation_violations',
  {
    id: serial('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => validationRuns.runId, { onDelete: 'cascade' }),
    batchIndex: integer('batch_index').notNull(),
    ruleId: text('rule_id').notNull(),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    repo: text('repo').notNull(),
    filePath: text('file_path'),
    line: integer('line'),
    validator: text('validator').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    index('idx_validation_violations_run_id').on(table.runId),
    index('idx_validation_violations_run_batch').on(table.runId, table.batchIndex),
    index('idx_validation_violations_severity').on(table.severity),
  ]
);

// Export Zod schemas for validation
export const insertValidationRunSchema = createInsertSchema(validationRuns);
export const insertValidationViolationSchema = createInsertSchema(validationViolations);

// Export TypeScript types
export type ValidationRunRow = typeof validationRuns.$inferSelect;
export type InsertValidationRun = typeof validationRuns.$inferInsert;
export type ValidationViolationRow = typeof validationViolations.$inferSelect;
export type InsertValidationViolation = typeof validationViolations.$inferInsert;

/**
 * Validation Lifecycle Candidates Table (OMN-2333)
 *
 * Tracks validation lifecycle candidates — rules and patterns progressing
 * through the tiers: observed -> suggested -> shadow_apply -> promoted -> default.
 *
 * Populated by Kafka events from the OMN-2018 artifact store and check results.
 * Consumed by the lifecycle summary endpoint to drive the ValidationDashboard
 * Lifecycle tab.
 *
 * Idempotency: candidate_id is the primary key sourced from the upstream artifact
 * store, so upserts on conflict are safe for event replay.
 */
export const validationCandidates = pgTable(
  'validation_candidates',
  {
    /** Upstream artifact ID from OMN-2018 artifact store (primary key). */
    candidateId: text('candidate_id').primaryKey(),
    /** Human-readable rule name. */
    ruleName: text('rule_name').notNull(),
    /** Rule ID matching a validation rule (e.g. SCHEMA-001). */
    ruleId: text('rule_id').notNull(),
    /** Current lifecycle tier: observed | suggested | shadow_apply | promoted | default */
    tier: text('tier').notNull().default('observed'),
    /** Current validation status: pending | pass | fail | quarantine */
    status: text('status').notNull().default('pending'),
    /** Repository where this candidate was discovered. */
    sourceRepo: text('source_repo').notNull(),
    /** ISO-8601 timestamp when candidate entered the current tier. */
    enteredTierAt: timestamp('entered_tier_at', { withTimezone: true }).notNull().defaultNow(),
    /** ISO-8601 timestamp of the most recent validation run for this candidate. */
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Number of consecutive passes at current tier. */
    passStreak: integer('pass_streak').notNull().default(0),
    /** Number of consecutive failures at current tier. */
    failStreak: integer('fail_streak').notNull().default(0),
    /** Total validation runs across all tiers. */
    totalRuns: integer('total_runs').notNull().default(0),
    /** When this row was first created. */
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    /** When this row was last projected from Kafka. */
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    index('idx_validation_candidates_tier').on(table.tier),
    index('idx_validation_candidates_status').on(table.status),
    index('idx_validation_candidates_last_validated').on(table.lastValidatedAt),
    index('idx_validation_candidates_source_repo').on(table.sourceRepo),
  ]
);

// Export Zod schema for validation candidates
export const insertValidationCandidateSchema = createInsertSchema(validationCandidates);

// Export TypeScript types for validation candidates
export type ValidationCandidateRow = typeof validationCandidates.$inferSelect;
export type InsertValidationCandidate = typeof validationCandidates.$inferInsert;

// NOTE: Injection Effectiveness tables (OMN-1891) are defined in the
// Pattern Extraction Pipeline section above (OMN-1804) which shares
// injectionEffectiveness, latencyBreakdowns, and patternHitRates.

// ============================================================================
// LLM Cost Aggregates (OMN-2242)
// ============================================================================

/**
 * LLM Cost Aggregates Table
 * Pre-aggregated cost and token usage data for the cost trend dashboard.
 * Populated by the upstream aggregation service (OMN-2240) or by the
 * read-model consumer projecting Kafka events.
 *
 * usage_source indicates data provenance:
 *   - API: directly reported by the LLM provider
 *   - ESTIMATED: computed from heuristics / token estimation
 *   - MISSING: placeholder where data could not be obtained
 */
export const llmCostAggregates = pgTable(
  'llm_cost_aggregates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Time bucket for the aggregate (hourly or daily). */
    bucketTime: timestamp('bucket_time', { withTimezone: true }).notNull(),
    /** Granularity of the bucket: 'hour' or 'day'. */
    granularity: text('granularity').notNull().default('hour'),
    /** LLM model name (e.g. 'gpt-4', 'claude-3-opus'). */
    modelName: text('model_name').notNull(),
    /** Repository that generated the usage. */
    repoName: text('repo_name'),
    /** Pattern ID if usage was pattern-driven. */
    patternId: text('pattern_id'),
    /** Pattern name for display. */
    patternName: text('pattern_name'),
    /** Session ID grouping related calls. */
    sessionId: text('session_id'),
    /** How the data was obtained: API, ESTIMATED, MISSING. */
    usageSource: text('usage_source').notNull().default('API'),
    /** Number of LLM requests in this bucket. */
    requestCount: integer('request_count').notNull().default(0),
    /** Total prompt tokens. */
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull().default(0),
    /** Total completion tokens. */
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull().default(0),
    /** Total tokens (prompt + completion). */
    totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
    /** Total cost in USD. */
    totalCostUsd: numeric('total_cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    /** Cost from API-reported data only (subset of total_cost_usd). */
    reportedCostUsd: numeric('reported_cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    /** Cost from estimated/missing data (subset of total_cost_usd). */
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_llm_cost_agg_bucket_time').on(table.bucketTime),
    index('idx_llm_cost_agg_model').on(table.modelName),
    // Partial indexes: exclude NULL rows so the index is compact and queries
    // filtering IS NOT NULL benefit without wasted space (mirrors the SQL migration).
    index('idx_llm_cost_agg_repo')
      .on(table.repoName)
      .where(sql`${table.repoName} IS NOT NULL`),
    index('idx_llm_cost_agg_pattern')
      .on(table.patternId)
      .where(sql`${table.patternId} IS NOT NULL`),
    index('idx_llm_cost_agg_session')
      .on(table.sessionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    index('idx_llm_cost_agg_source').on(table.usageSource),
    index('idx_llm_cost_agg_bucket_model').on(table.bucketTime, table.modelName),
    // Composite index for hourly/daily view switching (used when toggling granularity).
    index('idx_llm_cost_agg_bucket_granularity').on(table.bucketTime, table.granularity),
    // CHECK constraints mirror the SQL migration (0003_llm_cost_aggregates.sql).
    // Without these, a future `db:push` would skip the constraints and allow
    // invalid values that the migration enforces at the database level.
    check('llm_cost_agg_granularity_check', sql`${table.granularity} IN ('hour', 'day')`),
    check(
      'llm_cost_agg_usage_source_check',
      sql`${table.usageSource} IN ('API', 'ESTIMATED', 'MISSING')`
    ),
  ]
);

// Export Zod schemas for cost aggregates
export const insertLlmCostAggregateSchema = createInsertSchema(llmCostAggregates);

// Export TypeScript types
export type LlmCostAggregateRow = typeof llmCostAggregates.$inferSelect;

// ============================================================================
// Baselines & ROI Tables (OMN-2331)
//
// These tables persist snapshots produced by the upstream baselines-computed
// Kafka event (onex.evt.omnibase-infra.baselines-computed.v1).
//
// Snapshot lifecycle:
//   1. ReadModelConsumer receives BaselinesSnapshotEvent from Kafka.
//   2. It upserts baselines_snapshots, then replaces the child rows for that
//      snapshot_id (deletes old, inserts fresh) in a single transaction.
//   3. baselines-routes.ts queries the latest snapshot (MAX computed_at_utc)
//      and joins child tables to serve the four REST endpoints.
// ============================================================================

/**
 * Baselines Snapshots Table
 *
 * One row per emitted snapshot. The "latest" snapshot is determined by
 * MAX(computed_at_utc). Routes always query the latest snapshot — they do NOT
 * aggregate across multiple snapshots.
 */
export const baselinesSnapshots = pgTable(
  'baselines_snapshots',
  {
    /** UUID set by the upstream producer; used as the dedup/upsert key. */
    snapshotId: uuid('snapshot_id').primaryKey(),
    /** Schema version carried in the event (1 = initial). */
    contractVersion: integer('contract_version').notNull().default(1),
    /** When the upstream service computed this snapshot (UTC). */
    computedAtUtc: timestamp('computed_at_utc', { withTimezone: true }).notNull(),
    /** Start of the evaluation window (null = rolling / no fixed start). */
    windowStartUtc: timestamp('window_start_utc', { withTimezone: true }),
    /** End of the evaluation window (null = rolling / open end). */
    windowEndUtc: timestamp('window_end_utc', { withTimezone: true }),
    /** When this row was inserted/updated by the projection. */
    projectedAt: timestamp('projected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Primary query: find the latest snapshot fast (ORDER BY computed_at_utc DESC). */
    index('idx_baselines_snapshots_computed').on(table.computedAtUtc.desc()),
  ]
);

export const insertBaselinesSnapshotSchema = createInsertSchema(baselinesSnapshots);
export type BaselinesSnapshotRow = typeof baselinesSnapshots.$inferSelect;
export type InsertBaselinesSnapshot = typeof baselinesSnapshots.$inferInsert;

/**
 * Baselines Comparisons Table
 *
 * Mirrors BaselinesComparisonRow from the event payload.
 * Each row belongs to exactly one snapshot_id.
 * Replaced atomically on each new snapshot (delete-then-insert).
 */
export const baselinesComparisons = pgTable(
  'baselines_comparisons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => baselinesSnapshots.snapshotId, { onDelete: 'cascade' }),
    patternId: text('pattern_id').notNull(),
    patternName: text('pattern_name').notNull(),
    sampleSize: integer('sample_size').notNull().default(0),
    windowStart: text('window_start').notNull().default(''),
    windowEnd: text('window_end').notNull().default(''),
    /** Stored as JSONB: DeltaMetric */
    tokenDelta: jsonb('token_delta').notNull(),
    /** Stored as JSONB: DeltaMetric */
    timeDelta: jsonb('time_delta').notNull(),
    /** Stored as JSONB: DeltaMetric */
    retryDelta: jsonb('retry_delta').notNull(),
    /** Stored as JSONB: DeltaMetric */
    testPassRateDelta: jsonb('test_pass_rate_delta').notNull(),
    /** Stored as JSONB: DeltaMetric */
    reviewIterationDelta: jsonb('review_iteration_delta').notNull(),
    /** 'promote' | 'shadow' | 'suppress' | 'fork' */
    recommendation: text('recommendation').notNull(),
    /** 'high' | 'medium' | 'low' */
    confidence: text('confidence').notNull(),
    rationale: text('rationale').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_baselines_comparisons_snapshot').on(table.snapshotId),
    index('idx_baselines_comparisons_pattern').on(table.patternId),
    index('idx_baselines_comparisons_recommendation').on(table.recommendation),
  ]
);

export const insertBaselinesComparisonSchema = createInsertSchema(baselinesComparisons);
export type BaselinesComparisonRow = typeof baselinesComparisons.$inferSelect;
export type InsertBaselinesComparison = typeof baselinesComparisons.$inferInsert;

/**
 * Baselines Trend Table
 *
 * Mirrors BaselinesTrendRow (ROITrendPoint) from the event payload.
 * Each row belongs to exactly one snapshot_id.
 * Replaced atomically on each new snapshot (delete-then-insert).
 */
export const baselinesTrend = pgTable(
  'baselines_trend',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => baselinesSnapshots.snapshotId, { onDelete: 'cascade' }),
    /** ISO date string (YYYY-MM-DD) for the data point. */
    date: text('date').notNull(),
    avgCostSavings: numeric('avg_cost_savings', { precision: 8, scale: 6 }).notNull().default('0'),
    avgOutcomeImprovement: numeric('avg_outcome_improvement', { precision: 8, scale: 6 })
      .notNull()
      .default('0'),
    comparisonsEvaluated: integer('comparisons_evaluated').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_baselines_trend_snapshot').on(table.snapshotId),
    index('idx_baselines_trend_date').on(table.date),
    uniqueIndex('baselines_trend_snapshot_date_unique').on(table.snapshotId, table.date),
  ]
);

export const insertBaselinesTrendSchema = createInsertSchema(baselinesTrend);
export type BaselinesTrendRow = typeof baselinesTrend.$inferSelect;
export type InsertBaselinesTrend = typeof baselinesTrend.$inferInsert;

/**
 * Baselines Breakdown Table
 *
 * Mirrors RecommendationBreakdown from the event payload.
 * Each row belongs to exactly one snapshot_id.
 * Replaced atomically on each new snapshot (delete-then-insert).
 */
export const baselinesBreakdown = pgTable(
  'baselines_breakdown',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => baselinesSnapshots.snapshotId, { onDelete: 'cascade' }),
    /** 'promote' | 'shadow' | 'suppress' | 'fork' */
    action: text('action').notNull(),
    count: integer('count').notNull().default(0),
    avgConfidence: numeric('avg_confidence', { precision: 5, scale: 4 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_baselines_breakdown_snapshot').on(table.snapshotId),
    index('idx_baselines_breakdown_action').on(table.action),
    uniqueIndex('baselines_breakdown_snapshot_action_unique').on(table.snapshotId, table.action),
  ]
);

export const insertBaselinesBreakdownSchema = createInsertSchema(baselinesBreakdown);
export type BaselinesBreakdownRow = typeof baselinesBreakdown.$inferSelect;
export type InsertBaselinesBreakdown = typeof baselinesBreakdown.$inferInsert;

export type InsertLlmCostAggregate = typeof llmCostAggregates.$inferInsert;

// ============================================================================
// Delegation Events (OMN-2284)
//
// Two tables track the delegation metrics dashboard:
//   1. delegation_events — one row per task-delegated event
//   2. delegation_shadow_comparisons — one row per shadow comparison event
//
// Both tables use correlation_id as the deduplication key (UNIQUE constraint)
// so that ON CONFLICT DO NOTHING makes projections idempotent on Kafka replay.
// ============================================================================

/**
 * Delegation Events Table
 *
 * Tracks all task delegation events emitted by the omniclaude delegation hook.
 * Populated by ReadModelConsumer projecting onex.evt.omniclaude.task-delegated.v1.
 *
 * GOLDEN METRIC: quality_gate_pass_rate (quality_gate_passed / total) > 80%.
 */
export const delegationEvents = pgTable(
  'delegation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Unique correlation ID for this delegation — deduplication key. */
    correlationId: text('correlation_id').unique().notNull(),
    /** Parent session ID. */
    sessionId: text('session_id'),
    /** When this delegation occurred. */
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    /** Task type (e.g. "code-review", "refactor", "test-generation"). */
    taskType: text('task_type').notNull(),
    /** Agent that received the delegated task. */
    delegatedTo: text('delegated_to').notNull(),
    /** Agent that initiated the delegation. */
    delegatedBy: text('delegated_by'),
    /** Whether this delegation passed all quality gates before being accepted. */
    qualityGatePassed: boolean('quality_gate_passed').notNull().default(false),
    /** Names of quality gates checked (stored as JSONB string array). */
    qualityGatesChecked: jsonb('quality_gates_checked').$type<string[]>(),
    /** Names of quality gates that failed (stored as JSONB string array). */
    qualityGatesFailed: jsonb('quality_gates_failed').$type<string[]>(),
    /** Estimated cost of the delegated task (USD, stored as numeric string). */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    /** Estimated cost savings vs. non-delegated execution (USD). */
    costSavingsUsd: numeric('cost_savings_usd', { precision: 12, scale: 6 }),
    /** Latency of the delegation handoff (ms). */
    delegationLatencyMs: integer('delegation_latency_ms'),
    /** Repository context. */
    repo: text('repo'),
    /** Whether this is a shadow delegation (not actually executed). */
    isShadow: boolean('is_shadow').notNull().default(false),
    /** When this row was projected from Kafka. */
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_delegation_events_correlation').on(table.correlationId),
    index('idx_delegation_events_task_type').on(table.taskType),
    index('idx_delegation_events_projected_at').on(table.projectedAt),
    index('idx_delegation_events_delegated_to').on(table.delegatedTo),
    index('idx_delegation_events_timestamp').on(table.timestamp),
  ]
);

export const insertDelegationEventSchema = createInsertSchema(delegationEvents);
export type DelegationEventRow = typeof delegationEvents.$inferSelect;
export type InsertDelegationEvent = typeof delegationEvents.$inferInsert;

/**
 * Delegation Shadow Comparisons Table
 *
 * Tracks shadow validation comparisons between primary and shadow agent outputs.
 * Populated by ReadModelConsumer projecting
 * onex.evt.omniclaude.delegation-shadow-comparison.v1.
 */
export const delegationShadowComparisons = pgTable(
  'delegation_shadow_comparisons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Unique correlation ID — deduplication key. */
    correlationId: text('correlation_id').unique().notNull(),
    /** Session ID. */
    sessionId: text('session_id'),
    /** When this comparison occurred. */
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    /** Task type. */
    taskType: text('task_type').notNull(),
    /** Primary agent that handled the task. */
    primaryAgent: text('primary_agent').notNull(),
    /** Shadow agent compared against the primary. */
    shadowAgent: text('shadow_agent').notNull(),
    /** Whether the shadow agent's output diverged from the primary. */
    divergenceDetected: boolean('divergence_detected').notNull().default(false),
    /** Divergence score (0–1, 0 = identical, 1 = completely different). */
    divergenceScore: numeric('divergence_score', { precision: 5, scale: 4 }),
    /** Latency of the primary agent (ms). */
    primaryLatencyMs: integer('primary_latency_ms'),
    /** Latency of the shadow agent (ms). */
    shadowLatencyMs: integer('shadow_latency_ms'),
    /** Cost of the primary execution (USD). */
    primaryCostUsd: numeric('primary_cost_usd', { precision: 12, scale: 6 }),
    /** Cost of the shadow execution (USD). */
    shadowCostUsd: numeric('shadow_cost_usd', { precision: 12, scale: 6 }),
    /** Human-readable description of the divergence (if detected). */
    divergenceReason: text('divergence_reason'),
    /** When this row was projected from Kafka. */
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_delegation_shadow_correlation').on(table.correlationId),
    index('idx_delegation_shadow_task_type').on(table.taskType),
    index('idx_delegation_shadow_projected_at').on(table.projectedAt),
    index('idx_delegation_shadow_divergence').on(table.divergenceDetected),
    index('idx_delegation_shadow_timestamp').on(table.timestamp),
  ]
);

export const insertDelegationShadowComparisonSchema = createInsertSchema(
  delegationShadowComparisons
);
export type DelegationShadowComparisonRow = typeof delegationShadowComparisons.$inferSelect;
export type InsertDelegationShadowComparison = typeof delegationShadowComparisons.$inferInsert;

/**
 * Plan Review Runs Table (OMN-3324)
 *
 * Tracks plan-reviewer strategy run completions from omniintelligence.
 * Populated by ReadModelConsumer projecting
 * onex.evt.omniintelligence.plan-review-strategy-run-completed.v1.
 */
export const planReviewRuns = pgTable(
  'plan_review_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: text('event_id').notNull(),
    runId: text('run_id').notNull(),
    strategy: text('strategy').notNull(),
    modelsUsed: text('models_used')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    planTextHash: text('plan_text_hash').notNull(),
    findingsCount: integer('findings_count').notNull().default(0),
    blocksCount: integer('blocks_count').notNull().default(0),
    categoriesWithFindings: text('categories_with_findings')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    categoriesClean: text('categories_clean')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    avgConfidence: doublePrecision('avg_confidence'),
    tokensUsed: integer('tokens_used'),
    durationMs: integer('duration_ms'),
    strategyRunStored: boolean('strategy_run_stored').notNull().default(false),
    modelWeights: jsonb('model_weights'),
    emittedAt: timestamp('emitted_at', { withTimezone: true }).notNull(),
    projectedAt: timestamp('projected_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_plan_review_runs_run_id').on(table.runId),
    index('idx_plan_review_runs_strategy').on(table.strategy),
    index('idx_plan_review_runs_emitted_at').on(table.emittedAt),
  ]
);

export const insertPlanReviewRunSchema = createInsertSchema(planReviewRuns);
export type PlanReviewRunRow = typeof planReviewRuns.$inferSelect;
export type InsertPlanReviewRun = typeof planReviewRuns.$inferInsert;

// ============================================================================
// Pattern Pipeline Tables (OMN-2191)
//
// These tables track the pattern injection pipeline: injection events with A/B
// experiment support, lifecycle audit trail, and evidence-based attribution.
// They exist in PostgreSQL (created by omnidash migration 0014_pattern_pipeline_tables).
// ============================================================================

/**
 * Pattern Injections Table (migration 0014)
 * Tracks every pattern injection event with A/B experiment support
 * for measuring effectiveness. Includes run_id for pipeline measurement linkage.
 */
export const patternInjections = pgTable(
  'pattern_injections',
  {
    injectionId: uuid('injection_id').primaryKey().defaultRandom(),

    // Session and tracing
    sessionId: uuid('session_id').notNull(),
    correlationId: uuid('correlation_id'),

    // Pattern tracking (UUID array, no FK - PostgreSQL limitation)
    patternIds: uuid('pattern_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

    // Timing
    injectedAt: timestamp('injected_at', { withTimezone: true }).notNull().defaultNow(),

    // Injection context
    injectionContext: varchar('injection_context', { length: 30 }).notNull(),

    // A/B experiment tracking
    cohort: varchar('cohort', { length: 20 }).notNull().default('treatment'),
    assignmentSeed: bigint('assignment_seed', { mode: 'number' }).notNull(),

    // Compiled content
    compiledContent: text('compiled_content'),
    compiledTokenCount: integer('compiled_token_count'),

    // Outcome tracking
    outcomeRecorded: boolean('outcome_recorded').notNull().default(false),
    outcomeSuccess: boolean('outcome_success'),
    outcomeRecordedAt: timestamp('outcome_recorded_at', { withTimezone: true }),
    outcomeFailureReason: text('outcome_failure_reason'),

    // Contribution heuristic
    contributionHeuristic: jsonb('contribution_heuristic'),
    heuristicMethod: varchar('heuristic_method', { length: 50 }),
    heuristicConfidence: doublePrecision('heuristic_confidence'),

    // Pipeline run linkage (migration 013)
    runId: uuid('run_id'),

    // Auditing
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pi_session_id').on(table.sessionId),
    index('idx_pi_cohort').on(table.cohort),
    index('idx_pi_injected_at').on(table.injectedAt),
    index('idx_pi_correlation_id').on(table.correlationId),
    index('idx_pi_run_id').on(table.runId),
  ]
);

export const insertPatternInjectionSchema = createInsertSchema(patternInjections);
export type PatternInjectionRow = typeof patternInjections.$inferSelect;
export type InsertPatternInjection = typeof patternInjections.$inferInsert;

/**
 * Pattern Lifecycle Transitions Table (migration 010)
 * Audit table tracking all pattern status transitions for the reducer-first
 * state machine. Supports promotion/demotion history visualization.
 */
export const patternLifecycleTransitions = pgTable(
  'pattern_lifecycle_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Request tracking (for idempotency)
    requestId: uuid('request_id').notNull(),

    // Pattern reference
    patternId: uuid('pattern_id').notNull(),

    // State transition
    fromStatus: varchar('from_status', { length: 20 }).notNull(),
    toStatus: varchar('to_status', { length: 20 }).notNull(),
    transitionTrigger: varchar('transition_trigger', { length: 50 }).notNull(),

    // Tracing and attribution
    correlationId: uuid('correlation_id'),
    actor: varchar('actor', { length: 100 }),
    reason: text('reason'),

    // Snapshot of gate conditions at transition time
    gateSnapshot: jsonb('gate_snapshot'),

    // Timing
    transitionAt: timestamp('transition_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_plt_pattern_id').on(table.patternId),
    index('idx_plt_transition_at').on(table.transitionAt),
    index('idx_plt_correlation_id').on(table.correlationId),
    index('idx_plt_trigger').on(table.transitionTrigger),
    index('idx_plt_from_to_status').on(table.fromStatus, table.toStatus),
    uniqueIndex('uq_plt_request_pattern').on(table.requestId, table.patternId),
  ]
);

export const insertPatternLifecycleTransitionSchema = createInsertSchema(
  patternLifecycleTransitions
);
export type PatternLifecycleTransitionRow = typeof patternLifecycleTransitions.$inferSelect;
export type InsertPatternLifecycleTransition = typeof patternLifecycleTransitions.$inferInsert;

/**
 * Pattern Measured Attributions Table (migration 012)
 * Audit trail for evidence-based attribution binding. Links session outcomes
 * to pipeline runs and records evidence tier computations.
 */
export const patternMeasuredAttributions = pgTable(
  'pattern_measured_attributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Pattern reference
    patternId: uuid('pattern_id').notNull(),

    // Session that triggered this attribution
    sessionId: uuid('session_id').notNull(),

    // Pipeline run (nullable: run_id=NULL means OBSERVED-only attribution)
    runId: uuid('run_id'),

    // Evidence tier
    evidenceTier: text('evidence_tier').notNull(),

    // Full measured attribution contract as JSON
    measuredAttributionJson: jsonb('measured_attribution_json'),

    // Correlation tracing
    correlationId: uuid('correlation_id'),

    // Timing
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pma_pattern_created').on(table.patternId, table.createdAt),
    index('idx_pma_session').on(table.sessionId),
    index('idx_pma_run_id').on(table.runId),
    index('idx_pma_correlation').on(table.correlationId),
  ]
);

export const insertPatternMeasuredAttributionSchema = createInsertSchema(
  patternMeasuredAttributions
);
export type PatternMeasuredAttributionRow = typeof patternMeasuredAttributions.$inferSelect;
export type InsertPatternMeasuredAttribution = typeof patternMeasuredAttributions.$inferInsert;

// ============================================================================
// Migration-only tables backfilled with Drizzle definitions (OMN-3750)
//
// These tables were created by SQL migrations but had no corresponding Drizzle
// pgTable() definition. Each definition below matches the column types in the
// migration file exactly (accounting for subsequent ALTER migrations).
// ============================================================================

/**
 * Users Table (migration 0000)
 * Basic user authentication table created by Drizzle's initial push.
 */
export const users = pgTable('users', {
  id: varchar('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  username: text('username').notNull().unique(),
  password: text('password').notNull(),
});

export const insertUserSchema = createInsertSchema(users);
export type UserRow = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Pattern Enforcement Events Table (migration 0002)
 * Projected events from onex.evt.omniclaude.pattern-enforcement.v1
 */
export const patternEnforcementEvents = pgTable(
  'pattern_enforcement_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: text('correlation_id').notNull(),
    sessionId: text('session_id'),
    repo: text('repo'),
    language: text('language').notNull().default('unknown'),
    domain: text('domain').notNull().default('unknown'),
    patternName: text('pattern_name').notNull(),
    patternLifecycleState: text('pattern_lifecycle_state'),
    outcome: text('outcome').notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    agentName: text('agent_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_pee_correlation_id').on(table.correlationId),
    index('idx_pee_created_at').on(table.createdAt),
    index('idx_pee_outcome').on(table.outcome),
    index('idx_pee_language').on(table.language),
    index('idx_pee_domain').on(table.domain),
    index('idx_pee_pattern_name').on(table.patternName),
    index('idx_pee_created_outcome').on(table.createdAt, table.outcome),
  ]
);

export const insertPatternEnforcementEventSchema = createInsertSchema(patternEnforcementEvents);
export type PatternEnforcementEventRow = typeof patternEnforcementEvents.$inferSelect;
export type InsertPatternEnforcementEvent = typeof patternEnforcementEvents.$inferInsert;

/**
 * Context Enrichment Events Table (migration 0005b)
 * Projected events from onex.evt.omniclaude.context-enrichment.v1
 */
export const contextEnrichmentEvents = pgTable(
  'context_enrichment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: text('correlation_id').notNull(),
    sessionId: text('session_id'),
    channel: text('channel').notNull(),
    modelName: text('model_name').notNull().default('unknown'),
    cacheHit: boolean('cache_hit').notNull().default(false),
    outcome: text('outcome').notNull(),
    latencyMs: integer('latency_ms').notNull().default(0),
    tokensBefore: integer('tokens_before').notNull().default(0),
    tokensAfter: integer('tokens_after').notNull().default(0),
    netTokensSaved: integer('net_tokens_saved').notNull().default(0),
    similarityScore: numeric('similarity_score', { precision: 5, scale: 4 }),
    qualityScore: numeric('quality_score', { precision: 5, scale: 4 }),
    repo: text('repo'),
    agentName: text('agent_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_cee_correlation_id').on(table.correlationId),
    index('idx_cee_created_at').on(table.createdAt),
    index('idx_cee_outcome').on(table.outcome),
    index('idx_cee_channel').on(table.channel),
    index('idx_cee_model_name').on(table.modelName),
    index('idx_cee_created_channel').on(table.channel, table.createdAt),
  ]
);

export const insertContextEnrichmentEventSchema = createInsertSchema(contextEnrichmentEvents);
export type ContextEnrichmentEventRow = typeof contextEnrichmentEvents.$inferSelect;
export type InsertContextEnrichmentEvent = typeof contextEnrichmentEvents.$inferInsert;

/**
 * LLM Routing Decisions Table (migration 0006b, altered by 0011a + 0011b)
 * Projected events from onex.evt.omniclaude.llm-routing-decision.v1
 *
 * Note: correlation_id was TEXT in 0006b, converted to UUID by 0011a.
 * fuzzy_agent was NOT NULL in 0006b, made nullable by 0011b.
 */
export const llmRoutingDecisions = pgTable(
  'llm_routing_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: uuid('correlation_id').notNull().unique(),
    sessionId: text('session_id'),
    llmAgent: text('llm_agent').notNull(),
    fuzzyAgent: text('fuzzy_agent'),
    agreement: boolean('agreement').notNull().default(false),
    llmConfidence: numeric('llm_confidence', { precision: 5, scale: 4 }),
    fuzzyConfidence: numeric('fuzzy_confidence', { precision: 5, scale: 4 }),
    llmLatencyMs: integer('llm_latency_ms').notNull().default(0),
    fuzzyLatencyMs: integer('fuzzy_latency_ms').notNull().default(0),
    usedFallback: boolean('used_fallback').notNull().default(false),
    routingPromptVersion: text('routing_prompt_version').notNull().default('unknown'),
    intent: text('intent'),
    model: text('model'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 8 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_lrd_created_at').on(table.createdAt),
    index('idx_lrd_agreement').on(table.agreement, table.createdAt),
    index('idx_lrd_used_fallback').on(table.usedFallback, table.createdAt),
    index('idx_lrd_prompt_version').on(table.routingPromptVersion, table.createdAt),
    index('idx_lrd_agent_pair').on(table.llmAgent, table.fuzzyAgent, table.createdAt),
  ]
);

export const insertLlmRoutingDecisionSchema = createInsertSchema(llmRoutingDecisions);
export type LlmRoutingDecisionRow = typeof llmRoutingDecisions.$inferSelect;
export type InsertLlmRoutingDecision = typeof llmRoutingDecisions.$inferInsert;

/**
 * Gate Decisions Table (migration 0009)
 * Projected events from onex.evt.omniclaude.gate-decision.v1
 */
export const gateDecisions = pgTable(
  'gate_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: text('correlation_id').notNull().unique(),
    sessionId: text('session_id'),
    prNumber: integer('pr_number'),
    repo: text('repo'),
    gateName: text('gate_name').notNull().default('unknown'),
    outcome: text('outcome').notNull().default('unknown'),
    blocking: boolean('blocking').notNull().default(false),
    details: jsonb('details'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_gate_decisions_created_at').on(table.createdAt),
    index('idx_gate_decisions_pr_number').on(table.prNumber, table.createdAt),
    index('idx_gate_decisions_gate_name').on(table.gateName, table.createdAt),
    index('idx_gate_decisions_blocking').on(table.blocking, table.createdAt),
  ]
);

export const insertGateDecisionSchema = createInsertSchema(gateDecisions);
export type GateDecisionRow = typeof gateDecisions.$inferSelect;
export type InsertGateDecision = typeof gateDecisions.$inferInsert;

/**
 * Epic Run Events Table (migration 0009)
 * Append-only event log from onex.evt.omniclaude.epic-run-updated.v1
 */
export const epicRunEvents = pgTable(
  'epic_run_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: text('correlation_id').notNull().unique(),
    epicRunId: text('epic_run_id').notNull(),
    eventType: text('event_type').notNull().default('unknown'),
    ticketId: text('ticket_id'),
    repo: text('repo'),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_epic_run_events_created_at').on(table.createdAt),
    index('idx_epic_run_events_epic_run_id').on(table.epicRunId, table.createdAt),
    index('idx_epic_run_events_event_type').on(table.eventType, table.createdAt),
    index('idx_epic_run_events_ticket_id').on(table.ticketId, table.createdAt),
  ]
);

export const insertEpicRunEventSchema = createInsertSchema(epicRunEvents);
export type EpicRunEventRow = typeof epicRunEvents.$inferSelect;
export type InsertEpicRunEvent = typeof epicRunEvents.$inferInsert;

/**
 * Epic Run Lease Table (migration 0009)
 * Current lease holder per epic run, upserted on each epic-run-updated.v1 event.
 */
export const epicRunLease = pgTable(
  'epic_run_lease',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    epicRunId: text('epic_run_id').notNull().unique(),
    leaseHolder: text('lease_holder').notNull().default('unknown'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_epic_run_lease_expires_at').on(table.leaseExpiresAt),
    index('idx_epic_run_lease_holder').on(table.leaseHolder),
  ]
);

export const insertEpicRunLeaseSchema = createInsertSchema(epicRunLease);
export type EpicRunLeaseRow = typeof epicRunLease.$inferSelect;
export type InsertEpicRunLease = typeof epicRunLease.$inferInsert;

/**
 * PR Watch State Table (migration 0009)
 * Per-PR watch state snapshots from onex.evt.omniclaude.pr-watch-updated.v1
 */
export const prWatchState = pgTable(
  'pr_watch_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: text('correlation_id').notNull().unique(),
    prNumber: integer('pr_number'),
    repo: text('repo'),
    state: text('state').notNull().default('unknown'),
    checksStatus: text('checks_status'),
    reviewStatus: text('review_status'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pr_watch_state_created_at').on(table.createdAt),
    index('idx_pr_watch_state_pr_number').on(table.prNumber, table.createdAt),
    index('idx_pr_watch_state_state').on(table.state, table.createdAt),
  ]
);

export const insertPrWatchStateSchema = createInsertSchema(prWatchState);
export type PrWatchStateRow = typeof prWatchState.$inferSelect;
export type InsertPrWatchState = typeof prWatchState.$inferInsert;

/**
 * Pipeline Budget State Table (migration 0009)
 * Budget cap hit events from onex.evt.omniclaude.budget-cap-hit.v1
 */
export const pipelineBudgetState = pgTable(
  'pipeline_budget_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: text('correlation_id').notNull().unique(),
    pipelineId: text('pipeline_id').notNull(),
    budgetType: text('budget_type').notNull().default('tokens'),
    capValue: numeric('cap_value', { precision: 18, scale: 4 }),
    currentValue: numeric('current_value', { precision: 18, scale: 4 }),
    capHit: boolean('cap_hit').notNull().default(true),
    repo: text('repo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pipeline_budget_state_created_at').on(table.createdAt),
    index('idx_pipeline_budget_state_pipeline_id').on(table.pipelineId, table.createdAt),
    index('idx_pipeline_budget_state_budget_type').on(table.budgetType, table.createdAt),
  ]
);

export const insertPipelineBudgetStateSchema = createInsertSchema(pipelineBudgetState);
export type PipelineBudgetStateRow = typeof pipelineBudgetState.$inferSelect;
export type InsertPipelineBudgetState = typeof pipelineBudgetState.$inferInsert;

/**
 * Debug Escalation Counts Table (migration 0009)
 * Circuit breaker trip events from onex.evt.omniclaude.circuit-breaker-tripped.v1
 */
export const debugEscalationCounts = pgTable(
  'debug_escalation_counts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: text('correlation_id').notNull().unique(),
    sessionId: text('session_id'),
    agentName: text('agent_name').notNull().default('unknown'),
    escalationCount: integer('escalation_count').notNull().default(1),
    windowStart: timestamp('window_start', { withTimezone: true }),
    windowEnd: timestamp('window_end', { withTimezone: true }),
    tripped: boolean('tripped').notNull().default(true),
    repo: text('repo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_debug_escalation_counts_created_at').on(table.createdAt),
    index('idx_debug_escalation_counts_agent_name').on(table.agentName, table.createdAt),
    index('idx_debug_escalation_counts_session_id').on(table.sessionId, table.createdAt),
    index('idx_debug_escalation_counts_tripped').on(table.tripped, table.createdAt),
  ]
);

export const insertDebugEscalationCountSchema = createInsertSchema(debugEscalationCounts);
export type DebugEscalationCountRow = typeof debugEscalationCounts.$inferSelect;
export type InsertDebugEscalationCount = typeof debugEscalationCounts.$inferInsert;

/**
 * Routing Config Table (migration 0012)
 * Generic key-value store for routing configuration (model switcher, prompt version).
 */
export const routingConfig = pgTable('routing_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const insertRoutingConfigSchema = createInsertSchema(routingConfig);
export type RoutingConfigRow = typeof routingConfig.$inferSelect;
export type InsertRoutingConfig = typeof routingConfig.$inferInsert;

/**
 * Model Efficiency Rollups Table (migration 0017)
 * PR validation rollup events for the Model Efficiency Index (MEI) dashboard.
 * MEI is defined only over rollup_status='final' rows.
 */
export const modelEfficiencyRollups = pgTable(
  'model_efficiency_rollups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: text('run_id').notNull().unique(),
    repoId: text('repo_id').notNull(),
    prId: text('pr_id').default(''),
    prUrl: text('pr_url').default(''),
    ticketId: text('ticket_id').default(''),
    modelId: text('model_id').notNull(),
    producerKind: text('producer_kind').notNull().default('unknown'),
    rollupStatus: text('rollup_status').notNull().default('final'),
    metricVersion: text('metric_version').notNull().default('v1'),
    filesChanged: integer('files_changed').notNull().default(0),
    linesChanged: integer('lines_changed').notNull().default(0),
    moduleTags: jsonb('module_tags').default(sql`'[]'::jsonb`),
    blockingFailures: integer('blocking_failures').notNull().default(0),
    warnFindings: integer('warn_findings').notNull().default(0),
    reruns: integer('reruns').notNull().default(0),
    validatorRuntimeMs: integer('validator_runtime_ms').notNull().default(0),
    humanEscalations: integer('human_escalations').notNull().default(0),
    autofixSuccesses: integer('autofix_successes').notNull().default(0),
    timeToGreenMs: integer('time_to_green_ms').notNull().default(0),
    vts: doublePrecision('vts').notNull().default(0),
    vtsPerKloc: doublePrecision('vts_per_kloc').notNull().default(0),
    phaseCount: integer('phase_count').notNull().default(0),
    missingFields: jsonb('missing_fields').default(sql`'[]'::jsonb`),
    emittedAt: timestamp('emitted_at', { withTimezone: true }).notNull(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_mer_model_id').on(table.modelId),
    index('idx_mer_repo_id').on(table.repoId),
    index('idx_mer_emitted_at').on(table.emittedAt),
    index('idx_mer_rollup_status').on(table.rollupStatus),
  ]
);

export const insertModelEfficiencyRollupSchema = createInsertSchema(modelEfficiencyRollups);
export type ModelEfficiencyRollupRow = typeof modelEfficiencyRollups.$inferSelect;
export type InsertModelEfficiencyRollup = typeof modelEfficiencyRollups.$inferInsert;

/**
 * Correlation Trace Spans Table (migration 0020, OMN-5047)
 * Stores individual trace spans emitted by the omniclaude trace emitter.
 * Each span represents a hop in the agent execution flow (routing, tool-call,
 * manifest-injection, etc.) and belongs to a trace_id that groups all spans
 * for a single end-to-end execution.
 */
export const correlationTraceSpans = pgTable(
  'correlation_trace_spans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    correlationId: uuid('correlation_id').notNull(),
    sessionId: text('session_id'),
    spanKind: text('span_kind').notNull(),
    spanName: text('span_name').notNull(),
    status: text('status').notNull().default('ok'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    metadata: jsonb('metadata').default(sql`'{}'::jsonb`),
    projectedAt: timestamp('projected_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_trace_span').on(table.traceId, table.spanId),
    index('idx_cts_trace_id').on(table.traceId),
    index('idx_cts_correlation_id').on(table.correlationId),
    index('idx_cts_session_id').on(table.sessionId),
    index('idx_cts_started_at').on(table.startedAt),
  ]
);

export const insertCorrelationTraceSpanSchema = createInsertSchema(correlationTraceSpans);
export type CorrelationTraceSpanRow = typeof correlationTraceSpans.$inferSelect;
export type InsertCorrelationTraceSpan = typeof correlationTraceSpans.$inferInsert;

// ============================================================================
// Session Outcomes Table (migration 0021, OMN-5184)
// Tracks session-level outcome classifications emitted by omniclaude.
// Source topic: onex.evt.omniclaude.session-outcome.v1
// Replay policy: UPSERT by session_id (latest-state-wins).
// ============================================================================

export const sessionOutcomes = pgTable(
  'session_outcomes',
  {
    sessionId: text('session_id').primaryKey(),
    outcome: text('outcome').notNull(),
    emittedAt: timestamp('emitted_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_session_outcomes_outcome').on(table.outcome),
    index('idx_session_outcomes_emitted_at').on(table.emittedAt),
  ]
);

export const insertSessionOutcomeSchema = createInsertSchema(sessionOutcomes);
export type SessionOutcomeRow = typeof sessionOutcomes.$inferSelect;
export type InsertSessionOutcome = typeof sessionOutcomes.$inferInsert;

// ============================================================================
// Phase Metrics Events Table (migration 0022, OMN-5184)
// Tracks per-phase pipeline metrics emitted by omniclaude phase_instrumentation.
// Source topic: onex.evt.omniclaude.phase-metrics.v1
// Replay policy: APPEND-ONLY with natural dedup key (session_id, phase, emitted_at).
// ============================================================================

export const phaseMetricsEvents = pgTable(
  'phase_metrics_events',
  {
    id: serial('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    ticketId: text('ticket_id'),
    phase: text('phase').notNull(),
    status: text('status').notNull(),
    durationMs: integer('duration_ms').notNull(),
    emittedAt: timestamp('emitted_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_phase_metrics_dedup').on(table.sessionId, table.phase, table.emittedAt),
    index('idx_phase_metrics_session_id').on(table.sessionId),
    index('idx_phase_metrics_phase').on(table.phase),
    index('idx_phase_metrics_emitted_at').on(table.emittedAt),
  ]
);

export const insertPhaseMetricsEventSchema = createInsertSchema(phaseMetricsEvents);
export type PhaseMetricsEventRow = typeof phaseMetricsEvents.$inferSelect;
export type InsertPhaseMetricsEvent = typeof phaseMetricsEvents.$inferInsert;

// ============================================================================
// DoD Verify Runs Table (migration 0023, OMN-5199)
// Tracks DoD verification run completions emitted by omniclaude dod-verify skill.
// Source topic: onex.evt.omniclaude.dod-verify-completed.v1
// Replay policy: INSERT with ON CONFLICT (run_id) DO NOTHING (idempotent).
// ============================================================================

export const dodVerifyRuns = pgTable(
  'dod_verify_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: text('ticket_id').notNull(),
    runId: text('run_id').notNull().unique(),
    sessionId: text('session_id'),
    correlationId: text('correlation_id'),
    totalChecks: integer('total_checks').notNull(),
    passedChecks: integer('passed_checks').notNull(),
    failedChecks: integer('failed_checks').notNull(),
    skippedChecks: integer('skipped_checks').notNull(),
    overallPass: boolean('overall_pass').notNull(),
    policyMode: text('policy_mode').notNull(),
    evidenceItems: jsonb('evidence_items').notNull(),
    eventTimestamp: timestamp('event_timestamp', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_dod_verify_runs_ticket_id').on(table.ticketId),
    index('idx_dod_verify_runs_event_timestamp').on(table.eventTimestamp),
    index('idx_dod_verify_runs_overall_pass').on(table.overallPass),
  ]
);

export const insertDodVerifyRunSchema = createInsertSchema(dodVerifyRuns);
export type DodVerifyRunRow = typeof dodVerifyRuns.$inferSelect;
export type InsertDodVerifyRun = typeof dodVerifyRuns.$inferInsert;

// ============================================================================
// DoD Guard Events Table (migration 0023, OMN-5199)
// Tracks DoD guard decisions emitted by omniclaude dod-guard hook.
// Source topic: onex.evt.omniclaude.dod-guard-fired.v1
// Replay policy: APPEND-ONLY (no natural dedup key).
// ============================================================================

export const dodGuardEvents = pgTable(
  'dod_guard_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: text('ticket_id').notNull(),
    sessionId: text('session_id'),
    guardOutcome: text('guard_outcome').notNull(),
    policyMode: text('policy_mode').notNull(),
    receiptAgeSeconds: numeric('receipt_age_seconds', { precision: 12, scale: 3 }),
    receiptPass: boolean('receipt_pass'),
    eventTimestamp: timestamp('event_timestamp', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_dod_guard_events_ticket_id').on(table.ticketId),
    index('idx_dod_guard_events_event_timestamp').on(table.eventTimestamp),
    index('idx_dod_guard_events_guard_outcome').on(table.guardOutcome),
  ]
);

export const insertDodGuardEventSchema = createInsertSchema(dodGuardEvents);
export type DodGuardEventRow = typeof dodGuardEvents.$inferSelect;
export type InsertDodGuardEvent = typeof dodGuardEvents.$inferInsert;

// ============================================================================
// Intent Drift Events Table (migration 0024, OMN-5281)
// Tracks when agent intent drifts from the original plan.
// Source topic: onex.evt.omniintelligence.intent-drift-detected.v1
// Replay policy: APPEND-ONLY (no natural dedup key).
// ============================================================================

export const intentDriftEvents = pgTable(
  'intent_drift_events',
  {
    id: serial('id').primaryKey(),
    sessionId: text('session_id'),
    originalIntent: text('original_intent'),
    currentIntent: text('current_intent'),
    driftScore: real('drift_score'),
    severity: text('severity'), // low, medium, high, critical
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_intent_drift_session').on(table.sessionId)]
);

export type IntentDriftRow = typeof intentDriftEvents.$inferSelect;
export type InsertIntentDrift = typeof intentDriftEvents.$inferInsert;

// ============================================================================
// LLM Health Snapshots Table (migration 0024_llm_health_snapshots, OMN-5279)
// Tracks per-endpoint health metrics for LLM inference servers.
// Source topic: onex.evt.omnibase-infra.llm-health-snapshot.v1
// Replay policy: APPEND-ONLY.
// ============================================================================

export const llmHealthSnapshots = pgTable(
  'llm_health_snapshots',
  {
    id: serial('id').primaryKey(),
    modelId: text('model_id').notNull(),
    endpointUrl: text('endpoint_url').notNull(),
    latencyP50Ms: integer('latency_p50_ms'),
    latencyP99Ms: integer('latency_p99_ms'),
    errorRate: doublePrecision('error_rate'),
    tokensPerSecond: doublePrecision('tokens_per_second'),
    status: text('status').notNull().default('unknown'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_llm_health_model_id').on(table.modelId),
    index('idx_llm_health_created_at').on(table.createdAt),
    index('idx_llm_health_status').on(table.status),
    // Composite index for the primary read pattern: latest snapshot per model_id
    index('idx_llm_health_model_created').on(table.modelId, table.createdAt),
  ]
);

export const insertLlmHealthSnapshotSchema = createInsertSchema(llmHealthSnapshots);
export type LlmHealthSnapshotRow = typeof llmHealthSnapshots.$inferSelect;
export type InsertLlmHealthSnapshot = typeof llmHealthSnapshots.$inferInsert;

// ============================================================================
// Routing Feedback Events Table (migration 0024_routing_feedback_events, OMN-5284)
// Tracks per-event routing feedback for the Routing Feedback Dashboard.
// Source topic: onex.evt.omniintelligence.routing-feedback-processed.v1
// Replay policy: APPEND-ONLY.
// ============================================================================

export const routingFeedbackEvents = pgTable(
  'routing_feedback_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: text('agent_id').notNull(),
    feedbackType: text('feedback_type').notNull(),
    originalRoute: text('original_route').notNull(),
    correctedRoute: text('corrected_route'),
    accuracyScore: doublePrecision('accuracy_score'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_routing_feedback_agent_id').on(table.agentId),
    index('idx_routing_feedback_created_at').on(table.createdAt),
    index('idx_routing_feedback_type').on(table.feedbackType),
  ]
);

export const insertRoutingFeedbackEventSchema = createInsertSchema(routingFeedbackEvents);
export type RoutingFeedbackEventRow = typeof routingFeedbackEvents.$inferSelect;
export type InsertRoutingFeedbackEvent = typeof routingFeedbackEvents.$inferInsert;

// ============================================================================
// Compliance Evaluations Table (migration 0024_compliance_evaluations, OMN-5285)
// Tracks per-evaluation compliance results for the Compliance Dashboard.
// Source topic: onex.evt.omniintelligence.compliance-evaluated.v1
// Replay policy: APPEND-ONLY with evaluation_id as natural dedup key.
// ============================================================================

export const complianceEvaluations = pgTable(
  'compliance_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evaluationId: text('evaluation_id').notNull().unique(),
    repo: text('repo').notNull(),
    ruleSet: text('rule_set').notNull(),
    score: real('score').notNull(),
    violations: jsonb('violations').default([]),
    pass: boolean('pass').notNull(),
    eventTimestamp: timestamp('event_timestamp', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_compliance_evaluations_repo').on(table.repo),
    index('idx_compliance_evaluations_rule_set').on(table.ruleSet),
    index('idx_compliance_evaluations_event_timestamp').on(table.eventTimestamp),
    index('idx_compliance_evaluations_pass').on(table.pass),
  ]
);

export const insertComplianceEvaluationSchema = createInsertSchema(complianceEvaluations);
export type ComplianceEvaluationRow = typeof complianceEvaluations.$inferSelect;
export type InsertComplianceEvaluation = typeof complianceEvaluations.$inferInsert;

// ============================================================================
// Memory Documents Table (migration 0024_omnimemory_tables, OMN-5290)
// Tracks ingested documents in the OmniMemory store (one row per document,
// upserted on document_id).
// Source topics:
//   onex.evt.omnimemory.document-discovered.v1
//   onex.evt.omnimemory.memory-stored.v1
//   onex.evt.omnimemory.memory-expired.v1
// ============================================================================

export const memoryDocuments = pgTable(
  'memory_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: text('document_id').notNull().unique(),
    sourcePath: text('source_path'),
    sourceType: text('source_type'),
    contentHash: text('content_hash'),
    sizeBytes: integer('size_bytes'),
    status: text('status').notNull().default('discovered'),
    memoryBackend: text('memory_backend'),
    correlationId: text('correlation_id'),
    sessionId: text('session_id'),
    eventTimestamp: timestamp('event_timestamp', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_memory_documents_event_timestamp').on(table.eventTimestamp),
    index('idx_memory_documents_status').on(table.status),
    index('idx_memory_documents_source_type').on(table.sourceType),
  ]
);

export type MemoryDocumentRow = typeof memoryDocuments.$inferSelect;
export type InsertMemoryDocument = typeof memoryDocuments.$inferInsert;

// ============================================================================
// Memory Retrievals Table (migration 0024_omnimemory_tables, OMN-5290)
// Append-only log of OmniMemory retrieval responses.
// Source topic: onex.evt.omnimemory.memory-retrieval-response.v1
// ============================================================================

export const memoryRetrievals = pgTable(
  'memory_retrievals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correlationId: text('correlation_id'),
    sessionId: text('session_id'),
    queryType: text('query_type'),
    resultCount: integer('result_count').notNull().default(0),
    success: boolean('success').notNull().default(true),
    latencyMs: integer('latency_ms'),
    errorMessage: text('error_message'),
    eventTimestamp: timestamp('event_timestamp', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_memory_retrievals_event_timestamp').on(table.eventTimestamp),
    index('idx_memory_retrievals_success').on(table.success),
    index('idx_memory_retrievals_session_id').on(table.sessionId),
  ]
);

export type MemoryRetrievalRow = typeof memoryRetrievals.$inferSelect;
export type InsertMemoryRetrieval = typeof memoryRetrievals.$inferInsert;

// ============================================================================
// Skill Invocations Table (OMN-5278)
// Tracks each skill invocation event from the omniclaude agent.
// Source topic: onex.evt.omniclaude.skill-invoked.v1
// Replay policy: APPEND-ONLY.
// ============================================================================

export const skillInvocations = pgTable(
  'skill_invocations',
  {
    id: serial('id').primaryKey(),
    skillName: text('skill_name').notNull(),
    sessionId: text('session_id'),
    durationMs: integer('duration_ms'),
    success: boolean('success').notNull().default(true),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_skill_invocations_name').on(table.skillName),
    index('idx_skill_invocations_ts').on(table.createdAt),
  ]
);

export const insertSkillInvocationSchema = createInsertSchema(skillInvocations);
export type SkillInvocationRow = typeof skillInvocations.$inferSelect;
export type InsertSkillInvocation = typeof skillInvocations.$inferInsert;
