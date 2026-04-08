/**
 * Pattern Enforcement Types (OMN-2275)
 *
 * Shared type definitions for the pattern enforcement dashboard.
 * Events consumed from: onex.evt.omniclaude.pattern-enforcement.v1
 */

// ============================================================================
// Kafka Event Schema
// ============================================================================

/**
 * Raw event payload from `onex.evt.omniclaude.pattern-enforcement.v1`.
 *
 * Emitted by OMN-2270 (enforcement feedback loop) whenever the enforcement
 * engine evaluates code against a known pattern.
 */
export interface PatternEnforcementEvent {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Unique correlation ID for this enforcement evaluation */
  correlation_id: string;
  /** Session ID (if available) */
  session_id?: string;
  /** Repository where enforcement ran */
  repo?: string;
  /** Language of the code being evaluated */
  language: string;
  /** Domain / category (e.g. "api", "validation", "error-handling") */
  domain: string;
  /** Name of the pattern that was evaluated */
  pattern_name: string;
  /** Pattern lifecycle state when enforcement ran */
  pattern_lifecycle_state?: string;
  /**
   * Enforcement outcome:
   * - hit: pattern was applied and accepted
   * - violation: pattern was evaluated and rejected
   * - corrected: a violation was detected and then corrected
   * - false_positive: enforcement flagged valid code incorrectly
   */
  outcome: 'hit' | 'violation' | 'corrected' | 'false_positive';
  /** Confidence score of the enforcement decision (0–1) */
  confidence?: number;
  /** Agent name that triggered enforcement */
  agent_name?: string;
}

// ============================================================================
// API Response Types
// ============================================================================

/** Aggregate summary metrics for the enforcement dashboard hero cards. */
export interface EnforcementSummary {
  /** Total enforcement evaluations in the window */
  total_evaluations: number;
  /** Hit rate = hits / total_evaluations (0–1) */
  hit_rate: number;
  /**
   * Correction rate = corrected / (violations + corrected) (0–1)
   * GOLDEN METRIC: measures how often violations are self-corrected.
   */
  correction_rate: number;
  /** False positive rate = false_positives / total_evaluations (0–1) */
  false_positive_rate: number;
  /** Number of distinct violated patterns */
  violated_pattern_count: number;
  /** Absolute counts for each outcome */
  counts: {
    hits: number;
    violations: number;
    corrected: number;
    false_positives: number;
  };
  /** Rolling trend for correction rate over the selected window (array of {date, value} points) */
  correction_rate_trend: Array<{ date: string; value: number }>;
}

/** Enforcement hit rate broken down by language. */
export interface EnforcementByLanguage {
  language: string;
  evaluations: number;
  hits: number;
  violations: number;
  corrected: number;
  false_positives: number;
  /** Hit rate (0–1) for this language */
  hit_rate: number;
}

/** Enforcement hit rate broken down by domain. */
export interface EnforcementByDomain {
  domain: string;
  evaluations: number;
  hits: number;
  violations: number;
  corrected: number;
  false_positives: number;
  /** Hit rate (0–1) for this domain */
  hit_rate: number;
}

/** A single entry in the "Top Violated Patterns" table. */
export interface ViolatedPattern {
  pattern_name: string;
  violation_count: number;
  corrected_count: number;
  /** Correction rate for this pattern specifically (0–1) */
  correction_rate: number;
  /** Most recent violation timestamp (ISO-8601) */
  last_violation_at: string;
  language?: string;
  domain?: string;
}

/** Time-series data point for trend charts. */
export interface EnforcementTrendPoint {
  /** Date label (ISO-8601 date string, e.g. "2026-02-17") */
  date: string;
  hit_rate: number;
  correction_rate: number;
  false_positive_rate: number;
  total_evaluations: number;
}

/** Valid time windows for enforcement dashboard queries. */
export type EnforcementTimeWindow = '24h' | '7d' | '30d' | 'all';
