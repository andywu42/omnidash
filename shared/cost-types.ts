/**
 * Cost Trend Dashboard Types (OMN-2242)
 *
 * Shared types for the LLM cost and token usage trend dashboard.
 * Supports reported-only vs estimated data toggle, budget threshold
 * alerts, and drill-down by model/repo/pattern/session.
 */

// ============================================================================
// Usage Source Classification
// ============================================================================

/** How the usage data was obtained. */
export type UsageSource = 'API' | 'ESTIMATED' | 'MISSING';

// ============================================================================
// Time Window
// ============================================================================

/** Supported time windows for trend queries. */
export type CostTimeWindow = '24h' | '7d' | '30d' | 'all';

// ============================================================================
// Cost Per Session (Line Chart)
// ============================================================================

/** A single data point in the cost-over-time line chart. */
export interface CostTrendPoint {
  /** ISO date string (YYYY-MM-DD or YYYY-MM-DDTHH:mm). */
  timestamp: string;
  /** Total cost in USD for this bucket. */
  total_cost_usd: number;
  /** Cost from API-reported data only. */
  reported_cost_usd: number;
  /** Cost from estimated/missing data. */
  estimated_cost_usd: number;
  /** Number of sessions in this bucket. */
  session_count: number;
}

// ============================================================================
// Cost by Model (Bar Chart)
// ============================================================================

/** Aggregate cost for a single LLM model. */
export interface CostByModel {
  model_name: string;
  total_cost_usd: number;
  reported_cost_usd: number;
  estimated_cost_usd: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  request_count: number;
  usage_source: UsageSource;
}

// ============================================================================
// Cost by Repo (Bar Chart)
// ============================================================================

/** Aggregate cost for a single repository. */
export interface CostByRepo {
  repo_name: string;
  total_cost_usd: number;
  reported_cost_usd: number;
  estimated_cost_usd: number;
  total_tokens: number;
  session_count: number;
  usage_source: UsageSource;
}

// ============================================================================
// Cost by Pattern (Table)
// ============================================================================

/** Per-pattern token costs and injection frequency. */
export interface CostByPattern {
  pattern_id: string;
  pattern_name: string;
  total_cost_usd: number;
  reported_cost_usd: number;
  estimated_cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  injection_count: number;
  avg_cost_per_injection: number;
  usage_source: UsageSource;
}

// ============================================================================
// Token Usage Breakdown (Stacked Bar)
// ============================================================================

/** Token breakdown for a time bucket (prompt vs completion). */
export interface TokenUsagePoint {
  timestamp: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  usage_source: UsageSource;
}

// ============================================================================
// Budget Threshold Alert
// ============================================================================

/** A configurable budget alert threshold. */
export interface BudgetAlert {
  id: string;
  name: string;
  /** Dollar threshold that triggers the alert. */
  threshold_usd: number;
  /** Time window for the threshold (daily, weekly, monthly). */
  period: 'daily' | 'weekly' | 'monthly';
  /** Current spend in the current period. */
  current_spend_usd: number;
  /** Percentage of threshold consumed (0-100+). */
  utilization_pct: number;
  /** Whether the alert is currently triggered. */
  is_triggered: boolean;
  /** When the alert was last evaluated. */
  last_evaluated: string;
}

// ============================================================================
// Summary / Dashboard Overview
// ============================================================================

/** Top-level summary metrics for the cost dashboard. */
export interface CostSummary {
  /** Total spend in the selected time window. */
  total_cost_usd: number;
  /** Spend from API-reported data only. */
  reported_cost_usd: number;
  /** Spend from estimated/missing data. */
  estimated_cost_usd: number;
  /** Percentage of data that is API-reported (0-100). */
  reported_coverage_pct: number;
  /** Total tokens consumed. */
  total_tokens: number;
  /** Total prompt tokens. */
  prompt_tokens: number;
  /** Total completion tokens. */
  completion_tokens: number;
  /** Number of sessions in the window. */
  session_count: number;
  /** Number of unique models used. */
  model_count: number;
  /** Average cost per session. */
  avg_cost_per_session: number;
  /** Percentage change from previous period. */
  cost_change_pct: number;
  /** Number of budget alerts currently triggered. */
  active_alerts: number;
}
