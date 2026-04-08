/**
 * Context Enrichment Types (OMN-2280)
 *
 * Shared type definitions for the context enrichment dashboard.
 * Events consumed from: onex.evt.omniclaude.context-enrichment.v1
 */

// ============================================================================
// Shared Constants
// ============================================================================

/** Readonly tuple of valid enrichment outcome values — single source of truth. */
export const ENRICHMENT_OUTCOMES = ['hit', 'miss', 'error', 'inflated'] as const;
/** Union type derived from ENRICHMENT_OUTCOMES. */
export type EnrichmentOutcome = (typeof ENRICHMENT_OUTCOMES)[number];

// ============================================================================
// Kafka Event Schema
// ============================================================================

/**
 * Raw event payload from `onex.evt.omniclaude.context-enrichment.v1`.
 *
 * Emitted by the context enrichment pipeline whenever a context enrichment
 * operation completes (either from cache hit or fresh retrieval).
 */
export interface ContextEnrichmentEvent {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Unique correlation ID for this enrichment operation */
  correlation_id: string;
  /** Session ID (if available) */
  session_id?: string;
  /**
   * Enrichment channel (e.g. "qdrant", "pattern-cache", "similarity-search",
   * "summarization", "inline-context")
   */
  channel: string;
  /** Model used for enrichment (e.g. "gte-qwen2", "qwen2.5-coder-14b") */
  model_name: string;
  /**
   * Whether the enrichment result was served from cache.
   * Used to compute hit rate.
   */
  cache_hit: boolean;
  /**
   * Enrichment outcome:
   * - hit: enrichment retrieved context successfully
   * - miss: enrichment found no relevant context
   * - error: enrichment failed (service error)
   * - inflated: enrichment INCREASED token count (context inflation alert)
   */
  outcome: EnrichmentOutcome;
  /** Latency for this enrichment operation in milliseconds */
  latency_ms: number;
  /** Tokens in the original context (pre-enrichment) */
  tokens_before: number;
  /** Tokens after enrichment (post-enrichment) */
  tokens_after: number;
  /**
   * Net tokens saved by summarization/compression.
   * Positive = tokens reduced (good).
   * Negative = tokens increased (context inflation alert).
   * GOLDEN METRIC: net_tokens_saved > 0 indicates value delivered.
   */
  net_tokens_saved: number;
  /** Similarity score of the retrieved context (0–1, if applicable) */
  similarity_score?: number;
  /** Quality score of the retrieved context (0–1, if applicable) */
  quality_score?: number;
  /** Repository context */
  repo?: string;
  /** Agent that triggered the enrichment */
  agent_name?: string;
}

// ============================================================================
// API Response Types
// ============================================================================

/** Aggregate summary metrics for the enrichment dashboard hero cards. */
export interface EnrichmentSummary {
  /** Total enrichment operations in the window */
  total_enrichments: number;
  /**
   * Overall cache hit rate across all channels (0–1).
   * GOLDEN METRIC: high hit rate means efficient context reuse.
   */
  hit_rate: number;
  /**
   * Net tokens saved from summarization in the window.
   * GOLDEN METRIC: positive value indicates value delivered.
   */
  net_tokens_saved: number;
  /** Median latency across all enrichment operations (ms) */
  p50_latency_ms: number;
  /** 95th percentile latency (ms) */
  p95_latency_ms: number;
  /** Average similarity search quality score (0–1) */
  avg_similarity_score: number;
  /** Number of context inflation alerts (outcome = 'inflated') */
  inflation_alert_count: number;
  /** Error rate (errors / total_enrichments, 0–1) */
  error_rate: number;
  /** Absolute outcome counts */
  counts: {
    hits: number;
    misses: number;
    errors: number;
    inflated: number;
  };
}

/** Hit rate broken down by enrichment channel. */
export interface EnrichmentByChannel {
  channel: string;
  total: number;
  hits: number;
  misses: number;
  errors: number;
  inflated: number;
  /** Hit rate (0–1) */
  hit_rate: number;
  /** Average latency for this channel (ms) */
  avg_latency_ms: number;
  /** Average net tokens saved for this channel */
  avg_net_tokens_saved: number;
}

/** Latency distribution bucketed for histogram display. */
export interface LatencyDistributionPoint {
  /** Model name */
  model: string;
  /** p50 latency (ms) */
  p50_ms: number;
  /** p90 latency (ms) */
  p90_ms: number;
  /** p95 latency (ms) */
  p95_ms: number;
  /** p99 latency (ms) */
  p99_ms: number;
  /** Total samples in this model bucket */
  sample_count: number;
}

/** Token savings trend data point. */
export interface TokenSavingsTrendPoint {
  /** Date label (ISO-8601 date string, e.g. "2026-02-17") */
  date: string;
  /** Cumulative net tokens saved in this period */
  net_tokens_saved: number;
  /** Total enrichment operations in this period */
  total_enrichments: number;
  /** Average tokens before enrichment */
  avg_tokens_before: number;
  /** Average tokens after enrichment */
  avg_tokens_after: number;
}

/** Similarity search quality over time. */
export interface SimilarityQualityPoint {
  /** Date label (ISO-8601 date string) */
  date: string;
  /** Average similarity score (0–1) */
  avg_similarity_score: number;
  /** Average quality score (0–1) */
  avg_quality_score: number;
  /** Total similarity search operations in this period */
  search_count: number;
}

/** A single context inflation alert entry. */
export interface InflationAlert {
  correlation_id: string;
  channel: string;
  model_name: string;
  tokens_before: number;
  tokens_after: number;
  /**
   * Net tokens saved (tokens_before - tokens_after).
   * For inflation alerts this is always negative because tokens_after >
   * tokens_before — meaning the enrichment INCREASED token count.
   */
  net_tokens_saved: number;
  occurred_at: string;
  repo?: string;
  agent_name?: string;
}

/** Valid time windows for enrichment dashboard queries. */
export type EnrichmentTimeWindow = '24h' | '7d' | '30d' | 'all';
