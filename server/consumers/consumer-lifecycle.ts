// no-migration: OMN-5252 No schema change — replaces buildSubscriptionTopics() with loadManifestTopics() as fallback topic source.
/**
 * Consumer lifecycle utilities — singleton, proxy, catalog management [OMN-5191]
 *
 * Extracted from event-consumer.ts to keep the orchestrator under 500 lines.
 */

import type { EventConsumer } from '../event-consumer';
import { TopicCatalogManager } from '../topic-catalog-manager';
import { loadManifestTopics } from '../services/topic-manifest-loader';

// ============================================================================
// Class Registry (breaks ESM circular dep — event-consumer.ts registers itself)
// ============================================================================

type EventConsumerConstructor = new () => EventConsumer;
let EventConsumerClass: EventConsumerConstructor | null = null;

export function registerEventConsumerClass(cls: EventConsumerConstructor): void {
  EventConsumerClass = cls;
}

// ============================================================================
// Catalog Management
// ============================================================================

export interface CatalogState {
  catalogTopics: string[];
  catalogWarnings: string[];
  catalogSource: 'catalog' | 'fallback';
  catalogManager: TopicCatalogManager | null;
  emit: (event: string, ...args: unknown[]) => boolean;
  handleCatalogChanged: (topicsAdded: string[], topicsRemoved: string[]) => void;
}

export async function fetchCatalogTopics(state: CatalogState): Promise<string[]> {
  state.catalogSource = 'fallback';
  state.catalogTopics = [];
  state.catalogWarnings = [];
  try {
    const manager = new TopicCatalogManager();
    state.catalogManager = manager;
    return await new Promise<string[]>((resolve) => {
      manager.once('catalogReceived', (event) => {
        state.catalogTopics = event.topics;
        state.catalogWarnings = event.warnings;
        state.catalogSource = 'catalog';
        if (event.warnings.length > 0) state.emit('catalogWarnings', event.warnings);
        manager.on('catalogChanged', (e) =>
          state.handleCatalogChanged(e.topicsAdded, e.topicsRemoved)
        );
        resolve(event.topics);
      });
      manager.once('catalogTimeout', () => {
        manager.stop().catch(() => {});
        state.catalogManager = null;
        resolve(loadManifestTopics());
      });
      manager.bootstrap().catch(() => {
        manager.stop().catch(() => {});
        state.catalogManager = null;
        resolve(loadManifestTopics());
      });
    });
  } catch {
    return loadManifestTopics();
  }
}

// ============================================================================
// Singleton & Proxy
// ============================================================================

let eventConsumerInstance: EventConsumer | null = null;
let initializationError: Error | null = null;

export function getEventConsumer(): EventConsumer | null {
  if (eventConsumerInstance) return eventConsumerInstance;
  if (initializationError) return null;
  if (!EventConsumerClass) {
    initializationError = new Error('EventConsumer class not registered');
    console.error('EventConsumer initialization failed:', initializationError.message);
    return null;
  }
  try {
    eventConsumerInstance = new EventConsumerClass();
    return eventConsumerInstance;
  } catch (error) {
    initializationError = error instanceof Error ? error : new Error(String(error));
    console.error('EventConsumer initialization failed:', initializationError.message);
    return null;
  }
}

export function isEventConsumerAvailable(): boolean {
  getEventConsumer();
  return eventConsumerInstance !== null;
}

export function getEventConsumerError(): Error | null {
  return initializationError;
}

const PROXY_STUBS: Record<string, () => unknown> = {
  validateConnection: () => async () => false,
  start: () => async () => {
    throw new Error('[EventConsumer] start called before initialization');
  },
  stop: () => async () => {},
  getHealthStatus: () => () => ({
    status: 'unhealthy',
    eventsProcessed: 0,
    recentActionsCount: 0,
    registeredNodesCount: 0,
    timestamp: new Date().toISOString(),
  }),
  getIntentDistribution: () => () => ({}),
  getIntentStats: () => () => ({
    totalIntents: 0,
    recentIntentsCount: 0,
    typeDistribution: {},
    topIntentTypes: [],
  }),
  getNodeRegistryStats: () => () => ({
    totalNodes: 0,
    activeNodes: 0,
    pendingNodes: 0,
    failedNodes: 0,
    typeDistribution: {},
  }),
  getCanonicalNodeStats: () => () => ({
    totalNodes: 0,
    activeNodes: 0,
    pendingNodes: 0,
    offlineNodes: 0,
  }),
  getPerformanceStats: () => () => ({
    totalQueries: 0,
    cacheHitCount: 0,
    avgRoutingDuration: 0,
    totalRoutingDuration: 0,
    cacheHitRate: 0,
  }),
  getCatalogStatus: () => () => ({
    topics: [] as string[],
    warnings: [] as string[],
    source: 'fallback' as const,
    instanceUuid: null,
  }),
};

const ARRAY_GETTERS = new Set([
  'getAgentMetrics',
  'getRecentActions',
  'getRoutingDecisions',
  'getRecentTransformations',
  'getPerformanceMetrics',
  'getRegisteredNodes',
  'getNodeIntrospectionEvents',
  'getNodeHeartbeatEvents',
  'getNodeStateChangeEvents',
  'getRecentIntents',
  'getCanonicalNodes',
  'getPreloadedEventBusEvents',
  'getActionsByAgent',
]);

export function createEventConsumerProxy(): EventConsumer {
  const proxy = new Proxy({} as EventConsumer, {
    get(_target, prop) {
      const instance = getEventConsumer();
      if (!instance) {
        const stub = PROXY_STUBS[prop as string];
        if (stub) return stub();
        if (ARRAY_GETTERS.has(prop as string)) return () => [];
        if (prop === 'getRegisteredNode' || prop === 'getCanonicalNode') return () => undefined;
        if (prop === 'on' || prop === 'once' || prop === 'emit' || prop === 'removeListener')
          return (..._args: unknown[]) => {
            if (prop === 'emit') return false;
            return proxy;
          };
        return undefined;
      }
      const value = instance[prop as keyof EventConsumer];
      if (typeof value === 'function')
        return (value as (...args: unknown[]) => unknown).bind(instance);
      return value;
    },
  });
  return proxy;
}
