// no-migration: OMN-4587 No schema change — only controls which topics the consumer subscribes to at startup.
/**
 * Read-Model Consumer (OMN-2061)
 *
 * Kafka consumer that projects events into the omnidash_analytics database.
 * This is omnidash's own consumer -- deployed as an omnidash artifact.
 *
 * Design:
 * - Append-only projections: events are inserted, never updated in place
 * - Versioned projection rules: projection_watermarks tracks consumer progress
 * - Idempotent: duplicate events are safely ignored via ON CONFLICT
 * - Graceful degradation: if DB is unavailable, events are skipped (Kafka retains them)
 *
 * Topics consumed (canonical ONEX names):
 * - onex.evt.omniclaude.routing-decision.v1 -> agent_routing_decisions table
 * - onex.evt.omniclaude.agent-actions.v1 -> agent_actions table
 * - onex.evt.omniclaude.agent-transformation.v1 -> agent_transformation_events table
 *
 * Note: onex.evt.omniclaude.performance-metrics.v1 is handled by EventConsumer
 * in event-consumer.ts (in-memory aggregation only, no table needed).
 *
 * The consumer runs alongside the existing EventConsumer (which handles
 * in-memory aggregation for real-time WebSocket delivery). This consumer
 * is responsible for durable persistence into the read-model DB.
 */

import crypto from 'node:crypto';
import { Kafka, Consumer, EachMessagePayload, KafkaMessage } from 'kafkajs';
import { resolveBrokers } from './bus-config.js';
import { TopicCatalogManager } from './topic-catalog-manager';
import { tryGetIntelligenceDb } from './storage';
import { sql, eq } from 'drizzle-orm';
import {
  agentRoutingDecisions,
  agentActions,
  agentTransformationEvents,
  llmCostAggregates,
  baselinesSnapshots,
  baselinesComparisons,
  baselinesTrend,
  baselinesBreakdown,
  delegationEvents,
  delegationShadowComparisons,
  patternLearningArtifacts,
  planReviewRuns,
  modelEfficiencyRollups,
} from '@shared/intelligence-schema';
import type {
  InsertAgentRoutingDecision,
  InsertAgentAction,
  InsertAgentTransformationEvent,
  InsertLlmCostAggregate,
  InsertBaselinesSnapshot,
  InsertBaselinesComparison,
  InsertBaselinesTrend,
  InsertBaselinesBreakdown,
  InsertDelegationEvent,
  InsertDelegationShadowComparison,
  InsertPatternLearningArtifact,
} from '@shared/intelligence-schema';
import type { PatternEnforcementEvent } from '@shared/enforcement-types';
import { ENRICHMENT_OUTCOMES } from '@shared/enrichment-types';
import type { ContextEnrichmentEvent } from '@shared/enrichment-types';
import {
  SUFFIX_OMNICLAUDE_CONTEXT_ENRICHMENT,
  SUFFIX_OMNICLAUDE_LLM_ROUTING_DECISION,
  SUFFIX_OMNICLAUDE_TASK_DELEGATED,
  SUFFIX_OMNICLAUDE_DELEGATION_SHADOW_COMPARISON,
  TOPIC_OMNIINTELLIGENCE_LLM_CALL_COMPLETED,
  SUFFIX_OMNICLAUDE_GATE_DECISION,
  SUFFIX_OMNICLAUDE_EPIC_RUN_UPDATED,
  SUFFIX_OMNICLAUDE_PR_WATCH_UPDATED,
  SUFFIX_OMNICLAUDE_BUDGET_CAP_HIT,
  SUFFIX_OMNICLAUDE_CIRCUIT_BREAKER_TRIPPED,
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
  OMNICLAUDE_AGENT_TOPICS,
  SUFFIX_MEMORY_INTENT_STORED,
  SUFFIX_INTELLIGENCE_PATTERN_PROJECTION,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
  TOPIC_INTELLIGENCE_PLAN_REVIEW_STRATEGY_RUN_COMPLETED,
  SUFFIX_OMNICLAUDE_PR_VALIDATION_ROLLUP,
} from '@shared/topics';
import type { LlmRoutingDecisionEvent } from '@shared/llm-routing-types';
import type { TaskDelegatedEvent, DelegationShadowComparisonEvent } from '@shared/delegation-types';
import { baselinesProjection, llmRoutingProjection } from './projection-bootstrap';
import { emitBaselinesUpdate } from './baselines-events';
import { emitLlmRoutingInvalidate } from './llm-routing-events';
import { emitDelegationInvalidate } from './delegation-events';
import { emitEnrichmentInvalidate } from './enrichment-events';
import { emitEnforcementInvalidate } from './enforcement-events';
import {
  emitGateDecisionInvalidate,
  emitEpicRunInvalidate,
  emitPrWatchInvalidate,
  emitPipelineBudgetInvalidate,
  emitCircuitBreakerInvalidate,
} from './omniclaude-state-events';
import {
  PatternProjectionEventSchema,
  PatternLifecycleTransitionedEventSchema,
  PatternLearningRequestedEventSchema,
  validateEvent,
} from '@shared/event-schemas';

/**
 * Derive a deterministic UUID-shaped string from Kafka message coordinates.
 * Uses SHA-256 hash of topic + partition + offset, which uniquely identify
 * a message within a Kafka cluster. This ensures that redelivery of the
 * same message produces the same fallback correlation_id, preserving
 * ON CONFLICT DO NOTHING idempotency.
 */
function deterministicCorrelationId(topic: string, partition: number, offset: string): string {
  return crypto
    .createHash('sha256')
    .update(`${topic}:${partition}:${offset}`)
    .digest('hex')
    .slice(0, 32)
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

/**
 * Sanitize a session_id value before writing to agent_routing_decisions (OMN-4823).
 *
 * After OMN-4821, session_id is typed text so any string is valid at the DB
 * layer. This helper enforces application-level quality:
 * - Trims whitespace
 * - Returns undefined (null in DB) for empty, null, or whitespace-only values
 * - Logs a warning when the raw value was non-empty but malformed (not a UUID
 *   and not a plain printable string)
 *
 * All INSERT sites for agent_routing_decisions.session_id must route through
 * this helper — do not inline session_id sanitization at call sites.
 */
function sanitizeSessionId(
  raw: string | null | undefined,
  context: { correlationId?: string } = {}
): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') {
    // Empty/whitespace is treated as absent — write null to DB.
    return undefined;
  }
  // Check for control characters or non-printable content that indicates
  // a corrupted or unexpected value.

  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    console.warn('[read-model-consumer] session_id contains control characters — writing null', {
      rawLength: raw.length,
      correlationId: context.correlationId,
    });
    return undefined;
  }
  return trimmed;
}

/**
 * Parse a date string safely, returning the current wall-clock time (`new
 * Date()`) when the input is missing or produces an invalid Date (e.g.
 * malformed ISO string).
 *
 * Wall-clock is used as the fallback so that rows with a missing/malformed
 * timestamp are stored with a "reasonable recent" time rather than 1970-01-01,
 * which would make them appear as the oldest records in the system.
 *
 * Use `safeParseDateOrMin` instead when epoch-zero (sorting last as oldest) is
 * the desired sentinel — currently only for `computedAtUtc` in baselines
 * snapshots.
 */
function safeParseDate(value: unknown): Date {
  if (!value) {
    return new Date();
  }
  const d = new Date(value as string);
  if (!Number.isFinite(d.getTime())) {
    console.warn(
      `[ReadModelConsumer] safeParseDate: malformed timestamp "${value}", falling back to wall-clock`
    );
    return new Date();
  }
  return d;
}

/**
 * Parse a date string safely, returning epoch-zero (`new Date(0)`) when the
 * input is missing or produces an invalid Date (e.g. malformed ISO string).
 *
 * Epoch-zero is used as a min-date sentinel so that rows with a
 * missing/malformed timestamp sort last (oldest) rather than first (newest)
 * when the field is used as an ordering key such as MAX(computed_at_utc) for
 * "latest snapshot". A wall-clock fallback would incorrectly rank a malformed
 * event as the most recent snapshot, hiding correct data from callers.
 *
 * Only use this variant for fields where epoch-zero-as-oldest is intentional.
 * Use `safeParseDate` for all other timestamp fields.
 */
function safeParseDateOrMin(value: unknown): Date {
  if (!value) {
    console.warn(
      '[ReadModelConsumer] safeParseDateOrMin: missing timestamp value, falling back to epoch-zero'
    );
    return new Date(0);
  }
  const d = new Date(value as string);
  if (!Number.isFinite(d.getTime())) {
    console.warn(
      `[ReadModelConsumer] safeParseDateOrMin: malformed timestamp "${value}", falling back to epoch-zero`
    );
    return new Date(0);
  }
  // Extra guard: a valid-but-suspiciously-old date (before 2020) almost
  // certainly indicates a malformed value (e.g. an accidental epoch-seconds
  // value interpreted as milliseconds). Treat it as missing.
  if (d.getFullYear() < 2020) {
    console.warn(
      `[ReadModelConsumer] safeParseDateOrMin: timestamp "${value}" parsed to year ${d.getFullYear()} (< 2020), treating as epoch-zero sentinel`
    );
    return new Date(0);
  }
  return d;
}

const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

// UUID validation regex — hoisted to module scope so it is compiled once rather
// than once per Kafka message inside projectBaselinesSnapshot().
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PostgreSQL hard limit is 65535 parameters per query.
// The widest baselines child table (comparisons) has 14 explicit user params
// (snapshotId, patternId, patternName, sampleSize, windowStart, windowEnd,
//  tokenDelta, timeDelta, retryDelta, testPassRateDelta, reviewIterationDelta,
//  recommendation, confidence, rationale — DB handles id and createdAt).
// floor(65535 / 14) = 4681 safe rows. Use 4000 as a conservative cap with margin.
const MAX_BATCH_ROWS = 4000;

// Hoisted to module scope — shared by both comparison and breakdown writers so validation
// is applied consistently at ingest time (write-time) rather than silently at read-time.
const VALID_PROMOTION_ACTIONS = new Set(['promote', 'shadow', 'suppress', 'fork']);
const VALID_CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);

// Consumer configuration
const CONSUMER_GROUP_ID = process.env.READ_MODEL_CONSUMER_GROUP_ID || 'omnidash-read-model-v1';
const CLIENT_ID = process.env.READ_MODEL_CLIENT_ID || 'omnidash-read-model-consumer';
const RETRY_BASE_DELAY_MS = isTestEnv ? 20 : 2000;
const RETRY_MAX_DELAY_MS = isTestEnv ? 200 : 30000;
const MAX_RETRY_ATTEMPTS = isTestEnv ? 2 : 10;

// Topics this consumer subscribes to.
// OMNICLAUDE_AGENT_TOPICS is the canonical source of truth for the agent-action,
// routing-decision, agent-transformation, and performance-metrics subscriptions.
// omniclaude now produces to these onex.evt.omniclaude.* topics; the legacy flat
// names (agent-actions, agent-routing-decisions, etc.) are no longer produced.
// Exported for regression testing (OMN-2760): every topic in OMNICLAUDE_AGENT_TOPICS
// must have a corresponding case in the handleMessage switch statement.
export const READ_MODEL_TOPICS = [
  ...OMNICLAUDE_AGENT_TOPICS,
  'onex.evt.omniclaude.pattern-enforcement.v1',
  // OMN-2371 (GAP-5): Canonical producer is NodeLlmInferenceEffect in omnibase_infra.
  // The old topic 'onex.evt.omniclaude.llm-cost-reported.v1' had zero producers.
  // Now subscribing to the canonical per-call topic; projectLlmCostEvent() handles
  // ContractLlmCallMetrics payload and projects each call into llm_cost_aggregates.
  TOPIC_OMNIINTELLIGENCE_LLM_CALL_COMPLETED,
  'onex.evt.omnibase-infra.baselines-computed.v1',
  SUFFIX_OMNICLAUDE_CONTEXT_ENRICHMENT,
  SUFFIX_OMNICLAUDE_LLM_ROUTING_DECISION,
  // OMN-2284: Delegation metrics — task-delegated and shadow-comparison events.
  SUFFIX_OMNICLAUDE_TASK_DELEGATED,
  SUFFIX_OMNICLAUDE_DELEGATION_SHADOW_COMPARISON,
  // Wave 2 topics (OMN-2596)
  SUFFIX_OMNICLAUDE_GATE_DECISION,
  SUFFIX_OMNICLAUDE_EPIC_RUN_UPDATED,
  SUFFIX_OMNICLAUDE_PR_WATCH_UPDATED,
  SUFFIX_OMNICLAUDE_BUDGET_CAP_HIT,
  SUFFIX_OMNICLAUDE_CIRCUIT_BREAKER_TRIPPED,
  // OMN-2889: OmniMemory intent signals — durable projection into intent_signals table.
  SUFFIX_MEMORY_INTENT_STORED,
  // OMN-2924: OmniIntelligence pattern topics — durable projection into pattern_learning_artifacts.
  SUFFIX_INTELLIGENCE_PATTERN_PROJECTION,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED,
  // OMN-2920: Pattern learning command topic — backfill pattern_learning_artifacts from
  // PatternLearningRequested events so the Patterns and Learned Insights pages show live
  // data even when omniintelligence does not yet emit pattern-projection.v1 completions.
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
  // OMN-3324: Plan reviewer strategy run completions from omniintelligence.
  TOPIC_INTELLIGENCE_PLAN_REVIEW_STRATEGY_RUN_COMPLETED,
  SUFFIX_OMNICLAUDE_PR_VALIDATION_ROLLUP,
] as const;

type ReadModelTopic = (typeof READ_MODEL_TOPICS)[number];

export interface ReadModelConsumerStats {
  isRunning: boolean;
  eventsProjected: number;
  errorsCount: number;
  lastProjectedAt: Date | null;
  topicStats: Record<string, { projected: number; errors: number }>;
  catalogSource: 'catalog' | 'fallback' | 'static';
  unsupportedCatalogTopics: string[];
}

/**
 * Read-Model Consumer
 *
 * Projects Kafka events into the omnidash_analytics database tables.
 * Runs as a separate consumer group from the main EventConsumer to ensure
 * independent offset tracking and processing guarantees.
 */
export class ReadModelConsumer {
  private kafka: Kafka | null = null;
  private consumer: Consumer | null = null;
  private running = false;
  private stopped = false;
  private catalogManager: TopicCatalogManager | null = null;
  private catalogSource: 'catalog' | 'fallback' | 'static' = 'fallback';
  private stats: ReadModelConsumerStats = {
    isRunning: false,
    eventsProjected: 0,
    errorsCount: 0,
    lastProjectedAt: null,
    topicStats: {},
    catalogSource: 'fallback',
    unsupportedCatalogTopics: [],
  };

  /**
   * Start the read-model consumer.
   * Connects to Kafka and begins consuming events for projection.
   *
   * Fire-and-forget by design: the caller in server/index.ts must NOT await
   * this method. The retry loop (up to MAX_RETRY_ATTEMPTS with exponential
   * backoff to RETRY_MAX_DELAY_MS per attempt) is intentionally long to survive
   * transient Kafka outages without crashing the server. Awaiting it would
   * block server.listen() for minutes during a Kafka outage.
   */
  async start(): Promise<void> {
    // Reset the stopped flag so a consumer that was previously stopped can be
    // restarted cleanly. Placed before the `this.running` guard so that a
    // concurrent stop()+start() sequence — where stop() sets stopped=true and
    // then start() runs — cannot slip past the guard and override stopped=true
    // with false after the guard has been checked. After the assignment we
    // immediately re-check stopped: if stop() raced in and set it back to true
    // between the assignment and this re-check we abort rather than proceeding
    // to connect.
    this.stopped = false;
    if (this.stopped) return;

    if (this.running) {
      console.log('[ReadModelConsumer] Already running');
      return;
    }

    // Reset stopped flag so start() can be called again after stop().
    this.stopped = false;

    let brokers: string[];
    try {
      brokers = resolveBrokers();
    } catch {
      console.warn('[ReadModelConsumer] No Kafka brokers configured -- skipping');
      return;
    }

    const db = tryGetIntelligenceDb();
    if (!db) {
      console.warn('[ReadModelConsumer] Database not configured -- skipping');
      return;
    }

    let attempts = 0;
    while (attempts < MAX_RETRY_ATTEMPTS) {
      // If stop() was called while we were sleeping between retries, abort the
      // retry loop immediately. Without this guard the loop would recreate a
      // Kafka client + consumer after stop() already nulled them, leaving a
      // live connection that is never disconnected.
      if (this.stopped) return;

      try {
        this.kafka = new Kafka({
          clientId: CLIENT_ID,
          brokers,
          connectionTimeout: 10000,
          requestTimeout: 30000,
          retry: {
            initialRetryTime: RETRY_BASE_DELAY_MS,
            maxRetryTime: RETRY_MAX_DELAY_MS,
            retries: 10,
          },
        });

        this.consumer = this.kafka.consumer({
          groupId: CONSUMER_GROUP_ID,
          sessionTimeout: 30000,
          heartbeatInterval: 10000,
        });

        this.consumer.on(this.consumer.events.DISCONNECT, () => {
          if (!this.stopped) {
            console.warn(
              '[ReadModelConsumer] Kafka broker disconnected — will reconnect on next loop iteration'
            );
          }
        });

        await this.consumer.connect();
        console.log('[ReadModelConsumer] Connected to Kafka');

        // -----------------------------------------------------------------------
        // Topic subscription (OMN-2926, OMN-4587)
        //
        // OMNIDASH_READ_MODEL_USE_CATALOG=false bypasses catalog-driven
        // subscription and always uses the static READ_MODEL_TOPICS list.
        // This prevents multi-replica rebalance storms where two pods racing
        // through the catalog query can receive different topic subsets,
        // causing their group memberships to diverge and trigger an infinite
        // rebalance loop. Set to 'false' in production k8s deployments.
        //
        // When enabled (default), queries the platform topic-catalog service
        // for the dynamic topic list, filtered to READ_MODEL_TOPICS. Falls
        // back to READ_MODEL_TOPICS if catalog does not respond.
        // -----------------------------------------------------------------------
        // Catalog is enabled when:
        //   1. Explicitly set: OMNIDASH_READ_MODEL_USE_CATALOG=true
        //   2. Not explicitly disabled AND not running in k8s (local dev default)
        // Catalog is disabled when:
        //   1. Explicitly set: OMNIDASH_READ_MODEL_USE_CATALOG=false
        //   2. Running in k8s without explicit opt-in (prevents rebalance storms)
        const catalogEnv = process.env.OMNIDASH_READ_MODEL_USE_CATALOG;
        const useCatalog =
          catalogEnv === 'true' || (catalogEnv !== 'false' && !process.env.KUBERNETES_SERVICE_HOST);
        let finalTopics: string[];

        if (!useCatalog) {
          this.catalogSource = 'static';
          this.stats.catalogSource = 'static';
          finalTopics = [...READ_MODEL_TOPICS];
          const reason =
            catalogEnv === 'false'
              ? 'OMNIDASH_READ_MODEL_USE_CATALOG=false'
              : 'k8s detected (KUBERNETES_SERVICE_HOST set)';
          console.info(
            `[read-model] topic source: static (${reason}, subscribed=${finalTopics.length})`
          );
        } else {
          const catalogTopics = await this.fetchCatalogTopics();
          const supported = new Set(READ_MODEL_TOPICS as readonly string[]);
          const subscribeTopics = catalogTopics.filter((t) => supported.has(t));
          const unsupportedCatalogTopics = catalogTopics.filter((t) => !supported.has(t));

          this.catalogSource = catalogTopics.length > 0 ? 'catalog' : 'fallback';
          this.stats.catalogSource = this.catalogSource;

          const startupLogMsg =
            `[read-model] topic source: ${this.catalogSource} ` +
            `(subscribed=${subscribeTopics.length} ` +
            `catalog_size=${catalogTopics.length} ` +
            `unsupported=${unsupportedCatalogTopics.length})`;
          if (this.catalogSource === 'fallback') {
            console.warn(startupLogMsg);
          } else {
            console.info(startupLogMsg);
          }

          if (unsupportedCatalogTopics.length > 0) {
            console.warn(
              `[ReadModelConsumer] DRIFT: catalog has handlers not in consumer: ${unsupportedCatalogTopics.join(', ')}`
            );
            // Surface in health endpoint so drift is visible without log scraping.
            this.stats.unsupportedCatalogTopics = unsupportedCatalogTopics;
          }

          finalTopics = subscribeTopics.length > 0 ? subscribeTopics : [...READ_MODEL_TOPICS];
        }

        // Subscribe to all final topics individually so that a single
        // missing/uncreated topic (which returns invalid partition metadata from
        // Redpanda) does not crash the entire consumer. fromBeginning: false is
        // intentional -- we only project events produced after this consumer
        // first joins the group.
        const subscribedTopics: string[] = [];
        const skippedTopics: string[] = [];
        for (const topic of finalTopics) {
          try {
            await this.consumer.subscribe({ topic, fromBeginning: false });
            subscribedTopics.push(topic);
          } catch (subscribeErr) {
            skippedTopics.push(topic);
            console.warn(
              `[ReadModelConsumer] Skipping topic "${topic}" (not available on broker):`,
              subscribeErr instanceof Error ? subscribeErr.message : subscribeErr
            );
          }
        }
        if (subscribedTopics.length === 0) {
          throw new Error(
            `No topics could be subscribed — all topics failed metadata check: ${skippedTopics.join(', ')}`
          );
        }
        if (skippedTopics.length > 0) {
          console.warn(
            `[ReadModelConsumer] Skipped ${skippedTopics.length} topic(s): ${skippedTopics.join(', ')}`
          );
        }

        // Process messages
        this.running = true;
        this.stats.isRunning = true;
        console.log(
          `[ReadModelConsumer] Running. Topics (${subscribedTopics.length}): ${subscribedTopics.join(', ')}. ` +
            `Group: ${CONSUMER_GROUP_ID}`
        );

        // IMPORTANT: kafkajs 2.2.4 + Redpanda compatibility issue (OMN-2789)
        //
        // consumer.run() resolves its promise almost immediately (~100ms) after
        // the consumer joins the group — it does NOT block until the consumer
        // stops. The internal fetch loop continues running in the background.
        //
        // If you `await` this call and then treat resolution as "consumer
        // crashed", you will disconnect the still-running fetch loop and enter
        // an infinite connect/subscribe/disconnect cycle where no messages are
        // ever consumed.
        //
        // Fix: fire-and-forget the run() promise and block on a stopped-flag
        // poll loop instead. The CRASH event handles real failures.
        this.consumer
          .run({
            eachMessage: async (payload: EachMessagePayload) => {
              await this.handleMessage(payload);
            },
          })
          .catch((runErr) => {
            if (!this.stopped) {
              console.error(
                '[ReadModelConsumer] consumer.run() threw — will reconnect:',
                runErr instanceof Error ? runErr.message : runErr
              );
              // Signal the wait loop below to break so the outer retry loop
              // can reconnect.
              this.running = false;
              this.stats.isRunning = false;
            }
          });

        // Block here while the consumer is alive. The internal kafkajs fetch
        // loop runs in the background; we just need to keep this iteration of
        // the retry-while loop from advancing. stop() sets this.stopped=true,
        // and the .catch() above sets this.running=false on real crashes.
        while (this.running && !this.stopped) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        if (this.stopped) return;

        // If we reach here, running was set to false by the .catch() handler
        // (a real crash). Clean up and let the outer while-loop retry.
        console.warn('[ReadModelConsumer] Consumer fetch loop exited — cleaning up for retry...');
        try {
          await this.consumer.disconnect();
        } catch (disconnectErr) {
          console.warn(
            '[ReadModelConsumer] Error disconnecting consumer after crash:',
            disconnectErr instanceof Error ? disconnectErr.message : disconnectErr
          );
        }
        this.consumer = null;
        this.kafka = null;
        attempts = 0;
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS));
        if (this.stopped) return;
        continue;
      } catch (err) {
        // Disconnect the current consumer before resetting flags so we do not
        // orphan a live broker connection. connect() may have succeeded before
        // subscribe() or run() threw, leaving a connected consumer handle we
        // will never use again if we just abandon it and create new
        // Kafka+consumer instances. Flags are reset only after disconnect so a
        // caller observing running=false cannot call start() while the old
        // consumer disconnect is still in flight.
        if (this.consumer) {
          try {
            await this.consumer.disconnect();
          } catch (disconnectErr) {
            console.warn(
              '[ReadModelConsumer] Error disconnecting consumer during retry cleanup:',
              disconnectErr instanceof Error ? disconnectErr.message : disconnectErr
            );
          }
          this.consumer = null;
          this.kafka = null;
        }
        this.running = false;
        this.stats.isRunning = false;

        attempts++;
        const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempts), RETRY_MAX_DELAY_MS);
        console.error(
          `[ReadModelConsumer] Connection attempt ${attempts}/${MAX_RETRY_ATTEMPTS} failed:`,
          err instanceof Error ? err.message : err
        );
        if (attempts < MAX_RETRY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          // Re-check stopped after the backoff sleep — stop() may have been called
          // during the up-to-30s wait. Abort immediately rather than proceeding to
          // the next iteration which would recreate a connection after stop() cleared state.
          if (this.stopped) return;
        }
      }
    }

    console.error('[ReadModelConsumer] Failed to connect after max retries');
  }

  /**
   * Stop the consumer gracefully.
   *
   * Guard uses `&&` (not `||`): skip only when BOTH running=false AND
   * consumer=null. If consumer.connect() succeeded but consumer.run() threw
   * before this.running was set to true, running=false but consumer is
   * non-null — a torn state. Using `||` would make stop() a no-op in that
   * scenario, leaking the Kafka connection. `&&` ensures we always disconnect
   * a live consumer handle regardless of the running flag.
   */
  async stop(): Promise<void> {
    // Set stopped before any await so that if start() is concurrently sleeping
    // between retry attempts it will observe this flag on its next iteration
    // and abort rather than creating a new connection after we disconnect.
    this.stopped = true;

    if (!this.running && !this.consumer) return;

    // Stop the catalog manager (its own consumer/producer pair).
    if (this.catalogManager) {
      await this.catalogManager.stop().catch((err) => {
        console.warn('[ReadModelConsumer] Error stopping catalog manager:', err);
      });
      this.catalogManager = null;
    }

    try {
      if (this.consumer) {
        await this.consumer.disconnect();
      }
      console.log('[ReadModelConsumer] Disconnected');
    } catch (err) {
      console.error('[ReadModelConsumer] Error during disconnect:', err);
    } finally {
      this.running = false;
      this.stats.isRunning = false;
      this.consumer = null;
      this.kafka = null;
    }
  }

  /**
   * Fetch topic list from the platform topic-catalog service (OMN-2926).
   *
   * Uses a 10s timeout (longer than EventConsumer's 5s) because the
   * read-model consumer starts after EventConsumer and the catalog responder
   * may still be processing the first request.
   *
   * Returns an empty array on timeout or error, causing the caller to fall
   * back to READ_MODEL_TOPICS.
   */
  private async fetchCatalogTopics(): Promise<string[]> {
    // Reset stale catalog state from any prior bootstrap attempt.
    this.catalogSource = 'fallback';
    this.stats.catalogSource = 'fallback';
    this.stats.unsupportedCatalogTopics = [];

    try {
      const manager = new TopicCatalogManager();
      this.catalogManager = manager;

      const topics = await new Promise<string[]>((resolve) => {
        manager.once('catalogReceived', (event) => {
          this.catalogSource = 'catalog';
          this.stats.catalogSource = 'catalog';
          resolve(event.topics);
        });

        manager.once('catalogTimeout', () => {
          console.warn(
            '[ReadModelConsumer] Topic catalog timed out — using READ_MODEL_TOPICS fallback'
          );
          manager.stop().catch((stopErr) => {
            console.warn(
              '[ReadModelConsumer] Error stopping catalog manager after timeout:',
              stopErr
            );
          });
          this.catalogManager = null;
          resolve([]);
        });

        // Non-blocking: errors from bootstrap should not crash consumer startup.
        manager.bootstrap().catch((err) => {
          console.warn('[ReadModelConsumer] Topic catalog bootstrap error:', err);
          manager.stop().catch((stopErr) => {
            console.warn(
              '[ReadModelConsumer] Error stopping catalog manager after bootstrap error:',
              stopErr
            );
          });
          this.catalogManager = null;
          resolve([]);
        });
      });

      return topics;
    } catch (err) {
      console.warn('[ReadModelConsumer] fetchCatalogTopics error — using fallback:', err);
      this.catalogManager = null;
      return [];
    }
  }

  /**
   * Get consumer statistics.
   */
  getStats(): ReadModelConsumerStats {
    return { ...this.stats };
  }

  /**
   * Handle an incoming Kafka message and project it to the read-model.
   */
  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;

    try {
      const parsed = this.parseMessage(message);
      if (!parsed) return;

      const topicKey = topic as ReadModelTopic;
      // fallbackId: deterministic dedup key from partition+offset coordinates.
      // Used when neither correlation_id nor correlationId is present in the event.
      // Edge case: duplicate partition+offset (e.g. Kafka compaction artifact) will
      // silently drop the second event via ON CONFLICT DO NOTHING — acceptable in practice.
      const fallbackId = deterministicCorrelationId(topic, partition, message.offset);

      let projected: boolean;
      switch (topicKey) {
        case TOPIC_OMNICLAUDE_ROUTING_DECISIONS:
          projected = await this.projectRoutingDecision(parsed, fallbackId);
          break;
        case TOPIC_OMNICLAUDE_AGENT_ACTIONS:
          projected = await this.projectAgentAction(parsed, fallbackId);
          break;
        case TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION:
          projected = await this.projectTransformationEvent(parsed);
          break;
        case TOPIC_OMNICLAUDE_PERFORMANCE_METRICS:
          // Performance metrics: in-memory only (EventConsumer), no durable projection needed.
          projected = true;
          break;
        case 'onex.evt.omniclaude.pattern-enforcement.v1':
          projected = await this.projectEnforcementEvent(parsed, fallbackId);
          break;
        case TOPIC_OMNIINTELLIGENCE_LLM_CALL_COMPLETED:
          projected = await this.projectLlmCostEvent(parsed);
          break;
        case 'onex.evt.omnibase-infra.baselines-computed.v1':
          projected = await this.projectBaselinesSnapshot(parsed, partition, message.offset);
          break;
        case SUFFIX_OMNICLAUDE_CONTEXT_ENRICHMENT:
          projected = await this.projectEnrichmentEvent(parsed, fallbackId);
          break;
        case SUFFIX_OMNICLAUDE_LLM_ROUTING_DECISION:
          projected = await this.projectLlmRoutingDecisionEvent(parsed, fallbackId);
          break;
        case SUFFIX_OMNICLAUDE_TASK_DELEGATED:
          projected = await this.projectTaskDelegatedEvent(parsed, fallbackId);
          break;
        case SUFFIX_OMNICLAUDE_DELEGATION_SHADOW_COMPARISON:
          projected = await this.projectDelegationShadowComparisonEvent(parsed, fallbackId);
          break;
        // Wave 2 topics (OMN-2596)
        case SUFFIX_OMNICLAUDE_GATE_DECISION:
          projected = await this.projectGateDecisionEvent(parsed, fallbackId);
          break;
        case SUFFIX_OMNICLAUDE_EPIC_RUN_UPDATED:
          projected = await this.projectEpicRunUpdatedEvent(parsed, fallbackId);
          break;
        case SUFFIX_OMNICLAUDE_PR_WATCH_UPDATED:
          projected = await this.projectPrWatchUpdatedEvent(parsed, fallbackId);
          break;
        case SUFFIX_OMNICLAUDE_BUDGET_CAP_HIT:
          projected = await this.projectBudgetCapHitEvent(parsed, fallbackId);
          break;
        case SUFFIX_OMNICLAUDE_CIRCUIT_BREAKER_TRIPPED:
          projected = await this.projectCircuitBreakerTrippedEvent(parsed, fallbackId);
          break;
        case SUFFIX_MEMORY_INTENT_STORED:
          projected = await this.projectIntentStoredEvent(parsed, fallbackId);
          break;
        // OMN-2924: Pattern write handlers (OMN-3751: Zod-validated)
        case SUFFIX_INTELLIGENCE_PATTERN_PROJECTION: {
          const validatedProjection = validateEvent(PatternProjectionEventSchema, parsed, topic);
          if (!validatedProjection) {
            this.stats.errorsCount++;
            return;
          }
          projected = await this.projectPatternProjectionEvent(
            parsed as Record<string, unknown>,
            fallbackId
          );
          break;
        }
        case SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED: {
          const validatedLifecycle = validateEvent(
            PatternLifecycleTransitionedEventSchema,
            parsed,
            topic
          );
          if (!validatedLifecycle) {
            this.stats.errorsCount++;
            return;
          }
          projected = await this.projectPatternLifecycleTransitionedEvent(
            parsed as Record<string, unknown>,
            fallbackId
          );
          break;
        }
        // OMN-2920: Pattern learning command — backfill pattern_learning_artifacts
        // from PatternLearningRequested events (omniintelligence has not yet emitted
        // pattern-projection.v1 completions, so this ensures the table is non-empty).
        // OMN-3751: Zod-validated before projection.
        case SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD: {
          const validatedLearning = validateEvent(
            PatternLearningRequestedEventSchema,
            parsed,
            topic
          );
          if (!validatedLearning) {
            this.stats.errorsCount++;
            return;
          }
          projected = await this.projectPatternLearningRequestedEvent(
            parsed as Record<string, unknown>,
            fallbackId
          );
          break;
        }
        // OMN-3324: Plan reviewer strategy run completions
        case TOPIC_INTELLIGENCE_PLAN_REVIEW_STRATEGY_RUN_COMPLETED:
          projected = await this.projectPlanReviewStrategyRunEvent(parsed, fallbackId);
          break;
        // OMN-3933: PR validation rollup events for MEI dashboard
        case SUFFIX_OMNICLAUDE_PR_VALIDATION_ROLLUP:
          projected = await this.projectPrValidationRollup(parsed);
          break;
        default:
          console.warn(
            `[ReadModelConsumer] Received message on unknown topic "${topic}" -- skipping`
          );
          return;
      }

      // Only update stats and watermark when the projection actually succeeded.
      // If the DB was unavailable the projection method returns false and we
      // must NOT advance the watermark -- Kafka will redeliver the message on
      // the next consumer restart (or when the DB comes back and the next
      // poll cycle retries).
      if (!projected) {
        console.warn(
          `[ReadModelConsumer] DB unavailable, skipping projection for ${topic} ` +
            `partition=${partition} offset=${message.offset}`
        );
        return;
      }

      // Update stats
      this.stats.eventsProjected++;
      this.stats.lastProjectedAt = new Date();
      if (!this.stats.topicStats[topic]) {
        this.stats.topicStats[topic] = { projected: 0, errors: 0 };
      }
      this.stats.topicStats[topic].projected++;

      // Track consumer progress via watermark
      const watermarkName = `${topic}:${partition}`;
      await this.updateWatermark(watermarkName, Number(message.offset));
    } catch (err) {
      this.stats.errorsCount++;
      if (!this.stats.topicStats[topic]) {
        this.stats.topicStats[topic] = { projected: 0, errors: 0 };
      }
      this.stats.topicStats[topic].errors++;

      console.error(
        `[ReadModelConsumer] Error projecting ${topic} message:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Parse a Kafka message value into a JSON object.
   */
  private parseMessage(message: KafkaMessage): Record<string, unknown> | null {
    if (!message.value) return null;

    try {
      const raw = JSON.parse(message.value.toString());
      // Handle envelope pattern: { payload: { ... } }
      if (raw.payload && typeof raw.payload === 'object') {
        return { ...raw.payload, _envelope: raw };
      }
      return raw;
    } catch {
      return null;
    }
  }

  /**
   * Project a routing decision event into agent_routing_decisions table.
   * Returns true if the row was successfully written, false if the DB was unavailable.
   */
  private async projectRoutingDecision(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const row: InsertAgentRoutingDecision = {
      correlationId:
        (data.correlation_id as string) || (data.correlationId as string) || fallbackId,
      // OMN-4823: sanitize session_id before INSERT — strips whitespace, maps
      // empty/null/control-char values to undefined (null in DB).
      sessionId: sanitizeSessionId(
        (data.session_id as string | null | undefined) ??
          (data.sessionId as string | null | undefined),
        { correlationId: (data.correlation_id as string) || (data.correlationId as string) }
      ),
      // user_request / userRequest: canonical names.
      // prompt_preview: field name used by omniclaude routing.decision events. [OMN-3320]
      userRequest:
        (data.user_request as string) ||
        (data.userRequest as string) ||
        (data.prompt_preview as string) ||
        '',
      userRequestHash:
        (data.user_request_hash as string) || (data.userRequestHash as string) || undefined,
      contextSnapshot: data.context_snapshot || data.contextSnapshot || undefined,
      selectedAgent: (data.selected_agent as string) || (data.selectedAgent as string) || 'unknown',
      // confidence_score / confidenceScore: canonical names.
      // confidence: field name used by omniclaude routing.decision events. [OMN-3320]
      confidenceScore: String(
        data.confidence_score ?? data.confidenceScore ?? data.confidence ?? 0
      ),
      routingStrategy:
        (data.routing_strategy as string) || (data.routingStrategy as string) || 'unknown',
      triggerConfidence:
        data.trigger_confidence != null ? String(data.trigger_confidence) : undefined,
      contextConfidence:
        data.context_confidence != null ? String(data.context_confidence) : undefined,
      capabilityConfidence:
        data.capability_confidence != null ? String(data.capability_confidence) : undefined,
      historicalConfidence:
        data.historical_confidence != null ? String(data.historical_confidence) : undefined,
      alternatives: data.alternatives || undefined,
      reasoning: (data.reasoning as string) || undefined,
      routingTimeMs: Number(data.routing_time_ms ?? data.routingTimeMs ?? 0),
      cacheHit: Boolean(data.cache_hit ?? data.cacheHit ?? false),
      selectionValidated: Boolean(data.selection_validated ?? data.selectionValidated ?? false),
      actualSuccess: data.actual_success != null ? Boolean(data.actual_success) : undefined,
      executionSucceeded:
        data.execution_succeeded != null ? Boolean(data.execution_succeeded) : undefined,
      actualQualityScore:
        data.actual_quality_score != null ? String(data.actual_quality_score) : undefined,
      createdAt: safeParseDate(data.created_at),
    };

    await db
      .insert(agentRoutingDecisions)
      .values(row)
      .onConflictDoNothing({ target: agentRoutingDecisions.correlationId });

    return true;
  }

  /**
   * Project an agent action event into agent_actions table.
   * Returns true if the row was successfully written, false if the DB was unavailable.
   */
  private async projectAgentAction(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const row: InsertAgentAction = {
      correlationId:
        (data.correlation_id as string) || (data.correlationId as string) || fallbackId,
      agentName: (data.agent_name as string) || (data.agentName as string) || 'unknown',
      actionType: (data.action_type as string) || (data.actionType as string) || 'unknown',
      actionName: (data.action_name as string) || (data.actionName as string) || 'unknown',
      actionDetails: data.action_details || data.actionDetails || {},
      debugMode: Boolean(data.debug_mode ?? data.debugMode ?? true),
      durationMs:
        data.duration_ms != null
          ? Number(data.duration_ms)
          : data.durationMs != null
            ? Number(data.durationMs)
            : undefined,
      createdAt: safeParseDate(data.created_at),
    };

    await db
      .insert(agentActions)
      .values(row)
      .onConflictDoNothing({ target: agentActions.correlationId });

    return true;
  }

  /**
   * Project a transformation event into agent_transformation_events table.
   * Returns true if the row was successfully written, false if the DB was unavailable.
   */
  private async projectTransformationEvent(data: Record<string, unknown>): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const row: InsertAgentTransformationEvent = {
      sourceAgent: (data.source_agent as string) || (data.sourceAgent as string) || 'unknown',
      targetAgent: (data.target_agent as string) || (data.targetAgent as string) || 'unknown',
      transformationReason:
        (data.transformation_reason as string) ||
        (data.transformationReason as string) ||
        undefined,
      confidenceScore: data.confidence_score != null ? String(data.confidence_score) : undefined,
      transformationDurationMs:
        data.transformation_duration_ms != null
          ? Number(data.transformation_duration_ms)
          : undefined,
      success: Boolean(data.success ?? true),
      createdAt: safeParseDate(data.created_at),
      projectPath: (data.project_path as string) || (data.projectPath as string) || undefined,
      projectName: (data.project_name as string) || (data.projectName as string) || undefined,
      claudeSessionId:
        (data.claude_session_id as string) || (data.claudeSessionId as string) || undefined,
    };

    // NOTE: The composite key (source_agent, target_agent, created_at) is a
    // best-effort deduplication strategy. Two distinct transformation events
    // between the same agents within the same second-level timestamp will
    // collide and the second will be silently dropped. If transformation
    // events gain a correlation_id or unique event ID in the future, that
    // field should be used as the deduplication target instead.
    await db
      .insert(agentTransformationEvents)
      .values(row)
      .onConflictDoNothing({
        target: [
          agentTransformationEvents.sourceAgent,
          agentTransformationEvents.targetAgent,
          agentTransformationEvents.createdAt,
        ],
      });

    return true;
  }

  /**
   * Project a pattern enforcement event into the `pattern_enforcement_events` table.
   *
   * The table is created by a SQL migration (see migrations/).
   * Returns true when written, false when the DB is unavailable.
   *
   * Deduplication key: (correlation_id) -- each evaluation has a unique correlation ID.
   * Falls back to a deterministic hash when correlation_id is absent.
   */
  private async projectEnforcementEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    // Returning false means this event will be re-processed when the DB
    // reconnects — the consumer watermark is not advanced.
    if (!db) return false;

    // Coerce the raw event into a typed shape
    const evt = data as Partial<PatternEnforcementEvent>;

    const correlationId =
      (evt.correlation_id as string) ||
      (data.correlationId as string) || // camelCase fallback for producers that serialize without snake_case transform
      fallbackId;

    // outcome is required -- a missing value indicates a malformed event.
    // Do NOT default to 'hit' or any other value; that would silently inflate
    // hit counts and corrupt the enforcement metrics.
    if (evt.outcome == null) {
      console.warn(
        '[ReadModelConsumer] Enforcement event missing required "outcome" field ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true; // Treat as "handled" so we advance the watermark
    }
    const outcome = evt.outcome;
    if (!['hit', 'violation', 'corrected', 'false_positive'].includes(outcome)) {
      console.warn('[ReadModelConsumer] Unknown enforcement outcome:', outcome, '-- skipping');
      return true; // Treat as "handled" so we advance the watermark
    }

    // pattern_name is required -- a missing value indicates a malformed event.
    // Do NOT default to 'unknown'; that would silently aggregate unidentifiable
    // patterns and corrupt per-pattern enforcement metrics.
    const patternName = (evt.pattern_name as string) || (data.patternName as string);
    if (!patternName) {
      console.warn(
        '[ReadModelConsumer] Enforcement event missing required "pattern_name" field ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true; // Treat as "handled" so we advance the watermark
    }

    let insertedRowCount = 0;
    try {
      const result = await db.execute(sql`
        INSERT INTO pattern_enforcement_events (
          correlation_id,
          session_id,
          repo,
          language,
          domain,
          pattern_name,
          pattern_lifecycle_state,
          outcome,
          confidence,
          agent_name,
          created_at
        ) VALUES (
          ${correlationId},
          ${(evt.session_id as string) ?? null},
          ${(evt.repo as string) ?? null},
          ${(evt.language as string) ?? 'unknown'},
          ${(evt.domain as string) ?? 'unknown'},
          ${patternName},
          ${(evt.pattern_lifecycle_state as string) ?? null},
          ${outcome},
          ${evt.confidence != null ? Number(evt.confidence) : null},
          ${(evt.agent_name as string) ?? null},
          ${safeParseDate(evt.timestamp)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
      // Track inserted row count to suppress WebSocket invalidation on duplicate events.
      // ON CONFLICT DO NOTHING produces rowCount=0 for duplicates; no invalidation needed.
      const rawRowCount = (result as unknown as Record<string, unknown>).rowCount;
      if (typeof rawRowCount === 'number') {
        insertedRowCount = rawRowCount;
      } else {
        console.warn(
          `[ReadModelConsumer] enforcement INSERT: rowCount not found in result shape — WebSocket invalidation suppressed. Actual type: ${typeof rawRowCount}`
        );
        insertedRowCount = 0;
      }
    } catch (err) {
      // If the table doesn't exist yet, warn and return true to advance the
      // watermark so the consumer is not stuck retrying indefinitely.
      // The table is created by a SQL migration; until that migration runs we
      // degrade gracefully and skip enforcement events.
      //
      // Primary check: PostgreSQL error code 42P01 ("undefined_table").
      // The pg / @neondatabase/serverless driver surfaces this as a `.code`
      // property on the thrown Error object.
      // Fallback string check retained for defensive coverage in case the
      // driver wraps the error in a way that omits the code property.
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('pattern_enforcement_events') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] pattern_enforcement_events table not yet created -- ' +
            'run migrations to enable enforcement projection'
        );
        return true;
      }
      throw err;
    }

    // Notify WebSocket clients subscribed to the 'enforcement' topic only when
    // a new row was genuinely inserted (rowCount > 0). Duplicate events produce
    // rowCount=0 via ON CONFLICT DO NOTHING and should not trigger invalidation.
    if (insertedRowCount > 0) {
      try {
        emitEnforcementInvalidate(correlationId);
      } catch (e) {
        console.warn('[ReadModelConsumer] emitEnforcementInvalidate() failed post-commit:', e);
      }
    }

    return true;
  }

  /**
   * Project a context enrichment event into the `context_enrichment_events` table.
   *
   * The table is created by SQL migration 0005b_context_enrichment_events.sql.
   * Returns true when written, false when the DB is unavailable.
   *
   * Deduplication key: (correlation_id) — each enrichment operation has a
   * unique correlation ID. Falls back to a deterministic hash when absent.
   *
   * GOLDEN METRIC: net_tokens_saved > 0 means the enrichment delivered value.
   * Rows with outcome = 'inflated' are context inflation alerts.
   */
  private async projectEnrichmentEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const evt = data as Partial<ContextEnrichmentEvent>;

    const correlationId =
      (evt.correlation_id as string) || (data.correlationId as string) || fallbackId;

    // outcome is required — missing value indicates a malformed event.
    // Do NOT default; that would silently corrupt enrichment metrics.
    const outcome = evt.outcome;
    if (outcome == null) {
      console.warn(
        '[ReadModelConsumer] Enrichment event missing required "outcome" field ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true; // Advance watermark so consumer is not stuck
    }
    if (!(ENRICHMENT_OUTCOMES as readonly string[]).includes(outcome)) {
      console.warn('[ReadModelConsumer] Unknown enrichment outcome:', outcome, '-- skipping');
      return true;
    }

    // channel is required — missing value indicates a malformed event.
    // evt = data as Partial<ContextEnrichmentEvent>, so evt.channel already covers data.channel.
    const channel = evt.channel as string | undefined;
    if (!channel) {
      console.warn(
        '[ReadModelConsumer] Enrichment event missing required "channel" field ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true;
    }

    let insertedRowCount = 0;
    try {
      const result = await db.execute(sql`
        INSERT INTO context_enrichment_events (
          correlation_id,
          session_id,
          channel,
          model_name,
          cache_hit,
          outcome,
          latency_ms,
          tokens_before,
          tokens_after,
          net_tokens_saved,
          similarity_score,
          quality_score,
          repo,
          agent_name,
          created_at
        ) VALUES (
          ${correlationId},
          ${(evt.session_id as string) ?? null},
          ${channel},
          ${(evt.model_name as string) ?? 'unknown'},
          ${Boolean(evt.cache_hit ?? false)},
          ${outcome},
          ${Number.isNaN(Number(evt.latency_ms)) ? 0 : Math.round(Number(evt.latency_ms ?? 0))},
          ${Number.isNaN(Number(evt.tokens_before)) ? 0 : Math.round(Number(evt.tokens_before ?? 0))},
          ${Number.isNaN(Number(evt.tokens_after)) ? 0 : Math.round(Number(evt.tokens_after ?? 0))},
          ${Number.isNaN(Number(evt.net_tokens_saved)) ? 0 : Math.round(Number(evt.net_tokens_saved ?? 0))},
          ${evt.similarity_score != null && !Number.isNaN(Number(evt.similarity_score)) ? Number(evt.similarity_score) : null},
          ${evt.quality_score != null && !Number.isNaN(Number(evt.quality_score)) ? Number(evt.quality_score) : null},
          ${(evt.repo as string) ?? null},
          ${(evt.agent_name as string) ?? null},
          ${safeParseDate(evt.timestamp)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
      // db.execute() with raw SQL returns the underlying pg/Neon QueryResult,
      // which carries `rowCount`: the number of rows actually written by the
      // INSERT.  When the ON CONFLICT … DO NOTHING clause suppresses a
      // duplicate the command completes without error but rowCount is 0.
      //
      // The pg socket driver initialises rowCount to null and populates it
      // from the CommandComplete message; the Neon HTTP driver always returns
      // a numeric rowCount.  Both paths therefore produce number | null.
      //
      // We avoid a blind `as { rowCount?: number | null }` cast, which would
      // silently evaluate to 0 if the result object has an unexpected shape
      // (e.g. a future Drizzle version wraps the raw result differently).
      // Instead we use a typeof guard so that any shape mismatch is visible
      // as a NaN/undefined at runtime rather than a silent zero.
      const rawRowCount = (result as unknown as Record<string, unknown>).rowCount;
      if (typeof rawRowCount === 'number') {
        insertedRowCount = rawRowCount;
      } else {
        // console.error (not warn) is intentional: a shape change here means
        // WebSocket invalidation is silently suppressed for all enrichment
        // inserts until the code is updated. This must be visible and alarming
        // in production logs so on-call engineers notice it immediately.
        console.error(
          `[ReadModelConsumer] enrichment INSERT: rowCount not found in result shape — WebSocket invalidation suppressed. Shape may have changed. Actual type of rawRowCount: ${typeof rawRowCount}`
        );
        // TODO: Add a structured metric/counter here so shape changes are
        // detectable in production monitoring without requiring log scraping.
        // Track as a follow-up ticket after OMN-2373 merges.
        insertedRowCount = 0;
      }
    } catch (err) {
      // If the table doesn't exist yet (migration not run), degrade gracefully
      // and advance the watermark so the consumer is not stuck retrying.
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('context_enrichment_events') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] context_enrichment_events table not yet created -- ' +
            'run migrations to enable enrichment projection'
        );
        return true;
      }
      throw err;
    }

    // Notify WebSocket clients subscribed to the 'enrichment' topic only when
    // a new row was genuinely inserted (rowCount > 0).  When the ON CONFLICT
    // clause suppresses a duplicate the insert is a no-op and rowCount is 0;
    // emitting in that case would cause spurious WebSocket invalidation
    // broadcasts on every duplicate event. (OMN-2373)
    //
    // NOTE (at-least-once edge case): the emit fires after the DB commit but
    // before the watermark is advanced by the caller.  If the process crashes
    // in this narrow window, Kafka redelivers the message, ON CONFLICT DO
    // NOTHING fires (rowCount=0), and no second invalidation is emitted.
    // Clients that connected during the window may miss one real-time update;
    // they will receive the correct data on their next poll. This is an
    // inherent at-least-once delivery trade-off: moving the emit to after
    // watermark advancement would close the window but add complexity.  The
    // chosen ordering (emit before watermark) prioritises real-time freshness
    // for the common case over theoretical crash-recovery purity.
    if (insertedRowCount > 0) {
      // Wrapped defensively: a failure here must not block watermark advancement.
      try {
        emitEnrichmentInvalidate(correlationId);
      } catch (e) {
        console.warn('[ReadModelConsumer] emitEnrichmentInvalidate() failed post-commit:', e);
      }
    }

    return true;
  }

  /**
   * Project an LLM routing decision event into the `llm_routing_decisions` table (OMN-2279).
   *
   * The table is created by SQL migration 0006b_llm_routing_decisions.sql.
   * Returns true when written, false when the DB is unavailable.
   *
   * Deduplication key: (correlation_id) — each routing decision has a unique
   * correlation ID. Falls back to a deterministic hash when absent.
   *
   * GOLDEN METRIC: agreement_rate (agreed / (agreed + disagreed)) > 60%.
   * Alert if disagreement rate exceeds 40%.
   */
  private async projectLlmRoutingDecisionEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const evt = data as Partial<LlmRoutingDecisionEvent>;

    // correlation_id column is uuid type (OMN-2960).  Validate the value from
    // the event before inserting so Postgres never receives a malformed string.
    // The fallbackId is always a valid UUID (derived deterministically from
    // Kafka message coordinates — see deriveMessageId above).
    const rawCorrelationId =
      (evt.correlation_id as string) || (data.correlationId as string) || fallbackId;
    if (!UUID_RE.test(rawCorrelationId)) {
      console.warn(
        '[ReadModelConsumer] LLM routing decision event has non-UUID correlation_id ' +
          `(${rawCorrelationId}) -- skipping malformed event`
      );
      return true;
    }
    const correlationId = rawCorrelationId;

    // The omniclaude producer (ModelLlmRoutingDecisionPayload) uses:
    //   selected_agent        → the LLM-chosen agent
    //   fuzzy_top_candidate   → the fuzzy-chosen agent (nullable when fallback_used=true)
    //   fallback_used         → whether the fuzzy fallback was used
    //   model_used            → the LLM model identifier
    //   emitted_at            → event timestamp
    //
    // The TypeScript LlmRoutingDecisionEvent interface was originally drafted with
    // different field names (llm_agent, fuzzy_agent, used_fallback, model, timestamp).
    // We probe both names so the projector handles both the real omniclaude events
    // and any future events that conform to the interface spec. (OMN-2920 gap fix)
    const llmAgent =
      (data.selected_agent as string) ||
      (data.llm_selected_candidate as string) ||
      (evt.llm_agent as string) ||
      (data.llmAgent as string);
    // fuzzy_top_candidate is nullable when the LLM fell back to the fuzzy result
    // and no fuzzy candidate was available. Treat as empty string rather than
    // dropping the event — the row is still useful for fallback_rate metrics.
    const fuzzyAgent =
      (data.fuzzy_top_candidate as string | null) ??
      (evt.fuzzy_agent as string) ??
      (data.fuzzyAgent as string) ??
      null;

    if (!llmAgent) {
      console.warn(
        '[ReadModelConsumer] LLM routing decision event missing required llm_agent/selected_agent field ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      // Intentionally return true (advance the watermark) rather than throwing or
      // routing to a dead-letter queue. This follows the established pattern used
      // throughout this consumer for unrecoverable schema violations: logging a
      // warning and moving on keeps the consumer unblocked and prevents a single
      // malformed event from stalling the entire projection. If dead-letter queue
      // support is added in the future, replace this return with a DLQ publish.
      return true;
    }

    // routing_prompt_version is required — missing value makes longitudinal
    // comparison by version impossible. Default to 'unknown' rather than
    // dropping the event so overall agreement_rate metrics remain accurate.
    const routingPromptVersion =
      (evt.routing_prompt_version as string) || (data.routingPromptVersion as string) || 'unknown';

    // used_fallback: omniclaude emits fallback_used; interface spec uses used_fallback.
    const usedFallback = Boolean(
      (data.fallback_used as boolean | undefined) ??
      (evt.used_fallback as boolean | undefined) ??
      false
    );

    // OMN-2920: fallbacks are routing failures, not decisions — skip projection so
    // the llm_routing_decisions table only contains genuine LLM routing decisions.
    // This prevents fallback noise from polluting agreement_rate metrics.
    if (usedFallback) {
      return true; // advance watermark; do not write a row
    }

    // model: omniclaude emits model_used; interface spec uses model.
    const model = (data.model_used as string | null) ?? (evt.model as string | null) ?? null;

    // timestamp: omniclaude emits emitted_at; interface spec uses timestamp.
    const eventTimestamp =
      (data.emitted_at as string | null) ?? (evt.timestamp as string | null) ?? null;

    const agreement =
      evt.agreement != null
        ? Boolean(evt.agreement)
        : fuzzyAgent != null
          ? llmAgent === fuzzyAgent
          : usedFallback; // when fuzzy candidate is absent, agreement is implied by fallback

    // Token fields (OMN-3449) — present in events emitted after OMN-3448.
    // Default to 0 for pre-Task-5 events that lack these fields.
    const promptTokens = Number(evt.prompt_tokens ?? 0);
    const completionTokens = Number(evt.completion_tokens ?? 0);
    // Derive total_tokens from components when the event provides 0 but components are non-zero.
    const rawTotalTokens = Number(evt.total_tokens ?? 0);
    const totalTokens =
      rawTotalTokens === 0 && (promptTokens > 0 || completionTokens > 0)
        ? promptTokens + completionTokens
        : rawTotalTokens;
    const omninodeEnabled = evt.omninode_enabled !== false; // default true when absent

    try {
      await db.execute(sql`
        INSERT INTO llm_routing_decisions (
          correlation_id,
          session_id,
          llm_agent,
          fuzzy_agent,
          agreement,
          llm_confidence,
          fuzzy_confidence,
          llm_latency_ms,
          fuzzy_latency_ms,
          used_fallback,
          routing_prompt_version,
          intent,
          model,
          cost_usd,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          omninode_enabled,
          created_at
        ) VALUES (
          ${correlationId},
          ${(evt.session_id as string) ?? null},
          ${llmAgent},
          ${fuzzyAgent ?? null},
          ${agreement},
          ${evt.llm_confidence != null && !Number.isNaN(Number(evt.llm_confidence)) ? Number(evt.llm_confidence) : null},
          ${evt.fuzzy_confidence != null && !Number.isNaN(Number(evt.fuzzy_confidence)) ? Number(evt.fuzzy_confidence) : null},
          ${Number.isNaN(Number(evt.llm_latency_ms)) ? 0 : Math.round(Number(evt.llm_latency_ms ?? 0))},
          ${Number.isNaN(Number(evt.fuzzy_latency_ms)) ? 0 : Math.round(Number(evt.fuzzy_latency_ms ?? 0))},
          ${usedFallback},
          ${routingPromptVersion},
          ${(evt.intent as string) ?? null},
          ${model},
          ${evt.cost_usd != null && !Number.isNaN(Number(evt.cost_usd)) ? Number(evt.cost_usd) : null},
          ${promptTokens},
          ${completionTokens},
          ${totalTokens},
          ${omninodeEnabled},
          ${safeParseDate(eventTimestamp)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      // If the table doesn't exist yet (migration not run), degrade gracefully
      // and advance the watermark so the consumer is not stuck retrying.
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('llm_routing_decisions') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] llm_routing_decisions table not yet created -- ' +
            'run migrations to enable LLM routing projection'
        );
        return true;
      }
      throw err;
    }

    // Invalidate the LLM routing projection cache so the next API request
    // returns fresh data from the newly projected decision.
    // Wrapped defensively: a failure here must not block watermark advancement —
    // the DB write has already committed successfully.
    try {
      llmRoutingProjection.invalidateCache();
    } catch (e) {
      console.warn(
        '[read-model-consumer] llmRoutingProjection.invalidateCache() failed post-commit:',
        e
      );
    }

    // Notify WebSocket clients subscribed to the 'llm-routing' topic.
    // Called here (after the try/catch) so clients are only notified when
    // the DB write has committed successfully.
    emitLlmRoutingInvalidate(correlationId);

    return true;
  }

  /**
   * Project a task-delegated event into the `delegation_events` table (OMN-2284).
   *
   * Deduplication key: (correlation_id) — each delegation has a unique correlation ID.
   * Falls back to a deterministic hash when absent.
   *
   * GOLDEN METRIC: quality_gate_pass_rate > 80%.
   */
  private async projectTaskDelegatedEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const evt = data as Partial<TaskDelegatedEvent>;

    const correlationId =
      (evt.correlation_id as string) || (data.correlationId as string) || fallbackId;

    const taskType = (evt.task_type as string) || (data.taskType as string);
    const delegatedTo = (evt.delegated_to as string) || (data.delegatedTo as string);
    if (!taskType || !delegatedTo) {
      console.warn(
        '[ReadModelConsumer] task-delegated event missing required fields ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true;
    }

    const row: InsertDelegationEvent = {
      correlationId,
      sessionId: (evt.session_id as string) || (data.sessionId as string) || null,
      timestamp: safeParseDate(evt.timestamp),
      taskType,
      delegatedTo,
      delegatedBy: (evt.delegated_by as string) || (data.delegatedBy as string) || null,
      qualityGatePassed: Boolean(evt.quality_gate_passed ?? data.qualityGatePassed ?? false),
      qualityGatesChecked:
        evt.quality_gates_checked ??
        (data.qualityGatesChecked as string[] | null | undefined) ??
        null,
      qualityGatesFailed:
        evt.quality_gates_failed ??
        (data.qualityGatesFailed as string[] | null | undefined) ??
        null,
      costUsd: (() => {
        const v = evt.cost_usd ?? data.costUsd;
        return v != null && !Number.isNaN(Number(v)) ? String(Number(v)) : null;
      })(),
      costSavingsUsd: (() => {
        const v = evt.cost_savings_usd ?? data.costSavingsUsd;
        return v != null && !Number.isNaN(Number(v)) ? String(Number(v)) : null;
      })(),
      delegationLatencyMs: (() => {
        const v = evt.delegation_latency_ms ?? data.delegationLatencyMs;
        return v != null && !Number.isNaN(Number(v)) ? Math.round(Number(v)) : null;
      })(),
      repo: (evt.repo as string) || (data.repo as string) || null,
      isShadow: Boolean(evt.is_shadow ?? data.isShadow ?? false),
    };

    try {
      await db
        .insert(delegationEvents)
        .values(row)
        .onConflictDoNothing({ target: delegationEvents.correlationId });
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('delegation_events') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] delegation_events table not yet created -- ' +
            'run migrations to enable delegation projection'
        );
        return true;
      }
      throw err;
    }

    emitDelegationInvalidate(correlationId);
    return true;
  }

  /**
   * Project a delegation-shadow-comparison event into the
   * `delegation_shadow_comparisons` table (OMN-2284).
   *
   * Deduplication key: (correlation_id) — each comparison has a unique correlation ID.
   */
  private async projectDelegationShadowComparisonEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const evt = data as Partial<DelegationShadowComparisonEvent>;

    const correlationId =
      (evt.correlation_id as string) || (data.correlationId as string) || fallbackId;

    const taskType = (evt.task_type as string) || (data.taskType as string);
    const primaryAgent = (evt.primary_agent as string) || (data.primaryAgent as string);
    const shadowAgent = (evt.shadow_agent as string) || (data.shadowAgent as string);
    if (!taskType || !primaryAgent || !shadowAgent) {
      console.warn(
        '[ReadModelConsumer] delegation-shadow-comparison event missing required fields ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true;
    }

    const row: InsertDelegationShadowComparison = {
      correlationId,
      sessionId: (evt.session_id as string) || (data.sessionId as string) || null,
      timestamp: safeParseDate(evt.timestamp),
      taskType,
      primaryAgent,
      shadowAgent,
      divergenceDetected: Boolean(evt.divergence_detected ?? data.divergenceDetected ?? false),
      divergenceScore: (() => {
        const v = evt.divergence_score ?? data.divergenceScore;
        return v != null && !Number.isNaN(Number(v)) ? String(Number(v)) : null;
      })(),
      primaryLatencyMs: (() => {
        const v = evt.primary_latency_ms ?? data.primaryLatencyMs;
        return v != null && !Number.isNaN(Number(v)) ? Math.round(Number(v)) : null;
      })(),
      shadowLatencyMs: (() => {
        const v = evt.shadow_latency_ms ?? data.shadowLatencyMs;
        return v != null && !Number.isNaN(Number(v)) ? Math.round(Number(v)) : null;
      })(),
      primaryCostUsd: (() => {
        const v = evt.primary_cost_usd ?? data.primaryCostUsd;
        return v != null && !Number.isNaN(Number(v)) ? String(Number(v)) : null;
      })(),
      shadowCostUsd: (() => {
        const v = evt.shadow_cost_usd ?? data.shadowCostUsd;
        return v != null && !Number.isNaN(Number(v)) ? String(Number(v)) : null;
      })(),
      divergenceReason:
        (evt.divergence_reason as string) || (data.divergenceReason as string) || null,
    };

    try {
      await db
        .insert(delegationShadowComparisons)
        .values(row)
        .onConflictDoNothing({ target: delegationShadowComparisons.correlationId });
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('delegation_shadow_comparisons') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] delegation_shadow_comparisons table not yet created -- ' +
            'run migrations to enable delegation shadow projection'
        );
        return true;
      }
      throw err;
    }

    emitDelegationInvalidate(correlationId);
    return true;
  }

  /**
   * Project a LLM call completed event into the `llm_cost_aggregates` table.
   *
   * OMN-2371 (GAP-5): Previously consumed 'onex.evt.omniclaude.llm-cost-reported.v1'
   * which had zero producers. Now consuming the canonical topic
   * 'onex.evt.omniintelligence.llm-call-completed.v1' emitted by NodeLlmInferenceEffect
   * in omnibase_infra per each LLM API call.
   *
   * Payload schema: ContractLlmCallMetrics (omnibase_spi/contracts/measurement)
   *   - model_id: string — LLM model identifier
   *   - prompt_tokens / completion_tokens / total_tokens: number
   *   - estimated_cost_usd: number | null — the only cost field in this contract
   *   - usage_normalized: { source: 'API'|'ESTIMATED'|'MISSING', ... } | null
   *   - usage_is_estimated: boolean — top-level estimation flag
   *   - timestamp_iso: ISO-8601 string — call timestamp
   *   - reporting_source: string — provenance label (e.g. 'pipeline-agent', repo name)
   *
   * Each event maps to a single llm_cost_aggregates row with granularity='hour'.
   * The cost trend queries bucket rows via date_trunc() on bucket_time.
   *
   * Deduplication: no natural unique key exists on llm_cost_aggregates
   * (multiple calls for the same model+session are valid). INSERT without ON CONFLICT;
   * idempotency is achieved via Kafka consumer group offset tracking.
   *
   * Returns true when written, false when the DB is unavailable.
   */
  private async projectLlmCostEvent(data: Record<string, unknown>): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    // Resolve bucket_time from ContractLlmCallMetrics.timestamp_iso or fallbacks.
    // ContractLlmCallMetrics uses 'timestamp_iso' as the primary timestamp field.
    const bucketTime = safeParseDate(
      data.timestamp_iso ?? data.bucket_time ?? data.bucketTime ?? data.timestamp ?? data.created_at
    );

    // usage_source: prefer the nested usage_normalized.source (ContractLlmCallMetrics schema),
    // then fall back to top-level usage_source / usageSource (legacy schema compat).
    // Must be one of 'API' | 'ESTIMATED' | 'MISSING'.
    const usageNormalized = data.usage_normalized as Record<string, unknown> | null | undefined;
    const usageSourceRaw =
      (usageNormalized?.source as string) ||
      (data.usage_source as string) ||
      (data.usageSource as string) ||
      (data.usage_is_estimated ? 'ESTIMATED' : 'API');
    const usageSourceUpper = usageSourceRaw.toUpperCase();
    const validUsageSources = ['API', 'ESTIMATED', 'MISSING'] as const;
    const usageSource = validUsageSources.includes(
      usageSourceUpper as (typeof validUsageSources)[number]
    )
      ? (usageSourceUpper as 'API' | 'ESTIMATED' | 'MISSING')
      : 'API';
    if (
      !validUsageSources.includes(usageSourceUpper as (typeof validUsageSources)[number]) &&
      usageSourceRaw
    ) {
      console.warn(
        `[ReadModelConsumer] LLM cost event has unrecognised usage_source "${usageSourceRaw}" — defaulting to "API"`
      );
    }

    // granularity: always 'hour' for per-call events from ContractLlmCallMetrics.
    // Pre-aggregated events may carry an explicit 'day' granularity — respect it.
    const granularityRaw = (data.granularity as string) || 'hour';
    const granularity = ['hour', 'day'].includes(granularityRaw) ? granularityRaw : 'hour';

    const promptTokens = Number(data.prompt_tokens ?? data.promptTokens ?? 0);
    const completionTokens = Number(data.completion_tokens ?? data.completionTokens ?? 0);
    const rawTotalTokens = Number(data.total_tokens ?? data.totalTokens ?? 0);
    const derivedTotal = promptTokens + completionTokens;

    // Token total reconciliation:
    // If the event reports total_tokens = 0 but component counts are non-zero,
    // the upstream producer emitted an inconsistent payload — derive the total
    // from its components so we never store a misleading 0.
    // If all three are non-zero but the reported total disagrees with the sum,
    // log a warning and trust the event-supplied total (don't silently correct it;
    // the upstream source of truth may intentionally differ, e.g. cached tokens).
    let totalTokens: number;
    if (rawTotalTokens === 0 && derivedTotal > 0) {
      totalTokens = derivedTotal;
    } else {
      if (rawTotalTokens !== 0 && derivedTotal !== 0 && rawTotalTokens !== derivedTotal) {
        console.warn(
          `[ReadModelConsumer] LLM cost event token total mismatch: ` +
            `total_tokens=${rawTotalTokens} but prompt_tokens(${promptTokens}) + completion_tokens(${completionTokens}) = ${derivedTotal}. ` +
            `Storing event-supplied total.`
        );
      }
      totalTokens = rawTotalTokens;
    }

    // Cost field mapping for ContractLlmCallMetrics:
    // The contract only has estimated_cost_usd (no separate reported_cost_usd).
    // When a payload has no explicit total_cost_usd / totalCostUsd, fall back to
    // rawEstimatedCost so the cost-trend dashboard has a meaningful total value.
    // Legacy pre-aggregated events may carry explicit total_cost_usd / reported_cost_usd.
    //
    // Coerce to finite number, defaulting to 0 for any non-numeric value (including
    // false, '', NaN, Infinity). String(false) → 'false' fails PostgreSQL numeric columns.
    const rawEstimatedCost = data.estimated_cost_usd ?? data.estimatedCostUsd;
    const nEstimatedCost = Number(rawEstimatedCost);
    const estimatedCostUsd = String(Number.isFinite(nEstimatedCost) ? nEstimatedCost : 0);

    const rawTotalCost = data.total_cost_usd ?? data.totalCostUsd ?? rawEstimatedCost;
    const nTotalCost = Number(rawTotalCost);
    const totalCostUsd = String(Number.isFinite(nTotalCost) ? nTotalCost : 0);

    const rawReportedCost = data.reported_cost_usd ?? data.reportedCostUsd;
    const nReportedCost = Number(rawReportedCost);
    // reported_cost_usd: use explicit field if present, else fall back to 0.
    // ContractLlmCallMetrics does not carry reported_cost_usd separately.
    const reportedCostUsd = String(Number.isFinite(nReportedCost) ? nReportedCost : 0);

    // model_name: ContractLlmCallMetrics uses 'model_id'; also accept 'model_name' for
    // legacy compatibility.
    const modelName =
      (data.model_id as string) ||
      (data.model_name as string) ||
      (data.modelName as string) ||
      'unknown';

    // repo_name: ContractLlmCallMetrics uses 'reporting_source' as the provenance label.
    // Expected value space: short, slug-style identifiers such as 'omniclaude',
    // 'omniclaude-node', or 'pipeline-agent' — the canonical name of the service or
    // repository that emitted the event.  These identifiers contain no whitespace and
    // are well under 64 characters, so we use those two properties as a heuristic to
    // distinguish a valid repo name from a free-form description that a producer may
    // occasionally put in reporting_source.  Limitation: a descriptive string that
    // happens to be short and space-free (e.g. "adhoc") would also pass — but that is
    // an acceptable false-positive because the field still provides a useful grouping
    // key in the cost-aggregate table.  Explicit repo_name / repoName fields from
    // legacy payloads always take precedence and bypass this heuristic entirely.
    const reportingSource = (data.reporting_source as string) || (data.reportingSource as string);
    const explicitRepo = (data.repo_name as string) || (data.repoName as string);
    const repoName =
      explicitRepo ||
      (reportingSource && reportingSource.length < 64 && !/\s/.test(reportingSource)
        ? reportingSource
        : undefined);

    const row: InsertLlmCostAggregate = {
      bucketTime,
      granularity,
      modelName,
      repoName,
      patternId: (data.pattern_id as string) || (data.patternId as string) || undefined,
      patternName: (data.pattern_name as string) || (data.patternName as string) || undefined,
      sessionId: (data.session_id as string) || (data.sessionId as string) || undefined,
      usageSource,
      requestCount: Number(data.request_count ?? data.requestCount ?? 1),
      promptTokens,
      completionTokens,
      totalTokens,
      totalCostUsd,
      reportedCostUsd,
      estimatedCostUsd,
    };

    // Validate that model_name is not 'unknown' when the event carries one.
    // Check the DERIVED row value rather than the raw event fields — the raw
    // field check (data.model_id == null) misses the case where the event
    // sends model_id: '' which is coerced to 'unknown' by the || fallback.
    if (row.modelName === 'unknown') {
      console.warn(
        '[ReadModelConsumer] LLM cost event missing model_id/model_name — inserting as "unknown"'
      );
    }

    try {
      await db.insert(llmCostAggregates).values(row);
    } catch (err) {
      // If the table doesn't exist yet, warn and return true to advance the
      // watermark so the consumer is not stuck retrying indefinitely.
      // The table is created by a SQL migration; until that migration runs we
      // degrade gracefully and skip LLM cost events.
      //
      // Primary check: PostgreSQL error code 42P01 ("undefined_table").
      // The pg / @neondatabase/serverless driver surfaces this as a `.code`
      // property on the thrown Error object.
      // Fallback string check retained for defensive coverage in case the
      // driver wraps the error in a way that omits the code property.
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('llm_cost_aggregates') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] llm_cost_aggregates table not yet created -- ' +
            'run migrations to enable LLM cost projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  /**
   * Project a baselines snapshot event into the baselines_* tables (OMN-2331).
   *
   * Upserts the snapshot header into baselines_snapshots, then atomically
   * replaces child rows (comparisons, trend, breakdown) for that snapshot_id.
   * The replacement is delete-then-insert: old rows for the same snapshot_id
   * are deleted first so re-delivery of the same event is safe (idempotent).
   *
   * Returns true when written, false when the DB is unavailable.
   */
  private async projectBaselinesSnapshot(
    data: Record<string, unknown>,
    partition: number,
    offset: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    // snapshot_id is required — it is the dedup key.
    // Fall back to a deterministic hash when snapshot_id is absent OR when it
    // is present but not a valid UUID (e.g. a slug or opaque string). PostgreSQL
    // uuid primary key columns reject malformed values with a runtime error; a
    // truthy-but-non-UUID snapshot_id would bypass the falsy guard below and
    // crash the DB transaction.
    // NOTE: If this event is later re-delivered with a valid snapshot_id,
    // a second orphaned snapshot row will result (no automatic reconciliation).
    // This hash-based ID is a best-effort fallback for malformed events only.
    const rawSnapshotId = data.snapshot_id as string | undefined;
    const snapshotId =
      rawSnapshotId && UUID_RE.test(rawSnapshotId)
        ? rawSnapshotId
        : deterministicCorrelationId('baselines-computed', partition, offset);

    // String(null) → 'null', String(undefined) → 'undefined', String(0) → '0'.
    // parseInt('null', 10) and parseInt('undefined', 10) both return NaN, which
    // falls through to the || 1 default. A previous ?? '' guard was dead code:
    // String() never produces '' for null or undefined, so the guard was never
    // reached. Removed in favour of the simpler two-step form below.
    const contractVersion = parseInt(String(data.contract_version), 10) || 1;
    // Use safeParseDateOrMin so that a missing/malformed computedAtUtc sorts
    // as oldest (epoch-zero) rather than newest (wall-clock), preventing a
    // bad event from masquerading as the latest snapshot.
    const computedAtUtc = safeParseDateOrMin(
      data.computed_at_utc ?? data.computedAtUtc ?? data.computed_at
    );
    const windowStartUtc = data.window_start_utc
      ? safeParseDate(data.window_start_utc)
      : data.windowStartUtc
        ? safeParseDate(data.windowStartUtc)
        : null;
    const windowEndUtc = data.window_end_utc
      ? safeParseDate(data.window_end_utc)
      : data.windowEndUtc
        ? safeParseDate(data.windowEndUtc)
        : null;

    // Parse child arrays from the event payload.
    // These may be under camelCase or snake_case keys depending on producer.
    //
    // Guard against PostgreSQL's hard limit of 65535 parameters per query.
    // Each child-table row has at most 14 explicit user params (comparisons),
    // giving a safe ceiling of 4681 rows. Cap at MAX_BATCH_ROWS (module-scope
    // constant) to leave headroom. Log a warning when the cap fires so
    // operators can investigate abnormally large upstream events.
    const rawComparisonsAll = Array.isArray(data.comparisons) ? data.comparisons : [];
    if (rawComparisonsAll.length > MAX_BATCH_ROWS) {
      console.warn(
        `[ReadModelConsumer] baselines snapshot ${snapshotId} contains ` +
          `${rawComparisonsAll.length} comparison rows — capping at ${MAX_BATCH_ROWS} to avoid ` +
          `PostgreSQL parameter limit (65535). Excess rows will be dropped for this snapshot.`
      );
    }
    const rawComparisons = rawComparisonsAll.slice(0, MAX_BATCH_ROWS);

    const rawTrendAll = Array.isArray(data.trend) ? data.trend : [];
    if (rawTrendAll.length > MAX_BATCH_ROWS) {
      console.warn(
        `[ReadModelConsumer] baselines snapshot ${snapshotId} contains ` +
          `${rawTrendAll.length} trend rows — capping at ${MAX_BATCH_ROWS} to avoid ` +
          `PostgreSQL parameter limit (65535). Excess rows will be dropped for this snapshot.`
      );
    }
    const rawTrend = rawTrendAll.slice(0, MAX_BATCH_ROWS);

    const rawBreakdownAll = Array.isArray(data.breakdown) ? data.breakdown : [];
    if (rawBreakdownAll.length > MAX_BATCH_ROWS) {
      console.warn(
        `[ReadModelConsumer] baselines snapshot ${snapshotId} contains ` +
          `${rawBreakdownAll.length} breakdown rows — capping at ${MAX_BATCH_ROWS} to avoid ` +
          `PostgreSQL parameter limit (65535). Excess rows will be dropped for this snapshot.`
      );
    }
    const rawBreakdown = rawBreakdownAll.slice(0, MAX_BATCH_ROWS);

    // Build the filtered trend rows outside the transaction so the post-filter
    // count is accessible for the success log below (Issue 1 fix).
    const trendRows: InsertBaselinesTrend[] = (rawTrend as Record<string, unknown>[])
      .filter((t) => {
        const date = t.date ?? t.dateStr;
        if (date == null || date === '') {
          console.warn(
            '[ReadModelConsumer] Skipping trend row with blank/null date:',
            JSON.stringify(t)
          );
          return false;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
          console.warn(
            '[ReadModelConsumer] Skipping trend row with malformed date format (expected YYYY-MM-DD):',
            JSON.stringify(t)
          );
          return false;
        }
        return true;
      })
      .map((t) => ({
        snapshotId,
        date: String(t.date ?? t.dateStr),
        // NUMERIC(8,6) column: max 99.999999. Clamp to [0, 99] to prevent
        // PostgreSQL overflow if producer sends percentage-scale values (e.g. 12.5%).
        avgCostSavings: String(
          Math.min(Math.max(Number(t.avg_cost_savings ?? t.avgCostSavings ?? 0), 0), 99)
        ),
        avgOutcomeImprovement: String(
          Math.min(
            Math.max(Number(t.avg_outcome_improvement ?? t.avgOutcomeImprovement ?? 0), 0),
            99
          )
        ),
        comparisonsEvaluated: Number(t.comparisons_evaluated ?? t.comparisonsEvaluated ?? 0),
      }));

    // Deduplicate trend rows by date to prevent duplicate date inserts that would
    // inflate projection averages. Migration 0005 adds a UNIQUE(snapshot_id, date)
    // index as a DB-level guard; this dedup ensures duplicate-bearing payloads are
    // silently handled rather than raising a DB error.
    //
    // "Last wins" policy: the Map is iterated in insertion order, so each
    // occurrence of a duplicate date overwrites the previous one, keeping the
    // last row from the upstream payload. This is intentional — the upstream
    // producer emits trend rows ordered oldest-to-newest, so the last occurrence
    // of a given date represents the most recently computed value for that day.
    // If the producer's ordering guarantee is ever removed, "last wins" should
    // be revisited in favour of an explicit max-by-field selection.
    const trendRowsByDate = new Map<string, (typeof trendRows)[0]>();
    for (const row of trendRows) {
      trendRowsByDate.set(row.date, row);
    }
    const dedupedTrendRows = [...trendRowsByDate.values()];
    if (dedupedTrendRows.length < trendRows.length) {
      console.warn(
        `[read-model-consumer] Deduplicated ${trendRows.length - dedupedTrendRows.length} ` +
          `duplicate trend date(s) for snapshot ${snapshotId}`
      );
    }
    const finalTrendRows = dedupedTrendRows;
    if (rawTrend.length > 0 && finalTrendRows.length === 0) {
      console.warn(
        `[baselines] all ${rawTrend.length} trend rows filtered out for snapshot ${snapshotId} — check upstream data`
      );
    }

    try {
      // Upsert the snapshot header and replace child rows atomically inside a
      // single transaction. Keeping all writes together ensures a process crash
      // between the header commit and the child-row writes cannot leave the DB
      // with a snapshot row that has zero child rows (incorrect partial state).
      const snapshotRow: InsertBaselinesSnapshot = {
        snapshotId,
        contractVersion,
        computedAtUtc,
        windowStartUtc: windowStartUtc ?? undefined,
        windowEndUtc: windowEndUtc ?? undefined,
      };

      let insertedComparisonCount = 0;
      let insertedBreakdownCount = 0;
      await db.transaction(async (tx) => {
        // 1. Upsert the snapshot header — first operation in the transaction.
        await tx
          .insert(baselinesSnapshots)
          .values(snapshotRow)
          .onConflictDoUpdate({
            target: baselinesSnapshots.snapshotId,
            set: {
              contractVersion: snapshotRow.contractVersion,
              computedAtUtc: snapshotRow.computedAtUtc,
              windowStartUtc: snapshotRow.windowStartUtc,
              windowEndUtc: snapshotRow.windowEndUtc,
              projectedAt: new Date(),
            },
          });

        // 2. Replace child rows: delete old, insert fresh — all inside the same
        // transaction so a partial failure cannot leave the DB in a mixed state
        // (e.g. comparisons from the new snapshot with trend from the old).
        await tx
          .delete(baselinesComparisons)
          .where(eq(baselinesComparisons.snapshotId, snapshotId));

        if (rawComparisons.length > 0) {
          const comparisonRows: InsertBaselinesComparison[] = (
            rawComparisons as Record<string, unknown>[]
          )
            .filter((c) => {
              const pid = String(c.pattern_id ?? c.patternId ?? '').trim();
              if (!pid) {
                console.warn(
                  `[read-model-consumer] Skipping comparison row with blank pattern_id for snapshot ${snapshotId}`
                );
                return false;
              }
              return true;
            })
            .map((c) => ({
              snapshotId,
              patternId: String(c.pattern_id ?? c.patternId ?? ''),
              patternName: String(c.pattern_name ?? c.patternName ?? ''),
              sampleSize: Number(c.sample_size ?? c.sampleSize ?? 0),
              windowStart: String(c.window_start ?? c.windowStart ?? ''),
              windowEnd: String(c.window_end ?? c.windowEnd ?? ''),
              tokenDelta: (c.token_delta ?? c.tokenDelta ?? {}) as Record<string, unknown>,
              timeDelta: (c.time_delta ?? c.timeDelta ?? {}) as Record<string, unknown>,
              retryDelta: (c.retry_delta ?? c.retryDelta ?? {}) as Record<string, unknown>,
              testPassRateDelta: (c.test_pass_rate_delta ?? c.testPassRateDelta ?? {}) as Record<
                string,
                unknown
              >,
              reviewIterationDelta: (c.review_iteration_delta ??
                c.reviewIterationDelta ??
                {}) as Record<string, unknown>,
              recommendation: (() => {
                const raw = String(c.recommendation ?? '');
                return VALID_PROMOTION_ACTIONS.has(raw) ? raw : 'shadow';
              })(),
              confidence: (() => {
                const raw = String(c.confidence ?? '').toLowerCase();
                return VALID_CONFIDENCE_LEVELS.has(raw) ? raw : 'low';
              })(),
              rationale: String(c.rationale ?? ''),
            }));
          if (comparisonRows.length === 0) {
            console.warn(
              `[baselines] all ${rawComparisons.length} comparison rows filtered out for snapshot ${snapshotId} — check upstream data`
            );
          } else {
            await tx.insert(baselinesComparisons).values(comparisonRows);
          }
          insertedComparisonCount = comparisonRows.length;
        }

        await tx.delete(baselinesTrend).where(eq(baselinesTrend.snapshotId, snapshotId));

        if (finalTrendRows.length > 0) {
          await tx.insert(baselinesTrend).values(finalTrendRows);
        }

        await tx.delete(baselinesBreakdown).where(eq(baselinesBreakdown.snapshotId, snapshotId));

        if (rawBreakdown.length > 0) {
          const breakdownRowsRaw: InsertBaselinesBreakdown[] = (
            rawBreakdown as Record<string, unknown>[]
          ).map((b) => {
            const rawAction = String(b.action ?? '');
            const action = VALID_PROMOTION_ACTIONS.has(rawAction) ? rawAction : 'shadow';
            return {
              snapshotId,
              action,
              count: Number(b.count ?? 0),
              // NUMERIC(5,4) column: max 9.9999. Clamp to [0, 1] since confidence
              // is a 0-1 ratio; guard against out-of-range producer values.
              avgConfidence: String(
                Math.min(Math.max(Number(b.avg_confidence ?? b.avgConfidence ?? 0), 0), 1)
              ),
            };
          });

          // Deduplicate breakdown rows by action (keep last occurrence) to prevent
          // duplicate action entries that would cause _deriveSummary() to double-count
          // promote_count/shadow_count/etc. A DB-level UNIQUE(snapshot_id, action)
          // index is added by migrations/0006a_baselines_breakdown_unique.sql as a
          // backup guard; this app-level dedup remains as the primary defence so
          // the transaction never surfaces a constraint violation to callers.
          // (Analogous to the dedup applied to trend rows above, backed by 0005.)
          const breakdownByAction = new Map<string, (typeof breakdownRowsRaw)[0]>();
          for (const row of breakdownRowsRaw) {
            breakdownByAction.set(row.action, row);
          }
          const breakdownRows = [...breakdownByAction.values()];
          if (breakdownRows.length < breakdownRowsRaw.length) {
            console.warn(
              `[read-model-consumer] Deduplicated ${breakdownRowsRaw.length - breakdownRows.length} ` +
                `duplicate breakdown action(s) for snapshot ${snapshotId}`
            );
          }

          if (breakdownRows.length === 0) {
            console.warn(
              `[baselines] all ${rawBreakdown.length} breakdown rows filtered out for snapshot ${snapshotId} — check upstream data`
            );
          } else {
            await tx.insert(baselinesBreakdown).values(breakdownRows);
          }
          insertedBreakdownCount = breakdownRows.length;
        }
      });

      // Invalidate the baselines projection cache so the next API request
      // returns fresh data from the newly projected snapshot.
      // Wrapped defensively: a failure here must not block watermark advancement —
      // the DB writes have already committed successfully.
      try {
        baselinesProjection.reset();
      } catch (e) {
        console.warn('[read-model-consumer] baselinesProjection.reset() failed post-commit:', e);
      }

      // Notify WebSocket clients subscribed to the 'baselines' topic.
      // Called here (after transaction commits) so clients are only notified when
      // all DB writes have committed successfully.
      // Wrapped defensively: a failure here must not block watermark advancement.
      try {
        emitBaselinesUpdate(snapshotId);
      } catch (e) {
        console.warn('[read-model-consumer] emitBaselinesUpdate() failed post-commit:', e);
      }

      console.log(
        `[ReadModelConsumer] Projected baselines snapshot ${snapshotId} ` +
          `(${insertedComparisonCount} comparisons, ${finalTrendRows.length} trend points, ` +
          `${insertedBreakdownCount} breakdown rows)`
      );
    } catch (err) {
      // Degrade gracefully: if the table doesn't exist yet (migration not run),
      // advance the watermark so the consumer is not stuck retrying indefinitely.
      //
      // Primary check: PostgreSQL error code 42P01 ("undefined_table").
      // The pg / @neondatabase/serverless driver surfaces this as a `.code`
      // property on the thrown Error object.
      //
      // Fallback string check retained for defensive coverage in case the
      // driver wraps the error in a way that omits the code property.
      // Anchored to the primary table name so that 42703 "column does not exist"
      // errors from schema bugs are not silently swallowed as missing migrations.
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('baselines_snapshots') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] baselines_* tables not yet created -- ' +
            'run migrations to enable baselines projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  /**
   * Project a gate decision event into the `gate_decisions` table (OMN-2596).
   *
   * Emitted by the omniclaude CI gate when it evaluates a PR against quality
   * and test thresholds. Each evaluation is a row; deduplication uses the
   * (correlation_id) unique key.
   *
   * Returns true when written, false when the DB is unavailable.
   */
  private async projectGateDecisionEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;

    try {
      await db.execute(sql`
        INSERT INTO gate_decisions (
          correlation_id,
          session_id,
          pr_number,
          repo,
          gate_name,
          outcome,
          blocking,
          details,
          created_at
        ) VALUES (
          ${correlationId},
          ${(data.session_id as string) ?? null},
          ${data.pr_number != null ? Number(data.pr_number) : null},
          ${(data.repo as string) ?? null},
          ${(data.gate_name as string) ?? 'unknown'},
          ${(data.outcome as string) ?? 'unknown'},
          ${Boolean(data.blocking ?? false)},
          ${data.details != null ? JSON.stringify(data.details) : null},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('gate_decisions') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] gate_decisions table not yet created -- ' +
            'run migrations to enable gate decision projection'
        );
        return true;
      }
      throw err;
    }

    emitGateDecisionInvalidate(correlationId);
    return true;
  }

  /**
   * Project an epic run updated event into the `epic_run_lease` and
   * `epic_run_events` tables (OMN-2596).
   *
   * The epic-run-updated event covers both lease state changes (who holds the
   * lease, expiry time) and run-level events (ticket assigned, PR opened, etc.).
   * Each event is inserted idempotently using (correlation_id).
   *
   * Returns true when written, false when the DB is unavailable.
   */
  private async projectEpicRunUpdatedEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;
    const epicRunId = (data.epic_run_id as string) || (data.epicRunId as string) || correlationId;

    try {
      // Insert into epic_run_events for the event log
      await db.execute(sql`
        INSERT INTO epic_run_events (
          correlation_id,
          epic_run_id,
          event_type,
          ticket_id,
          repo,
          payload,
          created_at
        ) VALUES (
          ${correlationId},
          ${epicRunId},
          ${(data.event_type as string) ?? (data.eventType as string) ?? 'unknown'},
          ${(data.ticket_id as string) ?? (data.ticketId as string) ?? null},
          ${(data.repo as string) ?? null},
          ${data.payload != null ? JSON.stringify(data.payload) : null},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);

      // Upsert the lease state if lease fields are present
      if (data.lease_holder != null || data.leaseHolder != null) {
        const leaseHolder =
          (data.lease_holder as string) || (data.leaseHolder as string) || 'unknown';
        const leaseExpiresAt = data.lease_expires_at ?? data.leaseExpiresAt;
        await db.execute(sql`
          INSERT INTO epic_run_lease (
            epic_run_id,
            lease_holder,
            lease_expires_at,
            updated_at
          ) VALUES (
            ${epicRunId},
            ${leaseHolder},
            ${leaseExpiresAt != null ? safeParseDate(leaseExpiresAt) : null},
            ${safeParseDate(data.timestamp ?? data.created_at)}
          )
          ON CONFLICT (epic_run_id) DO UPDATE SET
            lease_holder = EXCLUDED.lease_holder,
            lease_expires_at = EXCLUDED.lease_expires_at,
            updated_at = EXCLUDED.updated_at
        `);
      }
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        ((msg.includes('epic_run_events') || msg.includes('epic_run_lease')) &&
          msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] epic_run_events/epic_run_lease tables not yet created -- ' +
            'run migrations to enable epic run projection'
        );
        return true;
      }
      throw err;
    }

    emitEpicRunInvalidate(epicRunId);
    return true;
  }

  /**
   * Project a PR watch state-change event into the `pr_watch_state` table (OMN-2596).
   *
   * Emitted when omnidash's PR watcher detects a state change (e.g. checks
   * passed, review requested, merged). Uses (correlation_id) for dedup.
   *
   * Returns true when written, false when the DB is unavailable.
   */
  private async projectPrWatchUpdatedEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;

    try {
      await db.execute(sql`
        INSERT INTO pr_watch_state (
          correlation_id,
          pr_number,
          repo,
          state,
          checks_status,
          review_status,
          metadata,
          created_at
        ) VALUES (
          ${correlationId},
          ${data.pr_number != null ? Number(data.pr_number) : null},
          ${(data.repo as string) ?? null},
          ${(data.state as string) ?? 'unknown'},
          ${(data.checks_status as string) ?? (data.checksStatus as string) ?? null},
          ${(data.review_status as string) ?? (data.reviewStatus as string) ?? null},
          ${data.metadata != null ? JSON.stringify(data.metadata) : null},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('pr_watch_state') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] pr_watch_state table not yet created -- ' +
            'run migrations to enable PR watch projection'
        );
        return true;
      }
      throw err;
    }

    emitPrWatchInvalidate(correlationId);
    return true;
  }

  /**
   * Project a budget cap hit event into the `pipeline_budget_state` table (OMN-2596).
   *
   * Emitted when a pipeline exceeds its configured token or cost budget cap.
   * Upserts the current budget state for the pipeline keyed by (pipeline_id).
   *
   * Returns true when written, false when the DB is unavailable.
   */
  private async projectBudgetCapHitEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;
    const pipelineId = (data.pipeline_id as string) || (data.pipelineId as string) || correlationId;

    try {
      await db.execute(sql`
        INSERT INTO pipeline_budget_state (
          correlation_id,
          pipeline_id,
          budget_type,
          cap_value,
          current_value,
          cap_hit,
          repo,
          created_at
        ) VALUES (
          ${correlationId},
          ${pipelineId},
          ${(data.budget_type as string) ?? (data.budgetType as string) ?? 'tokens'},
          ${data.cap_value != null ? Number(data.cap_value) : null},
          ${data.current_value != null ? Number(data.current_value) : null},
          ${Boolean(data.cap_hit ?? data.capHit ?? true)},
          ${(data.repo as string) ?? null},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('pipeline_budget_state') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] pipeline_budget_state table not yet created -- ' +
            'run migrations to enable pipeline budget projection'
        );
        return true;
      }
      throw err;
    }

    emitPipelineBudgetInvalidate(correlationId);
    return true;
  }

  /**
   * Project a circuit breaker tripped event into the `debug_escalation_counts` table
   * (OMN-2596).
   *
   * Emitted when the debug escalation circuit breaker trips (too many escalations
   * in a rolling window). Upserts the count row for the given agent/session.
   * Uses (correlation_id) for dedup.
   *
   * Returns true when written, false when the DB is unavailable.
   */
  private async projectCircuitBreakerTrippedEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;

    try {
      await db.execute(sql`
        INSERT INTO debug_escalation_counts (
          correlation_id,
          session_id,
          agent_name,
          escalation_count,
          window_start,
          window_end,
          tripped,
          repo,
          created_at
        ) VALUES (
          ${correlationId},
          ${(data.session_id as string) ?? null},
          ${(data.agent_name as string) ?? (data.agentName as string) ?? 'unknown'},
          ${data.escalation_count != null ? Number(data.escalation_count) : 1},
          ${data.window_start != null ? safeParseDate(data.window_start) : null},
          ${data.window_end != null ? safeParseDate(data.window_end) : null},
          ${Boolean(data.tripped ?? true)},
          ${(data.repo as string) ?? null},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('debug_escalation_counts') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] debug_escalation_counts table not yet created -- ' +
            'run migrations to enable circuit breaker projection'
        );
        return true;
      }
      throw err;
    }

    emitCircuitBreakerInvalidate(correlationId);
    return true;
  }

  /**
   * Project an intent-stored event into the `intent_signals` table (OMN-2889).
   *
   * Emitted by the omnimemory service when a new intent is durably stored in the
   * memory pipeline. Each event is a row; deduplication uses (correlation_id).
   *
   * Returns true when written, false when the DB is unavailable.
   */
  private async projectIntentStoredEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;

    try {
      await db.execute(sql`
        INSERT INTO intent_signals (
          correlation_id,
          event_id,
          intent_type,
          topic,
          raw_payload,
          created_at
        ) VALUES (
          ${correlationId},
          ${(data.event_id as string) ?? (data.eventId as string) ?? correlationId},
          ${(data.intent_type as string) ?? (data.intentType as string) ?? 'unknown'},
          ${'onex.evt.omnimemory.intent-stored.v1'},
          ${JSON.stringify(data)},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('intent_signals') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] intent_signals table not yet created -- ' +
            'run migrations to enable intent signal projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  /**
   * Project a PatternLearningRequested command event into the `pattern_learning_artifacts`
   * table (OMN-2920).
   *
   * omniintelligence does not yet emit pattern-projection.v1 completion events, so the
   * pattern_learning_artifacts table stays empty and the Patterns / Learned Insights pages
   * fall back to mock data. This handler writes one pending row per unique correlation_id
   * so probePatterns() and probeInsights() can confirm that real pipeline activity exists.
   *
   * The row uses lifecycle_state='requested' and sentinel values for non-null schema fields
   * that are not present in the command payload. When the upstream projection event
   * eventually arrives, projectPatternProjectionEvent() upserts real data over the row
   * (or alongside it — no conflict key on pattern_id, so the projection row is additive).
   *
   * Idempotency: implemented via raw SQL INSERT WHERE NOT EXISTS on pattern_id =
   * correlation_id, avoiding the need for a unique index on pattern_id.
   *
   * Returns true when written or skipped (already exists), false when DB is unavailable.
   */
  private async projectPatternLearningRequestedEvent(
    data: Record<string, unknown>,
    fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    // Use correlation_id as the pattern_id sentinel so duplicates can be detected.
    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;
    if (!UUID_RE.test(correlationId)) {
      // correlation_id is not a valid UUID — skip to avoid a DB type error.
      console.warn(
        `[ReadModelConsumer] PatternLearningRequested: correlation_id "${correlationId}" is not a ` +
          'valid UUID — skipping row'
      );
      return true;
    }

    const sessionId = (data.session_id as string) || (data.sessionId as string) || null;
    const trigger = (data.trigger as string) || 'unknown';
    const requestedAt = safeParseDate(data.timestamp ?? data.created_at);

    try {
      // INSERT ... WHERE NOT EXISTS is idempotent without a unique index on pattern_id.
      // The subquery matches on pattern_id = correlationId so redelivered Kafka messages
      // do not insert duplicate rows.
      await db.execute(sql`
        INSERT INTO pattern_learning_artifacts (
          pattern_id,
          pattern_name,
          pattern_type,
          lifecycle_state,
          composite_score,
          scoring_evidence,
          signature,
          metrics,
          metadata,
          created_at,
          updated_at,
          projected_at
        )
        SELECT
          ${correlationId}::uuid,
          ${'learning_requested'}::varchar(255),
          ${'pipeline_request'}::varchar(100),
          ${'requested'}::text,
          ${0}::numeric(10,6),
          ${{}}::jsonb,
          ${{ session_id: sessionId, trigger }}::jsonb,
          ${{}}::jsonb,
          ${{ source: 'PatternLearningRequested', trigger, session_id: sessionId }}::jsonb,
          ${requestedAt},
          ${requestedAt},
          ${new Date()}
        WHERE NOT EXISTS (
          SELECT 1 FROM pattern_learning_artifacts WHERE pattern_id = ${correlationId}::uuid
        )
      `);
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('pattern_learning_artifacts') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] pattern_learning_artifacts table not yet created -- ' +
            'run migrations to enable pattern learning request projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  /**
   * Project a pattern projection snapshot event into the `pattern_learning_artifacts`
   * table (OMN-2924).
   *
   * The event carries a full materialized snapshot of all validated/provisional patterns
   * produced by NodePatternProjectionEffect in omniintelligence. Each snapshot item
   * is upserted on (pattern_id) so the table always reflects the latest snapshot state.
   *
   * Returns true when written (or snapshot is empty), false when the DB is unavailable.
   */
  private async projectPatternProjectionEvent(
    data: Record<string, unknown>,
    _fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    // The projection event carries a `patterns` array where each item is a
    // ModelPatternSummary (Python snake_case serialization).
    const rawPatterns = data.patterns;
    if (!Array.isArray(rawPatterns) || rawPatterns.length === 0) {
      // Empty snapshot (no validated patterns yet) — advance watermark, no rows to write.
      return true;
    }

    try {
      for (const pattern of rawPatterns as Record<string, unknown>[]) {
        // Map ModelPatternSummary fields to pattern_learning_artifacts columns.
        // The Python model uses snake_case; we accept both snake_case and camelCase
        // for resilience against future envelope format changes.
        const patternId =
          (pattern.id as string) || (pattern.pattern_id as string) || (pattern.patternId as string);
        if (!patternId) {
          console.warn('[ReadModelConsumer] Pattern projection item missing id — skipping item');
          continue;
        }

        const patternName =
          (pattern.domain_id as string) ||
          (pattern.pattern_name as string) ||
          (pattern.patternName as string) ||
          'unknown';

        const patternType =
          (pattern.pattern_type as string) || (pattern.patternType as string) || 'unknown';

        const lifecycleState =
          (pattern.status as string) ||
          (pattern.lifecycle_state as string) ||
          (pattern.lifecycleState as string) ||
          'candidate';

        const compositeScore = String(
          pattern.quality_score ?? pattern.composite_score ?? pattern.compositeScore ?? 0
        );

        // The projection snapshot carries summary fields only — fill JSONB columns with
        // available data, defaulting to empty objects for fields not in ModelPatternSummary.
        const scoringEvidence = pattern.scoring_evidence ?? pattern.scoringEvidence ?? {};
        const signature = pattern.signature ?? { hash: pattern.signature_hash ?? '' };
        const metrics = pattern.metrics ?? {};
        const metadata = pattern.metadata ?? {};

        const row: InsertPatternLearningArtifact = {
          patternId,
          patternName,
          patternType,
          lifecycleState,
          compositeScore,
          scoringEvidence,
          signature,
          metrics,
          metadata,
          updatedAt: safeParseDate(data.snapshot_at ?? data.snapshotAt),
          projectedAt: new Date(),
        };

        await db
          .insert(patternLearningArtifacts)
          .values(row)
          .onConflictDoUpdate({
            target: patternLearningArtifacts.patternId,
            set: {
              patternName: row.patternName,
              patternType: row.patternType,
              lifecycleState: row.lifecycleState,
              compositeScore: row.compositeScore,
              scoringEvidence: row.scoringEvidence,
              signature: row.signature,
              metrics: row.metrics,
              metadata: row.metadata,
              updatedAt: row.updatedAt,
              projectedAt: row.projectedAt,
            },
          });
      }
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('pattern_learning_artifacts') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] pattern_learning_artifacts table not yet created -- ' +
            'run migrations to enable pattern projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  /**
   * Project a pattern lifecycle transitioned event into the `pattern_learning_artifacts`
   * table (OMN-2924).
   *
   * Updates only `lifecycle_state` and `state_changed_at` for the affected pattern.
   * If no row is found (projection snapshot not yet received), skips silently at
   * DEBUG level to avoid log spam on cold start.
   *
   * Returns true when written or skipped (no row found), false when DB is unavailable.
   */
  private async projectPatternLifecycleTransitionedEvent(
    data: Record<string, unknown>,
    _fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const patternId = (data.pattern_id as string) || (data.patternId as string);
    if (!patternId) {
      console.warn(
        '[ReadModelConsumer] Pattern lifecycle transitioned event missing pattern_id — skipping'
      );
      return true;
    }

    const toStatus = (data.to_status as string) || (data.toStatus as string);
    if (!toStatus) {
      console.warn(
        `[ReadModelConsumer] Pattern lifecycle transitioned event for ${patternId} ` +
          'missing to_status — skipping'
      );
      return true;
    }

    const transitionedAt = safeParseDate(
      data.transitioned_at ?? data.transitionedAt ?? data.timestamp ?? data.created_at
    );

    try {
      const result = await db
        .update(patternLearningArtifacts)
        .set({
          lifecycleState: toStatus,
          stateChangedAt: transitionedAt,
          updatedAt: new Date(),
        })
        .where(eq(patternLearningArtifacts.patternId, patternId))
        .returning({ id: patternLearningArtifacts.id });

      if (result.length === 0) {
        // Projection snapshot not yet received for this pattern — skip silently.
        console.debug(
          `[ReadModelConsumer] pattern-lifecycle-transitioned: no row found for pattern_id=${patternId} ` +
            '— skipping (projection snapshot may not have arrived yet)'
        );
      }
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('pattern_learning_artifacts') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] pattern_learning_artifacts table not yet created -- ' +
            'run migrations to enable pattern lifecycle projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  /**
   * Update projection watermark for tracking consumer progress.
   *
   * Called after each successful message projection in handleMessage().
   * The projection name is formatted as "topic:partition" to track
   * per-partition progress independently.
   */
  private async updateWatermark(projectionName: string, offset: number): Promise<void> {
    const db = tryGetIntelligenceDb();
    if (!db) return;

    try {
      // NOTE: The projection_watermarks table also has an errors_count column,
      // but we intentionally omit it here. Per-watermark error tracking is
      // deferred to a future iteration; for now, errors are tracked in the
      // in-memory ReadModelConsumerStats.errorsCount counter instead.
      await db.execute(sql`
        INSERT INTO projection_watermarks (projection_name, last_offset, events_projected, updated_at)
        VALUES (${projectionName}, ${offset}, 1, NOW())
        ON CONFLICT (projection_name)
        DO UPDATE SET
          last_offset = GREATEST(projection_watermarks.last_offset, EXCLUDED.last_offset),
          events_projected = projection_watermarks.events_projected + 1,
          last_projected_at = NOW(),
          updated_at = NOW()
      `);
    } catch (err) {
      // Non-fatal: watermark tracking is best-effort
      console.warn(
        '[ReadModelConsumer] Failed to update watermark:',
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Project a plan-review strategy run completed event into plan_review_runs table.
   * Returns true if the row was successfully written, false if the DB was unavailable.
   * OMN-3324
   */
  private async projectPlanReviewStrategyRunEvent(
    parsed: unknown,
    _fallbackId: string
  ): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    try {
      if (!parsed || typeof parsed !== 'object') return false;
      const e = parsed as Record<string, unknown>;

      const runId = typeof e.run_id === 'string' && e.run_id ? e.run_id : null;
      const strategy = typeof e.strategy === 'string' && e.strategy ? e.strategy : null;
      const planTextHash = typeof e.plan_text_hash === 'string' ? e.plan_text_hash : '';
      if (!runId || !strategy) {
        console.warn('[plan-reviewer] missing required fields run_id/strategy, skipping');
        return false;
      }

      const rawEmitted = typeof e.emitted_at === 'string' ? new Date(e.emitted_at) : null;
      const emittedAt = rawEmitted && !isNaN(rawEmitted.getTime()) ? rawEmitted : new Date();

      await db
        .insert(planReviewRuns)
        .values({
          eventId: typeof e.event_id === 'string' ? e.event_id : crypto.randomUUID(),
          runId,
          strategy,
          modelsUsed: Array.isArray(e.models_used) ? e.models_used.map(String) : [],
          planTextHash,
          findingsCount: typeof e.findings_count === 'number' ? e.findings_count : 0,
          blocksCount: typeof e.blocks_count === 'number' ? e.blocks_count : 0,
          categoriesWithFindings: Array.isArray(e.categories_with_findings)
            ? e.categories_with_findings.map(String)
            : [],
          categoriesClean: Array.isArray(e.categories_clean) ? e.categories_clean.map(String) : [],
          avgConfidence: typeof e.avg_confidence === 'number' ? e.avg_confidence : null,
          tokensUsed: typeof e.tokens_used === 'number' ? e.tokens_used : null,
          durationMs: typeof e.duration_ms === 'number' ? e.duration_ms : null,
          strategyRunStored: Boolean(e.strategy_run_stored),
          modelWeights:
            e.model_weights && typeof e.model_weights === 'object'
              ? (e.model_weights as Record<string, unknown>)
              : {},
          emittedAt,
        })
        .onConflictDoNothing();

      return true;
    } catch (err) {
      console.error('[plan-reviewer] projection error:', err);
      return false;
    }
  }

  /**
   * Project a PR validation rollup event into the `model_efficiency_rollups`
   * table (OMN-3933).
   *
   * Each event represents one PR validation run's aggregate metrics. The
   * run_id is used as the unique key; duplicate events are silently dropped
   * via ON CONFLICT DO NOTHING.
   *
   * Returns true when written (or silently skipped due to conflict), false
   * when the DB is unavailable or the table does not exist yet.
   */
  private async projectPrValidationRollup(data: Record<string, unknown>): Promise<boolean> {
    const db = tryGetIntelligenceDb();
    if (!db) return false;

    const runId = (data.run_id as string) || (data.runId as string);
    if (!runId) {
      console.warn('[ReadModelConsumer] pr-validation-rollup missing run_id — skipping');
      return true;
    }

    const ext = (data.extensions ?? data.ext ?? {}) as Record<string, unknown>;
    const missingFields = ext.missing_fields ?? data.missing_fields ?? [];

    try {
      await db
        .insert(modelEfficiencyRollups)
        .values({
          runId,
          repoId: (data.repo_id as string) || (data.repoId as string) || 'unknown',
          prId: (data.pr_id as string) || (data.prId as string) || '',
          prUrl: (data.pr_url as string) || (data.prUrl as string) || '',
          ticketId: (data.ticket_id as string) || (data.ticketId as string) || '',
          modelId: (data.model_id as string) || (data.modelId as string) || 'unknown',
          producerKind:
            (data.producer_kind as string) || (data.producerKind as string) || 'unknown',
          rollupStatus: (data.rollup_status as string) || (data.rollupStatus as string) || 'final',
          metricVersion: (data.metric_version as string) || (data.metricVersion as string) || 'v1',
          filesChanged: typeof data.files_changed === 'number' ? data.files_changed : 0,
          linesChanged: typeof data.lines_changed === 'number' ? data.lines_changed : 0,
          moduleTags: Array.isArray(data.module_tags) ? data.module_tags : [],
          blockingFailures: typeof data.blocking_failures === 'number' ? data.blocking_failures : 0,
          warnFindings: typeof data.warn_findings === 'number' ? data.warn_findings : 0,
          reruns: typeof data.reruns === 'number' ? data.reruns : 0,
          validatorRuntimeMs:
            typeof data.validator_runtime_ms === 'number' ? data.validator_runtime_ms : 0,
          humanEscalations: typeof data.human_escalations === 'number' ? data.human_escalations : 0,
          autofixSuccesses: typeof data.autofix_successes === 'number' ? data.autofix_successes : 0,
          timeToGreenMs: typeof data.time_to_green_ms === 'number' ? data.time_to_green_ms : 0,
          vts: typeof data.vts === 'number' ? data.vts : 0,
          vtsPerKloc: typeof data.vts_per_kloc === 'number' ? data.vts_per_kloc : 0,
          phaseCount: typeof data.phase_count === 'number' ? data.phase_count : 0,
          missingFields: Array.isArray(missingFields) ? missingFields : [],
          emittedAt: safeParseDate(data.emitted_at ?? data.emittedAt ?? data.timestamp),
        })
        .onConflictDoNothing();

      return true;
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('model_efficiency_rollups') && msg.includes('does not exist'))
      ) {
        console.warn(
          '[ReadModelConsumer] model_efficiency_rollups table not yet created -- ' +
            'run migrations to enable MEI projection'
        );
        return true;
      }
      throw err;
    }
  }
}

// Singleton instance
export const readModelConsumer = new ReadModelConsumer();
