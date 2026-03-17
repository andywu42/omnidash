/**
 * Phase Metrics API Routes (OMN-5184)
 *
 * Serves summary and by-phase data for pipeline phase metrics, powered by the
 * PhaseMetricsProjection. Used by the Speed category dashboard.
 */

import { Router } from 'express';
import {
  PhaseMetricsProjection,
  type PhaseMetricsWindow,
} from './projections/phase-metrics-projection';

export const phaseMetricsRoutes = Router();

const projection = new PhaseMetricsProjection();

const VALID_WINDOWS: PhaseMetricsWindow[] = ['24h', '7d', '30d'];

function parseWindow(raw: unknown): PhaseMetricsWindow {
  const s = String(raw ?? '7d');
  return VALID_WINDOWS.includes(s as PhaseMetricsWindow)
    ? (s as PhaseMetricsWindow)
    : '7d';
}

// GET /api/phase-metrics/summary?window=7d
phaseMetricsRoutes.get('/summary', async (req, res) => {
  try {
    const window = parseWindow(req.query.window);
    const data = await projection.ensureFreshForWindow(window);
    res.json(data.summary);
  } catch (error) {
    console.error('Error fetching phase metrics summary:', error);
    res.status(500).json({
      error: 'Failed to fetch phase metrics summary',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/phase-metrics/by-phase?window=7d
phaseMetricsRoutes.get('/by-phase', async (req, res) => {
  try {
    const window = parseWindow(req.query.window);
    const data = await projection.ensureFreshForWindow(window);
    res.json({
      phases: data.byPhase,
      window,
    });
  } catch (error) {
    console.error('Error fetching phase metrics by-phase:', error);
    res.status(500).json({
      error: 'Failed to fetch phase metrics by-phase',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
