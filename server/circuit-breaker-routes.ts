/**
 * Circuit Breaker API Routes (OMN-5293)
 *
 * Serves circuit breaker state summaries and recent events,
 * powered by CircuitBreakerProjection.
 * Used by the CircuitBreakerDashboard page.
 */

import { Router } from 'express';
import {
  CircuitBreakerProjection,
  type CircuitBreakerWindow,
} from './projections/circuit-breaker-projection';

export const circuitBreakerRoutes = Router();

const projection = new CircuitBreakerProjection();

const VALID_WINDOWS: CircuitBreakerWindow[] = ['1h', '24h', '7d'];

function parseWindow(raw: unknown): CircuitBreakerWindow {
  const s = String(raw ?? '24h');
  return VALID_WINDOWS.includes(s as CircuitBreakerWindow)
    ? (s as CircuitBreakerWindow)
    : '24h';
}

// GET /api/circuit-breaker/summary?window=24h
circuitBreakerRoutes.get('/summary', async (req, res) => {
  try {
    const window = parseWindow(req.query.window);
    const data = await projection.ensureFreshForWindow(window);
    res.json({
      services: data.services,
      stateCounts: data.stateCounts,
      totalEvents: data.totalEvents,
      window: data.window,
    });
  } catch (error) {
    console.error('Error fetching circuit breaker summary:', error);
    res.status(500).json({
      error: 'Failed to fetch circuit breaker summary',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/circuit-breaker/events?window=24h
circuitBreakerRoutes.get('/events', async (req, res) => {
  try {
    const window = parseWindow(req.query.window);
    const data = await projection.ensureFreshForWindow(window);
    res.json({ events: data.recentEvents, window: data.window });
  } catch (error) {
    console.error('Error fetching circuit breaker events:', error);
    res.status(500).json({
      error: 'Failed to fetch circuit breaker events',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
