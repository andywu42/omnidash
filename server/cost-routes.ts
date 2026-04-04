/**
 * Cost Trend API Routes (OMN-2300)
 *
 * REST endpoints for the LLM cost and token usage trend dashboard:
 * summary, trend, by-model, by-repo, by-pattern, token-usage, alerts.
 *
 * All data access goes through the CostMetricsProjection view
 * (projection-only read path). No direct DB imports.
 *
 * @see OMN-2300 - LLM cost Kafka consumer / read-model materialization
 * @see OMN-2242 - Cost trend dashboard UI
 */

import { Router } from 'express';
import type { CostTimeWindow } from '@shared/cost-types';
import { projectionService } from './projection-bootstrap';
import type {
  CostMetricsProjection,
  CostMetricsPayload,
} from './projections/cost-metrics-projection';

const router = Router();

// ============================================================================
// Helper: get projection view (with graceful degradation)
// ============================================================================

/**
 * Returns the registered CostMetricsProjection, or undefined if unavailable.
 *
 * Uses duck-typing on `ensureFreshForWindow` to verify the view is the
 * expected projection type without requiring a direct import of the class
 * (which would create a circular dependency through projection-bootstrap).
 */
function getCostView(): CostMetricsProjection | undefined {
  const view = projectionService.getView<CostMetricsPayload>('cost-metrics');
  if (view == null) return undefined;
  // Duck-type check: CostMetricsProjection extends DbBackedProjectionView and
  // exposes ensureFresh + ensureFreshForWindow. If these are present, the view
  // is a compatible CostMetricsProjection instance.
  // Known limitation: this check would also pass for any other
  // DbBackedProjectionView subclass that happens to expose both methods with
  // the same names. A stricter check (e.g. instanceof) is not possible here
  // without importing the class directly, which would create a circular
  // dependency through projection-bootstrap.
  if (typeof (view as CostMetricsProjection).ensureFresh !== 'function') return undefined;
  if (typeof (view as CostMetricsProjection).ensureFreshForWindow !== 'function') return undefined;
  return view as CostMetricsProjection;
}

/**
 * Parse the includeEstimated query parameter.
 *
 * Default is `true` (backwards-compatible — all rows returned).
 * When explicitly set to 'false' or '0', returns `false` to exclude
 * rows whose cost data is estimated rather than reported by the provider.
 */
function parseIncludeEstimated(raw: unknown): boolean {
  if (raw === 'false' || raw === '0') return false;
  return true;
}

/** Validate and normalize the time window query parameter. */
function parseWindow(raw: unknown): CostTimeWindow {
  if (raw === '24h' || raw === '7d' || raw === '30d') return raw;
  if (raw !== undefined) {
    console.warn(
      `[costs] parseWindow: unrecognised window value ${JSON.stringify(raw)} — defaulting to '7d'`
    );
  }
  return '7d';
}

/**
 * Get payload for the requested window.
 * For the default 7d window, use the TTL-cached ensureFresh().
 * For non-default windows, delegate to the projection's own method (which
 * accesses the DB internally — no direct DB imports in this route file).
 */
async function getPayloadForWindow(
  view: CostMetricsProjection,
  window: CostTimeWindow
): Promise<CostMetricsPayload> {
  if (window === '7d') {
    // '7d' is the default snapshot window pre-warmed by the base-class TTL cache
    // (via querySnapshot → ensureFresh). Routing it through ensureFreshForWindow()
    // would create a duplicate per-window cache entry for the same data, wasting
    // memory and causing the two caches to drift slightly out of sync.
    // Consequence: ensureFreshForWindow('7d') should never be called directly —
    // use ensureFresh() for the default window and ensureFreshForWindow() only for
    // '24h' and '30d'.
    return view.ensureFresh();
  }
  // Non-default window — the projection handles DB access internally
  return view.ensureFreshForWindow(window);
}

// ============================================================================
// GET /api/costs/summary?window=7d&includeEstimated=false
// ============================================================================

router.get('/summary', async (req, res) => {
  try {
    const timeWindow = parseWindow(req.query.window);
    const includeEstimated = parseIncludeEstimated(req.query.includeEstimated);

    const view = getCostView();
    if (!view) {
      return res.json({
        total_cost_usd: 0,
        reported_cost_usd: 0,
        estimated_cost_usd: 0,
        reported_coverage_pct: 0,
        total_tokens: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        session_count: 0,
        model_count: 0,
        avg_cost_per_session: 0,
        cost_change_pct: 0,
        active_alerts: 0,
      });
    }

    const payload = await getPayloadForWindow(view, timeWindow);
    // Communicate degradation via headers so clients always receive a consistent
    // object shape regardless of degradation state. The body never changes shape.
    if (payload.degraded) {
      res.setHeader('X-Degraded', 'true');
      if (payload.window !== undefined) res.setHeader('X-Degraded-Window', payload.window);
    }
    const summary = { ...payload.summary };
    // When includeEstimated=false, subtract estimated costs from totals and
    // zero out the estimated_cost_usd field so the response reflects only
    // provider-reported costs.
    if (!includeEstimated) {
      summary.total_cost_usd -= summary.estimated_cost_usd;
      summary.estimated_cost_usd = 0;
      summary.reported_coverage_pct = summary.total_cost_usd > 0 ? 100 : 0;
      summary.avg_cost_per_session =
        summary.session_count > 0 ? summary.total_cost_usd / summary.session_count : 0;
    }
    return res.json(summary);
  } catch (error) {
    console.error('[costs] Error fetching summary:', error);
    return res.status(500).json({ error: 'Failed to fetch cost summary' });
  }
});

// ============================================================================
// GET /api/costs/trend?window=7d&includeEstimated=false
// ============================================================================

router.get('/trend', async (req, res) => {
  try {
    const timeWindow = parseWindow(req.query.window);
    const includeEstimated = parseIncludeEstimated(req.query.includeEstimated);

    const view = getCostView();
    if (!view) {
      return res.json([]);
    }

    const payload = await getPayloadForWindow(view, timeWindow);
    // Communicate degradation via headers so the response body always remains
    // an array regardless of degradation state (fixes breaking contract change).
    if (payload.degraded) {
      res.setHeader('X-Degraded', 'true');
      if (payload.window !== undefined) res.setHeader('X-Degraded-Window', payload.window);
    }
    // When includeEstimated=false, subtract estimated costs from each trend point.
    if (!includeEstimated) {
      const filtered = payload.trend.map((p) => ({
        ...p,
        total_cost_usd: p.total_cost_usd - p.estimated_cost_usd,
        estimated_cost_usd: 0,
      }));
      return res.json(filtered);
    }
    return res.json(payload.trend);
  } catch (error) {
    console.error('[costs] Error fetching trend:', error);
    return res.status(500).json({ error: 'Failed to fetch cost trend' });
  }
});

// ============================================================================
// GET /api/costs/by-model?includeEstimated=false
// ============================================================================

// NOTE: window parameter is intentionally ignored; these views always return 30d data.
// byModel/byRepo/byPattern are context panels that need a stable long-horizon distribution.
// See queryByModel() in cost-metrics-projection.ts for the full rationale.
router.get('/by-model', async (req, res) => {
  try {
    const includeEstimated = parseIncludeEstimated(req.query.includeEstimated);
    // Signal to clients that their ?window= param was received but not applied.
    // These endpoints always use a fixed 30d window for stable distribution context.
    if (req.query.window !== undefined) {
      res.setHeader('X-Window-Ignored', 'true');
    }

    const view = getCostView();
    if (!view) {
      return res.json([]);
    }

    const payload = await view.ensureFresh();
    // When includeEstimated=false, exclude rows where the predominant usage_source
    // is 'ESTIMATED' (i.e. the model's cost data is primarily estimated, not reported).
    if (!includeEstimated) {
      return res.json(payload.byModel.filter((r) => r.usage_source !== 'ESTIMATED'));
    }
    return res.json(payload.byModel);
  } catch (error) {
    console.error('[costs] Error fetching by-model:', error);
    return res.status(500).json({ error: 'Failed to fetch cost by model' });
  }
});

// ============================================================================
// GET /api/costs/by-repo?includeEstimated=false
// ============================================================================

// NOTE: window parameter is intentionally ignored; these views always return 30d data.
// byModel/byRepo/byPattern are context panels that need a stable long-horizon distribution.
// See queryByRepo() in cost-metrics-projection.ts for the full rationale.
router.get('/by-repo', async (req, res) => {
  try {
    const includeEstimated = parseIncludeEstimated(req.query.includeEstimated);
    // Signal to clients that their ?window= param was received but not applied.
    // These endpoints always use a fixed 30d window for stable distribution context.
    if (req.query.window !== undefined) {
      res.setHeader('X-Window-Ignored', 'true');
    }

    const view = getCostView();
    if (!view) {
      return res.json([]);
    }

    const payload = await view.ensureFresh();
    if (!includeEstimated) {
      return res.json(payload.byRepo.filter((r) => r.usage_source !== 'ESTIMATED'));
    }
    return res.json(payload.byRepo);
  } catch (error) {
    console.error('[costs] Error fetching by-repo:', error);
    return res.status(500).json({ error: 'Failed to fetch cost by repo' });
  }
});

// ============================================================================
// GET /api/costs/by-pattern?includeEstimated=false
// ============================================================================

// NOTE: window parameter is intentionally ignored; these views always return 30d data.
// byModel/byRepo/byPattern are context panels that need a stable long-horizon distribution.
// See queryByPattern() in cost-metrics-projection.ts for the full rationale.
router.get('/by-pattern', async (req, res) => {
  try {
    const includeEstimated = parseIncludeEstimated(req.query.includeEstimated);
    // Signal to clients that their ?window= param was received but not applied.
    // These endpoints always use a fixed 30d window for stable distribution context.
    if (req.query.window !== undefined) {
      res.setHeader('X-Window-Ignored', 'true');
    }

    const view = getCostView();
    if (!view) {
      return res.json([]);
    }

    const payload = await view.ensureFresh();
    if (!includeEstimated) {
      return res.json(payload.byPattern.filter((r) => r.usage_source !== 'ESTIMATED'));
    }
    return res.json(payload.byPattern);
  } catch (error) {
    console.error('[costs] Error fetching by-pattern:', error);
    return res.status(500).json({ error: 'Failed to fetch cost by pattern' });
  }
});

// ============================================================================
// GET /api/costs/token-usage?window=7d&includeEstimated=false
// ============================================================================

router.get('/token-usage', async (req, res) => {
  try {
    const timeWindow = parseWindow(req.query.window);
    const includeEstimated = parseIncludeEstimated(req.query.includeEstimated);

    const view = getCostView();
    if (!view) {
      return res.json([]);
    }

    const payload = await getPayloadForWindow(view, timeWindow);
    // Communicate degradation via headers so the response body always remains
    // an array regardless of degradation state (fixes breaking contract change).
    if (payload.degraded) {
      res.setHeader('X-Degraded', 'true');
      if (payload.window !== undefined) res.setHeader('X-Degraded-Window', payload.window);
    }
    // When includeEstimated=false, filter out token usage points whose data
    // source is 'ESTIMATED'.
    if (!includeEstimated) {
      return res.json(payload.tokenUsage.filter((p) => p.usage_source !== 'ESTIMATED'));
    }
    return res.json(payload.tokenUsage);
  } catch (error) {
    console.error('[costs] Error fetching token-usage:', error);
    return res.status(500).json({ error: 'Failed to fetch token usage' });
  }
});

// ============================================================================
// GET /api/costs/alerts
// ============================================================================

router.get('/alerts', (_req, res) => {
  // Budget alerts not yet implemented (tracked in OMN-2240).
  // Returns 501 with empty data to signal the feature is not available.
  return res.status(501).json({
    alerts: [],
    message: 'Budget alerts not yet implemented (OMN-2240)',
  });
});

export default router;
