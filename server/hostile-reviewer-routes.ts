/**
 * Hostile Reviewer API Routes (OMN-5864)
 *
 * REST endpoints for the hostile reviewer dashboard:
 * GET /api/hostile-reviewer/snapshot  — recent runs + summary
 *
 * Data is served via HostileReviewerProjection (DB-backed, TTL-cached).
 * Per OMN-2325: no direct DB imports in route files.
 */

import { Router } from 'express';
import { hostileReviewerProjection } from './projection-bootstrap';

const router = Router();

// ============================================================================
// GET /api/hostile-reviewer/snapshot
// ============================================================================

router.get('/snapshot', async (_req, res) => {
  try {
    const payload = await hostileReviewerProjection.ensureFresh();
    return res.json(payload);
  } catch (error) {
    console.error('[hostile-reviewer] Error fetching snapshot:', error);
    return res.status(500).json({ error: 'Failed to fetch hostile reviewer snapshot' });
  }
});

export default router;
