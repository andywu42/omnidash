/**
 * LlmRoutingProjection — DB-backed projection for the LLM routing effectiveness dashboard (OMN-2372)
 *
 * Encapsulates all SQL queries for the LLM routing dashboard behind the
 * ProjectionView interface. Routes call ensureFresh() / ensureFreshForWindow()
 * and access sub-fields instead of executing SQL directly.
 *
 * Snapshot payload shape matches the combined API output of:
 *   GET /api/llm-routing/summary?window=7d
 *   GET /api/llm-routing/latency?window=7d
 *   GET /api/llm-routing/by-version?window=7d
 *   GET /api/llm-routing/disagreements?window=7d
 *   GET /api/llm-routing/trend?window=7d
 *
 * Source table: llm_routing_decisions (created by migrations/0063_llm_routing_decisions.sql).
 * Drizzle schema: llmRoutingDecisions in shared/intelligence-schema.ts. Queries use raw SQL via
 * drizzle's `db.execute(sql`...`)` interface, consistent with read-model-consumer.ts.
 *
 * GOLDEN METRIC: agreement_rate (agreed / (agreed + disagreed)) > 60%.
 * Alert if disagreement rate exceeds 40% (disagreement_rate > 0.4).
 */

import { sql } from 'drizzle-orm';
import type {
  LlmRoutingSummary,
  LlmRoutingLatencyPoint,
  LlmRoutingByVersion,
  LlmRoutingByModel,
  LlmRoutingByOmninodeMode,
  LlmRoutingDisagreement,
  LlmRoutingTrendPoint,
  LlmRoutingTimeWindow,
  LlmRoutingFuzzyConfidenceBucket,
} from '@shared/llm-routing-types';
import { DbBackedProjectionView, DEFAULT_CACHE_TTL_MS } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import { safeTruncUnit } from '../sql-safety';

// ============================================================================
// Payload type
// ============================================================================

export interface LlmRoutingPayload {
  summary: LlmRoutingSummary;
  latency: LlmRoutingLatencyPoint[];
  byVersion: LlmRoutingByVersion[];
  byModel: LlmRoutingByModel[];
  /** ONEX path vs legacy path comparison (OMN-3450) */
  byOmninodeMode: LlmRoutingByOmninodeMode[];
  disagreements: LlmRoutingDisagreement[];
  trend: LlmRoutingTrendPoint[];
  /** Fuzzy confidence distribution buckets (OMN-3447) */
  fuzzyConfidence: LlmRoutingFuzzyConfidenceBucket[];
  /** Distinct model names from the last 30d (stable list for model switcher) (OMN-3447) */
  models: string[];
  /**
   * Set to `true` when the DB was unavailable and ensureFreshForWindow()
   * fell back to the cached 7d snapshot. Callers should surface a warning.
   * Absent (undefined) when payload reflects the actually-requested window.
   */
  degraded?: boolean;
  /**
   * The actual time window reflected in this payload. Equals the requested
   * window when the DB was available; equals '7d' when degraded is true.
   * Absent (undefined) when data came from the default 7d TTL cache path.
   */
  window?: LlmRoutingTimeWindow;
}

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

// ============================================================================
// Window helpers
// ============================================================================

/** Return the cutoff Date for a given LlmRoutingTimeWindow. */
function windowCutoff(window: LlmRoutingTimeWindow): Date {
  const now = Date.now();
  if (window === '24h') return new Date(now - 24 * 60 * 60 * 1000);
  if (window === '7d') return new Date(now - 7 * 24 * 60 * 60 * 1000);
  if (window === '30d') return new Date(now - 30 * 24 * 60 * 60 * 1000);
  // Guard against future enum expansion or runtime boundary bypasses.
  throw new Error(`windowCutoff: unrecognised window '${window as string}'`);
}

/** Return 'hour' or 'day' truncation unit based on window. */
function truncUnit(window: LlmRoutingTimeWindow): 'hour' | 'day' {
  return window === '24h' ? 'hour' : 'day';
}

// ============================================================================
// Per-window cache TTL
// ============================================================================

/**
 * TTL for per-window snapshots cached by ensureFreshForWindow().
 * Mirrors DEFAULT_CACHE_TTL_MS so all caches expire on the same schedule.
 */
const WINDOW_CACHE_TTL_MS = DEFAULT_CACHE_TTL_MS;

// ============================================================================
// Projection
// ============================================================================

export class LlmRoutingProjection extends DbBackedProjectionView<LlmRoutingPayload> {
  readonly viewId = 'llm-routing';

  /** Per-window payload cache keyed by LlmRoutingTimeWindow. */
  private readonly _windowCache = new Map<LlmRoutingTimeWindow, LlmRoutingPayload>();
  /** Per-window cache expiry timestamps (ms since epoch). */
  private readonly _windowCacheExpiresAt = new Map<LlmRoutingTimeWindow, number>();
  /**
   * In-flight coalescing guard for ensureFreshForWindow().
   * Multiple concurrent callers for the same window share one DB round-trip.
   */
  private readonly _windowRefreshInFlight = new Map<
    LlmRoutingTimeWindow,
    Promise<LlmRoutingPayload>
  >();

  protected emptyPayload(): LlmRoutingPayload {
    return {
      summary: {
        total_decisions: 0,
        agreement_rate: 0,
        fallback_rate: 0,
        avg_cost_usd: 0,
        llm_p50_latency_ms: 0,
        llm_p95_latency_ms: 0,
        fuzzy_p50_latency_ms: 0,
        fuzzy_p95_latency_ms: 0,
        counts: { total: 0, agreed: 0, disagreed: 0, fallback: 0 },
        agreement_rate_trend: [],
        avg_prompt_tokens: 0,
        avg_completion_tokens: 0,
      },
      latency: [],
      byVersion: [],
      byModel: [],
      byOmninodeMode: [],
      disagreements: [],
      trend: [],
      fuzzyConfidence: [],
      models: [],
    };
  }

  /**
   * Override reset() to also clear per-window caches maintained by this subclass.
   *
   * Known race: any in-flight Promises that were cleared from _windowRefreshInFlight
   * may still resolve and write to _windowCache after this reset completes.
   * This is acceptable — the same race exists in the base class TTL cache — and
   * the stale write is harmless because the next TTL check will expire it.
   *
   * NOTE for invalidateCache() callers (e.g. post-commit in read-model-consumer):
   * If a cache-fill Promise was already in flight at the moment invalidateCache()
   * called reset(), that Promise will continue executing and may write its result
   * to _windowCache after the clear. The written entry will carry the TTL that was
   * computed before the invalidation, so data committed immediately before the
   * invalidation may not appear in the dashboard until that TTL expires and a fresh
   * DB query runs. This is a best-effort, eventually-consistent design: the window
   * of staleness is bounded by WINDOW_CACHE_TTL_MS (5 s by default).
   */
  override reset(): void {
    super.reset();
    this._windowCache.clear();
    this._windowCacheExpiresAt.clear();
    this._windowRefreshInFlight.clear();
  }

  protected async querySnapshot(db: Db): Promise<LlmRoutingPayload> {
    // Default window for the pre-warmed snapshot: 7d
    const window: LlmRoutingTimeWindow = '7d';

    const [
      summary,
      latency,
      byVersion,
      byModel,
      byOmninodeMode,
      disagreements,
      trend,
      fuzzyConfidence,
      models,
    ] = await Promise.all([
      this.querySummary(db, window),
      this.queryLatency(db, window),
      this.queryByVersion(db, window),
      this.queryByModel(db, window),
      this.queryByOmninodeMode(db, window),
      this.queryDisagreements(db, window),
      this.queryTrend(db, window),
      this.queryFuzzyConfidenceDistribution(db, window),
      this.queryModels(db),
    ]);

    return {
      summary,
      latency,
      byVersion,
      byModel,
      byOmninodeMode,
      disagreements,
      trend,
      fuzzyConfidence,
      models,
    };
  }

  // --------------------------------------------------------------------------
  // Public query methods — routes may call these directly for window-specific data.
  //
  // NOTE: These methods accept a `Db` parameter directly and execute SQL
  // immediately — they do NOT include graceful-degradation logic. Callers that
  // need graceful degradation should use `ensureFreshForWindow()` instead.
  // --------------------------------------------------------------------------

  async querySummary(db: Db, window: LlmRoutingTimeWindow = '7d'): Promise<LlmRoutingSummary> {
    const cutoff = windowCutoff(window);
    const unit = truncUnit(window);

    // safeTruncUnit() validates against the centralized allowlist in sql-safety.ts
    // Single aggregate query for hero card metrics.
    const aggResult = await db.execute(sql`
      SELECT
        COUNT(*)::int                                                            AS total_decisions,
        COUNT(*) FILTER (WHERE agreement = TRUE AND used_fallback = FALSE)::int  AS agreed_count,
        COUNT(*) FILTER (WHERE agreement = FALSE AND used_fallback = FALSE)::int AS disagreed_count,
        COUNT(*) FILTER (WHERE used_fallback = TRUE)::int                       AS fallback_count,
        COALESCE(AVG(cost_usd) FILTER (WHERE cost_usd IS NOT NULL), 0)::float   AS avg_cost_usd,
        COALESCE(
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY llm_latency_ms), 0
        )::float                                                                 AS llm_p50_ms,
        COALESCE(
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY llm_latency_ms), 0
        )::float                                                                 AS llm_p95_ms,
        COALESCE(
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fuzzy_latency_ms), 0
        )::float                                                                 AS fuzzy_p50_ms,
        COALESCE(
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY fuzzy_latency_ms), 0
        )::float                                                                 AS fuzzy_p95_ms,
        COALESCE(AVG(NULLIF(prompt_tokens, 0)), 0)::int                         AS avg_prompt_tokens,
        COALESCE(AVG(NULLIF(completion_tokens, 0)), 0)::int                     AS avg_completion_tokens
      FROM llm_routing_decisions
      WHERE created_at >= ${cutoff}
    `);

    const agg = (aggResult.rows[0] ?? {}) as Record<string, unknown>;

    const total = Number(agg.total_decisions ?? 0);
    const agreed = Number(agg.agreed_count ?? 0);
    const disagreed = Number(agg.disagreed_count ?? 0);
    const fallback = Number(agg.fallback_count ?? 0);
    const nonFallback = agreed + disagreed;
    const agreementRate = nonFallback > 0 ? agreed / nonFallback : 0;
    const fallbackRate = total > 0 ? fallback / total : 0;

    // Rolling trend for agreement rate — one bucket per day (or hour for 24h window).
    const trendResult = await db.execute(sql`
      SELECT
        date_trunc(${safeTruncUnit(unit)}, created_at)::text                                  AS bucket,
        COUNT(*) FILTER (WHERE agreement = TRUE AND used_fallback = FALSE)::int                 AS agreed,
        (COUNT(*) FILTER (WHERE agreement = FALSE AND used_fallback = FALSE) +
         COUNT(*) FILTER (WHERE agreement = TRUE AND used_fallback = FALSE))::int              AS non_fallback
      FROM llm_routing_decisions
      WHERE created_at >= ${cutoff}
      GROUP BY date_trunc(${safeTruncUnit(unit)}, created_at)
      ORDER BY date_trunc(${safeTruncUnit(unit)}, created_at)
    `);

    const trendRows = trendResult.rows as Array<Record<string, unknown>>;
    const agreementRateTrend = trendRows.map((r) => {
      const bucketAgreed = Number(r.agreed ?? 0);
      const bucketNonFallback = Number(r.non_fallback ?? 0);
      return {
        date: String(r.bucket ?? ''),
        value: bucketNonFallback > 0 ? bucketAgreed / bucketNonFallback : 0,
      };
    });

    return {
      total_decisions: total,
      agreement_rate: agreementRate,
      fallback_rate: fallbackRate,
      avg_cost_usd: parseFloat(String(agg.avg_cost_usd ?? '0')),
      llm_p50_latency_ms: parseFloat(String(agg.llm_p50_ms ?? '0')),
      llm_p95_latency_ms: parseFloat(String(agg.llm_p95_ms ?? '0')),
      fuzzy_p50_latency_ms: parseFloat(String(agg.fuzzy_p50_ms ?? '0')),
      fuzzy_p95_latency_ms: parseFloat(String(agg.fuzzy_p95_ms ?? '0')),
      counts: { total, agreed, disagreed, fallback },
      agreement_rate_trend: agreementRateTrend,
      avg_prompt_tokens: Number(agg.avg_prompt_tokens ?? 0),
      avg_completion_tokens: Number(agg.avg_completion_tokens ?? 0),
    };
  }

  async queryLatency(
    db: Db,
    window: LlmRoutingTimeWindow = '7d'
  ): Promise<LlmRoutingLatencyPoint[]> {
    const cutoff = windowCutoff(window);

    // One row per routing method (LLM, Fuzzy) with percentile distribution.
    const result = await db.execute(sql`
      SELECT
        'LLM'                                                                          AS method,
        COUNT(*)::int                                                                  AS sample_count,
        COALESCE(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY llm_latency_ms), 0)::float AS p50_ms,
        COALESCE(PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY llm_latency_ms), 0)::float AS p90_ms,
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY llm_latency_ms), 0)::float AS p95_ms,
        COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY llm_latency_ms), 0)::float AS p99_ms
      FROM llm_routing_decisions
      WHERE created_at >= ${cutoff}

      UNION ALL

      SELECT
        'Fuzzy'                                                                         AS method,
        COUNT(*)::int                                                                   AS sample_count,
        COALESCE(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY fuzzy_latency_ms), 0)::float AS p50_ms,
        COALESCE(PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY fuzzy_latency_ms), 0)::float AS p90_ms,
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY fuzzy_latency_ms), 0)::float AS p95_ms,
        COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY fuzzy_latency_ms), 0)::float AS p99_ms
      FROM llm_routing_decisions
      WHERE created_at >= ${cutoff}
    `);

    const rows = result.rows as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      method: String(r.method ?? ''),
      sample_count: Number(r.sample_count ?? 0),
      p50_ms: parseFloat(String(r.p50_ms ?? '0')),
      p90_ms: parseFloat(String(r.p90_ms ?? '0')),
      p95_ms: parseFloat(String(r.p95_ms ?? '0')),
      p99_ms: parseFloat(String(r.p99_ms ?? '0')),
    }));
  }

  async queryByVersion(
    db: Db,
    window: LlmRoutingTimeWindow = '7d'
  ): Promise<LlmRoutingByVersion[]> {
    const cutoff = windowCutoff(window);

    const result = await db.execute(sql`
      SELECT
        routing_prompt_version,
        COUNT(*)::int                                                             AS total,
        COUNT(*) FILTER (WHERE agreement = TRUE)::int                            AS agreed,
        COUNT(*) FILTER (WHERE agreement = FALSE AND used_fallback = FALSE)::int AS disagreed,
        COALESCE(AVG(llm_latency_ms), 0)::float                                  AS avg_llm_latency_ms,
        COALESCE(AVG(fuzzy_latency_ms), 0)::float                                AS avg_fuzzy_latency_ms,
        COALESCE(AVG(cost_usd) FILTER (WHERE cost_usd IS NOT NULL), 0)::float    AS avg_cost_usd
      FROM llm_routing_decisions
      WHERE created_at >= ${cutoff}
      GROUP BY routing_prompt_version
      ORDER BY total DESC
    `);

    const rows = result.rows as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const total = Number(r.total ?? 0);
      const agreed = Number(r.agreed ?? 0);
      const disagreed = Number(r.disagreed ?? 0);
      const nonFallback = agreed + disagreed;
      return {
        routing_prompt_version: String(r.routing_prompt_version ?? ''),
        total,
        agreed,
        disagreed,
        agreement_rate: nonFallback > 0 ? agreed / nonFallback : 0,
        avg_llm_latency_ms: parseFloat(String(r.avg_llm_latency_ms ?? '0')),
        avg_fuzzy_latency_ms: parseFloat(String(r.avg_fuzzy_latency_ms ?? '0')),
        avg_cost_usd: parseFloat(String(r.avg_cost_usd ?? '0')),
      };
    });
  }

  async queryByModel(db: Db, window: LlmRoutingTimeWindow = '7d'): Promise<LlmRoutingByModel[]> {
    const cutoff = windowCutoff(window);

    const result = await db.execute(sql`
      SELECT
        COALESCE(model, 'unknown')                                                AS model,
        COUNT(*)::int                                                             AS total,
        SUM(CASE WHEN agreement THEN 1 ELSE 0 END)::int                          AS agreed,
        SUM(CASE WHEN NOT agreement THEN 1 ELSE 0 END)::int                      AS disagreed,
        ROUND(AVG(llm_latency_ms))::int                                          AS avg_llm_latency_ms,
        COALESCE(AVG(cost_usd), 0)::float8                                       AS avg_cost_usd,
        COALESCE(AVG(NULLIF(prompt_tokens, 0)), 0)::int                          AS prompt_tokens_avg,
        COALESCE(AVG(NULLIF(completion_tokens, 0)), 0)::int                      AS completion_tokens_avg
      FROM llm_routing_decisions
      WHERE created_at >= ${cutoff}
      GROUP BY model
      ORDER BY total DESC
    `);

    const rows = result.rows as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const total = Number(r.total ?? 0);
      const agreed = Number(r.agreed ?? 0);
      const disagreed = Number(r.disagreed ?? 0);
      const nonFallback = agreed + disagreed;
      return {
        model: String(r.model ?? 'unknown'),
        total,
        agreed,
        disagreed,
        agreement_rate: nonFallback > 0 ? agreed / nonFallback : 0,
        avg_llm_latency_ms: Number(r.avg_llm_latency_ms ?? 0),
        avg_cost_usd: parseFloat(String(r.avg_cost_usd ?? '0')),
        prompt_tokens_avg: Number(r.prompt_tokens_avg ?? 0),
        completion_tokens_avg: Number(r.completion_tokens_avg ?? 0),
      };
    });
  }

  /**
   * Query ONEX path vs legacy path comparison (OMN-3450).
   *
   * Groups by omninode_enabled (added by migration 0013_routing_decisions_tokens.sql).
   * Uses AVG(NULLIF(total_tokens, 0)) so pre-Task-5 rows (col=0) are excluded
   * from token averages rather than dragging numbers down.
   *
   * Returns at most 2 rows: one for omninode_enabled=true, one for false.
   * Returns empty array when the column has no non-null data (pre-migration rows only).
   */
  async queryByOmninodeMode(
    db: Db,
    window: LlmRoutingTimeWindow = '7d'
  ): Promise<LlmRoutingByOmninodeMode[]> {
    const cutoff = windowCutoff(window);

    const result = await db.execute(sql`
      SELECT
        omninode_enabled,
        COUNT(*)::int                                                               AS total,
        AVG(CASE WHEN agreement THEN 1.0 ELSE 0.0 END)::float8                    AS agreement_rate,
        COALESCE(AVG(cost_usd), 0)::float8                                         AS avg_cost_usd,
        COALESCE(AVG(NULLIF(total_tokens, 0)), 0)::int                             AS avg_total_tokens,
        ROUND(AVG(llm_latency_ms))::int                                            AS avg_llm_latency_ms
      FROM llm_routing_decisions
      WHERE created_at >= ${cutoff}
      GROUP BY omninode_enabled
      ORDER BY omninode_enabled DESC
    `);

    const rows = result.rows as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      omninode_enabled: Boolean(r.omninode_enabled),
      total: Number(r.total ?? 0),
      agreement_rate: parseFloat(String(r.agreement_rate ?? '0')),
      avg_cost_usd: parseFloat(String(r.avg_cost_usd ?? '0')),
      avg_total_tokens: Number(r.avg_total_tokens ?? 0),
      avg_llm_latency_ms: Number(r.avg_llm_latency_ms ?? 0),
    }));
  }

  /**
   * Query fuzzy confidence distribution (OMN-3447).
   * Buckets: no_data, 0–30%, 30–50%, 50–70%, 70–90%, 90–100%.
   * sort_key is stable (0–5) for ordered rendering.
   */
  async queryFuzzyConfidenceDistribution(
    db: Db,
    window: LlmRoutingTimeWindow = '7d'
  ): Promise<LlmRoutingFuzzyConfidenceBucket[]> {
    const cutoff = windowCutoff(window);

    const result = await db.execute(sql`
      SELECT
        bucket,
        sort_key,
        COUNT(*)::int AS count
      FROM (
        SELECT
          CASE
            WHEN fuzzy_confidence IS NULL THEN 'no_data'
            WHEN fuzzy_confidence < 0.3   THEN '0–30%'
            WHEN fuzzy_confidence < 0.5   THEN '30–50%'
            WHEN fuzzy_confidence < 0.7   THEN '50–70%'
            WHEN fuzzy_confidence < 0.9   THEN '70–90%'
            ELSE '90–100%'
          END AS bucket,
          CASE
            WHEN fuzzy_confidence IS NULL THEN 0
            WHEN fuzzy_confidence < 0.3   THEN 1
            WHEN fuzzy_confidence < 0.5   THEN 2
            WHEN fuzzy_confidence < 0.7   THEN 3
            WHEN fuzzy_confidence < 0.9   THEN 4
            ELSE 5
          END AS sort_key
        FROM llm_routing_decisions
        WHERE created_at >= ${cutoff}
      ) sub
      GROUP BY bucket, sort_key
      ORDER BY sort_key
    `);

    const rows = result.rows as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      bucket: String(r.bucket ?? ''),
      sort_key: Number(r.sort_key ?? 0),
      count: Number(r.count ?? 0),
    }));
  }

  /**
   * Query distinct model names active in the last 30d (OMN-3447).
   * Used as the stable model list for the ModelSwitcher dropdown.
   * Always uses 30d regardless of the dashboard window because the switcher
   * needs a stable list that does not change as the user switches windows.
   */
  async queryModels(db: Db): Promise<string[]> {
    const cutoff = windowCutoff('30d');

    const result = await db.execute(sql`
      SELECT DISTINCT COALESCE(model, 'unknown') AS model
      FROM llm_routing_decisions
      WHERE created_at >= ${cutoff}
        AND model IS NOT NULL
        AND model != ''
      ORDER BY model
    `);

    const rows = result.rows as Array<Record<string, unknown>>;
    return rows.map((r) => String(r.model ?? 'unknown'));
  }

  async queryDisagreements(
    db: Db,
    window: LlmRoutingTimeWindow = '7d'
  ): Promise<LlmRoutingDisagreement[]> {
    const cutoff = windowCutoff(window);

    // Top disagreement pairs sorted by frequency descending.
    // The partial index idx_lrd_agent_pair (WHERE agreement = FALSE) makes this fast.
    const result = await db.execute(sql`
      SELECT
        llm_agent,
        fuzzy_agent,
        COUNT(*)::int                                                                 AS count,
        MAX(created_at)::text                                                         AS occurred_at,
        COALESCE(AVG(llm_confidence) FILTER (WHERE llm_confidence IS NOT NULL), 0)::float AS avg_llm_confidence,
        COALESCE(AVG(fuzzy_confidence) FILTER (WHERE fuzzy_confidence IS NOT NULL), 0)::float AS avg_fuzzy_confidence,
        mode() WITHIN GROUP (ORDER BY routing_prompt_version)                         AS routing_prompt_version
      FROM llm_routing_decisions
      WHERE created_at >= ${cutoff}
        AND agreement = FALSE
        AND used_fallback = FALSE
      GROUP BY llm_agent, fuzzy_agent
      ORDER BY count DESC
      LIMIT 20
    `);

    const rows = result.rows as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      occurred_at: String(r.occurred_at ?? ''),
      llm_agent: String(r.llm_agent ?? ''),
      fuzzy_agent: String(r.fuzzy_agent ?? ''),
      count: Number(r.count ?? 0),
      avg_llm_confidence: parseFloat(String(r.avg_llm_confidence ?? '0')),
      avg_fuzzy_confidence: parseFloat(String(r.avg_fuzzy_confidence ?? '0')),
      routing_prompt_version: String(r.routing_prompt_version ?? 'unknown'),
    }));
  }

  async queryTrend(db: Db, window: LlmRoutingTimeWindow = '7d'): Promise<LlmRoutingTrendPoint[]> {
    return this.queryTrendByModel(db, window);
  }

  /**
   * Trend query with optional model filter (OMN-7643).
   * When model is provided, only rows matching that model are included.
   */
  async queryTrendByModel(
    db: Db,
    window: LlmRoutingTimeWindow = '7d',
    model?: string
  ): Promise<LlmRoutingTrendPoint[]> {
    const cutoff = windowCutoff(window);
    const unit = truncUnit(window);

    // safeTruncUnit() validates against the centralized allowlist in sql-safety.ts
    const result = model
      ? await db.execute(sql`
          SELECT
            date_trunc(${safeTruncUnit(unit)}, created_at)::text                               AS bucket,
            COUNT(*)::int                                                                        AS total_decisions,
            COUNT(*) FILTER (WHERE agreement = TRUE AND used_fallback = FALSE)::int             AS agreed,
            COUNT(*) FILTER (WHERE used_fallback = FALSE)::int                                  AS non_fallback,
            COUNT(*) FILTER (WHERE used_fallback = TRUE)::int                                   AS fallback_count,
            COALESCE(AVG(cost_usd) FILTER (WHERE cost_usd IS NOT NULL), 0)::float               AS avg_cost_usd
          FROM llm_routing_decisions
          WHERE created_at >= ${cutoff} AND model = ${model}
          GROUP BY date_trunc(${safeTruncUnit(unit)}, created_at)
          ORDER BY date_trunc(${safeTruncUnit(unit)}, created_at)
        `)
      : await db.execute(sql`
          SELECT
            date_trunc(${safeTruncUnit(unit)}, created_at)::text                               AS bucket,
            COUNT(*)::int                                                                        AS total_decisions,
            COUNT(*) FILTER (WHERE agreement = TRUE AND used_fallback = FALSE)::int             AS agreed,
            COUNT(*) FILTER (WHERE used_fallback = FALSE)::int                                  AS non_fallback,
            COUNT(*) FILTER (WHERE used_fallback = TRUE)::int                                   AS fallback_count,
            COALESCE(AVG(cost_usd) FILTER (WHERE cost_usd IS NOT NULL), 0)::float               AS avg_cost_usd
          FROM llm_routing_decisions
          WHERE created_at >= ${cutoff}
          GROUP BY date_trunc(${safeTruncUnit(unit)}, created_at)
          ORDER BY date_trunc(${safeTruncUnit(unit)}, created_at)
        `);

    const rows = result.rows as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const total = Number(r.total_decisions ?? 0);
      const agreed = Number(r.agreed ?? 0);
      const fallbackCount = Number(r.fallback_count ?? 0);
      const nonFallback = Number(r.non_fallback ?? 0);
      return {
        date: String(r.bucket ?? ''),
        agreement_rate: nonFallback > 0 ? agreed / nonFallback : 0,
        fallback_rate: total > 0 ? fallbackCount / total : 0,
        avg_cost_usd: parseFloat(String(r.avg_cost_usd ?? '0')),
        total_decisions: total,
      };
    });
  }

  /**
   * Fetch trend data filtered by model (OMN-7643).
   * Acquires the DB handle internally so route files don't need to import storage.
   * Returns null if the DB is unavailable.
   */
  async fetchTrendByModel(
    window: LlmRoutingTimeWindow,
    model: string
  ): Promise<LlmRoutingTrendPoint[] | null> {
    const db = tryGetIntelligenceDb();
    if (!db) return null;
    return this.queryTrendByModel(db, window, model);
  }

  // --------------------------------------------------------------------------
  // Window-aware fetch (for route handlers with ?window= parameter)
  // --------------------------------------------------------------------------

  /**
   * Return payload for a specific time window with per-window TTL caching.
   * Route handlers call this when the request has a ?window= parameter.
   * Results are cached per-window for WINDOW_CACHE_TTL_MS (5 s) to coalesce
   * concurrent requests and avoid hammering the DB.
   *
   * Falls back to cached/empty payload if the DB is unavailable.
   *
   * Degraded-state behavior — two cases, both with a single DB interaction:
   *   1. `tryGetIntelligenceDb()` returns null (DB not configured): falls back
   *      to `ensureFresh()` which reads the base-class TTL cache synchronously
   *      (no extra DB round-trip since the DB is already known to be absent).
   *   2. DB query fails after a non-null `db` handle: falls back to
   *      `getSnapshot()` which reads the already-cached 7d base-class payload
   *      synchronously — no second DB round-trip.
   * In both cases the returned payload has `degraded: true` and `window: '7d'`
   * so callers can detect that the data does not reflect the requested window.
   */
  async ensureFreshForWindow(window: LlmRoutingTimeWindow): Promise<LlmRoutingPayload> {
    // Return the per-window cached snapshot if still fresh.
    const cachedPayload = this._windowCache.get(window);
    const expiresAt = this._windowCacheExpiresAt.get(window) ?? 0;
    if (cachedPayload !== undefined && Date.now() < expiresAt) {
      return cachedPayload;
    }

    // Coalesce concurrent requests for the same window.
    const inFlight = this._windowRefreshInFlight.get(window);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const db = tryGetIntelligenceDb();
    if (!db) {
      try {
        const fallback = await this.ensureFresh();
        return { ...fallback, degraded: true, window: '7d' };
      } catch {
        return { ...this.emptyPayload(), degraded: true, window: '7d' };
      }
    }

    const refreshPromise: Promise<LlmRoutingPayload> = Promise.all([
      this.querySummary(db, window),
      this.queryLatency(db, window),
      this.queryByVersion(db, window),
      this.queryByModel(db, window),
      this.queryByOmninodeMode(db, window),
      this.queryDisagreements(db, window),
      this.queryTrend(db, window),
      this.queryFuzzyConfidenceDistribution(db, window),
      this.queryModels(db),
    ])
      .then(
        ([
          summary,
          latency,
          byVersion,
          byModel,
          byOmninodeMode,
          disagreements,
          trend,
          fuzzyConfidence,
          models,
        ]) => {
          const payload: LlmRoutingPayload = {
            summary,
            latency,
            byVersion,
            byModel,
            byOmninodeMode,
            disagreements,
            trend,
            fuzzyConfidence,
            models,
            window,
          };

          this._windowCache.set(window, payload);
          this._windowCacheExpiresAt.set(window, Date.now() + WINDOW_CACHE_TTL_MS);

          return payload;
        }
      )
      .catch((err: unknown) => {
        // The DB query failed. Degrade to the already-cached 7d base-class
        // snapshot without issuing a second DB round-trip. We read the cached
        // payload synchronously from the base class rather than calling
        // ensureFresh() (which would call tryGetIntelligenceDb() again and
        // potentially start another failing query).
        console.warn(
          `[llm-routing] ensureFreshForWindow('${window}') DB query failed — degrading to 7d cache:`,
          err
        );
        const cached = this.getSnapshot();
        if (cached.payload) {
          return { ...cached.payload, degraded: true, window: '7d' as const };
        }
        return { ...this.emptyPayload(), degraded: true, window: '7d' as const };
      })
      .finally(() => {
        // Only remove the in-flight entry if it still refers to this Promise.
        // A concurrent reset() may have already cleared and replaced it.
        if (this._windowRefreshInFlight.get(window) === refreshPromise) {
          this._windowRefreshInFlight.delete(window);
        }
      });

    this._windowRefreshInFlight.set(window, refreshPromise);

    return refreshPromise;
  }

  /**
   * Invalidate per-window cache for a specific window (or all windows if omitted).
   *
   * Called by WebSocket invalidation handler after a new routing decision is projected
   * so the next request triggers a fresh DB query instead of returning stale data.
   *
   * The base-class snapshot (7d) is invalidated by super.reset() only when the '7d'
   * window is targeted or when no window is specified (full invalidation). This method
   * covers the additional per-window caches maintained by this subclass.
   */
  invalidateCache(window?: LlmRoutingTimeWindow): void {
    if (window) {
      this._windowCache.delete(window);
      this._windowCacheExpiresAt.delete(window);
      // Clear in-flight guard for this window so a fresh query can start.
      this._windowRefreshInFlight.delete(window);
      // Best-effort invalidation: any in-flight cache-fill Promise that was already
      // scheduled before this call may still write a (nearly-fresh) payload to the
      // cache. The staleness window is bounded by WINDOW_CACHE_TTL_MS. See reset() JSDoc.
      // Invalidate the base-class 7d TTL cache only when targeting the '7d' window,
      // since other windows do not share state with the base-class snapshot.
      if (window === '7d') {
        super.reset();
      }
    } else {
      // Full invalidation: clear everything.
      // Best-effort invalidation: any in-flight cache-fill Promise that was already
      // scheduled before this call may still write a (nearly-fresh) payload to the
      // cache. The staleness window is bounded by WINDOW_CACHE_TTL_MS. See reset() JSDoc.
      this._windowCache.clear();
      this._windowCacheExpiresAt.clear();
      this._windowRefreshInFlight.clear();
      super.reset();
    }
  }
}
