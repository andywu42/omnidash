// no-migration: OMN-6390 read-only diagnostic endpoint, no schema changes
/**
 * Projection Health Diagnostic Endpoint (OMN-6390)
 *
 * GET /api/projection-health
 *
 * Queries every table in omnidash_analytics and returns row counts,
 * last-updated timestamps, and watermark offsets. This provides the
 * observability foundation for detecting silent projection drops and
 * stale data.
 *
 * Response shape:
 * {
 *   tables: { [name]: { rowCount, lastUpdated, stale, staleThresholdMinutes } },
 *   watermarks: ProjectionWatermark[],
 *   summary: { totalTables, populatedTables, emptyTables, staleTables },
 *   checkedAt: string
 * }
 */

import { Router } from 'express';
import { tryGetIntelligenceDb } from './storage';
import { sql } from 'drizzle-orm';
import { safeCountQuery, safeMaxTimestampQuery } from './sql-safety';
import { getAllHandlerStats } from './consumers/read-model/types';
import type { ProjectionHandlerStats } from './consumers/read-model/types';
import { getReadModelConsumerLag, type ConsumerGroupLag } from './event-bus-health-poller';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TableHealth {
  rowCount: number;
  lastUpdated: string | null;
  stale: boolean;
  staleThresholdMinutes: number;
}

export interface WatermarkInfo {
  projectionName: string;
  lastOffset: number;
  lastEventId: string | null;
  lastProjectedAt: string | null;
  eventsProjected: number;
  errorsCount: number;
}

export interface ProjectionHealthResponse {
  tables: Record<string, TableHealth>;
  watermarks: WatermarkInfo[];
  handlerStats: Record<string, ProjectionHandlerStats>;
  consumerLag: ConsumerGroupLag | null;
  summary: {
    totalTables: number;
    populatedTables: number;
    emptyTables: number;
    staleTables: number;
  };
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default staleness threshold in minutes (1 hour) */
const DEFAULT_STALE_THRESHOLD_MINUTES = 60;

/**
 * Tables that are known to have timestamp columns for freshness detection.
 * Maps table name -> column to use for MAX() last-updated check.
 * Tables not listed here will report lastUpdated: null.
 */
const TIMESTAMP_COLUMNS: Record<string, string> = {
  agent_routing_decisions: 'created_at',
  agent_actions: 'created_at',
  agent_transformation_events: 'created_at',
  agent_manifest_injections: 'created_at',
  pattern_quality_metrics: 'measured_at',
  pattern_learning_artifacts: 'created_at',
  onex_compliance_stamps: 'stamped_at',
  document_metadata: 'created_at',
  document_access_log: 'accessed_at',
  task_completion_metrics: 'completed_at',
  injection_effectiveness: 'created_at',
  latency_breakdowns: 'created_at',
  pattern_hit_rates: 'created_at',
  projection_watermarks: 'updated_at',
  validation_runs: 'started_at',
  validation_violations: 'detected_at',
  validation_candidates: 'detected_at',
  llm_cost_aggregates: 'created_at',
  baselines_snapshots: 'created_at',
  baselines_comparisons: 'created_at',
  baselines_trend: 'created_at',
  baselines_breakdown: 'created_at',
  delegation_events: 'created_at',
  delegation_shadow_comparisons: 'created_at',
  plan_review_runs: 'created_at',
  pattern_injections: 'created_at',
  pattern_lifecycle_transitions: 'transitioned_at',
  pattern_measured_attributions: 'measured_at',
  pattern_enforcement_events: 'created_at',
  context_enrichment_events: 'created_at',
  llm_routing_decisions: 'created_at',
  gate_decisions: 'created_at',
  epic_run_events: 'created_at',
  pr_watch_state: 'updated_at',
  pipeline_budget_state: 'updated_at',
  debug_escalation_counts: 'updated_at',
  model_efficiency_rollups: 'created_at',
  correlation_trace_spans: 'created_at',
  session_outcomes: 'created_at',
  phase_metrics_events: 'created_at',
  dod_verify_runs: 'created_at',
  dod_guard_events: 'created_at',
  intent_drift_events: 'created_at',
  intent_signals: 'created_at',
  llm_health_snapshots: 'created_at',
  routing_feedback_events: 'created_at',
  compliance_evaluations: 'created_at',
  memory_documents: 'created_at',
  memory_retrievals: 'created_at',
  skill_invocations: 'created_at',
  dlq_messages: 'created_at',
  circuit_breaker_events: 'created_at',
  rl_episodes: 'created_at',
  savings_estimates: 'created_at',
  consumer_health_events: 'created_at',
  runtime_error_events: 'created_at',
  runtime_error_triage_state: 'updated_at',
  routing_shadow_decisions: 'created_at',
  review_calibration_runs: 'created_at',
};

// ---------------------------------------------------------------------------
// Cache (30s TTL to avoid hammering DB)
// ---------------------------------------------------------------------------

let cache: { response: ProjectionHealthResponse; expiresAt: number } | null = null;

/** Clear cache (exported for tests). */
export function clearProjectionHealthCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Query all user tables in omnidash_analytics for row counts and freshness.
 */
export async function getProjectionHealth(
  staleThresholdMinutes: number = DEFAULT_STALE_THRESHOLD_MINUTES
): Promise<ProjectionHealthResponse> {
  const db = tryGetIntelligenceDb();
  if (!db) {
    return {
      tables: {},
      watermarks: [],
      handlerStats: getAllHandlerStats(),
      consumerLag: getReadModelConsumerLag(),
      summary: { totalTables: 0, populatedTables: 0, emptyTables: 0, staleTables: 0 },
      checkedAt: new Date().toISOString(),
    };
  }

  // 1. Get all user tables in public schema
  const tablesResult = await db.execute(sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('schema_migrations', 'drizzle_migrations')
    ORDER BY tablename
  `);
  const rows = Array.isArray(tablesResult) ? tablesResult : ((tablesResult as any).rows ?? []);
  const tableNames: string[] = rows.map((r: any) => r.tablename as string);

  // 2. For each table, get row count and optionally last-updated
  const tables: Record<string, TableHealth> = {};
  const now = Date.now();
  const thresholdMs = staleThresholdMinutes * 60 * 1000;

  for (const tableName of tableNames) {
    try {
      // Use reltuples for fast approximate count, fall back to exact count for small tables
      const countResult = await db.execute(safeCountQuery(tableName));
      const countRows = Array.isArray(countResult)
        ? countResult
        : ((countResult as any).rows ?? []);
      const rowCount = Number(countRows[0]?.count ?? 0);

      let lastUpdated: string | null = null;
      const tsCol = TIMESTAMP_COLUMNS[tableName];
      if (tsCol && rowCount > 0) {
        try {
          const tsResult = await db.execute(safeMaxTimestampQuery(tableName, tsCol));
          const tsRows = Array.isArray(tsResult) ? tsResult : ((tsResult as any).rows ?? []);
          const rawTs = tsRows[0]?.last_updated;
          if (rawTs) {
            lastUpdated = new Date(rawTs as string).toISOString();
          }
        } catch {
          // Column might not exist for this table — skip
        }
      }

      const isStale =
        rowCount === 0 || !lastUpdated || now - new Date(lastUpdated).getTime() > thresholdMs;

      tables[tableName] = {
        rowCount,
        lastUpdated,
        stale: isStale,
        staleThresholdMinutes,
      };
    } catch (err) {
      // Table might be in a weird state — report zero
      tables[tableName] = {
        rowCount: 0,
        lastUpdated: null,
        stale: true,
        staleThresholdMinutes,
      };
    }
  }

  // 3. Get watermarks
  let watermarks: WatermarkInfo[] = [];
  try {
    const wmResult = await db.execute(sql`
      SELECT
        projection_name,
        last_offset,
        last_event_id,
        last_projected_at,
        events_projected,
        errors_count
      FROM projection_watermarks
      ORDER BY projection_name
    `);
    const wmRows = Array.isArray(wmResult) ? wmResult : ((wmResult as any).rows ?? []);
    watermarks = wmRows.map((r: any) => ({
      projectionName: r.projection_name,
      lastOffset: Number(r.last_offset),
      lastEventId: r.last_event_id,
      lastProjectedAt: r.last_projected_at
        ? new Date(r.last_projected_at as string).toISOString()
        : null,
      eventsProjected: Number(r.events_projected),
      errorsCount: Number(r.errors_count),
    }));
  } catch {
    // projection_watermarks table might not exist yet
  }

  // 4. Compute summary
  const totalTables = Object.keys(tables).length;
  const populatedTables = Object.values(tables).filter((t) => t.rowCount > 0).length;
  const emptyTables = totalTables - populatedTables;
  const staleTables = Object.values(tables).filter((t) => t.stale).length;

  return {
    tables,
    watermarks,
    handlerStats: getAllHandlerStats(),
    consumerLag: getReadModelConsumerLag(),
    summary: { totalTables, populatedTables, emptyTables, staleTables },
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

/**
 * GET /api/projection-health
 *
 * Returns projection health for all tables in omnidash_analytics.
 * Optional query param: ?staleThresholdMinutes=N (default: 60)
 */
router.get('/', async (req, res) => {
  try {
    // Serve from cache if fresh
    if (cache && Date.now() < cache.expiresAt) {
      res.set('Cache-Control', 'no-store');
      return res.json(cache.response);
    }

    const threshold = req.query.staleThresholdMinutes
      ? Number(req.query.staleThresholdMinutes)
      : DEFAULT_STALE_THRESHOLD_MINUTES;

    const response = await getProjectionHealth(threshold);

    // Cache for 30 seconds
    cache = { response, expiresAt: Date.now() + 30_000 };

    res.set('Cache-Control', 'no-store');
    return res.json(response);
  } catch (err) {
    console.error('[projection-health] Probe failed:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
      checkedAt: new Date().toISOString(),
    });
  }
});

export default router;
