// SPDX-License-Identifier: MIT
/**
 * Objective Evaluation API Routes (OMN-2583)
 *
 * Read-only REST endpoints for the objective evaluation dashboard:
 *   GET /api/objective/score-vector?window=7d
 *   GET /api/objective/gate-failures?window=7d
 *   GET /api/objective/policy-state?window=7d
 *   GET /api/objective/anti-gaming-alerts?window=7d
 *   POST /api/objective/anti-gaming-alerts/:alertId/acknowledge
 *
 * Data sourced from PostgreSQL tables:
 *   - objective_evaluations (populated by OMN-2545 ScoringReducer)
 *   - policy_state (populated by OMN-2557 PolicyState)
 *
 * No mutations to objective data — dashboards are read-only.
 * Alert acknowledgement is the only write operation (UI state only).
 *
 * Graceful degradation: returns empty payloads when DB tables don't exist yet
 * (backend PRs OMN-2545, OMN-2557 may not be merged in all envs).
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type {
  ScoreVectorSummaryResponse,
  GateFailureTimelineResponse,
  PolicyStateHistoryResponse,
  AntiGamingAlertFeedResponse,
  ObjectiveTimeWindow,
  GateType,
  PolicyType,
  PolicyLifecycleState,
  AntiGamingAlertType,
} from '@shared/objective-types';
import { tryGetIntelligenceDb } from './storage';

const router = Router();

// ============================================================================
// Validation
// ============================================================================

const TimeWindowSchema = z.enum(['24h', '7d', '30d', 'all']);

function validateWindow(req: Request, res: Response): ObjectiveTimeWindow | null {
  const raw = typeof req.query.window === 'string' ? req.query.window : '7d';
  const result = TimeWindowSchema.safeParse(raw);
  if (!result.success) {
    res.status(400).json({ error: 'Invalid window parameter. Must be one of: 24h, 7d, 30d, all' });
    return null;
  }
  return result.data as ObjectiveTimeWindow;
}

function windowToInterval(window: ObjectiveTimeWindow): string {
  switch (window) {
    case '24h':
      return "interval '24 hours'";
    case '7d':
      return "interval '7 days'";
    case '30d':
      return "interval '30 days'";
    case 'all':
      return "interval '10000 days'";
  }
}

// ============================================================================
// Score Vector
// ============================================================================

router.get('/score-vector', async (req: Request, res: Response) => {
  const window = validateWindow(req, res);
  if (!window) return;

  const db = tryGetIntelligenceDb();
  if (!db) {
    res.json(emptyScoreVectorResponse());
    return;
  }

  try {
    const interval = windowToInterval(window);

    // Fetch individual evaluation points
    const pointsResult = await db.execute<{
      evaluated_at: string;
      session_id: string;
      agent_name: string;
      task_class: string;
      evaluation_id: string;
      correctness: number;
      safety: number;
      cost: number;
      latency: number;
      maintainability: number;
      human_time: number;
    }>(`
      SELECT
        evaluated_at,
        session_id,
        agent_name,
        task_class,
        id AS evaluation_id,
        score_correctness AS correctness,
        score_safety AS safety,
        score_cost AS cost,
        score_latency AS latency,
        score_maintainability AS maintainability,
        score_human_time AS human_time
      FROM objective_evaluations
      WHERE evaluated_at >= NOW() - ${interval}
      ORDER BY evaluated_at DESC
      LIMIT 200
    `);

    const points = (pointsResult.rows ?? []).map((r) => ({
      evaluated_at: r.evaluated_at,
      session_id: r.session_id,
      agent_name: r.agent_name,
      task_class: r.task_class,
      evaluation_id: r.evaluation_id,
      scores: {
        correctness: Number(r.correctness),
        safety: Number(r.safety),
        cost: Number(r.cost),
        latency: Number(r.latency),
        maintainability: Number(r.maintainability),
        human_time: Number(r.human_time),
      },
    }));

    // Aggregate by agent
    const agentMap = new Map<string, { sum: Record<string, number>; count: number }>();
    points.forEach((p) => {
      const entry = agentMap.get(p.agent_name) ?? {
        sum: { correctness: 0, safety: 0, cost: 0, latency: 0, maintainability: 0, human_time: 0 },
        count: 0,
      };
      Object.keys(p.scores).forEach((k) => {
        entry.sum[k] = (entry.sum[k] ?? 0) + p.scores[k as keyof typeof p.scores];
      });
      entry.count += 1;
      agentMap.set(p.agent_name, entry);
    });

    const aggregates = Array.from(agentMap.entries()).map(([agent, { sum, count }]) => ({
      context_label: agent,
      scores: {
        correctness: sum.correctness / count,
        safety: sum.safety / count,
        cost: sum.cost / count,
        latency: sum.latency / count,
        maintainability: sum.maintainability / count,
        human_time: sum.human_time / count,
      },
      sample_count: count,
    }));

    const sessions = [...new Set(points.map((p) => p.session_id))];
    const agents = [...new Set(points.map((p) => p.agent_name))];
    const task_classes = [...new Set(points.map((p) => p.task_class))];

    const response: ScoreVectorSummaryResponse = {
      points,
      aggregates,
      sessions,
      agents,
      task_classes,
    };
    res.json(response);
  } catch {
    // DB table may not exist yet — return empty payload for graceful degradation
    res.json(emptyScoreVectorResponse());
  }
});

function emptyScoreVectorResponse(): ScoreVectorSummaryResponse {
  return { points: [], aggregates: [], sessions: [], agents: [], task_classes: [] };
}

// ============================================================================
// Gate Failure Timeline
// ============================================================================

router.get('/gate-failures', async (req: Request, res: Response) => {
  const window = validateWindow(req, res);
  if (!window) return;

  const db = tryGetIntelligenceDb();
  if (!db) {
    res.json(emptyGateFailureResponse());
    return;
  }

  try {
    const interval = windowToInterval(window);

    const eventsResult = await db.execute<{
      occurred_at: string;
      gate_type: GateType;
      session_id: string;
      agent_name: string;
      evaluation_id: string;
      attribution_refs: string;
      score_value: number;
      threshold: number;
      increased_vs_prev: boolean;
    }>(`
      SELECT
        occurred_at,
        gate_type,
        session_id,
        agent_name,
        evaluation_id,
        attribution_refs,
        score_value,
        threshold,
        increased_vs_prev_window AS increased_vs_prev
      FROM objective_gate_failures
      WHERE occurred_at >= NOW() - ${interval}
      ORDER BY occurred_at DESC
      LIMIT 500
    `);

    const events = (eventsResult.rows ?? []).map((r) => ({
      occurred_at: r.occurred_at,
      gate_type: r.gate_type,
      session_id: r.session_id,
      agent_name: r.agent_name,
      evaluation_id: r.evaluation_id,
      attribution_refs: (() => {
        try {
          return JSON.parse(r.attribution_refs as unknown as string) as string[];
        } catch {
          return [];
        }
      })(),
      score_value: Number(r.score_value),
      threshold: Number(r.threshold),
      increased_vs_prev_window: Boolean(r.increased_vs_prev),
    }));

    // Build time bins
    const binCount = window === '24h' ? 24 : 14;
    const windowMs = window === '24h' ? 86400000 : window === '7d' ? 604800000 : 2592000000;
    const now = Date.now();
    const binMs = windowMs / binCount;

    const bins = Array.from({ length: binCount }, (_, i) => {
      const binStart = new Date(now - (binCount - i) * binMs);
      const binEnd = new Date(binStart.getTime() + binMs);
      const inBin = events.filter((e) => {
        const t = new Date(e.occurred_at).getTime();
        return t >= binStart.getTime() && t < binEnd.getTime();
      });
      const byGate: Partial<Record<GateType, number>> = {};
      inBin.forEach((e) => {
        byGate[e.gate_type] = (byGate[e.gate_type] ?? 0) + 1;
      });
      return { bin_start: binStart.toISOString(), total: inBin.length, by_gate_type: byGate };
    });

    const totals: Partial<Record<GateType, number>> = {};
    events.forEach((e) => {
      totals[e.gate_type] = (totals[e.gate_type] ?? 0) + 1;
    });

    const response: GateFailureTimelineResponse = {
      bins,
      events,
      totals_by_gate_type: totals,
      total_failures: events.length,
      escalating_sessions: [
        ...new Set(events.filter((e) => e.increased_vs_prev_window).map((e) => e.session_id)),
      ],
    };
    res.json(response);
  } catch {
    res.json(emptyGateFailureResponse());
  }
});

function emptyGateFailureResponse(): GateFailureTimelineResponse {
  return {
    bins: [],
    events: [],
    totals_by_gate_type: {},
    total_failures: 0,
    escalating_sessions: [],
  };
}

// ============================================================================
// Policy State History
// ============================================================================

router.get('/policy-state', async (req: Request, res: Response) => {
  const window = validateWindow(req, res);
  if (!window) return;

  const db = tryGetIntelligenceDb();
  if (!db) {
    res.json(emptyPolicyStateResponse());
    return;
  }

  try {
    const interval = windowToInterval(window);

    const result = await db.execute<{
      recorded_at: string;
      policy_id: string;
      policy_type: PolicyType;
      policy_version: string;
      lifecycle_state: PolicyLifecycleState;
      reliability_0_1: number;
      confidence_0_1: number;
      is_transition: boolean;
      is_auto_blacklist: boolean;
      has_tool_degraded_alert: boolean;
      tool_degraded_message: string | null;
    }>(`
      SELECT
        recorded_at,
        policy_id,
        policy_type,
        policy_version,
        lifecycle_state,
        reliability_0_1,
        confidence_0_1,
        is_transition,
        is_auto_blacklist,
        has_tool_degraded_alert,
        tool_degraded_message
      FROM policy_state
      WHERE recorded_at >= NOW() - ${interval}
      ORDER BY recorded_at ASC
      LIMIT 1000
    `);

    const points = (result.rows ?? []).map((r) => ({
      recorded_at: r.recorded_at,
      policy_id: r.policy_id,
      policy_type: r.policy_type,
      policy_version: r.policy_version,
      lifecycle_state: r.lifecycle_state,
      reliability_0_1: Number(r.reliability_0_1),
      confidence_0_1: Number(r.confidence_0_1),
      is_transition: Boolean(r.is_transition),
      is_auto_blacklist: Boolean(r.is_auto_blacklist),
      has_tool_degraded_alert: Boolean(r.has_tool_degraded_alert),
      tool_degraded_message: r.tool_degraded_message ?? undefined,
    }));

    // Derive current states (latest per policy_id)
    const latestByPolicy = new Map<string, (typeof points)[0]>();
    points.forEach((p) => {
      const existing = latestByPolicy.get(p.policy_id);
      if (!existing || p.recorded_at > existing.recorded_at) {
        latestByPolicy.set(p.policy_id, p);
      }
    });

    const response: PolicyStateHistoryResponse = {
      points,
      policy_ids: [...new Set(points.map((p) => p.policy_id))],
      policy_types: [...new Set(points.map((p) => p.policy_type))],
      current_states: Array.from(latestByPolicy.values()).map((p) => ({
        policy_id: p.policy_id,
        policy_type: p.policy_type,
        lifecycle_state: p.lifecycle_state,
        reliability_0_1: p.reliability_0_1,
        confidence_0_1: p.confidence_0_1,
      })),
    };
    res.json(response);
  } catch {
    res.json(emptyPolicyStateResponse());
  }
});

function emptyPolicyStateResponse(): PolicyStateHistoryResponse {
  return { points: [], policy_ids: [], policy_types: [], current_states: [] };
}

// ============================================================================
// Anti-Gaming Alert Feed
// ============================================================================

// In-memory acknowledgement store (until OMN-2545 backend provides persistence)
const acknowledgedAlerts = new Set<string>();

router.get('/anti-gaming-alerts', async (req: Request, res: Response) => {
  const window = validateWindow(req, res);
  if (!window) return;

  const db = tryGetIntelligenceDb();
  if (!db) {
    res.json(emptyAlertFeedResponse());
    return;
  }

  try {
    const interval = windowToInterval(window);

    const result = await db.execute<{
      alert_id: string;
      alert_type: AntiGamingAlertType;
      triggered_at: string;
      metric_name: string;
      proxy_metric: string;
      delta: number;
      description: string;
      session_id: string;
      acknowledged: boolean;
      acknowledged_at: string | null;
    }>(`
      SELECT
        alert_id,
        alert_type,
        triggered_at,
        metric_name,
        proxy_metric,
        delta,
        description,
        session_id,
        acknowledged,
        acknowledged_at
      FROM objective_anti_gaming_alerts
      WHERE triggered_at >= NOW() - ${interval}
      ORDER BY triggered_at DESC
      LIMIT 200
    `);

    const alerts = (result.rows ?? []).map((r) => ({
      alert_id: r.alert_id,
      alert_type: r.alert_type,
      triggered_at: r.triggered_at,
      metric_name: r.metric_name,
      proxy_metric: r.proxy_metric,
      delta: Number(r.delta),
      description: r.description,
      session_id: r.session_id,
      // Merge in-memory acknowledgements with DB state
      acknowledged: r.acknowledged || acknowledgedAlerts.has(r.alert_id),
      acknowledged_at: r.acknowledged_at ?? undefined,
    }));

    const response: AntiGamingAlertFeedResponse = {
      alerts,
      total_unacknowledged: alerts.filter((a) => !a.acknowledged).length,
    };
    res.json(response);
  } catch {
    res.json(emptyAlertFeedResponse());
  }
});

router.post('/anti-gaming-alerts/:alertId/acknowledge', (req: Request, res: Response) => {
  const { alertId } = req.params;
  if (!alertId) {
    res.status(400).json({ error: 'alertId is required' });
    return;
  }
  acknowledgedAlerts.add(alertId);
  res.json({ success: true, alert_id: alertId, acknowledged_at: new Date().toISOString() });
});

function emptyAlertFeedResponse(): AntiGamingAlertFeedResponse {
  return { alerts: [], total_unacknowledged: 0 };
}

// ============================================================================
// Export
// ============================================================================

export default router;
