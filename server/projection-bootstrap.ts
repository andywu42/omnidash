// no-migration: OMN-4957 event wiring change only, no schema change
/**
 * Projection Bootstrap — Wire Event Sources to ProjectionService (OMN-2095)
 *
 * Creates the ProjectionService singleton, registers views, and wires
 * EventBusDataSource so that every Kafka event is routed through the
 * projection pipeline.
 *
 * Call `wireProjectionSources()` after EventBusDataSource has started
 * to begin live ingestion.
 */

import { ProjectionService, type RawEventInput } from './projection-service';
import { EventBusProjection } from './projections/event-bus-projection';
import { ExtractionMetricsProjection } from './projections/extraction-metrics-projection';
import { EffectivenessMetricsProjection } from './projections/effectiveness-metrics-projection';
import { CostMetricsProjection } from './projections/cost-metrics-projection';
import { BaselinesProjection } from './projections/baselines-projection';
import { ValidationProjection } from './projections/validation-projection';
import { PatternsProjection } from './projections/patterns-projection';
import { EnrichmentProjection } from './projections/enrichment-projection';
import { EnforcementProjection } from './projections/enforcement-projection';
import { LlmRoutingProjection } from './projections/llm-routing-projection';
import { DelegationProjection } from './projections/delegation-projection';
import { AgentRoutingProjection } from './projections/agent-routing-projection';
// Wave 2 projections (OMN-2602)
import { GateDecisionsProjection } from './projections/gate-decisions-projection';
// Plan reviewer projection (OMN-3324)
import { PlanReviewerProjection } from './projections/plan-reviewer-projection';
// DoD verification projection (OMN-5200)
import { DodProjection } from './projections/dod-projection';
import { EpicRunProjection } from './projections/epic-run-projection';
import { PrWatchProjection } from './projections/pr-watch-projection';
import { PipelineBudgetProjection } from './projections/pipeline-budget-projection';
import { DebugEscalationProjection } from './projections/debug-escalation-projection';
import { CiIntelProjection } from './projections/ci-intel-projection';
import { PatternLifecycleProjection } from './projections/pattern-lifecycle-projection';
// LLM Health projection (OMN-5279)
import { LlmHealthProjection } from './projections/llm-health-projection';
// Routing Feedback projection (OMN-5284)
import { RoutingFeedbackProjection } from './projections/routing-feedback-projection';
// Compliance projection (OMN-5285)
import { ComplianceProjection } from './projections/compliance-projection';
// Context Effectiveness projection (OMN-5286)
import { ContextEffectivenessProjection } from './projections/context-effectiveness-projection';
// OmniMemory projection (OMN-5290)
import { MemoryProjection } from './projections/memory-projection';
// Skill invocation projection (OMN-5278)
import { SkillProjection } from './projections/skill-projection';
import { HostileReviewerProjection } from './projections/hostile-reviewer-projection';
// Review calibration projection (OMN-6176)
import { ReviewCalibrationProjection } from './projections/review-calibration-projection';
// Agent metrics projection (OMN-7132) — replaces EventConsumer in-memory metrics
import { AgentMetricsProjection } from './projections/agent-metrics-projection';
// Infra routing decision projection (OMN-7447)
import { InfraRoutingProjection } from './projections/infra-routing-projection';
// Node registry DB-backed projection (OMN-7127)
import { NodeRegistryDbProjection } from './projections/node-registry-db-projection';
// Intent DB-backed projection (OMN-7129)
import { IntentDbProjection } from './projections/intent-db-projection';
import { eventBusDataSource } from './event-bus-data-source';
import { extractActionFromTopic, extractProducerFromTopicOrDefault } from '@shared/topics';
import { enrichmentPipeline } from './projections/event-enrichment-handlers';

// ============================================================================
// Singleton instances
// ============================================================================

/**
 * Application-wide ProjectionService singleton. Manages view registration,
 * cursor assignment, and event fan-out to all registered projection views.
 */
export const projectionService = new ProjectionService();

/**
 * EventBusProjection singleton. Maintains the materialized view consumed
 * by the `/api/projections/event-bus` endpoint and the EventBusMonitor page.
 * Registered into projectionService at module load time.
 */
// Uses DEFAULT_BURST_CONFIG from event-bus-projection.ts (single source of truth).
// No config override needed — the exported defaults are canonical.
export const eventBusProjection = new EventBusProjection();

// Register views (runs at import time — module-level side effect).
//
// Idempotent guard: if the module is re-evaluated (e.g. test runner
// resetModules with the same singleton in scope), skip re-registration
// instead of throwing "already registered".
//
// Module-caching dependency: This pattern relies on Node.js evaluating the
// module once and caching the result. All importers (routes.ts, websocket.ts,
// index.ts) receive the same `projectionService` and `eventBusProjection`
// instances. If module caching breaks (symlink aliasing, path mismatches, or
// test runners with `resetModules`), separate instances could be created.
// The idempotent guard above prevents duplicate registration errors but does
// NOT prevent the scenario where a second `projectionService` instance exists
// with no views. Importers should always use the exports from this module
// rather than constructing their own instances.
if (!projectionService.getView(eventBusProjection.viewId)) {
  projectionService.registerView(eventBusProjection);
}

/**
 * DB-backed projection singletons (OMN-2325).
 * These views query PostgreSQL on getSnapshot() with TTL-based caching,
 * unlike event-driven views that build state from Kafka events.
 *
 * OMN-4965: Both ExtractionMetricsProjection and EffectivenessMetricsProjection
 * extend DbBackedProjectionView, which auto-registers each instance in the
 * static `instances` Set via the constructor. The warmAll() call at server
 * startup (OMN-4958) eagerly populates their caches so the first API request
 * returns real data instead of emptyPayload(). This eliminates the cold-cache
 * race condition that previously caused /effectiveness and /extraction to
 * return empty results on fresh restarts.
 */
export const extractionMetricsProjection = new ExtractionMetricsProjection();
export const effectivenessMetricsProjection = new EffectivenessMetricsProjection();
/** Cost trend projection (OMN-2300). Queries llm_cost_aggregates table. */
export const costMetricsProjection = new CostMetricsProjection();
/** Baselines & ROI projection (OMN-2331). Queries baselines_* tables. */
export const baselinesProjection = new BaselinesProjection();
/** Validation dashboard projection. Queries validation-related tables. */
export const validationProjection = new ValidationProjection();
/** Patterns dashboard projection. Queries pattern discovery tables. */
export const patternsProjection = new PatternsProjection();
/** Context enrichment projection (OMN-2373). Queries context_enrichment_events table. */
export const enrichmentProjection = new EnrichmentProjection();
/** Pattern enforcement projection (OMN-2374). Queries pattern_enforcement_events table. */
export const enforcementProjection = new EnforcementProjection();
/** LLM routing effectiveness projection (OMN-2372). Queries llm_routing_decisions table. */
export const llmRoutingProjection = new LlmRoutingProjection();
/**
 * Delegation dashboard projection (OMN-2650). Queries delegation_events and
 * delegation_shadow_comparisons tables. Standalone — NOT registered with
 * ProjectionService (no fanout, no WS invalidation, no ingest pipeline).
 */
export const delegationProjection = new DelegationProjection();
/** Agent routing projection (OMN-2750). Queries agent_routing_decisions table. */
export const agentRoutingProjection = new AgentRoutingProjection();
// Wave 2 projections (OMN-2602)
/** Gate decisions projection. Queries gate_decisions table. */
export const gateDecisionsProjection = new GateDecisionsProjection();
/** Epic run projection. Queries epic_run_events + epic_run_lease tables. */
export const epicRunProjection = new EpicRunProjection();
/** PR watch projection. Queries pr_watch_state table. */
export const prWatchProjection = new PrWatchProjection();
/** Pipeline budget projection. Queries pipeline_budget_state table. */
export const pipelineBudgetProjection = new PipelineBudgetProjection();
/** Debug escalation projection. Queries debug_escalation_counts table. */
export const debugEscalationProjection = new DebugEscalationProjection();
/** CI Intelligence projection (OMN-5282). Queries ci_debug_escalation_events table. */
export const ciIntelProjection = new CiIntelProjection();
/** Pattern Lifecycle projection (OMN-5283). Queries pattern_lifecycle_transitions table. */
export const patternLifecycleProjection = new PatternLifecycleProjection();
/**
 * Plan reviewer projection (OMN-3324). Queries plan_review_runs table.
 * Standalone — NOT registered with ProjectionService (no fanout, no WS
 * invalidation, no ingest pipeline).
 */
export const planReviewerProjection = new PlanReviewerProjection();
/** DoD verification projection (OMN-5200). Queries dod_verify_runs + dod_guard_events tables. */
export const dodProjection = new DodProjection();
/** LLM endpoint health projection (OMN-5279). Queries llm_health_snapshots table. */
export const llmHealthProjection = new LlmHealthProjection();
/** Routing feedback projection (OMN-5284). Queries routing_feedback_events table. */
export const routingFeedbackProjection = new RoutingFeedbackProjection();
/** Compliance evaluation projection (OMN-5285). Queries compliance_evaluations table. */
export const complianceProjection = new ComplianceProjection();
/** Context effectiveness projection (OMN-5286). Queries injection_effectiveness table. */
export const contextEffectivenessProjection = new ContextEffectivenessProjection();
/** OmniMemory projection (OMN-5290). Queries memory_documents and memory_retrievals tables. */
export const memoryProjection = new MemoryProjection();
/** Skill invocation projection (OMN-5278). Queries skill_invocations table. */
export const skillProjection = new SkillProjection();
/** Hostile reviewer projection (OMN-5864). Queries hostile_reviewer_runs table. */
export const hostileReviewerProjection = new HostileReviewerProjection();
/** Review calibration projection (OMN-6176). Queries review_calibration_runs_rm table. */
export const reviewCalibrationProjection = new ReviewCalibrationProjection();
/** Node registry DB-backed projection (OMN-7127). Queries node_service_registry table. */
export const nodeRegistryDbProjection = new NodeRegistryDbProjection();
/** Intent DB-backed projection (OMN-7129). Queries intent_signals table. */
export const intentDbProjection = new IntentDbProjection();
/** Agent metrics projection (OMN-7132). Replaces EventConsumer in-memory agent metrics. */
export const agentMetricsProjection = new AgentMetricsProjection();
/** Infra routing decision projection (OMN-7447). Queries infra_routing_decisions table. */
export const infraRoutingProjection = new InfraRoutingProjection();

if (!projectionService.getView(extractionMetricsProjection.viewId)) {
  projectionService.registerView(extractionMetricsProjection);
}
if (!projectionService.getView(effectivenessMetricsProjection.viewId)) {
  projectionService.registerView(effectivenessMetricsProjection);
}
if (!projectionService.getView(costMetricsProjection.viewId)) {
  projectionService.registerView(costMetricsProjection);
}
if (!projectionService.getView(baselinesProjection.viewId)) {
  projectionService.registerView(baselinesProjection);
}
if (!projectionService.getView(validationProjection.viewId)) {
  projectionService.registerView(validationProjection);
}
if (!projectionService.getView(patternsProjection.viewId)) {
  projectionService.registerView(patternsProjection);
}
if (!projectionService.getView(enrichmentProjection.viewId)) {
  projectionService.registerView(enrichmentProjection);
}
if (!projectionService.getView(enforcementProjection.viewId)) {
  projectionService.registerView(enforcementProjection);
}
if (!projectionService.getView(llmRoutingProjection.viewId)) {
  projectionService.registerView(llmRoutingProjection);
}
if (!projectionService.getView(agentRoutingProjection.viewId)) {
  projectionService.registerView(agentRoutingProjection);
}
// Wave 2 registrations (OMN-2602)
if (!projectionService.getView(gateDecisionsProjection.viewId)) {
  projectionService.registerView(gateDecisionsProjection);
}
if (!projectionService.getView(epicRunProjection.viewId)) {
  projectionService.registerView(epicRunProjection);
}
if (!projectionService.getView(prWatchProjection.viewId)) {
  projectionService.registerView(prWatchProjection);
}
if (!projectionService.getView(pipelineBudgetProjection.viewId)) {
  projectionService.registerView(pipelineBudgetProjection);
}
if (!projectionService.getView(debugEscalationProjection.viewId)) {
  projectionService.registerView(debugEscalationProjection);
}
if (!projectionService.getView(ciIntelProjection.viewId)) {
  projectionService.registerView(ciIntelProjection);
}
if (!projectionService.getView(patternLifecycleProjection.viewId)) {
  projectionService.registerView(patternLifecycleProjection);
}
if (!projectionService.getView(llmHealthProjection.viewId)) {
  projectionService.registerView(llmHealthProjection);
}
if (!projectionService.getView(routingFeedbackProjection.viewId)) {
  projectionService.registerView(routingFeedbackProjection);
}
if (!projectionService.getView(complianceProjection.viewId)) {
  projectionService.registerView(complianceProjection);
}
if (!projectionService.getView(contextEffectivenessProjection.viewId)) {
  projectionService.registerView(contextEffectivenessProjection);
}
if (!projectionService.getView(memoryProjection.viewId)) {
  projectionService.registerView(memoryProjection);
}
if (!projectionService.getView(skillProjection.viewId)) {
  projectionService.registerView(skillProjection);
}
if (!projectionService.getView(hostileReviewerProjection.viewId)) {
  projectionService.registerView(hostileReviewerProjection);
}
if (!projectionService.getView(reviewCalibrationProjection.viewId)) {
  projectionService.registerView(reviewCalibrationProjection);
}
if (!projectionService.getView(nodeRegistryDbProjection.viewId)) {
  projectionService.registerView(nodeRegistryDbProjection);
}
if (!projectionService.getView(intentDbProjection.viewId)) {
  projectionService.registerView(intentDbProjection);
}
if (!projectionService.getView(agentMetricsProjection.viewId)) {
  projectionService.registerView(agentMetricsProjection);
}
if (!projectionService.getView(infraRoutingProjection.viewId)) {
  projectionService.registerView(infraRoutingProjection);
}

// ============================================================================
// Event source wiring
// ============================================================================

/** Cleanup function returned by wireProjectionSources to remove listeners. */
export type ProjectionSourceCleanup = () => void;

/**
 * Wire EventBusDataSource to the ProjectionService.
 *
 * EventBusDataSource provides full Kafka topic coverage. Each event is
 * enriched, mapped to a RawEventInput, and ingested into the projection
 * pipeline for fan-out to all registered views.
 *
 * @returns Cleanup function that removes all registered listeners.
 *          Call on shutdown or before re-wiring to prevent listener leaks.
 */
export function wireProjectionSources(): ProjectionSourceCleanup {
  if (projectionService.viewCount === 0) {
    console.warn(
      '[projection] WARNING: projectionService has no registered views — possible module caching issue'
    );
  }

  const cleanups: Array<() => void> = [];
  let wired = false;

  if (typeof eventBusDataSource.on === 'function') {
    const handleDataSourceEvent = (event: Record<string, unknown>): void => {
      try {
        const eventId = event.event_id as string | undefined;

        let payload: Record<string, unknown>;
        const rawPayload = event.payload;
        if (rawPayload != null && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
          payload = rawPayload as Record<string, unknown>;
        } else {
          payload = { value: rawPayload };
        }

        const topic = (event.topic as string) || '';
        const rawType = (event.event_type as string) || '';
        const rawSource = (event.source as string) || '';

        const type = rawType || extractActionFromTopic(topic);
        const source =
          rawSource && rawSource !== 'unknown'
            ? rawSource
            : extractProducerFromTopicOrDefault(topic);

        const raw: RawEventInput = {
          id: eventId,
          topic,
          type,
          source,
          severity: mapSeverity(payload),
          payload,
          eventTimeMs: extractTimestamp(event),
          enrichment: enrichmentPipeline.run(payload, type, topic),
        };

        projectionService.ingest(raw);
      } catch (err) {
        console.error('[projection] EventBusDataSource event handler error:', err);
      }
    };

    eventBusDataSource.on('event', handleDataSourceEvent);
    cleanups.push(() => {
      if (typeof eventBusDataSource.removeListener === 'function') {
        eventBusDataSource.removeListener('event', handleDataSourceEvent);
      }
    });
    wired = true;
  } else {
    console.warn('[projection] EventBusDataSource.on not available — skipping wiring');
  }

  if (wired) {
    console.log(
      '[projection] Wired to EventBusDataSource. Views:',
      projectionService.viewIds.join(', ')
    );
  } else {
    console.warn('[projection] No event sources available — projections will be empty');
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
    console.log('[projection] Removed all event source listeners');
  };
}

// ============================================================================
// Helpers
// ============================================================================

function mapSeverity(data: Record<string, unknown>): 'info' | 'warning' | 'error' | 'critical' {
  const severity = data.severity || data.priority;
  if (severity === 'critical') return 'critical';
  if (severity === 'error') return 'error';
  if (severity === 'warning' || severity === 'high') return 'warning';
  return 'info';
}

function extractTimestamp(data: Record<string, unknown>): number | undefined {
  // Canonical field name (omnibase_core ModelEventEnvelope) is checked first.
  // Legacy names are kept as fallbacks for older event shapes.
  const ts =
    data.envelope_timestamp ||
    data.emitted_at ||
    data.timestamp ||
    data.createdAt ||
    data.created_at;
  if (typeof ts === 'number' && ts > 0) return ts;
  if (typeof ts === 'string' && ts.length > 0) {
    const parsed = new Date(ts).getTime();
    return isNaN(parsed) ? undefined : parsed;
  }
  // Handle Date objects (e.g., from pre-parsed envelope timestamps)
  if (ts instanceof Date) {
    const ms = ts.getTime();
    return isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

// Re-export shared topic parsers so existing importers (tests, etc.) continue to work.
// The canonical implementations now live in @shared/topics.
export { extractActionFromTopic, extractProducerFromTopicOrDefault };
