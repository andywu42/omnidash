/**
 * CostMetricsProjection — DB-backed projection for the cost trend dashboard (OMN-2300)
 *
 * Encapsulates all SQL queries for the LLM cost and token usage dashboard behind
 * the ProjectionView interface. Routes call ensureFresh() and access sub-fields
 * instead of executing SQL directly.
 *
 * Snapshot payload shape matches the combined API output of:
 *   GET /api/costs/summary
 *   GET /api/costs/trend
 *   GET /api/costs/by-model
 *   GET /api/costs/by-repo
 *   GET /api/costs/by-pattern
 *   GET /api/costs/token-usage
 *
 * Source table: llm_cost_aggregates (defined in shared/intelligence-schema.ts)
 * Zero-cost rows are excluded from aggregates (total_cost_usd = 0 is filtered out).
 *
 * Note on NULL handling: even though numeric columns are declared NOT NULL with a
 * DEFAULT of '0', PostgreSQL's SUM() aggregate returns NULL (not 0) when the
 * input set is empty (i.e. no rows match the WHERE clause). COALESCE(..., 0) is
 * therefore required around every SUM() to guarantee a non-null numeric result
 * when there is no data for the requested window.
 */

import { sql, gte, lt, and, gt, desc, eq } from 'drizzle-orm';
import { llmCostAggregates } from '@shared/intelligence-schema';
import type {
  CostSummary,
  CostTrendPoint,
  CostByModel,
  CostByRepo,
  CostByPattern,
  TokenUsagePoint,
  CostTimeWindow,
  UsageSource,
} from '@shared/cost-types';
import { DbBackedProjectionView, DEFAULT_CACHE_TTL_MS } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import { safeTruncUnit } from '../sql-safety';

// ============================================================================
// Payload type
// ============================================================================

export interface CostMetricsPayload {
  summary: CostSummary;
  trend: CostTrendPoint[];
  byModel: CostByModel[];
  byRepo: CostByRepo[];
  byPattern: CostByPattern[];
  tokenUsage: TokenUsagePoint[];
  /**
   * Set to `true` when the DB was unavailable and `ensureFreshForWindow()`
   * fell back to the cached 7d snapshot instead of querying the requested
   * window. Callers should treat the data as window-mismatched and may
   * choose to surface a warning or retry later.
   * Absent (undefined) when the payload reflects the actually-requested window.
   */
  degraded?: boolean;
  /**
   * The actual time window reflected in this payload. Equals the requested
   * window when the DB was available; equals '7d' when degraded is true.
   * Absent (undefined) when data came from the default 7d TTL cache path
   * (i.e. the caller used ensureFresh() directly, not ensureFreshForWindow()).
   */
  window?: CostTimeWindow;
}

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

// ============================================================================
// Window helpers
// ============================================================================

/** Return the cutoff Date for a given CostTimeWindow. */
function windowCutoff(window: CostTimeWindow): Date {
  const now = Date.now();
  if (window === '24h') return new Date(now - 24 * 60 * 60 * 1000);
  if (window === '30d') return new Date(now - 30 * 24 * 60 * 60 * 1000);
  // default: 7d
  return new Date(now - 7 * 24 * 60 * 60 * 1000);
}

/** Return 'hour' or 'day' truncation unit based on window. */
function truncUnit(window: CostTimeWindow): 'hour' | 'day' {
  return window === '24h' ? 'hour' : 'day';
}

// ============================================================================
// Per-window cache TTL — mirrors DbBackedProjectionView's DEFAULT_CACHE_TTL_MS
// ============================================================================

/**
 * TTL for per-window snapshots cached by ensureFreshForWindow().
 *
 * Intentionally mirrors DEFAULT_CACHE_TTL_MS (the base-class TTL used by
 * ensureFresh()) so that the 7d default cache and every per-window cache all
 * expire on the same schedule. If you change one without changing the other,
 * requests for non-default windows will expire at a different rate than the
 * 7d snapshot, which can cause inconsistent staleness behaviour (e.g. a 30d
 * view staying stale long after the 7d view has refreshed).
 */
const WINDOW_CACHE_TTL_MS = DEFAULT_CACHE_TTL_MS;

// ============================================================================
// Projection
// ============================================================================

export class CostMetricsProjection extends DbBackedProjectionView<CostMetricsPayload> {
  readonly viewId = 'cost-metrics';

  /** Per-window payload cache: keyed by CostTimeWindow, stores the last payload. */
  private readonly _windowCache = new Map<CostTimeWindow, CostMetricsPayload>();
  /** Per-window cache expiry timestamps (ms since epoch). */
  private readonly _windowCacheExpiresAt = new Map<CostTimeWindow, number>();
  /**
   * In-flight coalescing guard for ensureFreshForWindow().
   * When multiple concurrent callers request the same window before the cache
   * is populated, all callers after the first share the same pending Promise
   * rather than firing N duplicate DB queries.
   */
  private readonly _windowRefreshInFlight = new Map<CostTimeWindow, Promise<CostMetricsPayload>>();

  protected emptyPayload(): CostMetricsPayload {
    return {
      summary: {
        total_cost_usd: 0,
        reported_cost_usd: 0,
        estimated_cost_usd: 0,
        reported_coverage_pct: 0,
        total_tokens: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        session_count: 0,
        model_count: 0,
        avg_cost_per_session: 0,
        cost_change_pct: 0,
        active_alerts: 0,
      },
      trend: [],
      byModel: [],
      byRepo: [],
      byPattern: [],
      tokenUsage: [],
    };
  }

  /**
   * Override reset() to also clear the per-window caches maintained by this subclass.
   *
   * Known race: any in-flight Promises that were cleared from _windowRefreshInFlight
   * may still resolve and write to _windowCache after this reset completes (because
   * their .then() callbacks hold a reference to `this`). This is acceptable — the
   * same race exists in the base class TTL cache — and the stale write is harmless
   * because the next TTL check will expire and re-fetch the data.
   */
  override reset(): void {
    super.reset();
    this._windowCache.clear();
    this._windowCacheExpiresAt.clear();
    this._windowRefreshInFlight.clear();
  }

  protected async querySnapshot(db: Db): Promise<CostMetricsPayload> {
    // Default window for the pre-warmed snapshot: 7d
    const window: CostTimeWindow = '7d';

    const [summary, trend, byModel, byRepo, byPattern, tokenUsage] = await Promise.all([
      this.querySummary(db, window),
      this.queryTrend(db, window),
      this.queryByModel(db),
      this.queryByRepo(db),
      this.queryByPattern(db),
      this.queryTokenUsage(db, window),
    ]);

    return { summary, trend, byModel, byRepo, byPattern, tokenUsage };
  }

  // --------------------------------------------------------------------------
  // Public query methods (routes may call these directly for window-specific data)
  //
  // NOTE: These methods accept a `Db` parameter directly and execute SQL
  // immediately — they do NOT include graceful-degradation logic (i.e., they
  // will throw if the DB is unavailable rather than falling back to a cached
  // snapshot). Callers that need graceful degradation should use
  // `ensureFreshForWindow()` instead, which handles the DB-unavailable case
  // by falling back to `ensureFresh()` transparently.
  // --------------------------------------------------------------------------

  async querySummary(db: Db, window: CostTimeWindow = '7d'): Promise<CostSummary> {
    const lca = llmCostAggregates;
    const cutoff = windowCutoff(window);
    // Prior period starts 2x the window width back from `cutoff`, giving a total
    // lookback of 2× the selected window (e.g. 14d for 7d, 60d for 30d, 48h for
    // 24h). This is intentional: querySummary needs two consecutive same-length
    // windows to compute the cost_change_pct delta.
    //
    // Note on asymmetry: the breakdown panels (queryByModel / queryByRepo /
    // queryByPattern) always use a fixed 30d window regardless of the trend window
    // selected by the user, so their effective lookback is always exactly 30d —
    // they do NOT use a prior period. This is by design: breakdown panels are
    // stable context panels, not time-comparison panels.
    const windowMs =
      window === '24h'
        ? 24 * 60 * 60 * 1000
        : window === '30d'
          ? 30 * 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;
    const priorCutoff = new Date(cutoff.getTime() - windowMs);

    // Two queries per period:
    //   costFiltered — rows with totalCostUsd > 0 only, used for cost aggregates.
    //   unfiltered   — all rows in window, used for token/session/model counts.
    // This ensures zero-cost Ollama/local-LLM calls are counted in usage metrics
    // even though they don't contribute to cost totals.
    const [currentCost, currentUsage, prior] = await Promise.all([
      db
        .select({
          total_cost: sql<string>`COALESCE(SUM(${lca.totalCostUsd}::numeric), 0)::text`,
          reported_cost: sql<string>`COALESCE(SUM(${lca.reportedCostUsd}::numeric), 0)::text`,
          estimated_cost: sql<string>`COALESCE(SUM(${lca.estimatedCostUsd}::numeric), 0)::text`,
        })
        .from(lca)
        .where(and(gte(lca.bucketTime, cutoff), gt(lca.totalCostUsd, '0'))),
      db
        .select({
          total_tokens: sql<number>`COALESCE(SUM(${lca.totalTokens}), 0)::bigint`,
          prompt_tokens: sql<number>`COALESCE(SUM(${lca.promptTokens}), 0)::bigint`,
          completion_tokens: sql<number>`COALESCE(SUM(${lca.completionTokens}), 0)::bigint`,
          session_count: sql<number>`COUNT(DISTINCT ${lca.sessionId}) FILTER (WHERE ${lca.sessionId} IS NOT NULL)::int`,
          model_count: sql<number>`COUNT(DISTINCT ${lca.modelName})::int`,
        })
        .from(lca)
        .where(gte(lca.bucketTime, cutoff)),
      db
        .select({
          total_cost: sql<string>`COALESCE(SUM(${lca.totalCostUsd}::numeric), 0)::text`,
        })
        .from(lca)
        .where(
          and(
            gte(lca.bucketTime, priorCutoff),
            lt(lca.bucketTime, cutoff),
            gt(lca.totalCostUsd, '0')
          )
        ),
    ]);

    const curCost = currentCost[0] ?? {
      total_cost: '0',
      reported_cost: '0',
      estimated_cost: '0',
    };
    const curUsage = currentUsage[0] ?? {
      total_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      session_count: 0,
      model_count: 0,
    };

    const totalCost = parseFloat(curCost.total_cost);
    const reportedCost = parseFloat(curCost.reported_cost);
    const estimatedCost = parseFloat(curCost.estimated_cost);
    const sessionCount = Number(curUsage.session_count);
    const priorCost = parseFloat(prior[0]?.total_cost ?? '0');

    const reportedCoverage = totalCost > 0 ? (reportedCost / totalCost) * 100 : 0;
    const avgCostPerSession = sessionCount > 0 ? totalCost / sessionCount : 0;
    // When current cost drops to zero from a positive prior cost, the change is a full -100%.
    // Without this special case the formula ((0 - priorCost) / priorCost) * 100 = -100 is
    // mathematically correct, but the guard `priorCost > 0` would short-circuit to 0 when
    // totalCost is also 0 — so we handle the zero-current case explicitly.
    const costChangePct =
      priorCost > 0 ? (totalCost === 0 ? -100 : ((totalCost - priorCost) / priorCost) * 100) : 0;

    return {
      total_cost_usd: totalCost,
      reported_cost_usd: reportedCost,
      estimated_cost_usd: estimatedCost,
      reported_coverage_pct: reportedCoverage,
      total_tokens: Number(curUsage.total_tokens),
      prompt_tokens: Number(curUsage.prompt_tokens),
      completion_tokens: Number(curUsage.completion_tokens),
      session_count: sessionCount,
      model_count: Number(curUsage.model_count),
      avg_cost_per_session: avgCostPerSession,
      cost_change_pct: costChangePct,
      active_alerts: 0, // Budget alerts table not yet implemented
    };
  }

  async queryTrend(
    db: Db,
    window: CostTimeWindow = '7d',
    modelName?: string
  ): Promise<CostTrendPoint[]> {
    const lca = llmCostAggregates;
    const cutoff = windowCutoff(window);
    const unit = truncUnit(window);

    const conditions = [gte(lca.bucketTime, cutoff), gt(lca.totalCostUsd, '0')];
    if (modelName) {
      conditions.push(eq(lca.modelName, modelName));
    }

    // safeTruncUnit() validates against the centralized allowlist in sql-safety.ts
    const rows = await db
      .select({
        bucket: sql<string>`date_trunc(${safeTruncUnit(unit)}, ${lca.bucketTime})::text`,
        total_cost: sql<string>`COALESCE(SUM(${lca.totalCostUsd}::numeric), 0)::text`,
        reported_cost: sql<string>`COALESCE(SUM(${lca.reportedCostUsd}::numeric), 0)::text`,
        estimated_cost: sql<string>`COALESCE(SUM(${lca.estimatedCostUsd}::numeric), 0)::text`,
        session_count: sql<number>`COUNT(DISTINCT ${lca.sessionId}) FILTER (WHERE ${lca.sessionId} IS NOT NULL)::int`,
      })
      .from(lca)
      .where(and(...conditions))
      .groupBy(sql`date_trunc(${safeTruncUnit(unit)}, ${lca.bucketTime})`)
      .orderBy(sql`date_trunc(${safeTruncUnit(unit)}, ${lca.bucketTime})`);

    return rows.map((r) => ({
      timestamp: r.bucket,
      total_cost_usd: parseFloat(r.total_cost),
      reported_cost_usd: parseFloat(r.reported_cost),
      estimated_cost_usd: parseFloat(r.estimated_cost),
      session_count: Number(r.session_count),
    }));
  }

  /**
   * Query trend data filtered by model name, obtaining the DB handle internally.
   *
   * This method exists so that route handlers can request model-filtered trend
   * data without importing tryGetIntelligenceDb directly (which violates the
   * OMN-2325 no-direct-DB-in-routes arch rule).
   *
   * Returns null when the DB is unavailable (caller should return [] or degrade).
   */
  async queryTrendForModel(
    window: CostTimeWindow,
    modelName: string
  ): Promise<CostTrendPoint[] | null> {
    const db = tryGetIntelligenceDb();
    if (!db) return null;
    return this.queryTrend(db, window, modelName);
  }

  async queryByModel(db: Db): Promise<CostByModel[]> {
    const lca = llmCostAggregates;
    // Intentionally hardcoded to 30d regardless of the active trend window.
    // Model breakdowns are designed to show a stable, long-horizon cost
    // distribution so users can compare model share over a meaningful period.
    // Tying the breakdown to the selected trend window (e.g. 24h) would produce
    // misleading percentages because short windows may not contain all models.
    // The trend/summary endpoints respect the window parameter; byModel/byRepo/
    // byPattern always show 30d for consistent context panels.
    const cutoff = windowCutoff('30d');

    const rows = await db
      .select({
        model_name: lca.modelName,
        total_cost: sql<string>`COALESCE(SUM(${lca.totalCostUsd}::numeric), 0)::text`,
        reported_cost: sql<string>`COALESCE(SUM(${lca.reportedCostUsd}::numeric), 0)::text`,
        estimated_cost: sql<string>`COALESCE(SUM(${lca.estimatedCostUsd}::numeric), 0)::text`,
        total_tokens: sql<number>`COALESCE(SUM(${lca.totalTokens}), 0)::bigint`,
        prompt_tokens: sql<number>`COALESCE(SUM(${lca.promptTokens}), 0)::bigint`,
        completion_tokens: sql<number>`COALESCE(SUM(${lca.completionTokens}), 0)::bigint`,
        request_count: sql<number>`COALESCE(SUM(${lca.requestCount}), 0)::int`,
        usage_source: sql<string | null>`mode() WITHIN GROUP (ORDER BY ${lca.usageSource})`,
      })
      .from(lca)
      .where(and(gte(lca.bucketTime, cutoff), gt(lca.totalCostUsd, '0')))
      .groupBy(lca.modelName)
      .orderBy(desc(sql`SUM(${lca.totalCostUsd}::numeric)`));

    return rows.map((r) => ({
      model_name: r.model_name,
      total_cost_usd: parseFloat(r.total_cost),
      reported_cost_usd: parseFloat(r.reported_cost),
      estimated_cost_usd: parseFloat(r.estimated_cost),
      total_tokens: Number(r.total_tokens),
      prompt_tokens: Number(r.prompt_tokens),
      completion_tokens: Number(r.completion_tokens),
      request_count: Number(r.request_count),
      // `|| 'API'` coerces both null (SQL NULL from mode() on an empty group) and
      // empty-string '' (a data quality issue — empty-string should not be stored,
      // but if it is, we treat it as missing and default to 'API').
      // Note: (r.usage_source ?? '') || 'API' would be equivalent but more verbose;
      // the simpler `||` form is fine because null is already falsy in JS.
      usage_source: (r.usage_source || 'API') as UsageSource,
    }));
  }

  async queryByRepo(db: Db): Promise<CostByRepo[]> {
    const lca = llmCostAggregates;
    // Intentionally hardcoded to 30d — same rationale as queryByModel above.
    // Repo breakdowns are context panels that need a stable long-horizon view,
    // independent of the trend window selected by the user.
    const cutoff = windowCutoff('30d');

    const rows = await db
      .select({
        repo_name: lca.repoName,
        total_cost: sql<string>`COALESCE(SUM(${lca.totalCostUsd}::numeric), 0)::text`,
        reported_cost: sql<string>`COALESCE(SUM(${lca.reportedCostUsd}::numeric), 0)::text`,
        estimated_cost: sql<string>`COALESCE(SUM(${lca.estimatedCostUsd}::numeric), 0)::text`,
        total_tokens: sql<number>`COALESCE(SUM(${lca.totalTokens}), 0)::bigint`,
        session_count: sql<number>`COUNT(DISTINCT ${lca.sessionId}) FILTER (WHERE ${lca.sessionId} IS NOT NULL)::int`,
        usage_source: sql<string | null>`mode() WITHIN GROUP (ORDER BY ${lca.usageSource})`,
      })
      .from(lca)
      .where(and(gte(lca.bucketTime, cutoff), gt(lca.totalCostUsd, '0')))
      .groupBy(lca.repoName)
      .orderBy(desc(sql`SUM(${lca.totalCostUsd}::numeric)`));

    return rows
      .filter((r) => r.repo_name != null)
      .map((r) => ({
        repo_name: r.repo_name!,
        total_cost_usd: parseFloat(r.total_cost),
        reported_cost_usd: parseFloat(r.reported_cost),
        estimated_cost_usd: parseFloat(r.estimated_cost),
        total_tokens: Number(r.total_tokens),
        session_count: Number(r.session_count),
        // Same null/empty-string handling as queryByModel — see comment there.
        usage_source: (r.usage_source || 'API') as UsageSource,
      }));
  }

  async queryByPattern(db: Db): Promise<CostByPattern[]> {
    const lca = llmCostAggregates;
    // Intentionally hardcoded to 30d — same rationale as queryByModel above.
    // Pattern breakdowns are context panels that need a stable long-horizon view,
    // independent of the trend window selected by the user.
    const cutoff = windowCutoff('30d');

    const rows = await db
      .select({
        pattern_id: lca.patternId,
        pattern_name: lca.patternName,
        total_cost: sql<string>`COALESCE(SUM(${lca.totalCostUsd}::numeric), 0)::text`,
        reported_cost: sql<string>`COALESCE(SUM(${lca.reportedCostUsd}::numeric), 0)::text`,
        estimated_cost: sql<string>`COALESCE(SUM(${lca.estimatedCostUsd}::numeric), 0)::text`,
        prompt_tokens: sql<number>`COALESCE(SUM(${lca.promptTokens}), 0)::bigint`,
        completion_tokens: sql<number>`COALESCE(SUM(${lca.completionTokens}), 0)::bigint`,
        injection_count: sql<number>`COALESCE(SUM(${lca.requestCount}), 0)::int`,
        usage_source: sql<string | null>`mode() WITHIN GROUP (ORDER BY ${lca.usageSource})`,
      })
      .from(lca)
      .where(and(gte(lca.bucketTime, cutoff), gt(lca.totalCostUsd, '0')))
      .groupBy(lca.patternId, lca.patternName)
      .orderBy(desc(sql`SUM(${lca.totalCostUsd}::numeric)`));

    return rows
      .filter((r) => r.pattern_id != null)
      .map((r) => {
        const totalCost = parseFloat(r.total_cost);
        const injectionCount = Number(r.injection_count);
        return {
          pattern_id: r.pattern_id!,
          pattern_name: r.pattern_name ?? r.pattern_id!,
          total_cost_usd: totalCost,
          reported_cost_usd: parseFloat(r.reported_cost),
          estimated_cost_usd: parseFloat(r.estimated_cost),
          prompt_tokens: Number(r.prompt_tokens),
          completion_tokens: Number(r.completion_tokens),
          injection_count: injectionCount,
          avg_cost_per_injection: injectionCount > 0 ? totalCost / injectionCount : 0,
          // Same null/empty-string handling as queryByModel — see comment there.
          usage_source: (r.usage_source || 'API') as UsageSource,
        };
      });
  }

  async queryTokenUsage(db: Db, window: CostTimeWindow = '7d'): Promise<TokenUsagePoint[]> {
    const lca = llmCostAggregates;
    const cutoff = windowCutoff(window);
    const unit = truncUnit(window);

    // safeTruncUnit() validates against the centralized allowlist in sql-safety.ts
    const rows = await db
      .select({
        bucket: sql<string>`date_trunc(${safeTruncUnit(unit)}, ${lca.bucketTime})::text`,
        prompt_tokens: sql<number>`COALESCE(SUM(${lca.promptTokens}), 0)::bigint`,
        completion_tokens: sql<number>`COALESCE(SUM(${lca.completionTokens}), 0)::bigint`,
        total_tokens: sql<number>`COALESCE(SUM(${lca.totalTokens}), 0)::bigint`,
        // Dominant usage source for the bucket
        usage_source: sql<string | null>`mode() WITHIN GROUP (ORDER BY ${lca.usageSource})`,
      })
      .from(lca)
      // Include all rows regardless of cost so that zero-cost local-LLM calls
      // (e.g. Ollama, where estimated_cost_usd is null/0) are reflected in the
      // token-usage chart. Unlike cost trend panels, token usage is always
      // meaningful even when the cost is $0.
      .where(gte(lca.bucketTime, cutoff))
      .groupBy(sql`date_trunc(${safeTruncUnit(unit)}, ${lca.bucketTime})`)
      .orderBy(sql`date_trunc(${safeTruncUnit(unit)}, ${lca.bucketTime})`);

    return rows.map((r) => ({
      timestamp: r.bucket,
      prompt_tokens: Number(r.prompt_tokens),
      completion_tokens: Number(r.completion_tokens),
      total_tokens: Number(r.total_tokens),
      // Same null/empty-string handling as queryByModel — see comment there.
      usage_source: (r.usage_source || 'API') as UsageSource,
    }));
  }

  // --------------------------------------------------------------------------
  // Window-aware fetch (for route handlers with ?window= parameter)
  // --------------------------------------------------------------------------

  /**
   * Return payload for a specific time window with per-window TTL caching.
   * Route handlers call this when window != '7d' (the default snapshot window).
   * Results are cached per-window for WINDOW_CACHE_TTL_MS (5 s) to coalesce
   * concurrent requests and avoid hammering the DB with repeated queries.
   * Encapsulates the DB access so routes don't need to import tryGetIntelligenceDb.
   *
   * Falls back to cached/empty payload if the DB is unavailable.
   *
   * Degraded-state behavior: when `tryGetIntelligenceDb()` returns null (DB
   * not configured or connection failed), this method falls back to
   * `ensureFresh()`, which returns the most recent TTL-cached snapshot for the
   * default 7d window (or an empty payload if no snapshot has been warmed yet).
   * The returned payload will have `degraded: true` and `window: '7d'` set so
   * callers can detect that the data does not reflect the requested window.
   * This is intentional — the dashboard should degrade gracefully rather than
   * surface DB errors to users, but callers need to know the mismatch occurred.
   */
  async ensureFreshForWindow(window: CostTimeWindow): Promise<CostMetricsPayload> {
    // Guard: '7d' must never be routed here — it is handled by the base-class
    // TTL cache via ensureFresh(). Calling ensureFreshForWindow('7d') would
    // create a duplicate per-window cache entry for the same data, wasting
    // memory and causing the two caches to drift slightly out of sync.
    if (window === '7d') {
      console.warn(
        '[cost-metrics] ensureFreshForWindow called with default window "7d" — redirecting to ensureFresh(). ' +
          'Use ensureFresh() directly for the default window.'
      );
      return this.ensureFresh();
    }

    // Return the per-window cached snapshot if it is still fresh.
    const cachedPayload = this._windowCache.get(window);
    const expiresAt = this._windowCacheExpiresAt.get(window) ?? 0;
    if (cachedPayload !== undefined && Date.now() < expiresAt) {
      return cachedPayload;
    }

    // Coalesce concurrent requests for the same window into a single DB round-trip.
    // Under burst traffic the TTL check above passes for all concurrent callers
    // before any one of them has populated the cache. Without this guard, N callers
    // would each independently start a full set of DB queries for the same window.
    const inFlight = this._windowRefreshInFlight.get(window);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const db = tryGetIntelligenceDb();
    if (!db) {
      // DB unavailable — fall back to the TTL-cached 7d snapshot (or empty payload
      // if not yet warmed). If ensureFresh() itself throws, return an empty payload
      // so callers are never left with an unhandled rejection from this degraded path.
      try {
        const fallback = await this.ensureFresh();
        return { ...fallback, degraded: true, window: '7d' };
      } catch {
        return { ...this.emptyPayload(), degraded: true, window: '7d' };
      }
    }

    const refreshPromise: Promise<CostMetricsPayload> = Promise.all([
      this.querySummary(db, window),
      this.queryTrend(db, window),
      this.queryByModel(db),
      this.queryByRepo(db),
      this.queryByPattern(db),
      this.queryTokenUsage(db, window),
    ])
      .then(([summary, trend, byModel, byRepo, byPattern, tokenUsage]) => {
        const payload: CostMetricsPayload = {
          summary,
          trend,
          byModel,
          byRepo,
          byPattern,
          tokenUsage,
          window,
        };

        // Store in per-window cache with TTL.
        this._windowCache.set(window, payload);
        this._windowCacheExpiresAt.set(window, Date.now() + WINDOW_CACHE_TTL_MS);

        return payload;
      })
      .catch(async (err: unknown) => {
        // DB query failed mid-flight (e.g. connection lost after tryGetIntelligenceDb()
        // returned non-null). Fall back to the TTL-cached 7d snapshot — same
        // degradation contract as the DB-unavailable path above. If ensureFresh()
        // also throws, return an empty payload rather than re-throwing, to keep both
        // degradation paths consistent (neither propagates an error to the caller).
        console.warn(
          `[cost-metrics] ensureFreshForWindow('${window}') DB query failed — degrading to 7d cache:`,
          err
        );
        try {
          const fallback = await this.ensureFresh();
          return { ...fallback, degraded: true, window: '7d' as const };
        } catch {
          console.warn(
            `[cost-metrics] ensureFreshForWindow('${window}') ensureFresh() also failed — returning empty payload`
          );
          return { ...this.emptyPayload(), degraded: true, window: '7d' as const };
        }
      })
      .finally(() => {
        // Guard against a reset() + new in-flight race: only remove the in-flight
        // entry if it still refers to this Promise. If reset() has already cleared
        // it and a new caller registered a fresh Promise, deleting here would
        // incorrectly discard the new in-flight, bypassing the coalescing guard.
        if (this._windowRefreshInFlight.get(window) === refreshPromise) {
          this._windowRefreshInFlight.delete(window);
        }
      });

    this._windowRefreshInFlight.set(window, refreshPromise);

    return refreshPromise;
  }
}
