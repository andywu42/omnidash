/**
 * Savings Estimation API Routes (OMN-5553)
 *
 * Serves token savings estimation data from the savings_estimates table,
 * powered by SavingsProjection. Replaces the previous in-memory
 * AgentRunTracker-based stubs with real DB-backed queries.
 *
 * Endpoints:
 *   GET /api/savings/summary?window=7d   — aggregate savings summary
 *   GET /api/savings/trend?window=7d     — time-bucketed savings trend
 *   GET /api/savings/categories?window=7d — category breakdown from JSONB
 */

import { Router } from 'express';
import { SavingsProjection, type SavingsWindow } from './projections/savings-projection';

const router = Router();
const projection = new SavingsProjection();

const VALID_WINDOWS: SavingsWindow[] = ['24h', '7d', '30d'];

function parseWindow(raw: unknown): SavingsWindow {
  const s = String(raw ?? '7d');
  return VALID_WINDOWS.includes(s as SavingsWindow) ? (s as SavingsWindow) : '7d';
}

// GET /api/savings/summary?window=7d
router.get('/summary', async (req, res) => {
  try {
    const window = parseWindow(req.query.window);
    const data = await projection.ensureFreshForWindow(window);
    res.json(data.summary);
  } catch (error) {
    console.error('Error fetching savings summary:', error);
    res.status(500).json({ error: 'Failed to fetch savings summary' });
  }
});

// GET /api/savings/trend?window=7d
router.get('/trend', async (req, res) => {
  try {
    const window = parseWindow(req.query.window);
    const data = await projection.ensureFreshForWindow(window);
    res.json({ trend: data.trend, granularity: data.granularity, window: data.summary.window });
  } catch (error) {
    console.error('Error fetching savings trend:', error);
    res.status(500).json({ error: 'Failed to fetch savings trend' });
  }
});

// GET /api/savings/categories?window=7d
router.get('/categories', async (req, res) => {
  try {
    const window = parseWindow(req.query.window);
    const data = await projection.ensureFreshForWindow(window);
    res.json({ categories: data.categories, window: data.summary.window });
  } catch (error) {
    console.error('Error fetching savings categories:', error);
    res.status(500).json({ error: 'Failed to fetch savings categories' });
  }
});

// GET /api/savings/metrics — backwards-compatible summary endpoint
// Maps the new DB-backed data to the legacy SavingsMetrics shape so that
// existing dashboard components continue to work during migration.
router.get('/metrics', async (req, res) => {
  try {
    const window = parseWindow(req.query.timeRange ?? req.query.window);
    const data = await projection.ensureFreshForWindow(window);
    const s = data.summary;

    const daysInWindow = window === '24h' ? 1 : window === '30d' ? 30 : 7;
    const dailySavings = daysInWindow > 0 ? s.totalEstimatedSavingsUsd / daysInWindow : 0;

    res.json({
      totalSavings: s.totalEstimatedSavingsUsd,
      monthlySavings: dailySavings * 30,
      weeklySavings: dailySavings * 7,
      dailySavings,
      intelligenceRuns: s.eventCount,
      baselineRuns: 0,
      avgTokensPerRun: s.eventCount > 0 ? s.totalTokensSaved / s.eventCount : 0,
      avgComputePerRun: 0,
      costPerToken: 0,
      costPerCompute: 0,
      efficiencyGain: s.avgConfidence * 100,
      timeSaved: 0,
      dataAvailable: s.eventCount > 0,
    });
  } catch (error) {
    console.error('Error calculating savings metrics:', error);
    res.status(500).json({ error: 'Failed to calculate savings metrics' });
  }
});

export default router;
