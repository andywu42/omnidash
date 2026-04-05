/**
 * System Activity API Routes
 *
 * Aggregates data from multiple tables to show what the autonomous system
 * is doing: build loop phases, pipeline runs (skill invocations), active
 * agent sessions, and delegation activity.
 *
 * Endpoints:
 *   GET /api/system-activity/build-loop       — latest build loop phase timeline
 *   GET /api/system-activity/pipelines?limit=20 — recent skill invocations
 *   GET /api/system-activity/sessions?limit=20  — recent session outcomes
 *   GET /api/system-activity/delegations?limit=20 — recent delegation events
 */

import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getIntelligenceDb } from './storage';
import { safeInterval } from './sql-safety';

export const systemActivityRoutes = Router();

// ============================================================================
// GET /api/system-activity/build-loop
// Returns the most recent build loop phases from phase_metrics_events.
// ============================================================================

systemActivityRoutes.get('/build-loop', async (_req, res) => {
  try {
    const db = getIntelligenceDb();
    if (!db) {
      return res.json({ phases: [], currentState: null });
    }

    // Get the most recent session's phase timeline
    const phases = await db.execute(sql`
      SELECT
        session_id,
        phase,
        status,
        duration_ms,
        ticket_id,
        emitted_at
      FROM phase_metrics_events
      WHERE emitted_at >= NOW() - INTERVAL ${safeInterval('24 hours')}
      ORDER BY emitted_at DESC
      LIMIT 50
    `);

    // Derive current state from most recent phase
    const rows = phases.rows as Array<{
      session_id: string;
      phase: string;
      status: string;
      duration_ms: number;
      ticket_id: string | null;
      emitted_at: string;
    }>;

    const currentState =
      rows.length > 0
        ? {
            phase: rows[0].phase,
            status: rows[0].status,
            sessionId: rows[0].session_id,
            at: rows[0].emitted_at,
          }
        : null;

    return res.json({ phases: rows, currentState });
  } catch (error) {
    console.error('[system-activity] Error fetching build-loop:', error);
    return res.json({ phases: [], currentState: null });
  }
});

// ============================================================================
// GET /api/system-activity/pipelines?limit=20
// Recent skill invocations from skill_invocations table.
// ============================================================================

systemActivityRoutes.get('/pipelines', async (req, res) => {
  try {
    const db = getIntelligenceDb();
    if (!db) {
      return res.json({ pipelines: [], totals: { total: 0, success: 0, error: 0 } });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const rows = await db.execute(sql`
      SELECT
        id,
        skill_name,
        session_id,
        duration_ms,
        success,
        status,
        error,
        created_at
      FROM skill_invocations
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);

    // Summary totals for last 24h
    const totalsResult = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE success = true)::int AS success,
        COUNT(*) FILTER (WHERE success = false)::int AS error
      FROM skill_invocations
      WHERE created_at >= NOW() - INTERVAL ${safeInterval('24 hours')}
    `);

    const totals = (totalsResult.rows[0] as { total: number; success: number; error: number }) ?? {
      total: 0,
      success: 0,
      error: 0,
    };

    return res.json({ pipelines: rows.rows, totals });
  } catch (error) {
    console.error('[system-activity] Error fetching pipelines:', error);
    return res.json({ pipelines: [], totals: { total: 0, success: 0, error: 0 } });
  }
});

// ============================================================================
// GET /api/system-activity/sessions?limit=20
// Recent session outcomes from session_outcomes table.
// ============================================================================

systemActivityRoutes.get('/sessions', async (req, res) => {
  try {
    const db = getIntelligenceDb();
    if (!db) {
      return res.json({ sessions: [], totals: { total: 0, byOutcome: {} } });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const rows = await db.execute(sql`
      SELECT
        session_id,
        outcome,
        emitted_at
      FROM session_outcomes
      ORDER BY emitted_at DESC
      LIMIT ${limit}
    `);

    // Outcome breakdown for last 24h
    const breakdownResult = await db.execute(sql`
      SELECT
        outcome,
        COUNT(*)::int AS count
      FROM session_outcomes
      WHERE emitted_at >= NOW() - INTERVAL ${safeInterval('24 hours')}
      GROUP BY outcome
    `);

    const byOutcome: Record<string, number> = {};
    let total = 0;
    for (const row of breakdownResult.rows as Array<{ outcome: string; count: number }>) {
      byOutcome[row.outcome] = row.count;
      total += row.count;
    }

    return res.json({ sessions: rows.rows, totals: { total, byOutcome } });
  } catch (error) {
    console.error('[system-activity] Error fetching sessions:', error);
    return res.json({ sessions: [], totals: { total: 0, byOutcome: {} } });
  }
});

// ============================================================================
// GET /api/system-activity/delegations?limit=20
// Recent delegation events from delegation_events table.
// ============================================================================

systemActivityRoutes.get('/delegations', async (req, res) => {
  try {
    const db = getIntelligenceDb();
    if (!db) {
      return res.json({
        delegations: [],
        totals: { total: 0, qualityGatePassRate: null, totalCostUsd: null },
      });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const rows = await db.execute(sql`
      SELECT
        id,
        task_type,
        delegated_to,
        delegated_by,
        quality_gate_passed,
        cost_usd,
        timestamp
      FROM delegation_events
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `);

    // Aggregates for last 24h
    const statsResult = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        ROUND(AVG(CASE WHEN quality_gate_passed THEN 1 ELSE 0 END) * 100, 1) AS quality_gate_pass_rate,
        ROUND(SUM(COALESCE(cost_usd, 0))::numeric, 4) AS total_cost_usd
      FROM delegation_events
      WHERE timestamp >= NOW() - INTERVAL ${safeInterval('24 hours')}
    `);

    const stats = (statsResult.rows[0] as {
      total: number;
      quality_gate_pass_rate: string | null;
      total_cost_usd: string | null;
    }) ?? { total: 0, quality_gate_pass_rate: null, total_cost_usd: null };

    return res.json({
      delegations: rows.rows,
      totals: {
        total: stats.total,
        qualityGatePassRate:
          stats.quality_gate_pass_rate != null ? Number(stats.quality_gate_pass_rate) : null,
        totalCostUsd: stats.total_cost_usd != null ? Number(stats.total_cost_usd) : null,
      },
    });
  } catch (error) {
    console.error('[system-activity] Error fetching delegations:', error);
    return res.json({
      delegations: [],
      totals: { total: 0, qualityGatePassRate: null, totalCostUsd: null },
    });
  }
});
