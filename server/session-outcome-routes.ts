/**
 * Session Outcome API Routes (OMN-5184)
 *
 * Serves summary and trend data for session outcomes, powered by the
 * SessionOutcomeProjection. Used by the Success category dashboard.
 */

import { Router } from 'express';
import {
  SessionOutcomeProjection,
  type SessionOutcomeWindow,
} from './projections/session-outcome-projection';

export const sessionOutcomeRoutes = Router();

const projection = new SessionOutcomeProjection();

const VALID_WINDOWS: SessionOutcomeWindow[] = ['24h', '7d', '30d'];

function parseWindow(raw: unknown): SessionOutcomeWindow {
  const s = String(raw ?? '7d');
  return VALID_WINDOWS.includes(s as SessionOutcomeWindow)
    ? (s as SessionOutcomeWindow)
    : '7d';
}

// GET /api/session-outcomes/summary?window=7d
sessionOutcomeRoutes.get('/summary', async (req, res) => {
  try {
    const window = parseWindow(req.query.window);
    const data = await projection.ensureFreshForWindow(window);
    res.json(data.summary);
  } catch (error) {
    console.error('Error fetching session outcome summary:', error);
    res.status(500).json({
      error: 'Failed to fetch session outcome summary',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/session-outcomes/trend?window=7d
sessionOutcomeRoutes.get('/trend', async (req, res) => {
  try {
    const window = parseWindow(req.query.window);
    const data = await projection.ensureFreshForWindow(window);
    res.json({
      points: data.trend,
      granularity: data.granularity,
    });
  } catch (error) {
    console.error('Error fetching session outcome trend:', error);
    res.status(500).json({
      error: 'Failed to fetch session outcome trend',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
