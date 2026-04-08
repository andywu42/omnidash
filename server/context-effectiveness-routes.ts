/**
 * Context Effectiveness API Routes (OMN-5286)
 *
 * REST endpoints for the /context-effectiveness dashboard.
 * Data served via ContextEffectivenessProjection (DB-backed, TTL-cached).
 * Per OMN-2325: no direct DB imports in route files.
 *
 * Endpoints:
 *   GET /api/context-effectiveness/summary?window=24h
 *   GET /api/context-effectiveness/by-method?window=24h
 *   GET /api/context-effectiveness/trend?window=24h
 *   GET /api/context-effectiveness/outcomes?window=24h
 *   GET /api/context-effectiveness/low-utilization?window=24h
 */

import { Router } from 'express';
import { contextEffectivenessProjection } from './projection-bootstrap';
import { ACCEPTED_WINDOWS } from './sql-safety';
import type { ContextEffectivenessTimeWindow } from '@shared/context-effectiveness-types';

const router = Router();

function getWindow(query: Record<string, unknown>): ContextEffectivenessTimeWindow | null {
  if (query.window !== undefined && typeof query.window !== 'string') {
    return null;
  }
  const windowParam = typeof query.window === 'string' ? query.window : '24h';
  if (!ACCEPTED_WINDOWS.has(windowParam)) {
    return null;
  }
  return windowParam as ContextEffectivenessTimeWindow;
}

// ============================================================================
// GET /api/context-effectiveness/summary
// ============================================================================

router.get('/summary', async (req, res) => {
  const window = getWindow(req.query as Record<string, unknown>);
  if (window === null) {
    return res
      .status(400)
      .json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
  }
  try {
    const payload = await contextEffectivenessProjection.ensureFresh();
    return res.json(payload[window].summary);
  } catch (error) {
    console.error('[context-effectiveness] Error fetching summary:', error);
    return res.status(500).json({ error: 'Failed to fetch context effectiveness summary' });
  }
});

// ============================================================================
// GET /api/context-effectiveness/by-method
// ============================================================================

router.get('/by-method', async (req, res) => {
  const window = getWindow(req.query as Record<string, unknown>);
  if (window === null) {
    return res
      .status(400)
      .json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
  }
  try {
    const payload = await contextEffectivenessProjection.ensureFresh();
    return res.json(payload[window].byMethod);
  } catch (error) {
    console.error('[context-effectiveness] Error fetching by-method:', error);
    return res.status(500).json({ error: 'Failed to fetch utilization by method' });
  }
});

// ============================================================================
// GET /api/context-effectiveness/trend
// ============================================================================

router.get('/trend', async (req, res) => {
  const window = getWindow(req.query as Record<string, unknown>);
  if (window === null) {
    return res
      .status(400)
      .json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
  }
  try {
    const payload = await contextEffectivenessProjection.ensureFresh();
    return res.json(payload[window].trend);
  } catch (error) {
    console.error('[context-effectiveness] Error fetching trend:', error);
    return res.status(500).json({ error: 'Failed to fetch effectiveness trend' });
  }
});

// ============================================================================
// GET /api/context-effectiveness/outcomes
// ============================================================================

router.get('/outcomes', async (req, res) => {
  const window = getWindow(req.query as Record<string, unknown>);
  if (window === null) {
    return res
      .status(400)
      .json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
  }
  try {
    const payload = await contextEffectivenessProjection.ensureFresh();
    return res.json(payload[window].outcomes);
  } catch (error) {
    console.error('[context-effectiveness] Error fetching outcomes:', error);
    return res.status(500).json({ error: 'Failed to fetch outcome breakdown' });
  }
});

// ============================================================================
// GET /api/context-effectiveness/low-utilization
// Sessions with utilization_score < 0.3
// ============================================================================

router.get('/low-utilization', async (req, res) => {
  const window = getWindow(req.query as Record<string, unknown>);
  if (window === null) {
    return res
      .status(400)
      .json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
  }
  try {
    const payload = await contextEffectivenessProjection.ensureFresh();
    return res.json(payload[window].lowUtilization);
  } catch (error) {
    console.error('[context-effectiveness] Error fetching low-utilization sessions:', error);
    return res.status(500).json({ error: 'Failed to fetch low-utilization sessions' });
  }
});

export default router;
