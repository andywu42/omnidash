/**
 * Pattern Enforcement API Routes (OMN-2374)
 *
 * REST endpoints for the pattern enforcement dashboard:
 * summary, by-language, by-domain, violated-patterns, trend.
 *
 * Per OMN-2325 architectural rule, route files must not import DB accessors
 * directly. All data access goes through enforcementProjection.
 */

import { Router } from 'express';
import { enforcementProjection } from './projection-bootstrap';
import { ACCEPTED_WINDOWS } from './sql-safety';

const router = Router();

// ============================================================================
// GET /api/enforcement/summary?window=7d
// ============================================================================

router.get('/summary', async (req, res) => {
  try {
    const window = (req.query.window as string) || '7d';
    if (!ACCEPTED_WINDOWS.has(window)) {
      return res
        .status(400)
        .json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
    }
    const payload = await enforcementProjection.ensureFreshForWindow(window);
    return res.json(payload.summary);
  } catch (error) {
    console.error('[enforcement] Error fetching summary:', error);
    return res.status(500).json({ error: 'Failed to fetch enforcement summary' });
  }
});

// ============================================================================
// GET /api/enforcement/by-language?window=7d
// ============================================================================

router.get('/by-language', async (req, res) => {
  try {
    const window = (req.query.window as string) || '7d';
    if (!ACCEPTED_WINDOWS.has(window)) {
      return res
        .status(400)
        .json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
    }
    const payload = await enforcementProjection.ensureFreshForWindow(window);
    return res.json(payload.byLanguage);
  } catch (error) {
    console.error('[enforcement] Error fetching by-language:', error);
    return res.status(500).json({ error: 'Failed to fetch enforcement by language' });
  }
});

// ============================================================================
// GET /api/enforcement/by-domain?window=7d
// ============================================================================

router.get('/by-domain', async (req, res) => {
  try {
    const window = (req.query.window as string) || '7d';
    if (!ACCEPTED_WINDOWS.has(window)) {
      return res
        .status(400)
        .json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
    }
    const payload = await enforcementProjection.ensureFreshForWindow(window);
    return res.json(payload.byDomain);
  } catch (error) {
    console.error('[enforcement] Error fetching by-domain:', error);
    return res.status(500).json({ error: 'Failed to fetch enforcement by domain' });
  }
});

// ============================================================================
// GET /api/enforcement/violated-patterns?window=7d
// ============================================================================

router.get('/violated-patterns', async (req, res) => {
  try {
    const window = (req.query.window as string) || '7d';
    if (!ACCEPTED_WINDOWS.has(window)) {
      return res
        .status(400)
        .json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
    }
    const payload = await enforcementProjection.ensureFreshForWindow(window);
    return res.json(payload.violatedPatterns);
  } catch (error) {
    console.error('[enforcement] Error fetching violated-patterns:', error);
    return res.status(500).json({ error: 'Failed to fetch violated patterns' });
  }
});

// ============================================================================
// GET /api/enforcement/trend?window=7d
// ============================================================================

router.get('/trend', async (req, res) => {
  try {
    const window = (req.query.window as string) || '7d';
    if (!ACCEPTED_WINDOWS.has(window)) {
      return res
        .status(400)
        .json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
    }
    const payload = await enforcementProjection.ensureFreshForWindow(window);
    return res.json(payload.trend);
  } catch (error) {
    console.error('[enforcement] Error fetching trend:', error);
    return res.status(500).json({ error: 'Failed to fetch enforcement trend' });
  }
});

export default router;
