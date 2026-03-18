/**
 * Context Effectiveness Dashboard Types (OMN-5286)
 *
 * Shared types for the /context-effectiveness page.
 * Data is sourced from injection_effectiveness table, event_type='context_utilization'.
 *
 * Metrics:
 * - Context utilization by detection_method (used / injected ratio)
 * - Utilization score distribution over time
 * - Effectiveness score trend (avg utilization_score)
 * - Patterns count distribution
 * - Session outcome breakdown
 */

export type ContextEffectivenessTimeWindow = '24h' | '7d' | '30d';

/**
 * Summary metrics for the hero cards.
 */
export interface ContextEffectivenessSummary {
  /** Average utilization score across all sessions (0–1) */
  avg_utilization_score: number;
  /** Total sessions with context injection */
  total_injected_sessions: number;
  /** Sessions where injection occurred */
  injection_occurred_count: number;
  /** Injection rate (injection_occurred / total) */
  injection_rate: number;
  /** Average patterns count per injection */
  avg_patterns_count: number;
  /** Cache hit rate across injected sessions */
  cache_hit_rate: number;
  /** Most common utilization method */
  top_utilization_method: string | null;
}

/**
 * Utilization score bucketed by detection method.
 */
export interface UtilizationByMethod {
  method: string;
  avg_score: number;
  session_count: number;
  injection_rate: number;
}

/**
 * Effectiveness score trend — one data point per time bucket.
 */
export interface EffectivenessTrendPoint {
  /** ISO date string truncated to the bucket boundary */
  date: string;
  avg_utilization_score: number;
  session_count: number;
  injection_rate: number;
}

/**
 * Session outcome breakdown for the pie / bar chart.
 */
export interface OutcomeBreakdown {
  outcome: string;
  count: number;
  avg_utilization_score: number;
}

/**
 * Low-utilization sessions (utilization_score < 0.3) for the alert table.
 */
export interface LowUtilizationSession {
  session_id: string;
  correlation_id: string;
  agent_name: string | null;
  detection_method: string | null;
  utilization_score: number;
  patterns_count: number | null;
  session_outcome: string | null;
  occurred_at: string;
}
