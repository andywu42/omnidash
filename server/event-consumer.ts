/**
 * EventConsumer — Thin Kafka consumer orchestrator [OMN-5191]
 *
 * Domain handlers: server/consumers/domain/
 * Preload/buffer: server/consumers/event-preload.ts
 * State helpers: server/consumers/consumer-state-helpers.ts
 * Singleton/proxy: server/consumers/consumer-lifecycle.ts
 */

import { Kafka, Consumer, Producer, KafkaMessage } from 'kafkajs';
import { resolveBrokers, getBrokerString } from './bus-config.js';
import { EventEmitter } from 'events';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import type { EventBusEvent } from './event-bus-data-source';
import { extractSuffix, SUFFIX_NODE_HEARTBEAT } from '@shared/topics';
// Manifest-driven topic loading for fallback (OMN-5252)
import { loadManifestTopics } from './services/topic-manifest-loader';
import { EventEnvelopeSchema, OFFLINE_NODE_TTL_MS, CLEANUP_INTERVAL_MS } from '@shared/schemas';
import type { EventEnvelope } from '@shared/schemas';
import { getTopicRegistryService } from './services/topic-registry-service';
import {
  TopicDiscoveryCoordinator,
  BOOTSTRAP_TOPICS,
} from './services/topic-discovery-coordinator';
import { ExtractionMetricsAggregator } from './extraction-aggregator';
import { MonotonicMergeTracker, extractEventTimeMs, parseOffsetAsSeq } from './monotonic-merge';
import { assertTopicsExist } from './lib/kafka-topic-preflight';
import {
  createDomainHandlers,
  intentLogger,
  currentLogLevel,
  normalizeActionFields,
} from './consumers/domain';
import type {
  DomainHandler,
  ConsumerContext,
  CanonicalOnexNode,
  RegisteredNode,
  AgentAction,
  RoutingDecision,
  TransformationEvent,
  NodeIntrospectionEvent,
  NodeHeartbeatEvent,
  NodeStateChangeEvent,
  InternalIntentClassifiedEvent,
  AgentMetrics,
} from './consumers/domain';
import {
  captureLiveEventBusEvent,
  preloadEventsFromDatabase,
  injectPlaybackEvent as _injectPlayback,
  getMergedEventBusEvents,
  type PlaybackContext,
} from './consumers/event-preload';
import {
  mapCanonicalState,
  syncCanonicalToRegistered,
  propagateHeartbeatMetrics,
  cleanupOldMetrics,
  computeAgentMetrics,
  computeNodeRegistryStats,
  computeIntentStats,
  computeCanonicalNodeStats,
  pruneOldData,
} from './consumers/consumer-state-helpers';
import {
  fetchCatalogTopics as _fetchCatalog,
  registerEventConsumerClass,
} from './consumers/consumer-lifecycle';

// Re-export ALL types for backward compatibility
export type {
  AgentMetrics,
  AgentAction,
  RoutingDecision,
  TransformationEvent,
  RegisteredNode,
  NodeType,
  RegistrationState,
  IntrospectionReason,
  OnexNodeState,
  CanonicalOnexNode,
  NodeIntrospectionEvent,
  NodeHeartbeatEvent,
  NodeStateChangeEvent,
  InternalIntentClassifiedEvent,
  RawRoutingDecisionEvent,
  RawAgentActionEvent,
  RawTransformationEvent,
  RawPerformanceMetricEvent,
  RawNodeIntrospectionEvent,
  RawNodeHeartbeatEvent,
  RawNodeStateChangeEvent,
  RawIntentClassifiedEvent,
  RawIntentStoredEvent,
  RawIntentQueryResponseEvent,
} from './consumers/domain';
export { normalizeActionFields };

// Re-export singleton/proxy from lifecycle module
export {
  getEventConsumer,
  isEventConsumerAvailable,
  getEventConsumerError,
  createEventConsumerProxy,
} from './consumers/consumer-lifecycle';

const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const RETRY_BASE_DELAY_MS = isTestEnv ? 20 : 1000;
const RETRY_MAX_DELAY_MS = isTestEnv ? 200 : 30000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
const PERFORMANCE_METRICS_BUFFER_SIZE = 200;
const MAX_TIMESTAMPS_PER_CATEGORY = 1000;
const safeInt = (envVar: string, fallback: number) => {
  const p = parseInt(process.env[envVar] || String(fallback), 10);
  return Number.isFinite(p) && p >= 0 ? p : fallback;
};
const PRELOAD_WINDOW_MINUTES = safeInt('PRELOAD_WINDOW_MINUTES', 1440);
const MAX_PRELOAD_EVENTS = safeInt('MAX_PRELOAD_EVENTS', 5000);
const ENABLE_BACKFILL = process.env.ENABLE_BACKFILL === 'true'; // ONEX_FLAG_EXEMPT: migration
const BACKFILL_MAX_EVENTS = safeInt('BACKFILL_MAX_EVENTS', 2000);
const TOPIC = {
  NODE_HEARTBEAT: SUFFIX_NODE_HEARTBEAT,
  REQUEST_INTROSPECTION: 'onex.cmd.platform.request-introspection.v1',
} as const;

export class EventConsumer extends EventEmitter {
  private kafka: Kafka;
  private consumer: Consumer | null = null;
  private producer: Producer | null = null;
  private isRunning = false;
  private isStopping = false;
  private readonly DATA_RETENTION_MS = (() => {
    const p = parseInt(process.env.INTENT_RETENTION_HOURS || '24', 10);
    return (Number.isFinite(p) && p > 0 ? p : 24) * 3600000;
  })();
  private readonly PRUNE_INTERVAL_MS = (() => {
    const p = parseInt(process.env.PRUNE_INTERVAL_HOURS || '1', 10);
    return (Number.isFinite(p) && p > 0 ? p : 1) * 3600000;
  })();
  private pruneTimer?: NodeJS.Timeout;
  private canonicalNodeCleanupInterval?: NodeJS.Timeout;
  private agentMetrics = new Map<
    string,
    {
      count: number;
      totalRoutingTime: number;
      totalConfidence: number;
      successCount: number;
      errorCount: number;
      lastSeen: Date;
    }
  >();
  private recentActions: AgentAction[] = [];
  private maxActions = 1000;
  private routingDecisions: RoutingDecision[] = [];
  private maxDecisions = 1000;
  private recentTransformations: TransformationEvent[] = [];
  private maxTransformations = 100;
  private registeredNodes = new Map<string, RegisteredNode>();
  private readonly MAX_REGISTERED_NODES = 10000;
  private nodeIntrospectionEvents: NodeIntrospectionEvent[] = [];
  private nodeHeartbeatEvents: NodeHeartbeatEvent[] = [];
  private nodeStateChangeEvents: NodeStateChangeEvent[] = [];
  private maxNodeEvents = 100;
  private recentIntents: InternalIntentClassifiedEvent[] = [];
  private maxIntents = 100;
  private intentDistributionWithTimestamps: Map<string, { count: number; timestamps: number[] }> =
    new Map();
  private canonicalNodes = new Map<string, CanonicalOnexNode>();
  private extractionAggregator = new ExtractionMetricsAggregator();
  private monotonicMerge = new MonotonicMergeTracker();
  private arrivalSeq = 0;
  private processedEvents = new LRUCache<string, number>({ max: 10_000 });
  private performanceMetrics: Array<{
    id: string;
    correlationId: string;
    queryText: string;
    routingDurationMs: number;
    cacheHit: boolean;
    candidatesEvaluated: number;
    triggerMatchStrategy: string;
    createdAt: Date;
  }> = [];
  private performanceStats = {
    totalQueries: 0,
    cacheHitCount: 0,
    avgRoutingDuration: 0,
    totalRoutingDuration: 0,
  };
  private playbackEventsInjected = 0;
  private playbackEventsFailed = 0;
  private catalogTopics: string[] = [];
  private catalogWarnings: string[] = [];
  private catalogSource: 'catalog' | 'fallback' = 'fallback';
  private catalogManager: import('./topic-catalog-manager').TopicCatalogManager | null = null;
  private topicSource: 'registry' | 'catalog' | 'fallback' = 'fallback';
  private discoveryCoordinator: TopicDiscoveryCoordinator | null = null;
  private preloadedEventBusEvents: EventBusEvent[] = [];
  private liveEventBusEvents: EventBusEvent[] = [];
  private stateSnapshot: Record<string, unknown> | null = null;
  private domainHandlers: DomainHandler[];

  constructor() {
    super();
    this.kafka = new Kafka({
      brokers: resolveBrokers(),
      clientId: 'omnidash-event-consumer',
      connectionTimeout: 10000,
      requestTimeout: 30000,
      retry: { initialRetryTime: 1000, maxRetryTime: 30000, retries: 10 },
    });
    this.consumer = this.kafka.consumer({ groupId: 'omnidash-consumers-v2' });
    this.producer = this.kafka.producer();
    this.consumer.events?.DISCONNECT &&
      this.consumer.on(this.consumer.events.DISCONNECT, () => {
        if (this.isRunning) {
          intentLogger.warn('[EventConsumer] Kafka broker disconnected');
          this.emit('brokerDisconnected');
        }
      });
    this.domainHandlers = createDomainHandlers();
  }

  private buildContext(isDebug: boolean): ConsumerContext {
    return {
      isDuplicate: (cid) => this.isDuplicate(cid),
      emit: (event, ...args) => this.emit(event, ...args),
      isDebug,
      parseEnvelope: <T>(msg: KafkaMessage, schema: z.ZodSchema<T>) =>
        this.parseEnvelope(msg, schema),
      shouldProcess: (node, ts) => this.shouldProcess(node, ts),
      agentMetrics: this.agentMetrics,
      recentActions: this.recentActions,
      maxActions: this.maxActions,
      routingDecisions: this.routingDecisions,
      maxDecisions: this.maxDecisions,
      recentTransformations: this.recentTransformations,
      maxTransformations: this.maxTransformations,
      registeredNodes: this.registeredNodes,
      MAX_REGISTERED_NODES: this.MAX_REGISTERED_NODES,
      nodeIntrospectionEvents: this.nodeIntrospectionEvents,
      nodeHeartbeatEvents: this.nodeHeartbeatEvents,
      nodeStateChangeEvents: this.nodeStateChangeEvents,
      maxNodeEvents: this.maxNodeEvents,
      recentIntents: this.recentIntents,
      maxIntents: this.maxIntents,
      intentDistributionWithTimestamps: this.intentDistributionWithTimestamps,
      MAX_TIMESTAMPS_PER_CATEGORY,
      canonicalNodes: this.canonicalNodes,
      performanceMetrics: this.performanceMetrics,
      performanceStats: this.performanceStats,
      PERFORMANCE_METRICS_BUFFER_SIZE,
      getAgentMetrics: () => this.getAgentMetrics(),
      getRegisteredNodes: () => this.getRegisteredNodes(),
      syncCanonicalToRegistered: (n) => syncCanonicalToRegistered(this.registeredNodes, n),
      mapCanonicalState: (s) => mapCanonicalState(s),
      propagateHeartbeatMetrics: (p) => propagateHeartbeatMetrics(this.registeredNodes, p),
      cleanupOldMetrics: () => cleanupOldMetrics(this.agentMetrics),
      extractionAggregator: this.extractionAggregator,
    };
  }

  private syncFromContext(ctx: ConsumerContext): void {
    this.recentActions = ctx.recentActions;
    this.routingDecisions = ctx.routingDecisions;
    this.recentTransformations = ctx.recentTransformations;
    this.recentIntents = ctx.recentIntents;
    this.nodeIntrospectionEvents = ctx.nodeIntrospectionEvents;
    this.nodeHeartbeatEvents = ctx.nodeHeartbeatEvents;
    this.nodeStateChangeEvents = ctx.nodeStateChangeEvents;
    this.performanceMetrics = ctx.performanceMetrics;
  }

  private isDuplicate(cid: string): boolean {
    if (this.processedEvents.has(cid)) return true;
    this.processedEvents.set(cid, Date.now());
    return false;
  }
  private shouldProcess(node: CanonicalOnexNode | undefined, ts: number): boolean {
    return !node || ts > (node.last_event_at || 0);
  }

  private parseEnvelope<T>(
    message: KafkaMessage,
    payloadSchema: z.ZodSchema<T>
  ): EventEnvelope<T> | null {
    try {
      const raw = JSON.parse(message.value?.toString() || '{}');
      const envelope = EventEnvelopeSchema.parse(raw);
      const payloadResult = payloadSchema.safeParse(envelope.payload);
      if (!payloadResult.success) {
        const rawPayload = envelope.payload as Record<string, unknown> | undefined;
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'envelope_payload_validation_failed',
            node_id: rawPayload?.node_id ?? null,
            issues: payloadResult.error.issues.map((i) => ({
              path: i.path.join('.'),
              code: i.code,
              expected: (i as unknown as Record<string, unknown>).expected,
              received: (i as unknown as Record<string, unknown>).received,
            })),
          })
        );
        return null;
      }
      return { ...envelope, payload: payloadResult.data };
    } catch (e) {
      console.warn(
        '[EventConsumer] Failed to parse envelope:',
        e instanceof Error ? e.message : String(e)
      );
      return null;
    }
  }
  static normalizeActionFields = normalizeActionFields;

  private async routeMessage(
    topic: string,
    event: Record<string, unknown>,
    message: KafkaMessage,
    isDebug: boolean
  ): Promise<void> {
    const ctx = this.buildContext(isDebug);
    for (const handler of this.domainHandlers) {
      if (handler.canHandle(topic)) {
        await handler.handleEvent(topic, event, message, ctx);
        this.syncFromContext(ctx);
        return;
      }
    }
  }

  async validateConnection(): Promise<boolean> {
    const brokerStr = getBrokerString();
    if (brokerStr === 'not configured') return false;
    try {
      const admin = this.kafka.admin();
      await admin.connect();
      const topics = await admin.listTopics();
      await admin.disconnect();
      intentLogger.info(`Kafka broker reachable: ${brokerStr} (${topics.length} topics)`);
      return true;
    } catch (error) {
      console.error(
        `Kafka broker unreachable: ${brokerStr}`,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  async connectWithRetry(maxRetries = DEFAULT_MAX_RETRY_ATTEMPTS): Promise<void> {
    if (!this.consumer) throw new Error('Consumer not initialized');
    if (this.producer) {
      this.producer.connect().catch((err: unknown) => {
        intentLogger.warn(
          `[EventConsumer] Producer connect failed (non-critical): ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.consumer.connect();
        intentLogger.info('Kafka consumer connected successfully');
        return;
      } catch (error) {
        const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS);
        if (maxRetries - attempt - 1 > 0) {
          console.warn(
            `Kafka connection failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          throw new Error(
            `Kafka connection failed after ${maxRetries} attempts: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  async start() {
    if (this.isRunning || !this.consumer) return;
    try {
      await this.connectWithRetry();
      this.emit('connected');
      if (process.env.ENABLE_EVENT_PRELOAD !== 'false') {
        // ONEX_FLAG_EXEMPT: migration
        try {
          await this.preloadFromDatabase();
        } catch (e) {
          console.error('[EventConsumer] DB preload failed:', e);
        }
      }
      if (this.registeredNodes.size === 0 && this.canonicalNodes.size === 0) {
        Promise.resolve().then(async () => {
          try {
            if (!this.producer) return;
            await this.producer.send({
              topic: TOPIC.REQUEST_INTROSPECTION,
              messages: [
                {
                  value: JSON.stringify({
                    reason: 'omnidash_startup',
                    timestamp: new Date().toISOString(),
                  }),
                },
              ],
            });
          } catch (err) {
            intentLogger.warn(
              `Re-introspection request failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        });
      }
      const useRegistryDiscovery = process.env.OMNIDASH_USE_REGISTRY_DISCOVERY !== 'false';
      let subscriptionTopics: string[];
      if (useRegistryDiscovery) {
        const topicRegistry = getTopicRegistryService();
        this.discoveryCoordinator = new TopicDiscoveryCoordinator(topicRegistry);
        await this.consumer.subscribe({ topics: [...BOOTSTRAP_TOPICS], fromBeginning: false });
        const discoveryResult = await this.discoveryCoordinator.waitForDiscovery();
        this.topicSource = discoveryResult.source === 'registry' ? 'registry' : 'fallback';
        subscriptionTopics = discoveryResult.topics;

        if (discoveryResult.degraded) {
          intentLogger.warn(
            `[EventConsumer] Topic discovery degraded after ${discoveryResult.durationMs}ms — ` +
              `proceeding with ${discoveryResult.registryTopicCount} registry topics + bootstrap`
          );
        } else {
          intentLogger.info(
            `[EventConsumer] Topic discovery stabilized in ${discoveryResult.durationMs}ms — ` +
              `${discoveryResult.registryTopicCount} registry topics from ${discoveryResult.nodeCount} nodes`
          );
        }

        // If registry found no topics beyond bootstrap, fall back to loadManifestTopics()
        // to ensure we don't miss events during initial deployment before nodes report event_bus
        if (discoveryResult.registryTopicCount === 0) {
          intentLogger.info(
            '[EventConsumer] No registry topics discovered — falling back to loadManifestTopics()'
          );
          subscriptionTopics = loadManifestTopics();
          this.topicSource = 'fallback';
        }
      } else {
        subscriptionTopics = await _fetchCatalog({
          catalogTopics: this.catalogTopics,
          catalogWarnings: this.catalogWarnings,
          catalogSource: this.catalogSource,
          catalogManager: this.catalogManager,
          emit: (e, ...a) => this.emit(e, ...a),
          handleCatalogChanged: (a, r) => this.handleCatalogChanged(a, r),
        });
        this.catalogSource = 'catalog';
      }
      if (!isTestEnv) {
        const preflightAdmin = this.kafka.admin();
        await assertTopicsExist(preflightAdmin, [
          'onex.evt.omniclaude.skill-started.v1',
          'onex.evt.omniclaude.skill-completed.v1',
        ]);
      }
      await this.consumer.subscribe({ topics: subscriptionTopics, fromBeginning: false });
      intentLogger.info(
        `Kafka subscription started (source=${this.topicSource}, topics=${subscriptionTopics.length})`
      );
      this.isRunning = true;
      this.pruneTimer = setInterval(() => this.pruneOldData(), this.PRUNE_INTERVAL_MS);
      this.canonicalNodeCleanupInterval = setInterval(
        () => this.cleanupStaleCanonicalNodes(),
        CLEANUP_INTERVAL_MS
      );
      this.runConsumerLoop(subscriptionTopics);
    } catch (error) {
      console.error('Failed to start event consumer:', error);
      this.emit('error', error);
      throw error;
    }
  }

  private runConsumerLoop(subscriptionTopics: string[]): void {
    (async () => {
      while (this.isRunning) {
        try {
          let consumerCrashed = false;
          this.consumer!.run({
            eachMessage: async ({ topic: rawTopic, partition, message }) => {
              try {
                const raw = message.value?.toString() || '{}';
                let event: any;
                try {
                  event = JSON.parse(raw);
                } catch (pe) {
                  console.warn('[EventConsumer] Skipping malformed JSON message:', {
                    topic: rawTopic,
                    partition,
                    offset: message.offset,
                    error: pe instanceof Error ? pe.message : String(pe),
                  });
                  return;
                }
                const topic = extractSuffix(rawTopic);
                if (topic !== TOPIC.NODE_HEARTBEAT)
                  captureLiveEventBusEvent(
                    this.liveEventBusEvents,
                    event,
                    rawTopic,
                    partition,
                    message
                  );
                const incomingEventTime = extractEventTimeMs(event);
                const kafkaOffset = parseOffsetAsSeq(message.offset);
                const hasKafkaOffset = message.offset != null && message.offset !== '';
                const incomingSeq = hasKafkaOffset ? kafkaOffset : ++this.arrivalSeq;
                if (
                  !this.monotonicMerge.checkAndUpdate(`${topic}:${partition}`, {
                    eventTime: incomingEventTime,
                    seq: incomingSeq,
                  })
                )
                  return;
                const isDebug = currentLogLevel <= LOG_LEVELS.debug;
                if (isDebug) intentLogger.debug(`Received event from topic: ${topic}`);
                await this.routeMessage(topic, event, message, isDebug);
              } catch (error) {
                console.error('Error processing Kafka message:', error);
                if (
                  error instanceof Error &&
                  (error.message.includes('connection') ||
                    error.message.includes('broker') ||
                    error.message.includes('network'))
                )
                  throw error;
                else this.emit('error', error);
              }
            },
          }).catch((runErr: unknown) => {
            if (this.isRunning && !isTestEnv) {
              console.error('[EventConsumer] consumer.run() threw:', runErr);
              this.emit('error', runErr);
              consumerCrashed = true;
            }
          });
          if (isTestEnv) break;
          while (this.isRunning && !consumerCrashed) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          if (consumerCrashed && this.isRunning) {
            intentLogger.warn('[EventConsumer] Consumer crashed, reconnecting in 5s...');
            await new Promise((resolve) => setTimeout(resolve, 5000));
            try {
              await this.consumer?.disconnect().catch(() => {});
              await this.connectWithRetry();
              await this.consumer!.subscribe({ topics: subscriptionTopics, fromBeginning: false });
            } catch (reconnectErr) {
              console.error('[EventConsumer] Reconnect failed', reconnectErr);
              this.emit('error', reconnectErr);
            }
          }
        } catch (outerErr) {
          if (!this.isRunning || isTestEnv) break;
          console.error('[EventConsumer] Unexpected error in consumer loop:', outerErr);
          this.emit('error', outerErr);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    })().catch((err) => {
      console.error('[EventConsumer] Background loop crashed:', err);
      this.emit('error', err);
    });
  }

  private async preloadFromDatabase() {
    try {
      const preloadStart = Date.now();
      const result = await preloadEventsFromDatabase({
        preloadWindowMinutes: PRELOAD_WINDOW_MINUTES,
        maxPreloadEvents: MAX_PRELOAD_EVENTS,
        enableBackfill: ENABLE_BACKFILL,
        backfillMaxEvents: BACKFILL_MAX_EVENTS,
      });
      this.preloadedEventBusEvents = result.preloadedEvents;
      let injected = 0;
      for (const row of result.playbackRows) {
        try {
          const event =
            typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {};
          this.injectPlaybackEvent(
            extractSuffix(row.topic),
            event as Record<string, unknown>,
            row.partition ?? undefined
          );
          injected++;
        } catch {
          /* skip */
        }
      }
      intentLogger.info(
        `Preload complete: Injected ${injected}/${result.playbackRows.length} events in ${Date.now() - preloadStart}ms`
      );
      this.emit('metricUpdate', this.getAgentMetrics());
      const lastAction = this.recentActions[this.recentActions.length - 1];
      if (lastAction) this.emit('actionUpdate', lastAction);
      if (this.routingDecisions[0]) this.emit('routingUpdate', this.routingDecisions[0]);
      if (this.recentTransformations[0])
        this.emit('transformationUpdate', this.recentTransformations[0]);
    } catch (error) {
      console.error('[EventConsumer] Error during preloadFromDatabase:', error);
    }
  }

  public injectPlaybackEvent(
    topic: string,
    event: Record<string, unknown>,
    partition?: number
  ): void {
    const pctx: PlaybackContext = {
      domainHandlers: this.domainHandlers,
      buildContext: (d) => this.buildContext(d),
      syncFromContext: (c) => this.syncFromContext(c),
      monotonicMerge: this.monotonicMerge,
      arrivalSeqRef: { value: this.arrivalSeq },
      playbackStats: { injected: this.playbackEventsInjected, failed: this.playbackEventsFailed },
      emit: (e, ...a) => this.emit(e, ...a),
    };
    _injectPlayback(pctx, topic, event, partition);
    this.arrivalSeq = pctx.arrivalSeqRef.value;
    this.playbackEventsInjected = pctx.playbackStats.injected;
    this.playbackEventsFailed = pctx.playbackStats.failed;
  }

  private pruneOldData(): void {
    const state = {
      recentActions: this.recentActions,
      routingDecisions: this.routingDecisions,
      recentTransformations: this.recentTransformations,
      performanceMetrics: this.performanceMetrics,
      nodeIntrospectionEvents: this.nodeIntrospectionEvents,
      nodeHeartbeatEvents: this.nodeHeartbeatEvents,
      nodeStateChangeEvents: this.nodeStateChangeEvents,
      registeredNodes: this.registeredNodes,
      liveEventBusEvents: this.liveEventBusEvents,
      preloadedEventBusEvents: this.preloadedEventBusEvents,
      recentIntents: this.recentIntents,
      intentDistributionWithTimestamps: this.intentDistributionWithTimestamps,
      agentMetrics: this.agentMetrics,
    };
    pruneOldData(state, this.DATA_RETENTION_MS);
    this.recentActions = state.recentActions;
    this.routingDecisions = state.routingDecisions;
    this.recentTransformations = state.recentTransformations;
    this.performanceMetrics = state.performanceMetrics;
    this.nodeIntrospectionEvents = state.nodeIntrospectionEvents;
    this.nodeHeartbeatEvents = state.nodeHeartbeatEvents;
    this.nodeStateChangeEvents = state.nodeStateChangeEvents;
    this.liveEventBusEvents = state.liveEventBusEvents;
    this.preloadedEventBusEvents = state.preloadedEventBusEvents;
    this.recentIntents = state.recentIntents;
  }

  private cleanupStaleCanonicalNodes(): void {
    const now = Date.now();
    let removed = 0;
    for (const [nodeId, node] of this.canonicalNodes) {
      if (
        node.state === 'OFFLINE' &&
        node.offline_at &&
        now - node.offline_at > OFFLINE_NODE_TTL_MS
      ) {
        this.canonicalNodes.delete(nodeId);
        removed++;
      }
    }
    if (removed > 0) intentLogger.info(`Cleaned up ${removed} stale offline canonical nodes`);
  }

  getAgentMetrics(): AgentMetrics[] {
    return computeAgentMetrics(this.agentMetrics);
  }
  getPlaybackStats() {
    const t = this.playbackEventsInjected;
    const f = this.playbackEventsFailed;
    return {
      injected: t,
      failed: f,
      successRate: t > 0 ? Math.round(((t - f) / t) * 10000) / 100 : 0,
    };
  }
  getRecentActions(limit?: number) {
    return limit && limit > 0 ? this.recentActions.slice(0, limit) : this.recentActions;
  }
  getPreloadedEventBusEvents(): EventBusEvent[] {
    return getMergedEventBusEvents(this.preloadedEventBusEvents, this.liveEventBusEvents);
  }
  getActionsByAgent(agentName: string, timeWindow = '1h') {
    const windowMs = timeWindow === '24h' ? 86400000 : timeWindow === '7d' ? 604800000 : 3600000;
    return this.recentActions.filter(
      (a) => a.agentName === agentName && a.createdAt >= new Date(Date.now() - windowMs)
    );
  }
  getRoutingDecisions(filters?: { agent?: string; minConfidence?: number }) {
    let d = this.routingDecisions;
    if (filters?.agent) d = d.filter((x) => x.selectedAgent === filters.agent);
    if (filters?.minConfidence !== undefined)
      d = d.filter((x) => x.confidenceScore >= filters.minConfidence!);
    return d;
  }
  getRecentTransformations(limit = 50) {
    return this.recentTransformations.slice(0, limit);
  }
  getPerformanceMetrics(limit = 100) {
    return this.performanceMetrics.slice(0, limit);
  }
  getPerformanceStats() {
    return {
      ...this.performanceStats,
      cacheHitRate:
        this.performanceStats.totalQueries > 0
          ? (this.performanceStats.cacheHitCount / this.performanceStats.totalQueries) * 100
          : 0,
    };
  }
  getHealthStatus() {
    return {
      status: this.isRunning ? 'healthy' : 'unhealthy',
      eventsProcessed: this.agentMetrics.size,
      recentActionsCount: this.recentActions.length,
      registeredNodesCount: this.registeredNodes.size,
      monotonicMergeRejections: this.monotonicMerge.rejectedCount,
      monotonicMergeTrackedTopics: this.monotonicMerge.trackedKeyCount,
      timestamp: new Date().toISOString(),
    };
  }
  getRegisteredNodes(): RegisteredNode[] {
    return Array.from(this.registeredNodes.values());
  }
  getRegisteredNode(nodeId: string) {
    return this.registeredNodes.get(nodeId);
  }
  getNodeIntrospectionEvents(limit?: number) {
    return limit && limit > 0
      ? this.nodeIntrospectionEvents.slice(0, limit)
      : this.nodeIntrospectionEvents;
  }
  getNodeHeartbeatEvents(limit?: number) {
    return limit && limit > 0 ? this.nodeHeartbeatEvents.slice(0, limit) : this.nodeHeartbeatEvents;
  }
  getNodeStateChangeEvents(limit?: number) {
    return limit && limit > 0
      ? this.nodeStateChangeEvents.slice(0, limit)
      : this.nodeStateChangeEvents;
  }
  getNodeRegistryStats() {
    return computeNodeRegistryStats(this.getRegisteredNodes());
  }
  getRecentIntents(limit = 50) {
    return this.recentIntents.slice(0, limit);
  }
  getIntentDistribution(): Record<string, number> {
    const d: Record<string, number> = {};
    for (const [t, data] of this.intentDistributionWithTimestamps.entries()) d[t] = data.count;
    return d;
  }
  getIntentStats() {
    return computeIntentStats(this.recentIntents, this.intentDistributionWithTimestamps);
  }
  getCanonicalNodes(): CanonicalOnexNode[] {
    return Array.from(this.canonicalNodes.values());
  }
  getCanonicalNode(nodeId: string) {
    return this.canonicalNodes.get(nodeId);
  }
  getCanonicalNodeStats() {
    return computeCanonicalNodeStats(this.getCanonicalNodes());
  }

  resetState(): void {
    this.recentActions = [];
    this.routingDecisions = [];
    this.recentTransformations = [];
    this.recentIntents = [];
    this.agentMetrics.clear();
    this.performanceMetrics = [];
    this.performanceStats = {
      totalQueries: 0,
      cacheHitCount: 0,
      avgRoutingDuration: 0,
      totalRoutingDuration: 0,
    };
    this.intentDistributionWithTimestamps.clear();
    this.playbackEventsInjected = 0;
    this.playbackEventsFailed = 0;
    this.monotonicMerge.reset();
    this.arrivalSeq = 0;
    this.emit('stateReset');
  }
  snapshotState(): void {
    this.stateSnapshot = {
      recentActions: [...this.recentActions],
      routingDecisions: [...this.routingDecisions],
      recentTransformations: [...this.recentTransformations],
      recentIntents: [...this.recentIntents],
      agentMetrics: new Map(this.agentMetrics),
      performanceMetrics: [...this.performanceMetrics],
      performanceStats: { ...this.performanceStats },
      intentDistributionWithTimestamps: new Map(
        Array.from(this.intentDistributionWithTimestamps.entries()).map(([k, v]) => [
          k,
          { count: v.count, timestamps: [...v.timestamps] },
        ])
      ),
    };
    this.emit('stateSnapshotted');
  }
  restoreState(): boolean {
    const s = this.stateSnapshot as any;
    if (!s) return false;
    this.recentActions = s.recentActions;
    this.routingDecisions = s.routingDecisions;
    this.recentTransformations = s.recentTransformations;
    this.recentIntents = s.recentIntents;
    this.agentMetrics = s.agentMetrics;
    this.performanceMetrics = s.performanceMetrics;
    this.performanceStats = s.performanceStats;
    this.intentDistributionWithTimestamps = s.intentDistributionWithTimestamps;
    this.stateSnapshot = null;
    this.playbackEventsInjected = 0;
    this.playbackEventsFailed = 0;
    this.emit('stateRestored');
    return true;
  }
  hasStateSnapshot(): boolean {
    return this.stateSnapshot !== null;
  }

  async stop() {
    if (!this.consumer || !this.isRunning || this.isStopping) return;
    this.isStopping = true;
    try {
      if (this.pruneTimer) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = undefined;
      }
      if (this.canonicalNodeCleanupInterval) {
        clearInterval(this.canonicalNodeCleanupInterval);
        this.canonicalNodeCleanupInterval = undefined;
      }
      if (typeof this.consumer.stop === 'function') {
        try {
          await this.consumer.stop();
        } catch {}
      }
      this.isRunning = false;
      await this.consumer.disconnect();
      if (this.producer) {
        await this.producer.disconnect().catch(() => {});
        this.producer = null;
      }
      if (this.catalogManager) {
        await this.catalogManager.stop().catch(() => {});
        this.catalogManager = null;
      }
      intentLogger.info('Event consumer stopped');
      this.emit('disconnected');
    } catch (error) {
      console.error('Error stopping Kafka consumer:', error);
      this.isRunning = false;
      this.emit('error', error);
    } finally {
      this.isStopping = false;
    }
  }

  private handleCatalogChanged(topicsAdded: string[], topicsRemoved: string[]): void {
    if (topicsAdded.length === 0 && topicsRemoved.length === 0) return;
    const currentSet = new Set(this.catalogTopics);
    for (const t of topicsAdded) currentSet.add(t);
    for (const t of topicsRemoved) currentSet.delete(t);
    this.catalogTopics = [...currentSet];
    this.emit('catalogChanged', { topicsAdded, topicsRemoved });
  }

  public getCatalogStatus() {
    if (this.topicSource === 'registry' && this.discoveryCoordinator)
      return {
        topics: this.discoveryCoordinator.getCurrentTopics(),
        warnings: this.catalogWarnings,
        source: 'registry' as const,
        instanceUuid: null,
      };
    return {
      topics: this.catalogSource === 'catalog' ? this.catalogTopics : loadManifestTopics(),
      warnings: this.catalogWarnings,
      source: this.catalogSource,
      instanceUuid: this.catalogManager?.instanceUuid ?? null,
    };
  }
}

// Register class with lifecycle module (breaks ESM circular dep — replaces require())
registerEventConsumerClass(EventConsumer);

// Backward-compatible named export
import { createEventConsumerProxy } from './consumers/consumer-lifecycle';
export const eventConsumer = createEventConsumerProxy();
