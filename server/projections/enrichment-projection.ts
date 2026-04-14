/**
 * EnrichmentProjection — DB-backed projection for the Context Enrichment dashboard (OMN-2373)
 *
 * Encapsulates all SQL queries for the enrichment dashboard behind the
 * ProjectionView interface. Routes call ensureFresh() and access sub-fields
 * instead of importing storage or executing SQL directly.
 *
 * Source table: context_enrichment_events (defined by migrations/0075_context_enrichment_events.sql)
 *
 * Columns used: correlation_id, channel, model_name, cache_hit, outcome,
 *   latency_ms, tokens_before, tokens_after, net_tokens_saved,
 *   similarity_score, quality_score, repo, agent_name, created_at
 *
 * Per OMN-2325 architectural rule: route files must not import DB accessors
 * directly. All data access goes through this projection.
 */

import { sql } from 'drizzle-orm';
import type {
  EnrichmentSummary,
  EnrichmentByChannel,
  LatencyDistributionPoint,
  TokenSavingsTrendPoint,
  SimilarityQualityPoint,
  InflationAlert,
} from '@shared/enrichment-types';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import {
  safeInterval,
  safeTruncUnit,
  timeWindowToInterval,
  truncUnitForWindow,
  ACCEPTED_WINDOWS,
} from '../sql-safety';

// ============================================================================
// Payload type
// ============================================================================

export interface EnrichmentPayload {
  summary: EnrichmentSummary;
  byChannel: EnrichmentByChannel[];
  latencyDistribution: LatencyDistributionPoint[];
  tokenSavingsTrend: TokenSavingsTrendPoint[];
  similarityQuality: SimilarityQualityPoint[];
  inflationAlerts: InflationAlert[];
}

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

// ============================================================================
// Projection
// ============================================================================

export class EnrichmentProjection extends DbBackedProjectionView<EnrichmentPayload> {
  readonly viewId = 'enrichment';

  /**
   * Per-window in-flight guard for ensureFreshForWindow().
   *
   * Concurrent calls for the same window string are coalesced onto a single
   * set of DB queries rather than each issuing their own six parallel queries.
   * The Map is keyed by the window string ('24h', '7d', '30d') and the stored
   * Promise is removed in a .finally() handler so the next call after the
   * current one resolves starts a fresh query.
   */
  private ensureFreshForWindowInFlight = new Map<string, Promise<EnrichmentPayload>>();

  /**
   * Per-window cooldown guard for ensureFreshForWindow().
   *
   * Records the monotonic timestamp (Date.now()) at which the most recent
   * non-coalesced DB query set was *dispatched* for each window key.  Any
   * call that arrives within ENSURE_FRESH_COOLDOWN_MS of the last dispatch —
   * and that is not already coalesced by ensureFreshForWindowInFlight — will
   * return the last resolved snapshot directly from the per-window cache
   * rather than starting a new round of six parallel DB queries.
   *
   * This is a minimal debounce, not a full TTL cache.  It prevents DB
   * hammering under rapid polling (e.g. a dashboard polling every 100 ms)
   * without requiring a separate per-window cache eviction strategy.
   *
   * The Map is intentionally unbounded because it holds at most three entries
   * (one per accepted window value: '24h', '7d', '30d').
   */
  private ensureFreshForWindowLastDispatched = new Map<string, number>();

  /**
   * Per-window snapshot cache populated by the cooldown guard.
   *
   * Stores the last successfully resolved EnrichmentPayload for each window
   * key so that calls arriving within ENSURE_FRESH_COOLDOWN_MS can be served
   * from memory rather than issuing new DB queries.
   */
  private ensureFreshForWindowLastSnapshot = new Map<string, EnrichmentPayload>();

  /**
   * Minimum interval (ms) between successive non-coalesced DB query sets for
   * the same window key.
   *
   * Production risk: without this guard, N clients each polling at 200 ms
   * would issue 5 * N query sets per second (6 parallel queries each), totalling
   * up to 30 * N DB round-trips per second.  At N=10 that is 300 round-trips/s
   * against a single PostgreSQL instance — enough to saturate connection pools
   * under sustained load.  The cooldown bounds the rate to at most
   * ceil(1000 / ENSURE_FRESH_COOLDOWN_MS) * 6 DB queries per second per window,
   * regardless of the number of polling clients, because concurrent calls are
   * additionally collapsed by ensureFreshForWindowInFlight.
   *
   * Recommended client polling interval: >= 2 000 ms (2 s) for production.
   * At 500 ms cooldown and 2 s polling: 0.5 query sets/s per window (~3 DB queries/s).
   * At 500 ms cooldown and 200 ms polling: 2 query sets/s per window (~12 DB queries/s).
   *
   * Raise this value if DB load is a concern.  Setting it above the client
   * polling interval will cause every poll to return the cached snapshot
   * (effectively a short TTL cache).
   *
   * TODO: replace with a proper per-window TTL cache keyed on window string to
   * reduce DB load further under sustained polling. Track as a follow-up ticket
   * after OMN-2373 merges (OMN-2373 is the implementation ticket, not the
   * follow-up).
   */
  private static readonly ENSURE_FRESH_COOLDOWN_MS = 500;

  /**
   * Return a zero-value `EnrichmentPayload` used as a safe fallback when the
   * database is unavailable or a query returns no rows.
   *
   * All numeric fields are initialised to `0`, all array fields to `[]`, and
   * the nested `counts` object within `summary` mirrors those defaults.
   *
   * @returns A fully-typed `EnrichmentPayload` with every field set to its
   *   empty/zero equivalent.
   */
  protected emptyPayload(): EnrichmentPayload {
    return {
      summary: {
        total_enrichments: 0,
        hit_rate: 0,
        net_tokens_saved: 0,
        p50_latency_ms: 0,
        p95_latency_ms: 0,
        avg_similarity_score: 0,
        inflation_alert_count: 0,
        error_rate: 0,
        counts: { hits: 0, misses: 0, errors: 0, inflated: 0 },
      },
      byChannel: [],
      latencyDistribution: [],
      tokenSavingsTrend: [],
      similarityQuality: [],
      inflationAlerts: [],
    };
  }

  /**
   * Build the default cached snapshot using the '24h' time window.
   *
   * This method is called by the `DbBackedProjectionView` base class whenever
   * the in-memory cache is stale or absent. It delegates to `_queryForWindow`
   * with the '24h' window, which fans out all six sub-queries in parallel via
   * `Promise.all`.
   *
   * NOTE: Route handlers MUST use `ensureFreshForWindow(window)` rather than
   * the inherited `ensureFresh()` / `getSnapshot()` path. The base-class
   * cache is a single 24h snapshot; per-window snapshots are managed by the
   * separate `ensureFreshForWindow` Maps. Calling both paths concurrently for
   * '24h' is safe (they share the same `_queryForWindow('24h')` call) but the
   * two caches are disjoint — only `ensureFreshForWindow` applies the cooldown
   * and in-flight coalescing guards.
   *
   * @param db - An active Drizzle database instance obtained from
   *   `tryGetIntelligenceDb`.
   * @returns A fully-populated `EnrichmentPayload` scoped to the last 24 hours.
   */
  protected async querySnapshot(db: Db): Promise<EnrichmentPayload> {
    return this._queryForWindow(db, '24h');
  }

  /**
   * Reset all cached state, including per-window cooldown Maps.
   *
   * Overrides the base-class `reset()` to also clear the per-window Maps
   * maintained by `ensureFreshForWindow()`. Without this, a `reset()` call
   * during testing or projection re-initialization would leave stale cooldown
   * timestamps and snapshots in the Maps, causing the cooldown guard to serve
   * outdated data or skip dispatching fresh queries.
   */
  override reset(): void {
    super.reset();
    // Clearing Maps means next call per window will dispatch immediately
    // regardless of any prior cooldown — correct after reset.
    //
    // KNOWN LIMITATION: Any promises already in ensureFreshForWindowInFlight
    // at the time of reset() cannot be cancelled. Their .then() callbacks will
    // still fire after reset(), re-adding one snapshot entry to the cleared
    // lastSnapshot Map. This is acceptable: the data is fresh (from the
    // just-resolved query) and will be overwritten on the next dispatch.
    // Callers must not rely on the snapshot Map being permanently empty after
    // reset() when concurrent queries are in flight.
    this.ensureFreshForWindowLastDispatched.clear();
    this.ensureFreshForWindowLastSnapshot.clear();
    this.ensureFreshForWindowInFlight.clear();
  }

  // --------------------------------------------------------------------------
  // Public API used by route handlers
  // --------------------------------------------------------------------------

  /**
   * Return a fresh snapshot scoped to the given time window.
   *
   * The base `getSnapshot()` / `ensureFresh()` caches only the '24h' window.
   * Callers that need '7d' or '30d' snapshots call this method directly, which
   * bypasses the base-class cache and issues live queries (subject to the
   * cooldown guard described below). Routes should prefer this over
   * `ensureFresh()` whenever the window parameter is user-supplied.
   *
   * If the database is unavailable (`tryGetIntelligenceDb` returns `null`),
   * an `emptyPayload()` is returned immediately without throwing.
   *
   * @param window - Time window identifier. Must be one of '24h', '7d', '30d'.
   *   An unrecognised value throws immediately so callers receive an explicit
   *   error rather than silently incorrect 7-day data. Note: the route layer
   *   imports ACCEPTED_WINDOWS directly and is the primary guard; this check is
   *   a secondary safety net sharing the same constant.
   * @returns A fully-populated `EnrichmentPayload` scoped to the requested
   *   window, or an empty payload when the DB is unreachable.
   * @throws {Error} If `window` is not one of the accepted values.
   *
   * @remarks
   * **Cache bypass**: This method intentionally skips the base-class projection
   * cache. Time-window variants (24h, 7d, 30d) cannot share a single cached
   * snapshot because each window requires a different aggregation range — the
   * cached snapshot produced by `querySnapshot()` always covers exactly 24 hours
   * and would return stale or incorrect data if reused for a 7-day or 30-day
   * request.
   *
   * **In-flight coalescing**: Concurrent calls for the same window string share
   * one set of DB queries via `ensureFreshForWindowInFlight`. The in-flight
   * promise is removed after it settles, so the next call after the current one
   * completes starts a fresh query rather than waiting on a stale promise.
   *
   * **Cooldown guard** (production performance): Because the base-class 24 h
   * cache is bypassed, every non-coalesced call would otherwise issue 6 parallel
   * DB queries.  At N polling clients each querying every 200 ms, that produces
   * up to 5 * N * 6 = 30 * N DB round-trips per second per window — enough to
   * saturate connection pools under sustained load.  A 500 ms per-window
   * cooldown (ENSURE_FRESH_COOLDOWN_MS) limits the real query rate to at most
   * 2 query sets per second per window, regardless of client count, by returning
   * the last resolved snapshot when a query was dispatched within the cooldown
   * window.  The cooldown timestamp is recorded only when a new query set is
   * actually dispatched, not when a coalesced or cooldown-cached result is
   * returned.
   *
   * **Recommended polling interval**: >= 1 000 ms in production (>= 2× the
   * 500 ms cooldown floor).  The cooldown is a safety net against misbehaving
   * clients, not expected to activate under recommended polling rates.  It is
   * a floor, not a substitute for a proper per-window TTL cache.
   *
   * TODO(OMN-2373): replace cooldown guard with a full per-window TTL cache to
   * allow longer freshness windows without hammering the DB on every poll.
   */
  async ensureFreshForWindow(window: string): Promise<EnrichmentPayload> {
    if (!ACCEPTED_WINDOWS.has(window)) {
      throw new Error(
        `ensureFreshForWindow: invalid window "${window}". ` +
          `Accepted values are: ${[...ACCEPTED_WINDOWS].join(', ')}.`
      );
    }

    // Coalesce concurrent calls for the same window onto a single DB query set.
    //
    // NOTE on cold-start burst safety: Node.js is single-threaded. Between the
    // Map.get() check and the Map.set() at the end of this method, there is
    // NO await — the entire block executes atomically within one event-loop
    // turn. Every concurrent HTTP request arrives as a separate macro-task and
    // is queued behind the currently executing turn. Therefore, the FIRST call
    // sets the in-flight Map entry before ANY subsequent call can reach this
    // check, making a "multiple first-callers simultaneously" scenario provably
    // impossible in this runtime. No extra locking is needed.
    const inflight = this.ensureFreshForWindowInFlight.get(window);
    if (inflight !== undefined) return inflight;

    // Cooldown guard: if a query set was dispatched within the last
    // ENSURE_FRESH_COOLDOWN_MS, return the cached snapshot from that query
    // rather than issuing another six parallel DB queries.  This prevents
    // rapid polling (e.g. a dashboard hitting this endpoint every 200 ms)
    // from hammering the database when no in-flight request is available to
    // coalesce onto.
    //
    // NOTE on concurrent-caller "race": the only path that bypasses both the
    // in-flight coalescer (see inflight check above) AND this cooldown is a caller that arrives
    // AFTER inFlight.delete() (in .finally()) but BEFORE lastSnapshot.set()
    // (in .then()). That window is a single microtask queue tick — between
    // the .then() and .finally() handlers of the resolved promise — and no
    // external I/O or macro-task can interleave there. In practice this window
    // is unreachable from concurrent HTTP requests, which arrive as separate
    // macro-tasks. No extra guard is needed.
    const lastDispatched = this.ensureFreshForWindowLastDispatched.get(window) ?? 0;
    if (Date.now() - lastDispatched < EnrichmentProjection.ENSURE_FRESH_COOLDOWN_MS) {
      const cached = this.ensureFreshForWindowLastSnapshot.get(window);
      if (cached !== undefined) return cached;
      // No snapshot yet — two cases:
      //  a) First call before any query resolves: fall through to dispatch.
      //     The in-flight coalescer will catch subsequent callers once the Map
      //     entry is written a few lines below.
      //  b) After a failed query (_queryForWindow rejection): lastDispatched was
      //     stamped but lastSnapshot was never set (.then() didn't run). Each
      //     caller within the 500ms cooldown will fall through here and retry,
      //     which is the correct error-recovery behavior. Repeated HTTP 500s
      //     for 500ms on DB failure are expected and intentional.
      // In both cases: fall through to dispatch a fresh query set.
    }

    const db = tryGetIntelligenceDb();
    // If the DB is unavailable, return empty payload immediately without
    // populating lastSnapshot. Any in-progress cooldown window from a prior
    // successful query continues serving its cached snapshot unaffected.
    // NOTE: if a previous query resolved with emptyPayload() and was cached,
    // the cooldown guard will serve that empty snapshot for up to
    // ENSURE_FRESH_COOLDOWN_MS. This is intentional: empty = DB unavailable,
    // not a stale-data bug. The snapshot will be overwritten when the DB
    // recovers and the next non-coalesced query succeeds.
    if (!db) return this.emptyPayload();

    const promise = this._queryForWindow(db, window)
      .then((payload) => {
        // Cache the resolved snapshot so the cooldown guard can serve it.
        this.ensureFreshForWindowLastSnapshot.set(window, payload);
        return payload;
      })
      .finally(() => {
        this.ensureFreshForWindowInFlight.delete(window);
      });

    // Record the dispatch timestamp AFTER the promise is successfully created
    // so that if _queryForWindow() throws synchronously (edge case), we don't
    // stamp lastDispatched without a corresponding in-flight entry — which
    // would cause 500ms of repeated throws before the cooldown expires.
    // NOTE: Both .set() calls below are synchronous with no await between them,
    // so JS single-threaded execution guarantees they appear atomic to any
    // concurrent callers — no other task can observe a state where one Map is
    // updated but the other is not.
    //
    // NOTE on async rejection: if _queryForWindow() rejects asynchronously
    // (e.g. DB error in one of the Promise.all sub-queries), lastDispatched is
    // already stamped and lastSnapshot is never set for this window (the .then()
    // handler doesn't run on rejection). For the next 500ms, cooldown callers
    // will find cached === undefined and fall through to retry — which is the
    // correct recovery behaviour. The stamp advancing on failure is intentional.
    this.ensureFreshForWindowLastDispatched.set(window, Date.now());
    this.ensureFreshForWindowInFlight.set(window, promise);
    return promise;
  }

  // --------------------------------------------------------------------------
  // Private query methods
  // --------------------------------------------------------------------------

  /**
   * Fan out all six enrichment sub-queries in parallel for the given window
   * and assemble the results into a single `EnrichmentPayload`.
   *
   * Converts `window` to a PostgreSQL INTERVAL string via `windowToInterval`,
   * then runs `Promise.all` over all sub-queries so that each executes
   * concurrently against the `context_enrichment_events` table.
   *
   * @param db - Active Drizzle database instance.
   * @param window - Time window identifier ('24h' | '7d' | '30d'). Passed
   *   through to sub-queries that need both the raw window label (for
   *   DATE_TRUNC granularity) and the derived INTERVAL string.
   * @returns A fully-populated `EnrichmentPayload` assembled from the
   *   parallel sub-query results.
   * @throws If any sub-query rejects (e.g. DB unavailable, missing column
   *   during a partial schema migration). The rejection propagates through
   *   `ensureFreshForWindow` to the route handler, which returns HTTP 500.
   *   This is the intended degradation: a broken schema should fail loudly
   *   rather than return partial or stale data silently.
   */
  private async _queryForWindow(db: Db, window: string): Promise<EnrichmentPayload> {
    const interval = timeWindowToInterval(window);

    const [
      summary,
      byChannel,
      latencyDistribution,
      tokenSavingsTrend,
      similarityQuality,
      inflationAlerts,
    ] = await Promise.all([
      this._querySummary(db, interval),
      this._queryByChannel(db, interval),
      this._queryLatencyDistribution(db, interval),
      this._queryTokenSavingsTrend(db, interval, window),
      this._querySimilarityQuality(db, interval, window),
      this._queryInflationAlerts(db, interval),
    ]);

    return {
      summary,
      byChannel,
      latencyDistribution,
      tokenSavingsTrend,
      similarityQuality,
      inflationAlerts,
    };
  }

  /**
   * Query aggregate summary statistics for the enrichment dashboard header row.
   *
   * Executes a single SQL statement against `context_enrichment_events` that
   * computes hit rate, cumulative net tokens saved, latency percentiles (p50,
   * p95), average similarity score, inflation alert count, error rate, and
   * per-outcome counts — all filtered to the supplied time window.
   *
   * Returns `emptyPayload().summary` when the query produces no rows (e.g. an
   * empty table).
   *
   * @param db - Active Drizzle database instance.
   * @param interval - PostgreSQL INTERVAL string produced by `windowToInterval`
   *   (e.g. `'24 hours'`, `'7 days'`).
   * @returns An `EnrichmentSummary` containing rolled-up metrics for the window.
   */
  private async _querySummary(db: Db, interval: string): Promise<EnrichmentSummary> {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*)::int                                                                AS total_enrichments,
        ROUND(AVG(CASE WHEN outcome = 'hit' THEN 1.0 ELSE 0.0 END)::numeric, 4)    AS hit_rate,
        COALESCE(SUM(net_tokens_saved), 0)::int                                     AS net_tokens_saved,
        COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p50_latency_ms,
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_latency_ms,
        COALESCE(ROUND(AVG(similarity_score)::numeric, 4), 0)                      AS avg_similarity_score,
        COUNT(*) FILTER (WHERE outcome = 'inflated')::int                           AS inflation_alert_count,
        ROUND(AVG(CASE WHEN outcome = 'error' THEN 1.0 ELSE 0.0 END)::numeric, 4)  AS error_rate,
        COUNT(*) FILTER (WHERE outcome = 'hit')::int                                AS hits,
        COUNT(*) FILTER (WHERE outcome = 'miss')::int                               AS misses,
        COUNT(*) FILTER (WHERE outcome = 'error')::int                              AS errors,
        COUNT(*) FILTER (WHERE outcome = 'inflated')::int                           AS inflated
      FROM context_enrichment_events
      -- interval validated by safeInterval() allowlist (sql-safety.ts)
      WHERE created_at >= NOW() - INTERVAL ${safeInterval(interval)}
    `);

    const r = (rows.rows ?? rows)[0] as Record<string, unknown> | undefined;
    // COUNT(*) with no GROUP BY always returns exactly one row, even over an
    // empty table (where all aggregates evaluate to 0/NULL). This guard is
    // therefore unreachable in normal PostgreSQL operation; it is retained only
    // as a defensive fallback against unexpected driver behaviour.
    if (!r) return this.emptyPayload().summary;

    return {
      total_enrichments: Number(r.total_enrichments ?? 0),
      hit_rate: Number(r.hit_rate ?? 0),
      net_tokens_saved: Number(r.net_tokens_saved ?? 0),
      p50_latency_ms: Number(r.p50_latency_ms ?? 0),
      p95_latency_ms: Number(r.p95_latency_ms ?? 0),
      avg_similarity_score: Number(r.avg_similarity_score ?? 0),
      inflation_alert_count: Number(r.inflation_alert_count ?? 0),
      error_rate: Number(r.error_rate ?? 0),
      counts: {
        hits: Number(r.hits ?? 0),
        misses: Number(r.misses ?? 0),
        errors: Number(r.errors ?? 0),
        inflated: Number(r.inflated ?? 0),
      },
    };
  }

  /**
   * Query per-channel breakdown of enrichment outcomes for the given window.
   *
   * Groups `context_enrichment_events` by `channel`, computing per-channel
   * hit/miss/error/inflated counts, hit rate, average latency, and average net
   * tokens saved. Results are ordered by total event count descending so the
   * most active channels appear first.
   *
   * @param db - Active Drizzle database instance.
   * @param interval - PostgreSQL INTERVAL string produced by `windowToInterval`
   *   (e.g. `'24 hours'`, `'7 days'`).
   * @returns An array of `EnrichmentByChannel` records, one per distinct
   *   channel, ordered by total descending. Returns an empty array when no
   *   rows match the interval.
   *
   * NOTE: No LIMIT clause — channel cardinality is bounded by the upstream
   * enrichment pipeline's channel enum (typically < 20 distinct values).
   * If the upstream ever emits free-form channel strings, add a LIMIT here.
   */
  private async _queryByChannel(db: Db, interval: string): Promise<EnrichmentByChannel[]> {
    const rows = await db.execute(sql`
      SELECT
        channel,
        COUNT(*)::int                                                                AS total,
        COUNT(*) FILTER (WHERE outcome = 'hit')::int                                AS hits,
        COUNT(*) FILTER (WHERE outcome = 'miss')::int                               AS misses,
        COUNT(*) FILTER (WHERE outcome = 'error')::int                              AS errors,
        COUNT(*) FILTER (WHERE outcome = 'inflated')::int                           AS inflated,
        ROUND(AVG(CASE WHEN outcome = 'hit' THEN 1.0 ELSE 0.0 END)::numeric, 4)    AS hit_rate,
        ROUND(AVG(latency_ms)::numeric, 2)                                          AS avg_latency_ms,
        ROUND(AVG(net_tokens_saved)::numeric, 2)                                    AS avg_net_tokens_saved
      FROM context_enrichment_events
      -- interval validated by safeInterval() allowlist (sql-safety.ts)
      WHERE created_at >= NOW() - INTERVAL ${safeInterval(interval)}
      GROUP BY channel
      ORDER BY total DESC
    `);

    const resultRows = (rows.rows ?? rows) as Record<string, unknown>[];
    return resultRows.map((r) => ({
      channel: String(r.channel ?? ''),
      total: Number(r.total ?? 0),
      hits: Number(r.hits ?? 0),
      misses: Number(r.misses ?? 0),
      errors: Number(r.errors ?? 0),
      inflated: Number(r.inflated ?? 0),
      hit_rate: Number(r.hit_rate ?? 0),
      avg_latency_ms: Number(r.avg_latency_ms ?? 0),
      avg_net_tokens_saved: Number(r.avg_net_tokens_saved ?? 0),
    }));
  }

  /**
   * Query latency percentile distribution broken down by model name.
   *
   * Groups `context_enrichment_events` by `model_name` and computes p50, p90,
   * p95, and p99 latency values (in milliseconds) using PostgreSQL's
   * `PERCENTILE_CONT` ordered-set aggregate. Results are ordered by sample
   * count descending so the most-used models appear first.
   *
   * @param db - Active Drizzle database instance.
   * @param interval - PostgreSQL INTERVAL string produced by `windowToInterval`
   *   (e.g. `'24 hours'`, `'7 days'`).
   * @returns An array of `LatencyDistributionPoint` records, one per distinct
   *   model, ordered by sample count descending. Returns an empty array when
   *   no rows match the interval.
   */
  private async _queryLatencyDistribution(
    db: Db,
    interval: string
  ): Promise<LatencyDistributionPoint[]> {
    const rows = await db.execute(sql`
      SELECT
        model_name                                                                   AS model,
        COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p50_ms,
        COALESCE(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p90_ms,
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_ms,
        COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p99_ms,
        COUNT(*)::int                                                                AS sample_count
      FROM context_enrichment_events
      -- interval validated by safeInterval() allowlist (sql-safety.ts)
      WHERE created_at >= NOW() - INTERVAL ${safeInterval(interval)}
      GROUP BY model_name
      ORDER BY sample_count DESC
    `);

    const resultRows = (rows.rows ?? rows) as Record<string, unknown>[];
    return resultRows.map((r) => ({
      model: String(r.model ?? 'unknown'),
      p50_ms: Number(r.p50_ms ?? 0),
      p90_ms: Number(r.p90_ms ?? 0),
      p95_ms: Number(r.p95_ms ?? 0),
      p99_ms: Number(r.p99_ms ?? 0),
      sample_count: Number(r.sample_count ?? 0),
    }));
  }

  /**
   * Query time-bucketed token savings trend data for the given window.
   *
   * Groups `context_enrichment_events` into time buckets using PostgreSQL's
   * `DATE_TRUNC`, with the bucket granularity derived from `window`:
   * - `'24h'` → hourly buckets
   * - `'7d'` / `'30d'` → daily buckets
   *
   * The `truncUnit` string is validated by `safeTruncUnit()`. This is safe because
   * its value is determined entirely by the `window` parameter comparison
   * above, never from user-supplied input.
   *
   * @param db - Active Drizzle database instance.
   * @param interval - PostgreSQL INTERVAL string produced by `windowToInterval`
   *   (e.g. `'24 hours'`, `'7 days'`), used in the WHERE clause.
   * @param window - Raw window label ('24h' | '7d' | '30d'), used to select
   *   the DATE_TRUNC granularity ('hour' or 'day').
   * @returns An array of `TokenSavingsTrendPoint` records ordered by bucket
   *   ascending. Each point carries an ISO-8601 `date` string plus cumulative
   *   and average token fields. Returns an empty array when no rows match.
   */
  private async _queryTokenSavingsTrend(
    db: Db,
    interval: string,
    window: string
  ): Promise<TokenSavingsTrendPoint[]> {
    // Choose bucket granularity based on the window size:
    //   24h  → hour buckets
    //   7d   → day buckets
    //   30d  → day buckets
    const truncUnit = truncUnitForWindow(window);

    // safeTruncUnit() validates against the centralized allowlist in sql-safety.ts
    const rows = await db.execute(sql`
      SELECT
        DATE_TRUNC(${safeTruncUnit(truncUnit)}, created_at) AT TIME ZONE 'UTC' AS bucket,
        SUM(net_tokens_saved)::int                               AS net_tokens_saved,
        COUNT(*)::int                                            AS total_enrichments,
        ROUND(AVG(tokens_before)::numeric, 2)                   AS avg_tokens_before,
        ROUND(AVG(tokens_after)::numeric, 2)                    AS avg_tokens_after
      FROM context_enrichment_events
      -- interval validated by safeInterval() allowlist (sql-safety.ts)
      WHERE created_at >= NOW() - INTERVAL ${safeInterval(interval)}
      GROUP BY bucket
      ORDER BY bucket ASC
    `);

    const resultRows = (rows.rows ?? rows) as Record<string, unknown>[];
    return resultRows.map((r) => {
      // Convert bucket timestamp to ISO-8601 date string (YYYY-MM-DD or
      // YYYY-MM-DDTHH:00:00.000Z depending on truncUnit).  We always emit the
      // full ISO string so the client can display it consistently.
      const bucket = r.bucket;
      const date = bucket instanceof Date ? bucket.toISOString() : String(bucket ?? '');
      return {
        date,
        net_tokens_saved: Number(r.net_tokens_saved ?? 0),
        total_enrichments: Number(r.total_enrichments ?? 0),
        avg_tokens_before: Number(r.avg_tokens_before ?? 0),
        avg_tokens_after: Number(r.avg_tokens_after ?? 0),
      };
    });
  }

  /**
   * Query time-bucketed average similarity and quality score trend data.
   *
   * Groups `context_enrichment_events` into time buckets using `DATE_TRUNC`,
   * with the same granularity logic as `_queryTokenSavingsTrend`:
   * - `'24h'` → hourly buckets
   * - `'7d'` / `'30d'` → daily buckets
   *
   * Only rows where `similarity_score IS NOT NULL` are included, so the
   * averages reflect actual scored lookups rather than unenriched events.
   *
   * The `truncUnit` string is validated by `safeTruncUnit()`. This is safe because
   * its value is determined entirely by the `window` comparison above, never
   * from user-supplied input.
   *
   * @param db - Active Drizzle database instance.
   * @param interval - PostgreSQL INTERVAL string produced by `windowToInterval`
   *   (e.g. `'24 hours'`, `'7 days'`), used in the WHERE clause.
   * @param window - Raw window label ('24h' | '7d' | '30d'), used to select
   *   the DATE_TRUNC granularity ('hour' or 'day').
   * @returns An array of `SimilarityQualityPoint` records ordered by bucket
   *   ascending. Each point carries an ISO-8601 `date` string, average
   *   similarity score, average quality score, and search count. Returns an
   *   empty array when no rows match.
   */
  private async _querySimilarityQuality(
    db: Db,
    interval: string,
    window: string
  ): Promise<SimilarityQualityPoint[]> {
    const truncUnit = truncUnitForWindow(window);

    // safeTruncUnit() validates against the centralized allowlist in sql-safety.ts
    const rows = await db.execute(sql`
      SELECT
        DATE_TRUNC(${safeTruncUnit(truncUnit)}, created_at) AT TIME ZONE 'UTC' AS bucket,
        ROUND(AVG(similarity_score)::numeric, 4)                AS avg_similarity_score,
        ROUND(AVG(quality_score)::numeric, 4)                   AS avg_quality_score,
        COUNT(*)::int                                            AS search_count
      FROM context_enrichment_events
      -- interval validated by safeInterval() allowlist (sql-safety.ts)
      WHERE created_at >= NOW() - INTERVAL ${safeInterval(interval)}
        -- Only events with a similarity score are counted here — events processed via
        -- exact-match or fallback path have NULL similarity_score and are intentionally
        -- excluded from quality trend metrics. This means search_count here will be lower
        -- than the summary's total event counts, which include all outcomes.
        AND similarity_score IS NOT NULL
      GROUP BY bucket
      ORDER BY bucket ASC
    `);

    const resultRows = (rows.rows ?? rows) as Record<string, unknown>[];
    return resultRows.map((r) => {
      const bucket = r.bucket;
      const date = bucket instanceof Date ? bucket.toISOString() : String(bucket ?? '');
      return {
        date,
        avg_similarity_score: Number(r.avg_similarity_score ?? 0),
        avg_quality_score: Number(r.avg_quality_score ?? 0),
        search_count: Number(r.search_count ?? 0),
      };
    });
  }

  /**
   * Query the most recent token-inflation incidents within the given window.
   *
   * Selects up to 100 rows from `context_enrichment_events` where
   * `outcome = 'inflated'` (i.e. the enriched context had more tokens than
   * the original), ordered by `created_at DESC` so the newest alerts surface
   * first. Results include full provenance fields (`correlation_id`, `channel`,
   * `model_name`, `repo`, `agent_name`) to aid investigation.
   *
   * @param db - Active Drizzle database instance.
   * @param interval - PostgreSQL INTERVAL string produced by `windowToInterval`
   *   (e.g. `'24 hours'`, `'7 days'`), used in the WHERE clause.
   * @returns An array of up to 100 `InflationAlert` records ordered by
   *   `occurred_at` descending. Optional fields (`repo`, `agent_name`) are
   *   `undefined` when the corresponding DB column is NULL. Returns an empty
   *   array when no inflated events exist in the window.
   */
  private async _queryInflationAlerts(db: Db, interval: string): Promise<InflationAlert[]> {
    const rows = await db.execute(sql`
      SELECT
        correlation_id,
        channel,
        model_name,
        tokens_before,
        tokens_after,
        net_tokens_saved,
        created_at       AS occurred_at,
        repo,
        agent_name
      FROM context_enrichment_events
      WHERE outcome = 'inflated'
        -- interval validated by safeInterval() allowlist (sql-safety.ts)
        AND created_at >= NOW() - INTERVAL ${safeInterval(interval)}
      ORDER BY created_at DESC
      LIMIT 100
    `);

    const resultRows = (rows.rows ?? rows) as Record<string, unknown>[];
    return resultRows.map((r) => {
      const occurredAt = r.occurred_at;
      return {
        correlation_id: String(r.correlation_id ?? ''),
        channel: String(r.channel ?? ''),
        model_name: String(r.model_name ?? 'unknown'),
        tokens_before: Number(r.tokens_before ?? 0),
        tokens_after: Number(r.tokens_after ?? 0),
        net_tokens_saved: Number(r.net_tokens_saved ?? 0),
        occurred_at:
          occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt ?? ''),
        repo: r.repo != null ? String(r.repo) : undefined,
        agent_name: r.agent_name != null ? String(r.agent_name) : undefined,
      };
    });
  }
}
