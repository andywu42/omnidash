/**
 * Pattern injection pipeline, lifecycle transitions, and attribution routes.
 * Extracted from intelligence-routes.ts (OMN-5193).
 *
 * Data access: Direct DB (getIntelligenceDb)
 * // TODO(OMN-6111): migrate to ProjectionService
 */
import type { Router, Request, Response } from 'express';
import { sql, desc, asc, eq } from 'drizzle-orm';
import { getIntelligenceDb } from '../../storage';
import {
  patternInjections,
  patternLifecycleTransitions,
  patternMeasuredAttributions,
} from '@shared/intelligence-schema';
import { safeInterval, timeWindowToInterval } from '../../sql-safety';

export function registerPipelineRoutes(router: Router): void {
  // GET /injections/recent
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/injections/recent', async (req: Request, res: Response) => {
    try {
      const db = getIntelligenceDb();
      if (!db) return res.status(503).json({ error: 'Intelligence DB not available' });

      const limit = Math.min(Number(req.query.limit ?? 50), 250);
      const rows = await db
        .select()
        .from(patternInjections)
        .orderBy(desc(patternInjections.injectedAt))
        .limit(limit);

      res.json({ injections: rows, total: rows.length });
    } catch (error) {
      console.error('Error fetching pattern injections:', error);
      res.status(500).json({
        error: 'Failed to fetch pattern injections',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /injections/cohort-summary
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/injections/cohort-summary', async (req: Request, res: Response) => {
    try {
      const db = getIntelligenceDb();
      if (!db) return res.status(503).json({ error: 'Intelligence DB not available' });

      const timeWindow = (req.query.timeWindow as string) || '7d';
      const interval = timeWindowToInterval(timeWindow);

      const summary = await db.execute(sql`
        SELECT
          cohort,
          COUNT(*) AS total_injections,
          COUNT(*) FILTER (WHERE outcome_recorded = TRUE) AS outcomes_recorded,
          COUNT(*) FILTER (WHERE outcome_success = TRUE) AS successes,
          COUNT(*) FILTER (WHERE outcome_success = FALSE) AS failures,
          ROUND(
            AVG(CASE WHEN outcome_success IS NOT NULL THEN outcome_success::int ELSE NULL END)::numeric,
            4
          ) AS success_rate,
          AVG(heuristic_confidence) AS avg_heuristic_confidence,
          AVG(compiled_token_count) AS avg_token_count
        FROM pattern_injections
        WHERE injected_at >= NOW() - INTERVAL ${safeInterval(interval)}
        GROUP BY cohort
        ORDER BY cohort
      `);

      res.json({ cohorts: summary.rows, timeWindow });
    } catch (error) {
      console.error('Error fetching cohort summary:', error);
      res.status(500).json({
        error: 'Failed to fetch cohort summary',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /lifecycle/recent
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/lifecycle/recent', async (req: Request, res: Response) => {
    try {
      const db = getIntelligenceDb();
      if (!db) return res.status(503).json({ error: 'Intelligence DB not available' });

      const limit = Math.min(Number(req.query.limit ?? 50), 250);
      const rows = await db
        .select()
        .from(patternLifecycleTransitions)
        .orderBy(desc(patternLifecycleTransitions.transitionAt))
        .limit(limit);

      res.json({ transitions: rows, total: rows.length });
    } catch (error) {
      console.error('Error fetching lifecycle transitions:', error);
      res.status(500).json({
        error: 'Failed to fetch lifecycle transitions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /lifecycle/summary
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/lifecycle/summary', async (req: Request, res: Response) => {
    try {
      const db = getIntelligenceDb();
      if (!db) return res.status(503).json({ error: 'Intelligence DB not available' });

      const timeWindow = (req.query.timeWindow as string) || '7d';
      const interval = timeWindowToInterval(timeWindow);

      const summary = await db.execute(sql`
        SELECT
          from_status,
          to_status,
          transition_trigger,
          COUNT(*) AS transition_count,
          COUNT(DISTINCT pattern_id) AS unique_patterns
        FROM pattern_lifecycle_transitions
        WHERE transition_at >= NOW() - INTERVAL ${safeInterval(interval)}
        GROUP BY from_status, to_status, transition_trigger
        ORDER BY transition_count DESC
      `);

      res.json({ transitions: summary.rows, timeWindow });
    } catch (error) {
      console.error('Error fetching lifecycle summary:', error);
      res.status(500).json({
        error: 'Failed to fetch lifecycle summary',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /lifecycle/pattern/:patternId
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/lifecycle/pattern/:patternId', async (req: Request, res: Response) => {
    try {
      const db = getIntelligenceDb();
      if (!db) return res.status(503).json({ error: 'Intelligence DB not available' });

      const { patternId } = req.params;
      const rows = await db
        .select()
        .from(patternLifecycleTransitions)
        .where(eq(patternLifecycleTransitions.patternId, patternId))
        .orderBy(asc(patternLifecycleTransitions.transitionAt));

      res.json({ transitions: rows, total: rows.length, patternId });
    } catch (error) {
      console.error('Error fetching pattern lifecycle:', error);
      res.status(500).json({
        error: 'Failed to fetch pattern lifecycle',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /attributions/recent
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/attributions/recent', async (req: Request, res: Response) => {
    try {
      const db = getIntelligenceDb();
      if (!db) return res.status(503).json({ error: 'Intelligence DB not available' });

      const limit = Math.min(Number(req.query.limit ?? 50), 250);
      const rows = await db
        .select()
        .from(patternMeasuredAttributions)
        .orderBy(desc(patternMeasuredAttributions.createdAt))
        .limit(limit);

      res.json({ attributions: rows, total: rows.length });
    } catch (error) {
      console.error('Error fetching measured attributions:', error);
      res.status(500).json({
        error: 'Failed to fetch measured attributions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /attributions/summary
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/attributions/summary', async (req: Request, res: Response) => {
    try {
      const db = getIntelligenceDb();
      if (!db) return res.status(503).json({ error: 'Intelligence DB not available' });

      const timeWindow = (req.query.timeWindow as string) || '7d';
      const interval = timeWindowToInterval(timeWindow);

      const summary = await db.execute(sql`
        SELECT
          evidence_tier,
          COUNT(*) AS attribution_count,
          COUNT(DISTINCT pattern_id) AS unique_patterns,
          COUNT(DISTINCT session_id) AS unique_sessions,
          COUNT(run_id) AS with_pipeline_run
        FROM pattern_measured_attributions
        WHERE created_at >= NOW() - INTERVAL ${safeInterval(interval)}
        GROUP BY evidence_tier
        ORDER BY evidence_tier
      `);

      res.json({ tiers: summary.rows, timeWindow });
    } catch (error) {
      console.error('Error fetching attribution summary:', error);
      res.status(500).json({
        error: 'Failed to fetch attribution summary',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}
