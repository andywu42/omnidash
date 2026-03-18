/**
 * Wiring Health API Routes (OMN-5292)
 *
 * REST endpoints for the Wiring Health dashboard:
 * GET /api/wiring-health         — latest snapshot + summary
 * GET /api/wiring-health/summary — aggregate summary only
 * GET /api/wiring-health/history — rolling history of snapshots
 *
 * Data is served from the in-memory WiringHealthProjection singleton,
 * populated by the read-model consumer from the
 * onex.evt.omnibase-infra.wiring-health-snapshot.v1 Kafka topic.
 */

import { Router } from 'express';
import { wiringHealthProjection } from './projections/wiring-health-projection';

const router = Router();

// ============================================================================
// GET /api/wiring-health
// ============================================================================

router.get('/', (_req, res) => {
  try {
    const latest = wiringHealthProjection.getLatest();
    const summary = wiringHealthProjection.getSummary();
    return res.json({ latest, summary });
  } catch (error) {
    console.error('[wiring-health] Error fetching wiring health data:', error);
    return res.status(500).json({ error: 'Failed to fetch wiring health data' });
  }
});

// ============================================================================
// GET /api/wiring-health/summary
// ============================================================================

router.get('/summary', (_req, res) => {
  try {
    const summary = wiringHealthProjection.getSummary();
    return res.json(summary);
  } catch (error) {
    console.error('[wiring-health] Error fetching summary:', error);
    return res.status(500).json({ error: 'Failed to fetch wiring health summary' });
  }
});

// ============================================================================
// GET /api/wiring-health/history
// ============================================================================

router.get('/history', (_req, res) => {
  try {
    const history = wiringHealthProjection.getHistory();
    return res.json(history);
  } catch (error) {
    console.error('[wiring-health] Error fetching history:', error);
    return res.status(500).json({ error: 'Failed to fetch wiring health history' });
  }
});

export default router;
