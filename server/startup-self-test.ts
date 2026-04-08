// no-migration: OMN-4974 startup self-test, no schema change
/**
 * Startup Self-Test (OMN-4974)
 *
 * Runs once at boot after `warmAll()` completes. Checks all 14 data sources
 * and logs exactly 14 `[self-test]` lines reporting LIVE/EMPTY/ERROR status.
 *
 * Empty sources include a hint referencing DATA_SOURCE_DEPENDENCIES.md so
 * operators know which upstream service to run.
 *
 * Results are cached and exposed via GET /api/health/self-test (registered
 * in routes.ts or index.ts after server.listen).
 *
 * Non-blocking: runs async and never prevents the server from accepting
 * requests. Failures are logged but silently swallowed.
 */

import { Router } from 'express';
import { projectionService, enforcementProjection } from './projection-bootstrap';
import { tryGetIntelligenceDb } from './storage';
import { patternLearningArtifacts } from '@shared/intelligence-schema';
import { count } from 'drizzle-orm';
import { getEventBusDataSource } from './event-bus-data-source';
import { readModelConsumer } from './read-model-consumer';
import { READ_MODEL_TOPICS } from './read-model-consumer';
import { EXPECTED_TOPICS } from './event-bus-health-poller';
import {
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
} from '../shared/topics';

import type { EventBusPayload } from '@shared/event-bus-payload';
import type { IntentProjectionPayload, NodeRegistryPayload } from '@shared/projection-types';
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
import type {
  ValidationProjection,
  ValidationProjectionPayload,
} from './projections/validation-projection';
import type {
  PatternsProjection,
  PatternsProjectionPayload,
} from './projections/patterns-projection';
import type { LlmRoutingPayload } from './projections/llm-routing-projection';

// ============================================================================
// Types
// ============================================================================

export type SelfTestStatus = 'LIVE' | 'EMPTY' | 'ERROR';

export interface SelfTestEntry {
  source: string;
  status: SelfTestStatus;
  detail: string;
  hint?: string;
}

export interface SelfTestReport {
  entries: SelfTestEntry[];
  summary: { live: number; empty: number; error: number };
  ranAt: string;
}

// ============================================================================
// Hints (reference DATA_SOURCE_DEPENDENCIES.md)
// ============================================================================

const DEPS_DOC = 'docs/DATA_SOURCE_DEPENDENCIES.md';

const HINTS: Record<string, string> = {
  eventBus: `Start Kafka consumer and ensure events are flowing. See ${DEPS_DOC} "Always-Live Pages".`,
  effectiveness: `Run an omniintelligence session to emit intent-classified events. See ${DEPS_DOC} "Always-Live Pages".`,
  extraction: `Run an omniintelligence session to emit pattern events. See ${DEPS_DOC} "Always-Live Pages".`,
  baselines: `Run the baselines compute skill. See ${DEPS_DOC} "Baselines Activation".`,
  costTrends: `Ensure LLM routing decisions are flowing. See ${DEPS_DOC} "Always-Live Pages".`,
  intents: `Run an omniintelligence session to classify intents. See ${DEPS_DOC} "Always-Live Pages".`,
  nodeRegistry: `Start the ONEX runtime to register nodes. See ${DEPS_DOC} "Always-Live Pages".`,
  correlationTrace: `Same as eventBus — events must be flowing. See ${DEPS_DOC} "Always-Live Pages".`,
  validation: `Trigger a validation run via runtime API. See ${DEPS_DOC} "Runtime-Effect Pages".`,
  insights: `Run an omniintelligence session to emit pattern artifacts. See ${DEPS_DOC} "Always-Live Pages".`,
  patterns: `Run an omniintelligence session to discover patterns. See ${DEPS_DOC} "Always-Live Pages".`,
  executionGraph: `Ensure agent-actions events are flowing. See ${DEPS_DOC} "Always-Live Pages".`,
  enforcement: `Ensure pattern enforcement events are flowing. See ${DEPS_DOC} "Always-Live Pages".`,
  topicParity: `Check READ_MODEL_TOPICS matches EXPECTED_TOPICS. See ${DEPS_DOC} "Architecture Notes".`,
};

// ============================================================================
// Probe functions (mirror health-data-sources-routes.ts)
// ============================================================================

function probeEventBus(): SelfTestEntry {
  try {
    const view = projectionService.getView<EventBusPayload>('event-bus');
    if (!view)
      return {
        source: 'eventBus',
        status: 'EMPTY',
        detail: 'no projection registered',
        hint: HINTS.eventBus,
      };
    const snapshot = view.getSnapshot();
    if (!snapshot?.payload || snapshot.payload.totalEventsIngested === 0) {
      return {
        source: 'eventBus',
        status: 'EMPTY',
        detail: 'no events ingested',
        hint: HINTS.eventBus,
      };
    }
    return {
      source: 'eventBus',
      status: 'LIVE',
      detail: `${snapshot.payload.totalEventsIngested} events`,
    };
  } catch (err) {
    return { source: 'eventBus', status: 'ERROR', detail: String(err) };
  }
}

function probeEffectiveness(): SelfTestEntry {
  try {
    const view = projectionService.getView<EffectivenessMetricsPayload>('effectiveness-metrics') as
      | EffectivenessMetricsProjection
      | undefined;
    if (!view)
      return {
        source: 'effectiveness',
        status: 'EMPTY',
        detail: 'no projection registered',
        hint: HINTS.effectiveness,
      };
    const snapshot = view.getSnapshot();
    const summary = snapshot?.payload?.summary;
    if (!summary || summary.total_sessions === 0) {
      return {
        source: 'effectiveness',
        status: 'EMPTY',
        detail: 'no sessions',
        hint: HINTS.effectiveness,
      };
    }
    return {
      source: 'effectiveness',
      status: 'LIVE',
      detail: `${summary.total_sessions} sessions`,
    };
  } catch (err) {
    return { source: 'effectiveness', status: 'ERROR', detail: String(err) };
  }
}

function probeExtraction(): SelfTestEntry {
  try {
    const view = projectionService.getView<ExtractionMetricsPayload>('extraction-metrics') as
      | ExtractionMetricsProjection
      | undefined;
    if (!view)
      return {
        source: 'extraction',
        status: 'EMPTY',
        detail: 'no projection registered',
        hint: HINTS.extraction,
      };
    const snapshot = view.getSnapshot();
    const summary = snapshot?.payload?.summary;
    if (!summary || summary.last_event_at == null) {
      return { source: 'extraction', status: 'EMPTY', detail: 'no events', hint: HINTS.extraction };
    }
    return { source: 'extraction', status: 'LIVE', detail: `last event: ${summary.last_event_at}` };
  } catch (err) {
    return { source: 'extraction', status: 'ERROR', detail: String(err) };
  }
}

function probeBaselines(): SelfTestEntry {
  try {
    const view = projectionService.getView<BaselinesPayload>('baselines') as
      | BaselinesProjection
      | undefined;
    if (!view)
      return {
        source: 'baselines',
        status: 'EMPTY',
        detail: 'no projection registered',
        hint: HINTS.baselines,
      };
    const snapshot = view.getSnapshot();
    if (!snapshot?.payload || snapshot.payload.summary.total_comparisons === 0) {
      return {
        source: 'baselines',
        status: 'EMPTY',
        detail: 'upstream never emitted',
        hint: HINTS.baselines,
      };
    }
    return {
      source: 'baselines',
      status: 'LIVE',
      detail: `${snapshot.payload.summary.total_comparisons} comparisons`,
    };
  } catch (err) {
    return { source: 'baselines', status: 'ERROR', detail: String(err) };
  }
}

function probeCostTrends(): SelfTestEntry {
  try {
    const view = projectionService.getView<CostMetricsPayload>('cost-metrics') as
      | CostMetricsProjection
      | undefined;
    if (!view)
      return {
        source: 'costTrends',
        status: 'EMPTY',
        detail: 'no projection registered',
        hint: HINTS.costTrends,
      };
    const snapshot = view.getSnapshot();
    const summary = snapshot?.payload?.summary;
    if (summary && (summary.session_count > 0 || summary.total_tokens > 0)) {
      return { source: 'costTrends', status: 'LIVE', detail: `${summary.session_count} sessions` };
    }
    // Check llm-routing as proxy
    const llmView = projectionService.getView<LlmRoutingPayload>('llm-routing');
    if (llmView) {
      const llmSnapshot = llmView.getSnapshot();
      if (llmSnapshot?.payload && llmSnapshot.payload.summary.total_decisions > 0) {
        return { source: 'costTrends', status: 'LIVE', detail: 'via llm-routing proxy' };
      }
    }
    return {
      source: 'costTrends',
      status: 'EMPTY',
      detail: 'upstream never emitted',
      hint: HINTS.costTrends,
    };
  } catch (err) {
    return { source: 'costTrends', status: 'ERROR', detail: String(err) };
  }
}

function probeIntents(): SelfTestEntry {
  try {
    const view = projectionService.getView<IntentProjectionPayload>('intent-db');
    if (!view)
      return {
        source: 'intents',
        status: 'EMPTY',
        detail: 'no projection registered',
        hint: HINTS.intents,
      };
    const snapshot = view.getSnapshot();
    if (!snapshot?.payload || snapshot.payload.totalIntents === 0) {
      return {
        source: 'intents',
        status: 'EMPTY',
        detail: 'no intents classified',
        hint: HINTS.intents,
      };
    }
    return {
      source: 'intents',
      status: 'LIVE',
      detail: `${snapshot.payload.totalIntents} intents`,
    };
  } catch (err) {
    return { source: 'intents', status: 'ERROR', detail: String(err) };
  }
}

function probeNodeRegistry(): SelfTestEntry {
  try {
    const view = projectionService.getView<NodeRegistryPayload>('node-registry-db');
    if (!view)
      return {
        source: 'nodeRegistry',
        status: 'EMPTY',
        detail: 'no projection registered',
        hint: HINTS.nodeRegistry,
      };
    const snapshot = view.getSnapshot();
    if (!snapshot?.payload || snapshot.payload.stats.totalNodes === 0) {
      return {
        source: 'nodeRegistry',
        status: 'EMPTY',
        detail: 'no nodes registered',
        hint: HINTS.nodeRegistry,
      };
    }
    return {
      source: 'nodeRegistry',
      status: 'LIVE',
      detail: `${snapshot.payload.stats.totalNodes} nodes`,
    };
  } catch (err) {
    return { source: 'nodeRegistry', status: 'ERROR', detail: String(err) };
  }
}

function probeCorrelationTrace(): SelfTestEntry {
  // Delegates to eventBus probe — correlationTrace is derived from the same projection
  const result = probeEventBus();
  return {
    ...result,
    source: 'correlationTrace',
    hint: result.hint ? HINTS.correlationTrace : undefined,
  };
}

function probeValidation(): SelfTestEntry {
  try {
    const view = projectionService.getView<ValidationProjectionPayload>('validation') as
      | ValidationProjection
      | undefined;
    if (!view)
      return {
        source: 'validation',
        status: 'EMPTY',
        detail: 'no projection registered',
        hint: HINTS.validation,
      };
    const snapshot = view.getSnapshot();
    if (!snapshot?.payload || snapshot.payload.totalRuns === 0) {
      return {
        source: 'validation',
        status: 'EMPTY',
        detail: 'upstream never emitted',
        hint: HINTS.validation,
      };
    }
    return { source: 'validation', status: 'LIVE', detail: `${snapshot.payload.totalRuns} runs` };
  } catch (err) {
    return { source: 'validation', status: 'ERROR', detail: String(err) };
  }
}

async function probeInsights(): Promise<SelfTestEntry> {
  try {
    const db = tryGetIntelligenceDb();
    if (!db)
      return {
        source: 'insights',
        status: 'EMPTY',
        detail: 'no DB connection',
        hint: HINTS.insights,
      };
    const result = await db.select({ total: count() }).from(patternLearningArtifacts);
    const total = result[0]?.total ?? 0;
    if (total === 0) {
      return {
        source: 'insights',
        status: 'EMPTY',
        detail: 'upstream never emitted',
        hint: HINTS.insights,
      };
    }
    return { source: 'insights', status: 'LIVE', detail: `${total} artifacts` };
  } catch (err) {
    return { source: 'insights', status: 'ERROR', detail: String(err) };
  }
}

function probePatterns(): SelfTestEntry {
  try {
    const view = projectionService.getView<PatternsProjectionPayload>('patterns') as
      | PatternsProjection
      | undefined;
    if (!view)
      return {
        source: 'patterns',
        status: 'EMPTY',
        detail: 'no projection registered',
        hint: HINTS.patterns,
      };
    const snapshot = view.getSnapshot();
    if (!snapshot?.payload || snapshot.payload.totalPatterns === 0) {
      return {
        source: 'patterns',
        status: 'EMPTY',
        detail: 'upstream never emitted',
        hint: HINTS.patterns,
      };
    }
    return {
      source: 'patterns',
      status: 'LIVE',
      detail: `${snapshot.payload.totalPatterns} patterns`,
    };
  } catch (err) {
    return { source: 'patterns', status: 'ERROR', detail: String(err) };
  }
}

async function probeExecutionGraph(): Promise<SelfTestEntry> {
  try {
    const dataSource = getEventBusDataSource();
    if (!dataSource)
      return {
        source: 'executionGraph',
        status: 'EMPTY',
        detail: 'no data source',
        hint: HINTS.executionGraph,
      };
    const rawEvents = await dataSource.queryEvents({
      event_types: [
        TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
        TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
        'agent-actions',
        'agent-routing-decisions',
        'agent-transformation-events',
        'AGENT_ACTION',
        'ROUTING_DECISION',
        'AGENT_TRANSFORMATION',
      ],
      limit: 1,
      order_by: 'timestamp',
      order_direction: 'desc',
    });
    if (!rawEvents || rawEvents.length === 0) {
      return {
        source: 'executionGraph',
        status: 'EMPTY',
        detail: 'no execution data',
        hint: HINTS.executionGraph,
      };
    }
    return { source: 'executionGraph', status: 'LIVE', detail: 'execution events found' };
  } catch (err) {
    return { source: 'executionGraph', status: 'ERROR', detail: String(err) };
  }
}

async function probeEnforcement(): Promise<SelfTestEntry> {
  try {
    const cnt = await enforcementProjection.probeRecentCount();
    if (cnt === null) {
      return {
        source: 'enforcement',
        status: 'EMPTY',
        detail: 'no DB connection',
        hint: HINTS.enforcement,
      };
    }
    return { source: 'enforcement', status: 'LIVE', detail: `${cnt} recent events` };
  } catch (err) {
    return { source: 'enforcement', status: 'ERROR', detail: String(err) };
  }
}

function probeTopicParity(): SelfTestEntry {
  try {
    const readModelSet = new Set(READ_MODEL_TOPICS as readonly string[]);
    const expectedSet = new Set(EXPECTED_TOPICS as readonly string[]);
    const stats = readModelConsumer.getStats();
    const subscribedSet = new Set(Object.keys(stats.topicStats));

    const expectedNotSubscribed = [...expectedSet].filter((t) => !readModelSet.has(t));
    const failedToSubscribe: string[] = [];
    if (stats.isRunning && subscribedSet.size > 0) {
      for (const topic of READ_MODEL_TOPICS) {
        if (!subscribedSet.has(topic)) failedToSubscribe.push(topic);
      }
    }
    const missing = [...expectedNotSubscribed, ...failedToSubscribe].sort();
    if (missing.length === 0) {
      return { source: 'topicParity', status: 'LIVE', detail: 'all topics aligned' };
    }
    return {
      source: 'topicParity',
      status: 'EMPTY',
      detail: `${missing.length} topics missing`,
      hint: HINTS.topicParity,
    };
  } catch (err) {
    return { source: 'topicParity', status: 'ERROR', detail: String(err) };
  }
}

// ============================================================================
// Self-test runner
// ============================================================================

/** Cached report from the latest self-test run. */
let latestReport: SelfTestReport | null = null;

/**
 * Run all 14 data source probes and log results.
 * Designed to be called once at startup after warmAll() completes.
 * Non-blocking: exceptions are caught and logged, never thrown.
 */
export async function runStartupSelfTest(): Promise<SelfTestReport> {
  const syncEntries: SelfTestEntry[] = [
    probeEventBus(),
    probeEffectiveness(),
    probeExtraction(),
    probeBaselines(),
    probeCostTrends(),
    probeIntents(),
    probeNodeRegistry(),
    probeCorrelationTrace(),
    probeValidation(),
    probePatterns(),
    probeTopicParity(),
  ];

  const [insights, executionGraph, enforcement] = await Promise.all([
    probeInsights(),
    probeExecutionGraph(),
    probeEnforcement(),
  ]);

  const entries: SelfTestEntry[] = [...syncEntries, insights, executionGraph, enforcement];

  // Log exactly 14 lines
  for (const entry of entries) {
    const hintSuffix = entry.hint ? ` -- ${entry.hint}` : '';
    console.log(`[self-test] ${entry.source}: ${entry.status} (${entry.detail})${hintSuffix}`);
  }

  const summary = entries.reduce(
    (acc, e) => {
      if (e.status === 'LIVE') acc.live++;
      else if (e.status === 'EMPTY') acc.empty++;
      else acc.error++;
      return acc;
    },
    { live: 0, empty: 0, error: 0 }
  );

  console.log(
    `[self-test] Summary: ${summary.live} LIVE, ${summary.empty} EMPTY, ${summary.error} ERROR (${entries.length} sources)`
  );

  const report: SelfTestReport = {
    entries,
    summary,
    ranAt: new Date().toISOString(),
  };

  latestReport = report;
  return report;
}

/**
 * Return the latest self-test report (or null if never run).
 */
export function getLatestSelfTestReport(): SelfTestReport | null {
  return latestReport;
}

// ============================================================================
// Router: GET /api/health/self-test
// ============================================================================

const router = Router();

/**
 * GET /api/health/self-test
 *
 * Returns the latest startup self-test report as JSON.
 * Returns 503 if the self-test has not run yet.
 */
router.get('/self-test', (_req, res) => {
  const report = getLatestSelfTestReport();
  if (!report) {
    res.status(503).json({ error: 'Self-test has not run yet' });
    return;
  }
  res.json(report);
});

export default router;
