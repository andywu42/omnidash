/**
 * Infrastructure Routing Decision API Routes (OMN-7447)
 *
 * REST endpoints for AdapterModelRouter provider selection decisions.
 * Source table: infra_routing_decisions (migrations/0052_infra_routing_decisions.sql)
 * Event consumed: onex.evt.omnibase-infra.routing-decided.v1
 *
 * All data access goes through the InfraRoutingProjection view
 * (projection-only read path). No direct DB imports.
 */

import { Router } from 'express';
import { projectionService } from './projection-bootstrap';
import type {
  InfraRoutingProjection,
  InfraRoutingPayload,
} from './projections/infra-routing-projection';

export const infraRoutingRoutes = Router();

function getInfraRoutingView(): InfraRoutingProjection | undefined {
  const view = projectionService.getView<InfraRoutingPayload>('infra-routing');
  if (view == null) return undefined;
  return view as InfraRoutingProjection;
}

// GET /api/infra-routing/decisions?limit=100
infraRoutingRoutes.get('/decisions', async (req, res) => {
  try {
    const view = getInfraRoutingView();
    if (!view) {
      return res.status(503).json({ error: 'Projection not available' });
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
    const snapshot = view.getSnapshot({ limit });
    const payload = snapshot.payload;

    return res.json({
      decisions: payload.recent.slice(0, limit),
      window: '24h',
    });
  } catch (error) {
    console.error('[infra-routing] Error fetching decisions:', error);
    return res.status(500).json({ error: 'Failed to fetch infra routing decisions' });
  }
});

// GET /api/infra-routing/summary
infraRoutingRoutes.get('/summary', async (req, res) => {
  try {
    const view = getInfraRoutingView();
    if (!view) {
      return res.status(503).json({ error: 'Projection not available' });
    }
    const snapshot = view.getSnapshot();
    const { summary } = snapshot.payload;

    return res.json({
      totalDecisions: summary.totalDecisions,
      fallbackCount: summary.fallbackCount,
      fallbackRate: summary.fallbackRate,
      avgLatencyMs: summary.avgLatencyMs,
      byProvider: summary.byProvider,
      byModel: summary.byModel,
      window: '24h',
    });
  } catch (error) {
    console.error('[infra-routing] Error fetching summary:', error);
    return res.status(500).json({ error: 'Failed to fetch infra routing summary' });
  }
});
