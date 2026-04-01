/**
 * Hook Health API Routes (OMN-7161)
 *
 * Serves hook error summary data for the hook health dashboard card.
 * Powered by HookHealthProjection.
 */

import { Router } from 'express';
import { HookHealthProjection } from './projections/hook-health-projection';

export const hookHealthRoutes = Router();

const projection = new HookHealthProjection();

const SUPPORTED_WINDOWS = {
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '24h': 1440,
  '7d': 10080,
} as const;

/**
 * GET /api/hook-health/summary
 *
 * Returns hook error summary for a time window.
 * Query params: ?window=5m|15m|30m|1h|24h|7d (default: 24h)
 */
hookHealthRoutes.get('/summary', async (req, res) => {
  try {
    const windowParam = typeof req.query.window === 'string' ? req.query.window : '24h';
    if (!Object.hasOwn(SUPPORTED_WINDOWS, windowParam)) {
      return res.status(400).json({
        error: `Invalid window. Use one of: ${Object.keys(SUPPORTED_WINDOWS).join(', ')}`,
      });
    }
    const windowMinutes = SUPPORTED_WINDOWS[windowParam as keyof typeof SUPPORTED_WINDOWS];
    const summary = await projection.summary(windowMinutes);
    return res.json(summary);
  } catch (err) {
    console.error('[hook-health] summary query failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
