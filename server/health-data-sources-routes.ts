/**
 * Data Source Health Routes (OMN-2307)
 *
 * Exposes GET /api/health/data-sources to report the live/mock status of every
 * dashboard data source. The endpoint probes each backing API (or projection)
 * to determine whether real data is available, then returns a structured
 * summary suitable for a pre-demo readiness check.
 *
 * Response shape:
 * {
 *   dataSources: {
 *     [key: string]: {
 *       status: "live" | "mock" | "error" | "offline";
 *       reason?: string;   // present when status != "live"
 *       lastEvent?: string; // ISO timestamp, present when status == "live"
 *     }
 *   },
 *   summary: { live: number; mock: number; error: number; offline: number },
 *   checkedAt: string; // ISO timestamp
 * }
 */

import * as fs from 'fs';
import * as os from 'os';
import { Router } from 'express';
import { projectionService, enforcementProjection } from './projection-bootstrap';
import type {
  ExtractionMetricsProjection,
  ExtractionMetricsPayload,
} from './projections/extraction-metrics-projection';
import type {
  EffectivenessMetricsProjection,
  EffectivenessMetricsPayload,
} from './projections/effectiveness-metrics-projection';
import type {
  CostMetricsProjection,
  CostMetricsPayload,
} from './projections/cost-metrics-projection';
import type { BaselinesProjection, BaselinesPayload } from './projections/baselines-projection';
import type { IntentProjectionPayload, NodeRegistryPayload } from '@shared/projection-types';
import type { EventBusPayload } from '@shared/event-bus-payload';
import type {
  ValidationProjection,
  ValidationProjectionPayload,
} from './projections/validation-projection';
import type {
  PatternsProjection,
  PatternsProjectionPayload,
} from './projections/patterns-projection';
import type { LlmRoutingPayload } from './projections/llm-routing-projection';
import { tryGetIntelligenceDb } from './storage';
import { patternLearningArtifacts } from '@shared/intelligence-schema';
import { count } from 'drizzle-orm';
import { getEventBusDataSource } from './event-bus-data-source';
import {
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
} from '../shared/topics';
import { READ_MODEL_TOPICS } from './read-model-consumer';
import { EXPECTED_TOPICS } from './event-bus-health-poller';
import { readModelConsumer } from './read-model-consumer';

// ============================================================================
// Types
// ============================================================================

export type DataSourceStatus =
  | 'live'
  | 'mock'
  | 'error'
  | 'offline'
  | 'expected_idle_local'
  | 'not_applicable';

export interface DataSourceInfo {
  status: DataSourceStatus;
  /** Present when status is 'mock', 'error', or 'offline', describes why live data is unavailable. */
  reason?: string;
  /** Present when status is 'live', ISO 8601 timestamp of the most recent real event. */
  lastEvent?: string;
}

export interface DataSourcesHealthResponse {
  dataSources: Record<string, DataSourceInfo>;
  summary: {
    live: number;
    mock: number;
    error: number;
    offline: number;
    expected_idle_local: number;
    not_applicable: number;
  };
  checkedAt: string;
}

// ============================================================================
// Constants
// ============================================================================

const ENV_SYNC_STALE_SECS = 86400; // 24 hours — local dev sessions are long-running (OMN-5155)

/**
 * Detect whether this is a local (non-cloud) environment.
 * Local dev environments don't have all upstream producers running, so some
 * data sources being empty is expected — not an error (OMN-5149).
 */
function isLocalEnvironment(): boolean {
  return (
    !process.env.K8S_NAMESPACE &&
    !process.env.KUBERNETES_SERVICE_HOST &&
    process.env.NODE_ENV !== 'production'
  );
}

/**
 * Data sources that are expected to be idle (no data) in local dev
 * environments because their upstream producers only run in cloud or during
 * active agent sessions. Listed here so the health panel can distinguish
 * "structurally offline" from "broken" (OMN-5149).
 */
const LOCAL_IDLE_EXPECTED: Set<string> = new Set([
  'intents',
  'baselines',
  'validation',
  'patterns',
  'insights',
  // Topic parity depends on all manifest topics existing on the broker,
  // which only happens in cloud. Local dev has a subset of topics.
  'topicParity',
  // Env sync requires Infisical which only runs with --profile secrets.
  'envSync',
  // Cost trends depend on LLM cost aggregation upstream service.
  'costTrends',
  // OMN-5820: The following 3 sources depend on runtime services actively
  // producing events. They show as "mock" in local dev when no agent session
  // is running. Added here temporarily to prevent false alarms on the health
  // panel. Remove each entry once its upstream data flow is verified end-to-end.
  'executionGraph',
  'enforcement',
  'nodeRegistry',
]);

// ============================================================================
// Individual probe functions
// ============================================================================

/**
 * Probe the event-bus projection.
 * Live if the projection has received at least one event.
 */
function probeEventBus(): DataSourceInfo {
  try {
    const view = projectionService.getView<EventBusPayload>('event-bus');
    if (!view) {
      return { status: 'mock', reason: 'no_projection_registered' };
    }
    const snapshot = view.getSnapshot();
    if (!snapshot) {
      return { status: 'mock', reason: 'empty_projection' };
    }
    const payload = snapshot.payload;
    if (!payload || payload.totalEventsIngested === 0) {
      return { status: 'mock', reason: 'no_events_ingested' };
    }
    // Use snapshotTimeMs (the time the snapshot was taken) as a proxy for lastEvent
    const lastEvent =
      snapshot.snapshotTimeMs != null ? new Date(snapshot.snapshotTimeMs).toISOString() : undefined;
    return { status: 'live', lastEvent };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe the effectiveness projection.
 * Live if the summary shows at least one session.
 */
function probeEffectiveness(): DataSourceInfo {
  try {
    const view = projectionService.getView<EffectivenessMetricsPayload>('effectiveness-metrics') as
      | EffectivenessMetricsProjection
      | undefined;
    if (!view) {
      return { status: 'mock', reason: 'no_projection_registered' };
    }
    const snapshot = view.getSnapshot();
    if (!snapshot) {
      return { status: 'mock', reason: 'empty_projection' };
    }
    const summary = snapshot.payload?.summary;
    if (!summary || summary.total_sessions === 0) {
      return { status: 'mock', reason: 'empty_tables' };
    }
    return { status: 'live' };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe the extraction-metrics projection.
 * Live if summary.last_event_at is not null (at least one row ever written).
 */
function probeExtraction(): DataSourceInfo {
  try {
    const view = projectionService.getView<ExtractionMetricsPayload>('extraction-metrics') as
      | ExtractionMetricsProjection
      | undefined;
    if (!view) {
      return { status: 'mock', reason: 'no_projection_registered' };
    }
    const snapshot = view.getSnapshot();
    if (!snapshot) {
      return { status: 'mock', reason: 'empty_projection' };
    }
    const summary = snapshot.payload?.summary;
    if (!summary || summary.last_event_at == null) {
      return { status: 'mock', reason: 'empty_tables' };
    }
    return { status: 'live', lastEvent: summary.last_event_at };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe the baselines projection.
 * Live if at least one comparison row exists (total_comparisons > 0).
 * Returns 'offline' (not 'mock') when the projection exists but has no data,
 * because the upstream producer (omnibase-infra baselines-computed event) has
 * never emitted — the tables are structurally present but unpopulated.
 */
function probeBaselines(): DataSourceInfo {
  try {
    const view = projectionService.getView<BaselinesPayload>('baselines') as
      | BaselinesProjection
      | undefined;
    if (!view) {
      return { status: 'mock', reason: 'no_projection_registered' };
    }
    const snapshot = view.getSnapshot();
    if (!snapshot) {
      return { status: 'mock', reason: 'empty_projection' };
    }
    const baselines = snapshot.payload;
    if (!baselines || baselines.summary.total_comparisons === 0) {
      return { status: 'offline', reason: 'upstream_service_offline' };
    }
    return { status: 'live' };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe the cost-metrics projection.
 * Live if session_count > 0 or total_tokens > 0 in llm_cost_aggregates.
 * Falls back to checking llm_routing_decisions.cost_usd when llm_cost_aggregates
 * is empty — the LLM routing table has real latency and cost data from routing
 * decisions and can serve as a proxy cost signal until the dedicated cost
 * producer (LLM usage events) is wired up.
 * Returns 'offline' when neither table has any data.
 */
function probeCost(): DataSourceInfo {
  try {
    const view = projectionService.getView<CostMetricsPayload>('cost-metrics') as
      | CostMetricsProjection
      | undefined;
    if (!view) {
      return { status: 'mock', reason: 'no_projection_registered' };
    }
    const snapshot = view.getSnapshot();
    if (!snapshot) {
      return { status: 'mock', reason: 'empty_projection' };
    }
    const summary = snapshot.payload?.summary;
    if (summary && (summary.session_count > 0 || summary.total_tokens > 0)) {
      return { status: 'live' };
    }
    // llm_cost_aggregates is empty. Check the llm-routing projection as a
    // proxy: it contains real latency/cost_usd data from routing decisions.
    const llmView = projectionService.getView<LlmRoutingPayload>('llm-routing');
    if (llmView) {
      const llmSnapshot = llmView.getSnapshot();
      if (llmSnapshot?.payload && llmSnapshot.payload.summary.total_decisions > 0) {
        return { status: 'live' };
      }
    }
    return { status: 'offline', reason: 'upstream_service_offline' };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe the intent projection.
 * Live if the projection has at least one classified intent.
 */
function probeIntents(): DataSourceInfo {
  try {
    const view = projectionService.getView<IntentProjectionPayload>('intent');
    if (!view) {
      return { status: 'mock', reason: 'no_projection_registered' };
    }
    const snapshot = view.getSnapshot();
    if (!snapshot) {
      return { status: 'mock', reason: 'empty_projection' };
    }
    const payload = snapshot.payload;
    if (!payload || payload.totalIntents === 0) {
      return { status: 'mock', reason: 'no_intents_classified' };
    }
    const lastEvent =
      payload.lastEventTimeMs != null ? new Date(payload.lastEventTimeMs).toISOString() : undefined;
    return { status: 'live', lastEvent };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe the node registry projection.
 * Live if at least one node is registered.
 */
function probeNodeRegistry(): DataSourceInfo {
  try {
    const view = projectionService.getView<NodeRegistryPayload>('node-registry');
    if (!view) {
      return { status: 'mock', reason: 'no_projection_registered' };
    }
    const snapshot = view.getSnapshot();
    if (!snapshot) {
      return { status: 'mock', reason: 'empty_projection' };
    }
    const payload = snapshot.payload;
    if (!payload || payload.stats.totalNodes === 0) {
      return { status: 'mock', reason: 'no_nodes_registered' };
    }
    return { status: 'live' };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe the validation projection.
 * Live if at least one validation run exists (totalRuns > 0).
 * Returns 'offline' (not 'mock') when the projection is registered but has no
 * data, because the upstream producer (cross-repo validation runner) has never
 * emitted events — the tables are structurally present but unpopulated.
 */
function probeValidation(): DataSourceInfo {
  try {
    const view = projectionService.getView<ValidationProjectionPayload>('validation') as
      | ValidationProjection
      | undefined;
    if (!view) {
      return { status: 'mock', reason: 'no_projection_registered' };
    }
    const snapshot = view.getSnapshot();
    if (!snapshot) {
      return { status: 'mock', reason: 'empty_projection' };
    }
    if (snapshot.payload.totalRuns === 0) {
      return { status: 'offline', reason: 'upstream_service_offline' };
    }
    return { status: 'live' };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe the insights data source by querying pattern_learning_artifacts (OMN-2924).
 * Live if at least one pattern artifact exists.
 *
 * The legacy learned_patterns table has been removed; canonical data source is now
 * pattern_learning_artifacts populated via the pattern-projection.v1 Kafka consumer.
 */
async function probeInsights(): Promise<DataSourceInfo> {
  try {
    const db = tryGetIntelligenceDb();
    if (!db) {
      return { status: 'mock', reason: 'no_db_connection' };
    }
    const result = await db.select({ total: count() }).from(patternLearningArtifacts);
    const total = result[0]?.total ?? 0;
    if (total === 0) {
      return { status: 'offline', reason: 'upstream_never_emitted' };
    }
    return { status: 'live' };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe the patterns projection.
 * Live if at least one pattern artifact exists (totalPatterns > 0).
 */
function probePatterns(): DataSourceInfo {
  try {
    const view = projectionService.getView<PatternsProjectionPayload>('patterns') as
      | PatternsProjection
      | undefined;
    if (!view) {
      return { status: 'mock', reason: 'no_projection_registered' };
    }
    const snapshot = view.getSnapshot();
    if (!snapshot) {
      return { status: 'mock', reason: 'empty_projection' };
    }
    if (snapshot.payload.totalPatterns === 0) {
      return { status: 'offline', reason: 'upstream_never_emitted' };
    }
    return { status: 'live' };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe the execution graph data source via the EventBusDataSource directly.
 * Live if at least one execution event has been stored.
 */
async function probeExecutionGraph(): Promise<DataSourceInfo> {
  try {
    const dataSource = getEventBusDataSource();
    if (!dataSource) {
      return { status: 'mock', reason: 'no_projection_registered' };
    }
    const rawEvents = await dataSource.queryEvents({
      // Match both canonical onex.evt.omniclaude.* topics (new producers) and
      // legacy flat topic names (existing DB rows stored before OMN-2760).
      event_types: [
        // Canonical omniclaude agent topics
        TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
        TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
        // Legacy flat topic names (match pre-OMN-2760 DB rows)
        'agent-actions',
        'agent-routing-decisions',
        'agent-transformation-events',
        // Payload event_type field values (producer-set, not topic-derived)
        'AGENT_ACTION',
        'ROUTING_DECISION',
        'AGENT_TRANSFORMATION',
      ],
      limit: 1,
      order_by: 'timestamp',
      order_direction: 'desc',
    });
    if (!rawEvents || rawEvents.length === 0) {
      return { status: 'mock', reason: 'no_execution_data' };
    }
    return { status: 'live' };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe the enforcement data source (OMN-2374).
 * Delegates to EnforcementProjection.probeRecentCount() which encapsulates
 * the DB query following the OMN-2325 architectural rule (no direct DB access
 * from route files). Returns live status with the count of enforcement events
 * in the last hour, or error/mock when the DB is unavailable.
 */
async function probeEnforcement(): Promise<DataSourceInfo> {
  try {
    const count = await enforcementProjection.probeRecentCount();
    if (count === null) {
      return { status: 'mock', reason: 'no_db_connection' };
    }
    return { status: 'live' };
  } catch (err) {
    console.error('[health] enforcement probe failed:', err);
    return { status: 'error', reason: 'db_query_failed' };
  }
}

/**
 * Probe the env→Infisical sync script (OMN-3216, OMN-5148).
 *
 * Status map:
 *   mock    — INFISICAL_ADDR not set (opt-out)
 *   offline — script not deployed, never run, or stale
 *   live    — script exists and last-run timestamp is within 1 hour
 *   error   — unexpected exception
 *
 * OMN-5148: Removed ENABLE_ENV_SYNC_PROBE gate. The probe is now always
 * active; when Infisical is disabled (INFISICAL_ADDR empty), it returns
 * 'mock' with reason 'infisical_disabled' which is then reclassified to
 * expected_idle_local in local dev by the OMN-5149 logic.
 */
function probeEnvSync(): DataSourceInfo {
  try {
    const infisicalAddr = process.env.INFISICAL_ADDR ?? '';
    if (!infisicalAddr.trim()) {
      return { status: 'not_applicable', reason: 'infisical_disabled' };
    }
    const infraDir = process.env.OMNIBASE_INFRA_DIR ?? '';
    const candidates = infraDir
      ? [`${infraDir}/scripts/sync-omnibase-env.py`]
      : [
          `${os.homedir()}/Code/omni_home/omnibase_infra/scripts/sync-omnibase-env.py`,
          '/Volumes/PRO-G40/Code/omni_home/omnibase_infra/scripts/sync-omnibase-env.py',
        ];
    if (!candidates.some((p) => fs.existsSync(p))) {
      return { status: 'offline', reason: 'sync_script_missing' };
    }
    const tsFile = `${os.homedir()}/.claude/sync-env-last-run`;
    if (!fs.existsSync(tsFile)) {
      return { status: 'offline', reason: 'sync_never_run' };
    }
    const lastRunSecs = parseFloat(fs.readFileSync(tsFile, 'utf-8').trim());
    const nowSecs = Date.now() / 1000;
    if (isNaN(lastRunSecs) || lastRunSecs < 0 || lastRunSecs > nowSecs + 60) {
      return { status: 'offline', reason: 'sync_never_run' };
    }
    if (nowSecs - lastRunSecs > ENV_SYNC_STALE_SECS) {
      return { status: 'offline', reason: 'sync_stale' };
    }
    return { status: 'live', lastEvent: new Date(lastRunSecs * 1000).toISOString() };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

/**
 * Probe topic subscription parity (OMN-4964, OMN-5155).
 *
 * Measures subscription parity: are we subscribed to everything in READ_MODEL_TOPICS?
 * Contract completeness (EXPECTED_TOPICS gaps) is reported as informational metadata,
 * not as health degradation.
 */
function probeTopicParity(): DataSourceInfo & {
  metadata?: { unsubscribed?: string[]; contractGaps?: string[] };
} {
  try {
    const stats = readModelConsumer.getStats();

    // If consumer is not running, that's a real problem
    if (!stats.isRunning) {
      return { status: 'offline', reason: 'consumer_not_running' };
    }

    const subscribedSet = new Set(Object.keys(stats.topicStats));

    // Primary check: subscription parity
    const unsubscribed: string[] = [];
    if (subscribedSet.size > 0) {
      for (const topic of READ_MODEL_TOPICS) {
        if (!subscribedSet.has(topic)) {
          unsubscribed.push(topic);
        }
      }
    }

    // Informational: contract gaps (not health degradation)
    const readModelSet = new Set(READ_MODEL_TOPICS as readonly string[]);
    const expectedSet = new Set(EXPECTED_TOPICS as readonly string[]);
    const contractGaps = [...expectedSet].filter((t) => !readModelSet.has(t));

    if (unsubscribed.length > 0) {
      return {
        status: 'offline',
        reason: `subscription_gap: ${unsubscribed.length} topics not subscribed`,
        metadata: { unsubscribed, ...(contractGaps.length > 0 ? { contractGaps } : {}) },
      };
    }

    return {
      status: 'live',
      lastEvent: new Date().toISOString(),
      ...(contractGaps.length > 0 ? { metadata: { contractGaps } } : {}),
    };
  } catch {
    return { status: 'error', reason: 'probe_threw' };
  }
}

// ============================================================================
// Router
// ============================================================================

const router = Router();

// Module-level TTL cache (30 s). Intentionally shared across all requests in
// the same process — there is no per-request or data-change invalidation. If
// upstream data changes mid-TTL, the cached response will be stale until
// expiry. This is acceptable: data source status changes infrequently and the
// 30 s window keeps the panel responsive during demos without hammering the DB.
//
// isError: true marks a short-TTL negative cache entry written when the outer
// catch fires (all probes failed unexpectedly). The 5 s TTL prevents a
// thundering herd of re-probes during a sustained infrastructure failure.
let healthCache: {
  result: DataSourcesHealthResponse;
  expiresAt: number;
  isError?: boolean;
} | null = null;

// Pending-probe singleton: when a probe run is already in flight, subsequent
// requests that arrive before the cache is populated await this promise instead
// of starting an independent probe run (thundering-herd guard).
let pendingProbe: Promise<DataSourcesHealthResponse> | null = null;

/**
 * Clear the health cache and the pending-probe singleton.
 * Exported for use in tests to prevent state leakage between test cases that
 * run in the same process.
 */
export function clearHealthCache(): void {
  healthCache = null;
  pendingProbe = null;
}

/**
 * GET /api/health/data-sources
 *
 * Returns a snapshot of every dashboard data source reporting whether it is
 * currently using live data or falling back to mock/demo data.
 */
router.get('/data-sources', async (_req, res) => {
  try {
    // Serve cached result if still fresh.
    // Cache-Control: no-store is applied to all response branches intentionally —
    // prevents browsers and proxies from caching this health payload regardless of branch.
    if (healthCache && Date.now() < healthCache.expiresAt) {
      res.set('Cache-Control', 'no-store');
      if (healthCache.isError) {
        // Cached failure — return 503 without re-probing until the short TTL expires.
        res.status(503).json({ error: 'Service temporarily unavailable' });
        return;
      }
      res.json(healthCache.result);
      return;
    }

    // Thundering-herd guard: if a probe run is already in flight, wait for it
    // and return from cache instead of starting an independent probe suite.
    if (pendingProbe !== null) {
      const result = await pendingProbe;
      res.set('Cache-Control', 'no-store');
      res.json(result);
      return;
    }

    // No cached result and no in-flight probe — start a new probe run and
    // store the promise so concurrent requests can attach to it.
    pendingProbe = (async (): Promise<DataSourcesHealthResponse> => {
      try {
        // Run all probes. Projection-based probes are synchronous; async probes
        // (insights, executionGraph, enforcement) are awaited via Promise.all.
        // All are called directly without HTTP self-calls.
        const [insights, executionGraph, enforcement] = await Promise.all([
          probeInsights(),
          probeExecutionGraph(),
          probeEnforcement(),
        ]);
        const validation = probeValidation();
        const patterns = probePatterns();

        // Probe the event bus once and reuse the result for correlationTrace, which
        // derives its live/mock status from the same event-bus projection.
        const eventBus = probeEventBus();

        const dataSources: Record<string, DataSourceInfo> = {
          eventBus,
          effectiveness: probeEffectiveness(),
          extraction: probeExtraction(),
          baselines: probeBaselines(),
          costTrends: probeCost(),
          intents: probeIntents(),
          nodeRegistry: probeNodeRegistry(),
          correlationTrace: { ...eventBus },
          validation,
          insights,
          patterns,
          executionGraph,
          enforcement,
          envSync: probeEnvSync(),
          topicParity: probeTopicParity(),
        };

        // OMN-5149: In local dev, reclassify known-idle sources from mock/offline
        // to expected_idle_local so the health panel doesn't alarm on expected gaps.
        const isLocal = isLocalEnvironment();
        if (isLocal) {
          for (const [key, info] of Object.entries(dataSources)) {
            if (
              LOCAL_IDLE_EXPECTED.has(key) &&
              (info.status === 'mock' || info.status === 'offline')
            ) {
              info.status = 'expected_idle_local';
              info.reason = info.reason
                ? `${info.reason} (expected idle in local dev)`
                : 'expected idle in local dev';
            }
          }
        }

        const counts = Object.values(dataSources).reduce(
          (acc, info) => {
            acc[info.status] = (acc[info.status] ?? 0) + 1;
            return acc;
          },
          { live: 0, mock: 0, error: 0, offline: 0, expected_idle_local: 0, not_applicable: 0 } as {
            live: number;
            mock: number;
            error: number;
            offline: number;
            expected_idle_local: number;
            not_applicable: number;
          }
        );

        const body: DataSourcesHealthResponse = {
          dataSources,
          summary: counts,
          checkedAt: new Date().toISOString(),
        };

        healthCache = { result: body, expiresAt: Date.now() + 30_000 };
        return body;
      } finally {
        // Always clear the pending-probe singleton so the next request after
        // TTL expiry can start a fresh probe run (even if this run threw).
        pendingProbe = null;
      }
    })();

    const body = await pendingProbe;
    res.set('Cache-Control', 'no-store');
    res.json(body);
  } catch {
    // Short negative cache to prevent a thundering herd of re-probes on
    // sustained failure. 5 s TTL vs the normal 30 s for successful results.
    //
    // Note: pendingProbe is already null here (cleared in the IIFE's finally)
    // — a concurrent request arriving in this narrow window starts a fresh
    // probe run rather than attaching to the error cache; this is acceptable
    // as the window is sub-millisecond.
    healthCache = {
      result: {} as DataSourcesHealthResponse,
      expiresAt: Date.now() + 5_000,
      isError: true,
    };
    res.set('Cache-Control', 'no-store');
    res.status(503).json({ error: 'Service temporarily unavailable' });
  }
});

export default router;
