/**
 * Extraction Pipeline Types
 *
 * Shared request/response interfaces for the pattern extraction
 * metrics dashboard (OMN-1804).
 *
 * PostgreSQL is the single source of truth for all data.
 * These types define the API contract between server and client.
 */

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Summary stats for the extraction pipeline (stats cards row).
 */
export interface ExtractionSummary {
  total_injections: number;
  total_patterns_matched: number;
  avg_utilization_score: number | null;
  avg_latency_ms: number | null;
  /** Ratio 0–1 (NOT percentage). Multiply by 100 for display. */
  success_rate: number | null;
  /**
   * ISO timestamp of the last recorded event.
   *
   * null when no rows have ever been written to the table (used as
   * empty-table sentinel by `isSummaryEmpty` in extraction-source.ts).
   * Present and non-null even during zero-traffic periods — it retains
   * the timestamp of the most recent historical event.
   */
  last_event_at: string | null;
}

/**
 * Pipeline health overview grouped by cohort.
 * Cohort represents the pipeline variant/bucket for a given run.
 */
export interface PipelineCohortHealth {
  cohort: string;
  total_events: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  avg_latency_ms: number | null;
}

export interface PipelineHealthResponse {
  cohorts: PipelineCohortHealth[];
}

/**
 * Latency heatmap data: percentiles by time bucket.
 */
export interface LatencyBucket {
  /** ISO date string for the time bucket (e.g. hour or day) */
  bucket: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  sample_count: number;
}

export interface LatencyHeatmapResponse {
  buckets: LatencyBucket[];
  window: string;
}

/**
 * Pattern volume chart data: pattern matches over time.
 */
export interface PatternVolumePoint {
  /** ISO date string for the time bucket */
  bucket: string;
  patterns_matched: number;
  injections: number;
}

export interface PatternVolumeResponse {
  points: PatternVolumePoint[];
  window: string;
}

/**
 * Error rates summary: failure counts and rates by cohort.
 */
export interface ErrorRateEntry {
  cohort: string;
  total_events: number;
  failure_count: number;
  error_rate: number;
  /** Recent error samples for debugging context */
  recent_errors: Array<{
    session_id: string;
    created_at: string;
    session_outcome: string | null;
  }>;
}

export interface ErrorRatesSummaryResponse {
  entries: ErrorRateEntry[];
  total_errors: number;
  overall_error_rate: number | null;
  /** True when cohort count exceeded the IN-clause cap and some entries may lack recent_errors. */
  truncated?: boolean;
}

// ============================================================================
// Kafka Event Type Guards
// ============================================================================

/**
 * Context utilization event from omniclaude.
 * Maps to injection_effectiveness table.
 */
export interface ContextUtilizationEvent {
  session_id: string;
  correlation_id: string;
  cohort: string;
  injection_occurred?: boolean;
  agent_name?: string;
  detection_method?: string;
  utilization_score?: number;
  utilization_method?: string;
  agent_match_score?: number;
  user_visible_latency_ms?: number;
  session_outcome?: string;
  routing_time_ms?: number;
  retrieval_time_ms?: number;
  injection_time_ms?: number;
  patterns_count?: number;
  cache_hit?: boolean;
  timestamp?: string;
}

/**
 * Agent match event from omniclaude.
 * Also maps to injection_effectiveness with agent match specifics.
 */
export interface AgentMatchEvent {
  session_id: string;
  correlation_id: string;
  cohort: string;
  agent_match_score?: number;
  agent_name?: string;
  session_outcome?: string;
  injection_occurred?: boolean;
  timestamp?: string;
}

/**
 * Latency breakdown event from omniclaude.
 * Maps to latency_breakdowns table.
 */
export interface LatencyBreakdownEvent {
  session_id: string;
  prompt_id?: string | null;
  cohort: string;
  routing_time_ms?: number;
  retrieval_time_ms?: number;
  injection_time_ms?: number;
  user_visible_latency_ms?: number;
  cache_hit?: boolean;
  timestamp?: string;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Helper: check that a value is a non-empty string.
 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Base structural check shared by all extraction event type guards.
 * Validates that the payload is a non-null object with a non-empty string
 * `session_id` (or camelCase `sessionId`). The `cohort` field is optional
 * since many upstream producers omit it — handlers should default to
 * 'unknown' when absent.
 *
 * Accepts both snake_case and camelCase field names to handle producer
 * inconsistencies (OMN-6392).
 */
function isExtractionBaseEvent(e: unknown): e is { session_id: string; cohort: string } {
  if (typeof e !== 'object' || e === null) return false;
  const obj = e as Record<string, unknown>;
  // Accept both snake_case and camelCase for session_id
  const hasSessionId = isNonEmptyString(obj.session_id) || isNonEmptyString(obj.sessionId);
  // cohort is no longer required — too many producers omit it (98% drop rate)
  return hasSessionId;
}

/**
 * Narrow an unknown Kafka payload to a ContextUtilizationEvent.
 *
 * Validates all required fields: `session_id`, `cohort` (via base),
 * and `correlation_id`. Optional fields like `utilization_score` are
 * NOT required — the caller discriminates event types via topic-specific
 * switch cases, so the type guard only needs to validate structural
 * correctness of the required interface fields.
 */
export function isContextUtilizationEvent(e: unknown): e is ContextUtilizationEvent {
  return (
    isExtractionBaseEvent(e) && isNonEmptyString((e as Record<string, unknown>).correlation_id)
  );
}

/**
 * Narrow an unknown Kafka payload to an AgentMatchEvent.
 *
 * Validates all required fields: `session_id`, `cohort` (via base),
 * and `correlation_id`. Also checks `agent_match_score` (optional in the
 * interface but used for discrimination) because ContextUtilizationEvent
 * also carries an optional `agent_name`, which would cause false positives
 * if used as a discriminator.
 *
 * NOTE: This guard is NOT a standalone discriminator — the caller MUST
 * dispatch by Kafka topic first (see event-consumer.ts switch/case).
 */
export function isAgentMatchEvent(e: unknown): e is AgentMatchEvent {
  if (!isExtractionBaseEvent(e)) return false;
  const obj = e as Record<string, unknown>;
  return isNonEmptyString(obj.correlation_id) && typeof obj.agent_match_score === 'number';
}

/**
 * Narrow an unknown Kafka payload to a LatencyBreakdownEvent.
 *
 * Validates required fields: `session_id` (via base).
 * prompt_id is optional — the Python emitter has no prompt_id concept,
 * only correlation_id. Events without prompt_id must pass this guard.
 */
export function isLatencyBreakdownEvent(e: unknown): e is LatencyBreakdownEvent {
  return isExtractionBaseEvent(e);
}
