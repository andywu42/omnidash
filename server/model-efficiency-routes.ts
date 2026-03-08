/**
 * Model Efficiency API Routes (OMN-3937)
 *
 * REST endpoints for the Model Efficiency Index (MEI) dashboard:
 * summary, trend, rollups, and comparison.
 *
 * HARD INVARIANT: MEI is defined only over rollup_status='final' rows.
 * ALL summary, trend, and comparison endpoints MUST filter WHERE rollup_status = 'final'.
 *
 * Source table: model_efficiency_rollups (migrations/0017_model_efficiency_rollups.sql)
 * Event consumed: onex.evt.omniclaude.pr-validation-rollup.v1
 */

import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { tryGetIntelligenceDb } from './storage';

const router = Router();

// ============================================================================
// GET /api/model-efficiency/summary?days=30
//
// Per-model aggregated MEI with median_vts, median_vts_per_kloc, avg_vts,
// avg_vts_per_kloc, total_blocking_failures, total_reruns, total_autofixes,
// avg_time_to_green_ms, metric_version. Sorted by median_vts_per_kloc ASC.
// ============================================================================

router.get('/summary', async (req, res) => {
  try {
    const db = tryGetIntelligenceDb();
    if (!db) {
      return res.json([]);
    }

    const daysParam = Array.isArray(req.query.days) ? req.query.days[0] : req.query.days;
    const days = Math.min(Math.max(parseInt(String(daysParam ?? ''), 10) || 30, 1), 365);

    const rows = await db.execute(sql`
      SELECT
        model_id,
        COUNT(*)::int AS pr_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY vts) AS median_vts,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY vts_per_kloc) AS median_vts_per_kloc,
        AVG(vts) AS avg_vts,
        AVG(vts_per_kloc) AS avg_vts_per_kloc,
        SUM(blocking_failures)::int AS total_blocking_failures,
        SUM(reruns)::int AS total_reruns,
        SUM(autofix_successes)::int AS total_autofixes,
        AVG(time_to_green_ms)::int AS avg_time_to_green_ms,
        MAX(metric_version) AS metric_version
      FROM model_efficiency_rollups
      WHERE rollup_status = 'final'
        AND emitted_at >= NOW() - MAKE_INTERVAL(days => ${days})
      GROUP BY model_id
      ORDER BY median_vts_per_kloc ASC
    `);

    return res.json(rows.rows);
  } catch (error) {
    console.error('[model-efficiency] Error fetching summary:', error);
    return res.status(500).json({ error: 'Failed to fetch model efficiency summary' });
  }
});

// ============================================================================
// GET /api/model-efficiency/trend?days=14&model_id=X
//
// Daily VTS trend per model (final only).
// ============================================================================

router.get('/trend', async (req, res) => {
  try {
    const db = tryGetIntelligenceDb();
    if (!db) {
      return res.json([]);
    }

    const daysParam = Array.isArray(req.query.days) ? req.query.days[0] : req.query.days;
    const days = Math.min(Math.max(parseInt(String(daysParam ?? ''), 10) || 14, 1), 90);
    const modelId = typeof req.query.model_id === 'string' ? req.query.model_id : null;

    const modelFilter = modelId ? sql`AND model_id = ${modelId}` : sql``;

    const rows = await db.execute(sql`
      SELECT
        DATE(emitted_at) AS date,
        model_id,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY vts) AS median_vts,
        COUNT(*)::int AS pr_count
      FROM model_efficiency_rollups
      WHERE rollup_status = 'final'
        AND emitted_at >= NOW() - MAKE_INTERVAL(days => ${days})
        ${modelFilter}
      GROUP BY DATE(emitted_at), model_id
      ORDER BY date ASC, model_id ASC
    `);

    return res.json(rows.rows);
  } catch (error) {
    console.error('[model-efficiency] Error fetching trend:', error);
    return res.status(500).json({ error: 'Failed to fetch model efficiency trend' });
  }
});

// ============================================================================
// GET /api/model-efficiency/rollups?model_id=X&limit=N&status=final
//
// Raw rollup list for drill-down, filterable by status.
// ============================================================================

router.get('/rollups', async (req, res) => {
  try {
    const db = tryGetIntelligenceDb();
    if (!db) {
      return res.json([]);
    }

    const limitParam = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const limit = Math.min(Math.max(parseInt(String(limitParam ?? ''), 10) || 50, 1), 500);
    const modelId = typeof req.query.model_id === 'string' ? req.query.model_id : null;
    const status = typeof req.query.status === 'string' ? req.query.status : null;

    const modelFilter = modelId ? sql`AND model_id = ${modelId}` : sql``;
    const statusFilter = status ? sql`AND rollup_status = ${status}` : sql``;

    const rows = await db.execute(sql`
      SELECT
        run_id,
        repo_id,
        pr_id,
        pr_url,
        model_id,
        producer_kind,
        rollup_status,
        vts,
        vts_per_kloc,
        blocking_failures,
        reruns,
        time_to_green_ms,
        missing_fields,
        emitted_at
      FROM model_efficiency_rollups
      WHERE 1=1
        ${modelFilter}
        ${statusFilter}
      ORDER BY emitted_at DESC
      LIMIT ${limit}
    `);

    return res.json(rows.rows);
  } catch (error) {
    console.error('[model-efficiency] Error fetching rollups:', error);
    return res.status(500).json({ error: 'Failed to fetch model efficiency rollups' });
  }
});

// ============================================================================
// GET /api/model-efficiency/comparison
//
// Side-by-side comparison with pr_count prominently included.
// HARD INVARIANT: only rollup_status='final' rows.
// ============================================================================

router.get('/comparison', async (req, res) => {
  try {
    const db = tryGetIntelligenceDb();
    if (!db) {
      return res.json([]);
    }

    const rows = await db.execute(sql`
      SELECT
        model_id,
        COUNT(*)::int AS pr_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY vts) AS median_vts,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY vts_per_kloc) AS median_vts_per_kloc,
        AVG(vts) AS avg_vts,
        AVG(vts_per_kloc) AS avg_vts_per_kloc,
        SUM(blocking_failures)::int AS total_blocking_failures,
        SUM(reruns)::int AS total_reruns,
        SUM(autofix_successes)::int AS total_autofixes,
        AVG(time_to_green_ms)::int AS avg_time_to_green_ms,
        MAX(metric_version) AS metric_version
      FROM model_efficiency_rollups
      WHERE rollup_status = 'final'
      GROUP BY model_id
      ORDER BY median_vts_per_kloc ASC
    `);

    return res.json(rows.rows);
  } catch (error) {
    console.error('[model-efficiency] Error fetching comparison:', error);
    return res.status(500).json({ error: 'Failed to fetch model efficiency comparison' });
  }
});

export default router;
