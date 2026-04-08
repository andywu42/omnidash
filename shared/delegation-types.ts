/**
 * Delegation Metrics Types (OMN-2284)
 *
 * Shared type definitions for the delegation metrics dashboard.
 * Events consumed from:
 *   - onex.evt.omniclaude.task-delegated.v1
 *   - onex.evt.omniclaude.delegation-shadow-comparison.v1
 *
 * The dashboard tracks task delegation rate, cost savings, quality gate
 * pass/fail rate, and shadow validation divergence.
 */

// ============================================================================
// Kafka Event Schemas
// ============================================================================

/**
 * Raw event payload from `onex.evt.omniclaude.task-delegated.v1`.
 *
 * Emitted by the omniclaude delegation hook whenever a task is delegated
 * to a sub-agent (polymorphic or specialist).
 */
export interface TaskDelegatedEvent {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Unique correlation ID for this delegation */
  correlation_id: string;
  /** Parent session ID */
  session_id?: string;
  /** Task type (e.g. "code-review", "refactor", "test-generation") */
  task_type: string;
  /** Agent that received the delegated task */
  delegated_to: string;
  /** Agent that initiated the delegation */
  delegated_by?: string;
  /**
   * Whether this delegation passed all quality gates before being accepted.
   * GOLDEN METRIC: quality_gate_passed rate target >80%.
   */
  quality_gate_passed: boolean;
  /** Names of quality gates checked (e.g. ["type-check", "lint", "test"]) */
  quality_gates_checked?: string[];
  /** Names of quality gates that failed (empty if all passed) */
  quality_gates_failed?: string[];
  /** Estimated cost of the delegated task (USD) */
  cost_usd?: number;
  /** Estimated cost savings vs. non-delegated execution (USD) */
  cost_savings_usd?: number;
  /** Latency of the delegation handoff in milliseconds */
  delegation_latency_ms?: number;
  /** Repository context */
  repo?: string;
  /** Whether this is a shadow delegation (not actually executed) */
  is_shadow?: boolean;
}

/**
 * Raw event payload from `onex.evt.omniclaude.delegation-shadow-comparison.v1`.
 *
 * Emitted when a shadow delegation result is compared to the primary
 * delegation result to measure divergence.
 */
export interface DelegationShadowComparisonEvent {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Correlation ID linking to the original task-delegated event */
  correlation_id: string;
  /** Session ID */
  session_id?: string;
  /** Task type */
  task_type: string;
  /** Primary agent that handled the task */
  primary_agent: string;
  /** Shadow agent that was compared against */
  shadow_agent: string;
  /**
   * Whether the shadow agent's output diverged from the primary agent.
   * GOLDEN METRIC: divergence_detected rate should be monitored.
   */
  divergence_detected: boolean;
  /** Divergence score (0–1, 0 = identical, 1 = completely different) */
  divergence_score?: number;
  /** Latency of the primary agent (ms) */
  primary_latency_ms?: number;
  /** Latency of the shadow agent (ms) */
  shadow_latency_ms?: number;
  /** Cost of the primary execution (USD) */
  primary_cost_usd?: number;
  /** Cost of the shadow execution (USD) */
  shadow_cost_usd?: number;
  /** Human-readable description of the divergence (if detected) */
  divergence_reason?: string;
}

// ============================================================================
// API Response Types
// ============================================================================

/** Aggregate summary metrics for the delegation dashboard hero cards. */
export interface DelegationSummary {
  /** Total delegation events in the window */
  total_delegations: number;
  /**
   * Delegation rate — fraction of tasks that were delegated (0–1).
   * Tracks delegation adoption over time.
   */
  delegation_rate: number;
  /**
   * Quality gate pass rate (0–1).
   * GOLDEN METRIC: target >80%. Below 60% triggers an alert.
   */
  quality_gate_pass_rate: number;
  /** Total cost savings from delegation in USD */
  total_cost_savings_usd: number;
  /** Average cost savings per delegation in USD */
  avg_cost_savings_usd: number;
  /** Shadow divergence rate (0–1) — fraction of shadow comparisons that diverged */
  shadow_divergence_rate: number;
  /** Total shadow comparisons in the window */
  total_shadow_comparisons: number;
  /** Average delegation latency (ms) */
  avg_delegation_latency_ms: number;
  /** Absolute counts */
  counts: {
    total: number;
    quality_gate_passed: number;
    quality_gate_failed: number;
    shadow_diverged: number;
    shadow_agreed: number;
  };
  /** Rolling trend for quality gate pass rate over the selected window */
  quality_gate_trend: Array<{ date: string; value: number }>;
}

/** Delegation breakdown by task type. */
export interface DelegationByTaskType {
  /** Task type label */
  task_type: string;
  /** Total delegations of this type */
  total: number;
  /** Delegations that passed quality gates */
  quality_gate_passed: number;
  /** Quality gate pass rate for this task type (0–1) */
  quality_gate_pass_rate: number;
  /** Total cost savings for this task type (USD) */
  total_cost_savings_usd: number;
  /** Average cost savings per delegation of this type (USD) */
  avg_cost_savings_usd: number;
  /** Average delegation latency for this type (ms) */
  avg_latency_ms: number;
  /** Number of shadow divergences for this type */
  shadow_divergences: number;
}

/** Cost savings trend data point. */
export interface DelegationCostSavingsTrendPoint {
  /** Date label (ISO-8601 date string, e.g. "2026-02-17") */
  date: string;
  /** Cumulative cost savings in this period (USD) */
  cost_savings_usd: number;
  /** Total delegation cost in this period (USD) */
  total_cost_usd: number;
  /** Total delegations in this period */
  total_delegations: number;
  /** Average cost savings per delegation in this period */
  avg_savings_usd: number;
}

/** Quality gate pass/fail data point. */
export interface DelegationQualityGatePoint {
  /** Date label (ISO-8601 date string) */
  date: string;
  /** Quality gate pass rate (0–1) */
  pass_rate: number;
  /** Total delegations checked against quality gates */
  total_checked: number;
  /** Number that passed */
  passed: number;
  /** Number that failed */
  failed: number;
}

/** Shadow validation divergence data point for the table. */
export interface DelegationShadowDivergence {
  /** Timestamp of the most recent divergence for this pair */
  occurred_at: string;
  /** Primary agent */
  primary_agent: string;
  /** Shadow agent */
  shadow_agent: string;
  /** Task type */
  task_type: string;
  /** Number of divergences for this pair in the window */
  count: number;
  /** Average divergence score (0–1) */
  avg_divergence_score: number;
  /** Average primary latency (ms) */
  avg_primary_latency_ms: number;
  /** Average shadow latency (ms) */
  avg_shadow_latency_ms: number;
}

/** Multi-metric trend data point for the main chart. */
export interface DelegationTrendPoint {
  /** Date label (ISO-8601 date string) */
  date: string;
  /** Quality gate pass rate in this period (0–1) */
  quality_gate_pass_rate: number;
  /** Shadow divergence rate in this period (0–1) */
  shadow_divergence_rate: number;
  /** Total cost savings in this period (USD) */
  cost_savings_usd: number;
  /** Total delegations in this period */
  total_delegations: number;
}

/** Delegation breakdown by model (delegated_to agent/model). */
export interface DelegationByModel {
  /** Model/agent name (from delegated_to field) */
  model: string;
  /** Total delegations to this model */
  total: number;
  /** Delegations that passed quality gates */
  quality_gate_passed: number;
  /** Quality gate pass rate for this model (0-1) */
  quality_gate_pass_rate: number;
  /** Average delegation latency for this model (ms) */
  avg_latency_ms: number;
  /** Total cost savings for this model (USD) */
  total_cost_savings_usd: number;
  /** Average cost savings per delegation for this model (USD) */
  avg_cost_savings_usd: number;
}

/** Valid time windows for delegation dashboard queries. */
export type DelegationTimeWindow = '24h' | '7d' | '30d' | 'all';
