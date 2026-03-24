/**
 * Review Calibration API Routes (OMN-6176)
 *
 * REST endpoints for the review calibration dashboard:
 * GET /api/review-calibration/history   — calibration run history
 * GET /api/review-calibration/scores    — per-model accuracy scores
 * GET /api/review-calibration/fewshot-log — few-shot prompt metadata
 *
 * Data is served via ReviewCalibrationProjection (DB-backed, TTL-cached).
 * Per OMN-2325: no direct DB imports in route files.
 */

import { Router } from 'express';
import { reviewCalibrationProjection } from './projection-bootstrap';

const router = Router();

// ============================================================================
// GET /api/review-calibration/history
// ============================================================================

router.get('/history', async (req, res) => {
  try {
    const model = req.query.model as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);

    // Use queryHistory for model-filter + custom limit support
    const runs = await reviewCalibrationProjection.queryHistory(model, limit);

    return res.json({ runs });
  } catch (error) {
    console.error('[review-calibration] Error fetching history:', error);
    return res.status(500).json({ error: 'Failed to fetch calibration history' });
  }
});

// ============================================================================
// GET /api/review-calibration/scores
// ============================================================================

router.get('/scores', async (_req, res) => {
  try {
    const payload = await reviewCalibrationProjection.ensureFresh();
    return res.json({ models: payload.models });
  } catch (error) {
    console.error('[review-calibration] Error fetching scores:', error);
    return res.status(500).json({ error: 'Failed to fetch calibration scores' });
  }
});

// ============================================================================
// GET /api/review-calibration/fewshot-log
// ============================================================================

router.get('/fewshot-log', async (_req, res) => {
  try {
    const payload = await reviewCalibrationProjection.ensureFresh();
    return res.json(payload.fewshot);
  } catch (error) {
    console.error('[review-calibration] Error fetching fewshot log:', error);
    return res.status(500).json({ error: 'Failed to fetch fewshot log' });
  }
});

export default router;
