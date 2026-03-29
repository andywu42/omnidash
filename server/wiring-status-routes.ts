/**
 * Wiring Status API Endpoint (OMN-6975)
 *
 * GET /api/wiring-status
 *
 * Returns the wiring status of every dashboard route, enriched with
 * live data from the omnidash_analytics database: row counts and
 * last-event timestamps for each route's backing table.
 *
 * DB access is delegated to wiring-status-service.ts to comply with
 * the OMN-2325 constraint that route files must not import DB accessors.
 */

import { Router } from 'express';
import { getWiringStatus } from './services/wiring-status-service';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const response = await getWiringStatus();
    res.set('Cache-Control', 'no-store');
    return res.json(response);
  } catch (err) {
    console.error('[wiring-status] Probe failed:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
      checkedAt: new Date().toISOString(),
    });
  }
});

export default router;
