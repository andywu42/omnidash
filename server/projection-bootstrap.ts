// no-migration: OMN-4957 event wiring change only, no schema change
/**
 * Projection Bootstrap — Wire Event Sources to ProjectionService (OMN-2095)
 *
 * Creates the ProjectionService singleton, registers views, and wires
 * event sources (EventBusDataSource, EventConsumer) so that every Kafka
 * event is routed through the projection pipeline.
 *
 * Call `wireProjectionSources()` after EventConsumer/EventBusDataSource
 * have started to begin live ingestion.
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
import { eventConsumer } from './event-consumer';
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

// ============================================================================
// Module-scoped fallback sequence counter
// ============================================================================

// Intentionally module-scoped (not inside wireProjectionSources) so that the
// counter persists across rewires within a single process lifetime. If it were
// local to wireProjectionSources, each call (e.g. test teardown/setup,
// hot-reload) would reset the counter to 0, allowing dedup keys from a
// previous wiring to collide with those from the new wiring.
let fallbackSeq = 0;
const FALLBACK_SEQ_MAX = Number.MAX_SAFE_INTEGER;

// ============================================================================
// Event source wiring
// ============================================================================

/** Cleanup function returned by wireProjectionSources to remove listeners. */
export type ProjectionSourceCleanup = () => void;

/**
 * Wire EventBusDataSource and EventConsumer to the ProjectionService.
 *
 * EventBusDataSource provides full 197-topic coverage (all Kafka events).
 * EventConsumer provides enriched events for legacy agent topics.
 * We deduplicate by tracking event IDs ingested from EventBusDataSource
 * to avoid double-counting when the same event arrives through both sources.
 *
 * @returns Cleanup function that removes all registered listeners.
 *          Call on shutdown or before re-wiring to prevent listener leaks.
 */
export function wireProjectionSources(): ProjectionSourceCleanup {
  // Guard: if module caching broke (symlink aliasing, path mismatches, or
  // bundler re-evaluation), a second ProjectionService instance may exist
  // with zero views. Surface the problem immediately instead of silently
  // routing events into the void.
  if (projectionService.viewCount === 0) {
    console.warn(
      '[projection] WARNING: projectionService has no registered views — possible module caching issue'
    );
  }

  // Ring-buffer deduplication: O(1) per add, no periodic pruning spikes.
  // Tracks event IDs from EventBusDataSource so EventConsumer doesn't double-count.
  // Trade-off: if an ID is evicted from the ring before EventConsumer delivers
  // the same event, a rare double-count can occur. At DEDUP_CAPACITY=5000 and
  // typical inter-source latency <1s, this is negligible.
  const DEDUP_CAPACITY = 5000;
  // Pre-fill with null to keep V8 packed-elements representation (faster property
  // access than a holey array created by `new Array(n)` with sparse slots).
  // null (not '') so that a real empty-string event ID is evictable.
  const dedupRing: (string | null)[] = new Array<string | null>(DEDUP_CAPACITY).fill(null);
  const dedupSet = new Set<string>();
  let dedupIdx = 0;

  function trackEventId(id: string): void {
    // Evict oldest entry if ring is full (null sentinel marks unused slots)
    const evicted = dedupRing[dedupIdx];
    if (evicted !== null) dedupSet.delete(evicted);
    dedupRing[dedupIdx] = id;
    dedupSet.add(id);
    dedupIdx = (dedupIdx + 1) % DEDUP_CAPACITY;
  }

  // OMN-2197: Secondary correlation-ID-based dedup ring (bidirectional).
  // The same tool call can appear on multiple Kafka topics (e.g. legacy
  // `agent-actions` AND canonical `onex.cmd.omniintelligence.tool-content.v1`).
  // EventBusDataSource and EventConsumer produce different event IDs for the
  // same underlying action (EventConsumer reshapes with crypto.randomUUID()),
  // making ID-based dedup insufficient. The correlation_id is preserved across
  // both paths, so it provides a reliable cross-source dedup dimension.
  //
  // BIDIRECTIONAL: Both EventBusDataSource and EventConsumer CHECK the set
  // before ingestion and TRACK after ingestion, so dedup works regardless of
  // which source delivers first. This eliminates the race condition where
  // EventConsumer-first delivery would bypass one-directional dedup.
  const corrDedupCapacity = 5000;
  const corrDedupRing: (string | null)[] = new Array<string | null>(corrDedupCapacity).fill(null);
  const corrDedupSet = new Set<string>();
  let corrDedupIdx = 0;

  function trackCorrelationId(corrId: string): void {
    if (!corrId) return;
    const evicted = corrDedupRing[corrDedupIdx];
    if (evicted !== null) corrDedupSet.delete(evicted);
    corrDedupRing[corrDedupIdx] = corrId;
    corrDedupSet.add(corrId);
    corrDedupIdx = (corrDedupIdx + 1) % corrDedupCapacity;
  }

  // Normalized fallback key: tries all known field name variants so the same
  // event produces an identical key regardless of which source delivers it.
  // Collision risk: two distinct events with identical topic + type + timestamp
  // (plausible at >1000 events/ms) would share a key, causing the second to be
  // silently dropped. This is acceptable because: (1) events with no event_id
  // are already low-fidelity (legacy format), (2) the dedup window is only
  // DEDUP_CAPACITY=5000 events, and (3) a rare duplicate miss is preferable
  // to a rare duplicate count.
  //
  // When timestamp is missing (sentinel 0/''), a monotonic counter is appended
  // to prevent collisions between events that share the same topic+type.
  // Wraps at MAX_SAFE_INTEGER to prevent loss of integer precision.
  // After wrap-around, early sequence numbers reappear. If the dedup ring
  // still holds a key from those early numbers (extremely unlikely given
  // DEDUP_CAPACITY=5000 and 9-quadrillion wraps), a collision can occur.
  // This is acceptable for the same reasons as timestamp-based collisions:
  // events without IDs are already low-fidelity, and a rare duplicate is
  // preferable to a rare missed dedup.
  // Note: fallbackSeq and FALLBACK_SEQ_MAX are module-scoped — see above.
  function deriveFallbackDedupKey(data: Record<string, unknown>): string {
    const topic = (data.topic as string) || '';
    const type =
      (data.event_type as string) || (data.actionType as string) || (data.type as string) || '';
    const ts =
      (data.timestamp as string | number) ||
      (data.createdAt as string | number) ||
      (data.created_at as string | number) ||
      '';
    // If timestamp is missing/empty/zero, append a monotonic sequence to avoid
    // collisions between distinct events with the same topic + type.
    if (!ts || ts === 0) {
      const seq = fallbackSeq;
      fallbackSeq = (fallbackSeq + 1) % FALLBACK_SEQ_MAX;
      return `${topic}:${type}:_seq${seq}`;
    }
    return `${topic}:${type}:${ts}`;
  }

  const sources: string[] = [];
  // Track registered listeners for cleanup
  const cleanups: Array<() => void> = [];

  // --------------------------------------------------------------------------
  // EventBusDataSource: full 197-topic coverage
  // --------------------------------------------------------------------------

  // Duck-type check: eventBusDataSource may not extend EventEmitter in all
  // environments (e.g. test mocks, alternative implementations). Checking for
  // .on as a function is the standard Node.js pattern for optional listeners.
  if (typeof eventBusDataSource.on === 'function') {
    const handleDataSourceEvent = (event: Record<string, unknown>): void => {
      try {
        const eventId = event.event_id as string | undefined;
        // Compute dedup key early; only track after corr-id check passes
        // so that skipped duplicates don't evict entries from the event-id
        // dedup ring (which would shrink the effective dedup window).
        const dedupKey = eventId || deriveFallbackDedupKey(event);

        // OMN-2197: Bidirectional correlation-ID dedup.
        // The same tool call can appear on multiple Kafka topics (e.g. legacy
        // `agent-actions` AND canonical `onex.cmd.omniintelligence.tool-content.v1`).
        // EventConsumer reshapes events with new crypto.randomUUID() IDs, so
        // ID-based dedup misses cross-source duplicates. The correlation_id is
        // preserved across both sources, so we use it as a secondary dedup key.
        //
        // Both sources CHECK and TRACK the corrDedupSet to handle either
        // arrival order (EventBusDataSource-first or EventConsumer-first).
        const corrIdRaw = event.correlation_id ?? event.correlationId;
        const corrId = corrIdRaw != null ? String(corrIdRaw) : '';
        if (corrId && corrDedupSet.has(corrId)) return; // Already ingested via EventConsumer

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

        // OMN-2196: When event_type is empty, extract the action name from the
        // topic (e.g. 'onex.cmd.omniintelligence.tool-content.v1' → 'tool-content').
        const type = rawType || extractActionFromTopic(topic);

        // OMN-2195: When source is empty or the literal 'unknown' default from
        // EventBusDataSource, infer the producer from the topic name
        // (e.g. 'onex.evt.omniclaude.session-started.v1' → 'omniclaude').
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

        // Track dedup state only after successful ingest so that if ingest
        // throws, the other source's copy of this event is not silently dropped.
        trackEventId(dedupKey);
        if (corrId) trackCorrelationId(corrId);
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
    sources.push('EventBusDataSource');
  } else {
    console.warn('[projection] EventBusDataSource.on not available — skipping wiring');
  }

  // --------------------------------------------------------------------------
  // EventConsumer: enriched legacy agent events
  // --------------------------------------------------------------------------

  if (typeof eventConsumer.on !== 'function') {
    console.warn('[projection] EventConsumer.on not available — skipping consumer wiring');
  } else {
    const consumerEventNames = [
      'actionUpdate',
      'routingUpdate',
      'transformationUpdate',
      'performanceUpdate',
      'nodeIntrospectionUpdate',
      'nodeHeartbeatUpdate',
      'nodeStateChangeUpdate',
      'intentUpdate',
    ] as const;

    for (const eventName of consumerEventNames) {
      const handler = (data: Record<string, unknown>): void => {
        try {
          // Skip if already ingested via EventBusDataSource.
          // Uses shared deriveFallbackDedupKey for symmetric key derivation:
          // both sources derive identical keys from topic+type+timestamp when
          // event_id/id is missing, so dedup works regardless of which source
          // delivers first. If both sources lack an ID AND share the same
          // topic+type+timestamp, the second is dropped (acceptable — see
          // collision risk comment on deriveFallbackDedupKey above).
          const id = data.id as string | undefined;
          const dedupKey = id || deriveFallbackDedupKey(data);
          if (dedupSet.has(dedupKey)) return;

          // OMN-2197: Bidirectional correlation-ID dedup.
          // EventConsumer reshapes events with new crypto.randomUUID() IDs,
          // so ID-based dedup misses cross-source duplicates. The correlation_id
          // is preserved across both sources. Both sources CHECK and TRACK the
          // corrDedupSet so dedup works regardless of arrival order.
          const corrIdRaw = data.correlationId ?? data.correlation_id;
          const corrId = corrIdRaw != null ? String(corrIdRaw) : '';
          if (corrId && corrDedupSet.has(corrId)) return;

          const derivedTopic = (data.topic as string) || eventName;
          const derivedType = (data.actionType as string) || (data.type as string) || eventName;

          const raw: RawEventInput = {
            id,
            topic: derivedTopic,
            type: derivedType,
            source:
              (data.agentName as string) ||
              (data.sourceAgent as string) ||
              (data.node_id as string) ||
              'system',
            severity: mapSeverity(data),
            // IMPORTANT: `data` is the full AgentAction (or similar) emitted by
            // EventConsumer. Client-side display logic (EventBusMonitor's
            // computeNormalizedType / getEventDisplayLabel) depends on `toolName`
            // being present inside this serialized payload for specific tool
            // name rendering (OMN-2196). Changing the shape of `data` here will
            // break the Event Type column display.
            payload: data,
            eventTimeMs: extractTimestamp(data),
            enrichment: enrichmentPipeline.run(data, derivedType, derivedTopic),
          };

          projectionService.ingest(raw);

          // Track dedup state only after successful ingest so that if ingest
          // throws, the other source's copy of this event is not silently dropped.
          trackEventId(dedupKey);
          if (corrId) trackCorrelationId(corrId);
        } catch (err) {
          console.error(`[projection] EventConsumer ${eventName} handler error:`, err);
        }
      };

      eventConsumer.on(eventName, handler);
      cleanups.push(() => {
        if (typeof eventConsumer.removeListener === 'function') {
          eventConsumer.removeListener(eventName, handler);
        }
      });
    }
    sources.push('EventConsumer');
  }

  if (sources.length > 0) {
    console.log(
      `[projection] Wired to ${sources.join(' + ')}. Views:`,
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
