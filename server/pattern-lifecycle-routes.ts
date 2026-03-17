/**
 * Pattern Lifecycle API Routes (OMN-5283)
 *
 * API endpoints for querying pattern lifecycle state transitions from the
 * pattern_lifecycle_transitions table. These endpoints power the
 * /pattern-lifecycle page.
 *
 * Endpoints:
 *   GET /api/pattern-lifecycle/recent        - Recent transitions (last 100)
 *   GET /api/pattern-lifecycle/state-summary - Count of transitions per to_status
 *   GET /api/pattern-lifecycle/trend         - Transition count by day (last 30 days)
 */

import { Router } from 'express';
import { projectionService } from './projection-bootstrap';
import type { PatternLifecyclePayload } from './projections/pattern-lifecycle-projection';

const router = Router();

// ============================================================================
// GET /recent — Recent lifecycle transitions
// ============================================================================

router.get('/recent', async (req, res) => {
  try {
    const view = projectionService.getView<PatternLifecyclePayload>('pattern-lifecycle');
    if (!view) {
      res.status(503).json({ error: 'Projection not available' });
      return;
    }

    const rawLimit = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 100;

    const snapshot = await view.getSnapshot({ limit });
    if (!snapshot.payload) {
      res.json([]);
      return;
    }

    res.json(snapshot.payload.recent.slice(0, limit));
  } catch (error) {
    console.error('[pattern-lifecycle] Error fetching recent transitions:', error);
    res.status(500).json({
      error: 'Failed to fetch recent transitions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// GET /state-summary — Distribution of patterns across lifecycle states
// ============================================================================

router.get('/state-summary', async (_req, res) => {
  try {
    const view = projectionService.getView<PatternLifecyclePayload>('pattern-lifecycle');
    if (!view) {
      res.status(503).json({ error: 'Projection not available' });
      return;
    }

    const snapshot = await view.getSnapshot();
    res.json(snapshot.payload?.stateSummary ?? []);
  } catch (error) {
    console.error('[pattern-lifecycle] Error fetching state summary:', error);
    res.status(500).json({
      error: 'Failed to fetch state summary',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// GET /trend — Transition count per day over last 30 days
// ============================================================================

router.get('/trend', async (_req, res) => {
  try {
    const view = projectionService.getView<PatternLifecyclePayload>('pattern-lifecycle');
    if (!view) {
      res.status(503).json({ error: 'Projection not available' });
      return;
    }

    const snapshot = await view.getSnapshot();
    res.json(snapshot.payload?.trend ?? []);
  } catch (error) {
    console.error('[pattern-lifecycle] Error fetching trend:', error);
    res.status(500).json({
      error: 'Failed to fetch trend',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
