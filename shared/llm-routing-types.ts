/**
 * LLM Routing Effectiveness Types (OMN-2279)
 *
 * Shared type definitions for the LLM routing effectiveness dashboard.
 * Events consumed from: onex.evt.omniclaude.llm-routing-decision.v1
 *
 * The dashboard compares LLM-based agent routing vs. fuzzy-string routing
 * to measure how well the two methods agree and highlight divergence that
 * may indicate a flawed prompt or a mis-ranked fuzzy matcher.
 */

// ============================================================================
// Kafka Event Schema
// ============================================================================

/**
 * Raw event payload from `onex.evt.omniclaude.llm-routing-decision.v1`.
 *
 * Emitted by the omniclaude routing hook (ModelLlmRoutingDecisionPayload)
 * whenever an LLM routing decision is made alongside (or instead of) the
 * fuzzy fallback routing decision.
 *
 * Field mapping note (OMN-2920): The omniclaude producer uses different field
 * names than the original interface draft. Both sets of names are present here
 * so this interface documents the actual wire format. The projector in
 * read-model-consumer.ts probes both names for backward compatibility.
 *
 * Producer field → Interface field:
 *   selected_agent        → selected_agent  (llm_agent is the old draft name)
 *   fuzzy_top_candidate   → fuzzy_top_candidate  (fuzzy_agent is old draft name; nullable)
 *   fallback_used         → fallback_used  (used_fallback is old draft name)
 *   model_used            → model_used  (model is old draft name)
 *   emitted_at            → emitted_at  (timestamp is old draft name)
 */
export interface LlmRoutingDecisionEvent {
  /** ISO-8601 timestamp — legacy field name; producer emits as emitted_at */
  timestamp?: string;
  /** ISO-8601 timestamp as emitted by omniclaude (ModelLlmRoutingDecisionPayload) */
  emitted_at?: string;
  /** Unique correlation ID for this routing decision */
  correlation_id: string;
  /** Session ID (if available) */
  session_id?: string;
  /**
   * Agent chosen by LLM routing — as emitted by omniclaude (selected_agent).
   * Legacy interface draft used llm_agent.
   */
  selected_agent?: string;
  /** Legacy field name for agent chosen by LLM routing */
  llm_agent?: string;
  /**
   * Top candidate from fuzzy matching — nullable when fallback_used=true and
   * no fuzzy candidate was available. Legacy interface draft used fuzzy_agent.
   */
  fuzzy_top_candidate?: string | null;
  /** Legacy field name for agent selected by fuzzy-string routing */
  fuzzy_agent?: string | null;
  /**
   * Raw agent name returned by the LLM before validation/fallback.
   * Present in events where fallback_used=false.
   */
  llm_selected_candidate?: string | null;
  /** Whether LLM and fuzzy agreed on the same agent */
  agreement: boolean;
  /** Confidence score from LLM routing decision (0–1); nullable when not reported. */
  llm_confidence: number | null | undefined;
  /** Confidence score from fuzzy-string routing (0–1); nullable when not reported. */
  fuzzy_confidence: number | null | undefined;
  /** Latency for LLM routing decision in milliseconds */
  llm_latency_ms: number;
  /** Latency for fuzzy routing decision in milliseconds */
  fuzzy_latency_ms?: number;
  /**
   * Whether the fuzzy matcher was used as a fallback — as emitted by omniclaude (fallback_used).
   * Legacy interface draft used used_fallback.
   */
  fallback_used?: boolean;
  /** Legacy field name for fallback indicator */
  used_fallback?: boolean;
  /** Prompt version used for the LLM routing call */
  routing_prompt_version: string;
  /** The original intent string that triggered routing */
  intent?: string;
  /**
   * LLM model identifier — as emitted by omniclaude (model_used).
   * Legacy interface draft used model.
   */
  model_used?: string;
  /** Legacy field name for LLM model */
  model?: string;
  /** Estimated cost of the LLM routing call in USD */
  cost_usd?: number;
  /** Schema version of the event */
  schema_version?: string;
  /**
   * Token counts added by OMN-3448 (omniclaude ModelRoutingResult).
   * Optional — absent in events emitted before Task 5.
   */
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Whether the omninode routing plugin was active for this decision. */
  omninode_enabled?: boolean;
}

// ============================================================================
// API Response Types
// ============================================================================

/** Aggregate summary metrics for the LLM routing dashboard hero cards. */
export interface LlmRoutingSummary {
  /** Total routing decisions in the window */
  total_decisions: number;
  /**
   * Agreement rate between LLM and fuzzy routing (0–1).
   * GOLDEN METRIC: target >60%. Below 40% triggers an alert.
   */
  agreement_rate: number;
  /**
   * Fallback frequency — how often the system fell back to fuzzy-only
   * routing because LLM was unavailable (0–1).
   */
  fallback_rate: number;
  /**
   * Average cost per routing decision in USD.
   * Used to track the cost trade-off of LLM-assisted routing.
   */
  avg_cost_usd: number;
  /** p50 LLM routing latency (ms) */
  llm_p50_latency_ms: number;
  /** p95 LLM routing latency (ms) */
  llm_p95_latency_ms: number;
  /** p50 fuzzy routing latency (ms) */
  fuzzy_p50_latency_ms: number;
  /** p95 fuzzy routing latency (ms) */
  fuzzy_p95_latency_ms: number;
  /** Absolute decision counts */
  counts: {
    total: number;
    agreed: number;
    disagreed: number;
    fallback: number;
  };
  /** Rolling trend for agreement rate over the selected window */
  agreement_rate_trend: Array<{ date: string; value: number }>;
  /**
   * Average prompt tokens per routing decision in the window (OMN-3449).
   * Computed with AVG(NULLIF(prompt_tokens, 0)) to exclude pre-Task-5 rows.
   * Zero means no token data available yet.
   */
  avg_prompt_tokens: number;
  /**
   * Average completion tokens per routing decision in the window (OMN-3449).
   * Computed with AVG(NULLIF(completion_tokens, 0)) to exclude pre-Task-5 rows.
   * Zero means no token data available yet.
   */
  avg_completion_tokens: number;
}

/** Latency distribution data point per routing method. */
export interface LlmRoutingLatencyPoint {
  /** Routing method label (e.g. "LLM" or "Fuzzy") */
  method: string;
  /** p50 latency (ms) */
  p50_ms: number;
  /** p90 latency (ms) */
  p90_ms: number;
  /** p95 latency (ms) */
  p95_ms: number;
  /** p99 latency (ms) */
  p99_ms: number;
  /** Total samples */
  sample_count: number;
}

/** Agreement rate comparison broken down by routing_prompt_version. */
export interface LlmRoutingByVersion {
  /** Prompt version string (e.g. "v1.0.0", "v1.1.0") */
  routing_prompt_version: string;
  /**
   * Total decisions for this version.
   * Includes fallback decisions (where LLM was unavailable and fuzzy was used
   * exclusively), so: total = agreed + disagreed + fallbacks.
   */
  total: number;
  /** Number of decisions where LLM and fuzzy agreed */
  agreed: number;
  /** Number of decisions where they disagreed */
  disagreed: number;
  /** Agreement rate for this version (0–1) */
  agreement_rate: number;
  /** Average LLM latency for this version (ms) */
  avg_llm_latency_ms: number;
  /** Average fuzzy latency for this version (ms) */
  avg_fuzzy_latency_ms: number;
  /** Average cost per decision for this version (USD) */
  avg_cost_usd: number;
}

/** Disagreement entry in the top-disagreements table. */
export interface LlmRoutingDisagreement {
  /** Timestamp of the most recent disagreement for this pair */
  occurred_at: string;
  /** Agent selected by LLM */
  llm_agent: string;
  /** Agent selected by fuzzy matcher */
  fuzzy_agent: string;
  /** Number of times this pair has disagreed in the window */
  count: number;
  /** Average LLM confidence for this pair (0–1) */
  avg_llm_confidence: number;
  /** Average fuzzy confidence for this pair (0–1) */
  avg_fuzzy_confidence: number;
  /** Routing prompt version that produced most of these disagreements */
  routing_prompt_version: string;
}

/** Time-series trend data point for the multi-metric chart. */
export interface LlmRoutingTrendPoint {
  /** Date label (ISO-8601 date string, e.g. "2026-02-17") */
  date: string;
  /** Agreement rate in this period (0–1) */
  agreement_rate: number;
  /** Fallback rate in this period (0–1) */
  fallback_rate: number;
  /** Average cost per decision in this period (USD) */
  avg_cost_usd: number;
  /** Total decisions in this period */
  total_decisions: number;
}

/** Valid time windows for LLM routing dashboard queries. */
export type LlmRoutingTimeWindow = '24h' | '7d' | '30d' | 'all';

/**
 * Per-model effectiveness metrics (OMN-3442, OMN-3449).
 * Groups routing decisions by the `model` column.
 * Token averages use AVG(NULLIF(col, 0)) so pre-Task-5 rows (col=0) are
 * excluded from the average rather than dragging it down.
 */
export interface LlmRoutingByModel {
  /** LLM model identifier (COALESCE(model, 'unknown')) */
  model: string;
  /** Total decisions for this model in the window */
  total: number;
  /** Number of decisions where LLM and fuzzy agreed */
  agreed: number;
  /** Number of decisions where they disagreed */
  disagreed: number;
  /** Agreement rate for this model (0–1) */
  agreement_rate: number;
  /** Average LLM routing latency (ms) */
  avg_llm_latency_ms: number;
  /** Average cost per decision (USD) */
  avg_cost_usd: number;
  /**
   * Average prompt tokens for this model (OMN-3449).
   * Zero when no token data has been stored yet (pre-Task-5 rows only).
   */
  prompt_tokens_avg: number;
  /**
   * Average completion tokens for this model (OMN-3449).
   * Zero when no token data has been stored yet (pre-Task-5 rows only).
   */
  completion_tokens_avg: number;
}

/**
 * Fuzzy confidence distribution bucket (OMN-3447).
 * Groups routing decisions by fuzzy_confidence range.
 */
export interface LlmRoutingFuzzyConfidenceBucket {
  /** Bucket label (e.g. "no_data", "0–30%", "30–50%", "50–70%", "70–90%", "90–100%") */
  bucket: string;
  /** Numeric sort key for stable ordering (0–5) */
  sort_key: number;
  /** Number of routing decisions in this confidence bucket */
  count: number;
}

/**
 * Path comparison metrics grouped by omninode_enabled (OMN-3450).
 * Groups routing decisions by whether they ran through the ONEX node pipeline.
 *
 * Semantics (locked from OMN-3449 migration):
 *   true  = HandlerRoutingLlm ran inside the ONEX node pipeline
 *   false = legacy path ran (or _onex_nodes_available was False)
 */
export interface LlmRoutingByOmninodeMode {
  /** true = ONEX pipeline (HandlerRoutingLlm), false = legacy path */
  omninode_enabled: boolean;
  /** Total routing decisions for this path in the window */
  total: number;
  /** Agreement rate for this path (0–1) */
  agreement_rate: number;
  /** Average cost per decision (USD) */
  avg_cost_usd: number;
  /**
   * Average total tokens per decision.
   * Uses AVG(NULLIF(total_tokens, 0)) so pre-Task-5 rows (col=0) are excluded.
   */
  avg_total_tokens: number;
  /** Average LLM routing latency (ms) */
  avg_llm_latency_ms: number;
}

// NOTE: Zod runtime validation schemas (LlmRoutingTimeWindowSchema, etc.) live
// in server/llm-routing-schemas.ts to avoid bundling the 'zod' runtime into
// client-side JavaScript. Import from there in server-only code.
