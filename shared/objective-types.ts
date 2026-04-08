// SPDX-License-Identifier: MIT
/**
 * Objective Evaluation Types (OMN-2583)
 *
 * Shared type definitions for the objective evaluation dashboard panels:
 * - Score Vector visualization (radar chart per layer/dimension)
 * - Gate Failure Timeline (time-series by GateType)
 * - Policy State History (lifecycle transitions per PolicyType)
 * - Anti-Gaming Alert Feed (Goodhart, reward hacking, distributional shift)
 *
 * Data sourced from PostgreSQL: objective_evaluations, policy_state tables.
 * Backend populated by OMN-2545 (ScoringReducer) and OMN-2557 (PolicyState).
 */

// ============================================================================
// Score Vector
// ============================================================================

/**
 * Six independent scoring dimensions from ScoreVector (OMN-2537).
 * Never collapsed to a scalar — each dimension is shown independently.
 */
export interface ScoreVectorDimensions {
  correctness: number;
  safety: number;
  cost: number;
  latency: number;
  maintainability: number;
  human_time: number;
}

/**
 * A single score vector data point for one evaluation.
 * Used to render one radar chart entry.
 */
export interface ScoreVectorPoint {
  /** ISO-8601 timestamp of the evaluation */
  evaluated_at: string;
  /** Session or task identifier */
  session_id: string;
  /** Agent name */
  agent_name: string;
  /** Task class label */
  task_class: string;
  /** The six-dimensional score vector */
  scores: ScoreVectorDimensions;
  /** Evaluation ID for drill-down */
  evaluation_id: string;
}

/** Aggregated (mean) score vector for a filter context (session/agent/task). */
export interface ScoreVectorAggregate {
  context_label: string;
  scores: ScoreVectorDimensions;
  sample_count: number;
}

export interface ScoreVectorSummaryResponse {
  /** Individual evaluation points for scatter/trace */
  points: ScoreVectorPoint[];
  /** Per-context aggregates for radar overlay */
  aggregates: ScoreVectorAggregate[];
  /** Available sessions for filter dropdown */
  sessions: string[];
  /** Available agent names for filter dropdown */
  agents: string[];
  /** Available task classes for filter dropdown */
  task_classes: string[];
}

// ============================================================================
// Gate Failure Timeline
// ============================================================================

/** Gate types from OMN-2537 GateType enum. */
export type GateType =
  | 'safety_hard'
  | 'safety_soft'
  | 'correctness'
  | 'cost_budget'
  | 'latency_budget'
  | 'maintainability'
  | 'human_time'
  | 'custom';

/** A single gate failure event on the timeline. */
export interface GateFailureEvent {
  /** ISO-8601 timestamp */
  occurred_at: string;
  gate_type: GateType;
  /** Session that triggered the failure */
  session_id: string;
  /** Agent involved */
  agent_name: string;
  /** The EvaluationResult ID for drill-down */
  evaluation_id: string;
  /** Attribution references (tool calls, evidence) */
  attribution_refs: string[];
  /** Actual score value that failed the gate */
  score_value: number;
  /** Threshold that was violated */
  threshold: number;
  /** True if this session had more failures than the previous window */
  increased_vs_prev_window: boolean;
}

/** Binned count for the time-series chart. */
export interface GateFailureBin {
  /** ISO-8601 bin start (hourly or daily depending on range) */
  bin_start: string;
  /** Total failures in this bin */
  total: number;
  /** Breakdown by gate type */
  by_gate_type: Partial<Record<GateType, number>>;
}

export interface GateFailureTimelineResponse {
  bins: GateFailureBin[];
  /** All individual failures (for drill-down table) */
  events: GateFailureEvent[];
  /** Summary counts per gate type */
  totals_by_gate_type: Partial<Record<GateType, number>>;
  total_failures: number;
  /** Sessions with increasing failures vs previous window */
  escalating_sessions: string[];
}

// ============================================================================
// Policy State History
// ============================================================================

/** Policy types from OMN-2557 PolicyType enum. */
export type PolicyType =
  | 'scoring'
  | 'routing'
  | 'enforcement'
  | 'delegation'
  | 'cost'
  | 'safety'
  | 'custom';

/** Policy lifecycle states. */
export type PolicyLifecycleState = 'candidate' | 'validated' | 'promoted' | 'deprecated';

/** A policy state snapshot at a point in time. */
export interface PolicyStatePoint {
  /** ISO-8601 timestamp */
  recorded_at: string;
  policy_id: string;
  policy_type: PolicyType;
  policy_version: string;
  lifecycle_state: PolicyLifecycleState;
  reliability_0_1: number;
  confidence_0_1: number;
  /** Whether this was a lifecycle transition (for timeline marker) */
  is_transition: boolean;
  /** Whether this point represents an auto-blacklist event */
  is_auto_blacklist: boolean;
  /** Whether a system.alert.tool_degraded event is associated */
  has_tool_degraded_alert: boolean;
  /** Alert message if has_tool_degraded_alert is true */
  tool_degraded_message?: string;
}

export interface PolicyStateHistoryResponse {
  /** Points ordered ascending by recorded_at */
  points: PolicyStatePoint[];
  /** Available policy IDs for filter */
  policy_ids: string[];
  /** Available policy types for filter */
  policy_types: PolicyType[];
  /** Summary: current state per policy */
  current_states: Array<{
    policy_id: string;
    policy_type: PolicyType;
    lifecycle_state: PolicyLifecycleState;
    reliability_0_1: number;
    confidence_0_1: number;
  }>;
}

// ============================================================================
// Anti-Gaming Alert Feed
// ============================================================================

export type AntiGamingAlertType = 'goodhart_violation' | 'reward_hacking' | 'distributional_shift';

export interface AntiGamingAlert {
  alert_id: string;
  alert_type: AntiGamingAlertType;
  /** ISO-8601 timestamp when alert was triggered */
  triggered_at: string;
  /** The metric that was gamed (e.g. "correctness") */
  metric_name: string;
  /** The paired proxy metric that diverged */
  proxy_metric: string;
  /** Delta that triggered the alert */
  delta: number;
  /** Human-readable description */
  description: string;
  /** Session that triggered it */
  session_id: string;
  /** Whether this alert has been acknowledged */
  acknowledged: boolean;
  /** ISO-8601 timestamp of acknowledgement */
  acknowledged_at?: string;
}

export interface AntiGamingAlertFeedResponse {
  alerts: AntiGamingAlert[];
  total_unacknowledged: number;
}

// ============================================================================
// Time Window
// ============================================================================

export type ObjectiveTimeWindow = '24h' | '7d' | '30d' | 'all';
