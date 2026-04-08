/**
 * LLM Routing Zod Schemas (OMN-2372)
 *
 * Runtime validation schemas for LLM routing API payloads. Kept server-side
 * only to avoid bundling the 'zod' runtime into client-side JavaScript.
 *
 * The corresponding TypeScript types live in shared/llm-routing-types.ts.
 */

import { z } from 'zod';

/** Zod schema for LlmRoutingTimeWindow. */
export const LlmRoutingTimeWindowSchema = z.enum(['24h', '7d', '30d', 'all']);

/** Zod schema for LlmRoutingSummary. */
export const LlmRoutingSummarySchema = z.object({
  total_decisions: z.number().int().nonnegative(),
  agreement_rate: z.number().min(0).max(1),
  fallback_rate: z.number().min(0).max(1),
  avg_cost_usd: z.number().nonnegative(),
  llm_p50_latency_ms: z.number().nonnegative(),
  llm_p95_latency_ms: z.number().nonnegative(),
  fuzzy_p50_latency_ms: z.number().nonnegative(),
  fuzzy_p95_latency_ms: z.number().nonnegative(),
  counts: z.object({
    total: z.number().int().nonnegative(),
    agreed: z.number().int().nonnegative(),
    disagreed: z.number().int().nonnegative(),
    fallback: z.number().int().nonnegative(),
  }),
  agreement_rate_trend: z.array(
    z.object({
      date: z.string(),
      value: z.number().min(0).max(1),
    })
  ),
  /** Token averages added by OMN-3449 — optional so existing callers stay compatible. */
  avg_prompt_tokens: z.number().int().min(0).optional().default(0),
  avg_completion_tokens: z.number().int().min(0).optional().default(0),
});

/** Zod schema for LlmRoutingLatencyPoint. */
export const LlmRoutingLatencyPointSchema = z.object({
  method: z.string(),
  p50_ms: z.number().nonnegative(),
  p90_ms: z.number().nonnegative(),
  p95_ms: z.number().nonnegative(),
  p99_ms: z.number().nonnegative(),
  sample_count: z.number().int().nonnegative(),
});

/** Zod schema for LlmRoutingByVersion. */
export const LlmRoutingByVersionSchema = z.object({
  routing_prompt_version: z.string(),
  total: z.number().int().nonnegative(),
  agreed: z.number().int().nonnegative(),
  disagreed: z.number().int().nonnegative(),
  agreement_rate: z.number().min(0).max(1),
  avg_llm_latency_ms: z.number().nonnegative(),
  avg_fuzzy_latency_ms: z.number().nonnegative(),
  avg_cost_usd: z.number().nonnegative(),
});

/** Zod schema for LlmRoutingDisagreement. */
export const LlmRoutingDisagreementSchema = z.object({
  occurred_at: z.string(),
  llm_agent: z.string(),
  fuzzy_agent: z.string(),
  count: z.number().int().positive(),
  avg_llm_confidence: z.number().min(0).max(1),
  avg_fuzzy_confidence: z.number().min(0).max(1),
  routing_prompt_version: z.string(),
});

/** Zod schema for LlmRoutingTrendPoint. */
export const LlmRoutingTrendPointSchema = z.object({
  date: z.string(),
  agreement_rate: z.number().min(0).max(1),
  fallback_rate: z.number().min(0).max(1),
  avg_cost_usd: z.number().nonnegative(),
  total_decisions: z.number().int().nonnegative(),
});

/**
 * Zod schema for LlmRoutingByModel (OMN-3449).
 *
 * Token fields are optional with default 0 so events emitted before Task 5
 * (OMN-3448) — which lack token fields — still parse successfully.
 */
export const LlmRoutingByModelSchema = z.object({
  model: z.string(),
  total: z.number().int().nonnegative(),
  agreed: z.number().int().nonnegative(),
  disagreed: z.number().int().nonnegative(),
  agreement_rate: z.number().min(0).max(1),
  avg_llm_latency_ms: z.number().nonnegative(),
  avg_cost_usd: z.number().nonnegative(),
  prompt_tokens_avg: z.number().int().min(0).optional().default(0),
  completion_tokens_avg: z.number().int().min(0).optional().default(0),
});
