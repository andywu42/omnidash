/**
 * Delegation Metrics API Routes (OMN-2284 / OMN-2650)
 *
 * REST endpoints for the delegation metrics dashboard:
 * summary, by-task-type, cost-savings, quality-gates, shadow-divergence, trend.
 *
 * All responses are derived from the delegation_events and
 * delegation_shadow_comparisons tables via DelegationProjection (DB-backed,
 * TTL-cached). No direct DB imports per OMN-2325 architectural rule.
 */

import { Router, type Request, type Response } from 'express';
import { delegationProjection } from './projection-bootstrap';

const router = Router();

const VALID_WINDOWS = ['24h', '7d', '30d', 'all'] as const;

function validateWindow(req: Request, res: Response): string | null {
  const timeWindow = typeof req.query.window === 'string' ? req.query.window : '7d';
  if (!VALID_WINDOWS.includes(timeWindow as (typeof VALID_WINDOWS)[number])) {
    res.status(400).json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
    return null;
  }
  return timeWindow;
}

// ============================================================================
// GET /api/delegation/summary?window=7d
// ============================================================================

router.get('/summary', async (req, res) => {
  try {
    const timeWindow = validateWindow(req, res);
    if (timeWindow === null) return;
    const payload = await delegationProjection.ensureFreshForWindow(timeWindow);
    return res.json(payload.summary);
  } catch (error) {
    console.error('[delegation] Error fetching summary');
    return res.status(500).json({ error: 'Failed to fetch delegation summary' });
  }
});

// ============================================================================
// GET /api/delegation/by-task-type?window=7d
// ============================================================================

router.get('/by-task-type', async (req, res) => {
  try {
    const timeWindow = validateWindow(req, res);
    if (timeWindow === null) return;
    const payload = await delegationProjection.ensureFreshForWindow(timeWindow);
    return res.json(payload.byTaskType);
  } catch (error) {
    console.error('[delegation] Error fetching by-task-type');
    return res.status(500).json({ error: 'Failed to fetch delegation by task type' });
  }
});

// ============================================================================
// GET /api/delegation/by-model?window=7d
// ============================================================================

router.get('/by-model', async (req, res) => {
  try {
    const timeWindow = validateWindow(req, res);
    if (timeWindow === null) return;
    const payload = await delegationProjection.ensureFreshForWindow(timeWindow);
    return res.json(payload.byModel);
  } catch (error) {
    console.error('[delegation] Error fetching by-model');
    return res.status(500).json({ error: 'Failed to fetch delegation by model' });
  }
});

// ============================================================================
// GET /api/delegation/cost-savings?window=7d
// ============================================================================

router.get('/cost-savings', async (req, res) => {
  try {
    const timeWindow = validateWindow(req, res);
    if (timeWindow === null) return;
    const payload = await delegationProjection.ensureFreshForWindow(timeWindow);
    return res.json(payload.costSavings);
  } catch (error) {
    console.error('[delegation] Error fetching cost-savings');
    return res.status(500).json({ error: 'Failed to fetch delegation cost savings' });
  }
});

// ============================================================================
// GET /api/delegation/quality-gates?window=7d
// ============================================================================

router.get('/quality-gates', async (req, res) => {
  try {
    const timeWindow = validateWindow(req, res);
    if (timeWindow === null) return;
    const payload = await delegationProjection.ensureFreshForWindow(timeWindow);
    return res.json(payload.qualityGates);
  } catch (error) {
    console.error('[delegation] Error fetching quality-gates');
    return res.status(500).json({ error: 'Failed to fetch delegation quality gates' });
  }
});

// ============================================================================
// GET /api/delegation/by-model?window=7d
// ============================================================================

router.get('/by-model', async (req, res) => {
  try {
    const timeWindow = validateWindow(req, res);
    if (timeWindow === null) return;
    const payload = await delegationProjection.ensureFreshForWindow(timeWindow);
    return res.json(payload.byModel);
  } catch (error) {
    console.error('[delegation] Error fetching by-model');
    return res.status(500).json({ error: 'Failed to fetch delegation by model' });
  }
});

// ============================================================================
// GET /api/delegation/shadow-divergence
// ============================================================================

router.get('/shadow-divergence', async (req, res) => {
  try {
    const timeWindow = validateWindow(req, res);
    if (timeWindow === null) return;
    const payload = await delegationProjection.ensureFreshForWindow(timeWindow);
    return res.json(payload.shadowDivergence);
  } catch (error) {
    console.error('[delegation] Error fetching shadow-divergence');
    return res.status(500).json({ error: 'Failed to fetch delegation shadow divergence' });
  }
});

// ============================================================================
// GET /api/delegation/decisions?limit=50
// ============================================================================

router.get('/decisions', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 250);
    const decisions = await delegationProjection.queryRecentDecisions(limit);
    return res.json(decisions);
  } catch (error) {
    console.error('[delegation] Error fetching decisions');
    return res.status(500).json({ error: 'Failed to fetch delegation decisions' });
  }
});

// ============================================================================
// GET /api/delegation/trend?window=7d
// ============================================================================

router.get('/trend', async (req, res) => {
  try {
    const timeWindow = validateWindow(req, res);
    if (timeWindow === null) return;
    const payload = await delegationProjection.ensureFreshForWindow(timeWindow);
    return res.json(payload.trend);
  } catch (error) {
    console.error('[delegation] Error fetching trend');
    return res.status(500).json({ error: 'Failed to fetch delegation trend' });
  }
});

export default router;
