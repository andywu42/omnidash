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
import type { CostTimeWindow, BudgetAlert } from '@shared/cost-types';
import { projectionService, pipelineBudgetProjection } from './projection-bootstrap';
import type {
  CostMetricsProjection,
  CostMetricsPayload,
} from './projections/cost-metrics-projection';
import type { PipelineBudgetRow } from './projections/pipeline-budget-projection';

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
  if (raw === '24h' || raw === '7d' || raw === '30d' || raw === 'all') return raw;
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
      res.setHeader('X-Projection-Status', 'empty');
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
    // Derive active_alerts from pipeline budget cap-hit data (SOW-Phase2).
    // Gracefully falls back to 0 if the pipeline budget projection is unavailable.
    try {
      const budgetPayload = await pipelineBudgetProjection.ensureFresh();
      summary.active_alerts = budgetPayload.summary.total_cap_hits;
    } catch (err) {
      // Pipeline budget projection unavailable — keep the default 0
      console.warn('[costs] Pipeline budget projection unavailable for active_alerts:', err);
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
    const modelFilter = typeof req.query.model === 'string' ? req.query.model : undefined;

    const view = getCostView();
    if (!view) {
      res.setHeader('X-Projection-Status', 'empty');
      return res.json([]);
    }

    // When a model filter is specified, query via the projection's
    // queryTrendForModel (which obtains the DB internally, respecting OMN-2325).
    let trend;
    if (modelFilter) {
      const filtered = await view.queryTrendForModel(timeWindow, modelFilter);
      if (!filtered) {
        return res.json([]); // fallback-ok: no trend data for specified model filter; empty is a valid result
      }
      trend = filtered;
    } else {
      const payload = await getPayloadForWindow(view, timeWindow);
      if (payload.degraded) {
        res.setHeader('X-Degraded', 'true');
        if (payload.window !== undefined) res.setHeader('X-Degraded-Window', payload.window);
      }
      trend = payload.trend;
    }

    // When includeEstimated=false, subtract estimated costs from each trend point.
    if (!includeEstimated) {
      const filtered = trend.map((p) => ({
        ...p,
        total_cost_usd: p.total_cost_usd - p.estimated_cost_usd,
        estimated_cost_usd: 0,
      }));
      return res.json(filtered);
    }
    return res.json(trend);
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
      res.setHeader('X-Projection-Status', 'empty');
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
      res.setHeader('X-Projection-Status', 'empty');
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
      res.setHeader('X-Projection-Status', 'empty');
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
      res.setHeader('X-Projection-Status', 'empty');
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

/**
 * Derive BudgetAlert[] from pipeline_budget_state cap-hit records.
 *
 * Each unique (pipeline_id, budget_type) pair that has cap_hit=true becomes
 * an alert. The most recent row per pair determines current_value / cap_value.
 * Utilization is calculated as (current_value / cap_value) * 100.
 */
function deriveBudgetAlerts(rows: PipelineBudgetRow[]): BudgetAlert[] {
  // Group by pipeline_id + budget_type to get the latest cap hit per pair
  const latest = new Map<string, PipelineBudgetRow>();
  for (const row of rows) {
    const key = `${row.pipeline_id}::${row.budget_type}`;
    const existing = latest.get(key);
    if (!existing || row.created_at > existing.created_at) {
      latest.set(key, row);
    }
  }

  return Array.from(latest.values()).map((row): BudgetAlert => {
    const capValue = row.cap_value ?? 0;
    const currentValue = row.current_value ?? 0;
    const utilization = capValue > 0 ? (currentValue / capValue) * 100 : 0;

    return {
      id: row.correlation_id,
      name: `${row.pipeline_id} ${row.budget_type} cap`,
      threshold_usd: capValue,
      period: 'daily',
      current_spend_usd: currentValue,
      utilization_pct: Math.round(utilization * 100) / 100,
      is_triggered: row.cap_hit,
      last_evaluated: row.created_at,
    };
  });
}

router.get('/alerts', async (_req, res) => {
  try {
    const payload = await pipelineBudgetProjection.ensureFresh();
    const alerts = deriveBudgetAlerts(payload.recent);
    return res.json(alerts);
  } catch (error) {
    console.error('[costs] Error fetching alerts:', error);
    return res.status(500).json({ error: 'Failed to fetch budget alerts' });
  }
});

export default router;
