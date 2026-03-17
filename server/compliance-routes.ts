/**
 * Compliance Evaluations API Routes (OMN-5285)
 *
 * REST endpoints for the Compliance Dashboard:
 *   GET /api/compliance         — recent evaluations + pass/fail summary
 *   GET /api/compliance/summary — aggregated pass/fail stats by repo and rule_set
 *   GET /api/compliance/trend   — score trend over time
 *
 * Data is served via ComplianceProjection (DB-backed, TTL-cached).
 * Per OMN-2325: no direct DB imports in route files.
 */

import { Router } from 'express';
import { complianceProjection } from './projection-bootstrap';

const router = Router();

// ============================================================================
// GET /api/compliance?window=7d&limit=50
// Returns recent evaluations + top-level pass/fail summary
// ============================================================================

router.get('/', async (_req, res) => {
  try {
    const payload = await complianceProjection.ensureFresh();
    return res.json({
      summary: payload.summary,
      evaluations: payload.evaluations,
    });
  } catch (err) {
    console.error('[compliance-routes] GET /api/compliance error:', err);
    return res.status(500).json({ error: 'Failed to fetch compliance evaluations' });
  }
});

// ============================================================================
// GET /api/compliance/summary?window=7d
// Aggregated pass/fail breakdown by repo and rule_set
// ============================================================================

router.get('/summary', async (_req, res) => {
  try {
    const payload = await complianceProjection.ensureFresh();
    return res.json({
      byRepo: payload.byRepo,
      byRuleSet: payload.byRuleSet,
    });
  } catch (err) {
    console.error('[compliance-routes] GET /api/compliance/summary error:', err);
    return res.status(500).json({ error: 'Failed to fetch compliance summary' });
  }
});

// ============================================================================
// GET /api/compliance/trend?window=7d
// Score trend bucketed by day
// ============================================================================

router.get('/trend', async (_req, res) => {
  try {
    const payload = await complianceProjection.ensureFresh();
    return res.json({ trend: payload.trend });
  } catch (err) {
    console.error('[compliance-routes] GET /api/compliance/trend error:', err);
    return res.status(500).json({ error: 'Failed to fetch compliance trend' });
  }
});

export default router;
