/**
 * Layer 2 Integration Test: Server EventConsumer
 *
 * Tests the EventConsumer's ability to:
 *   1. Correctly resolve canonical vs. legacy topic names
 *   2. Process events through injectPlaybackEvent and store them in memory
 *   3. Enforce in-memory storage bounds (pruning)
 *   4. (Integration) Connect to real Kafka, subscribe, and consume events
 *
 * Layer 1 verifies Kafka data availability.
 * Layer 2 (this file) verifies the server can consume and process that data.
 * Layer 3 will verify WebSocket relay to clients.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildSubscriptionTopics,
  extractSuffix,
  ENVIRONMENT_PREFIXES,
  SUFFIX_OMNICLAUDE_SESSION_STARTED,
  SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
  SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
  SUFFIX_NODE_HEARTBEAT,
  SUFFIX_NODE_INTROSPECTION,
  SUFFIX_VALIDATION_RUN_STARTED,
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
} from '@shared/topics';

// ---------------------------------------------------------------------------
// Fixture: sample events for each topic type
// ---------------------------------------------------------------------------

/** Sample session-started event (OmniClaude lifecycle) */
const FIXTURE_SESSION_STARTED = {
  session_id: 'test-session-001',
  correlation_id: 'corr-session-001',
  timestamp_utc: new Date().toISOString(),
  event_type: 'session_started',
  payload: {
    cwd: '/workspace/omnidash',
    model: 'claude-opus-4-6',
  },
};

/** Sample tool-executed event (OmniClaude lifecycle) */
const FIXTURE_TOOL_EXECUTED = {
  session_id: 'test-session-001',
  correlation_id: 'corr-tool-001',
  timestamp_utc: new Date().toISOString(),
  event_type: 'tool_executed',
  payload: {
    tool_name: 'Read',
    duration_ms: 42,
    success: true,
  },
};

/** Sample agent-action event (legacy flat topic) */
const FIXTURE_AGENT_ACTION = {
  id: 'action-001',
  correlation_id: 'corr-action-001',
  agent_name: 'api-architect',
  action_type: 'tool_call',
  action_name: 'read_file',
  action_details: { path: '/workspace/server/routes.ts' },
  duration_ms: 150,
  timestamp: new Date().toISOString(),
};

/** Sample routing-decision event (legacy flat topic) */
const FIXTURE_ROUTING_DECISION = {
  id: 'decision-001',
  correlation_id: 'corr-decision-001',
  user_request: 'Fix the authentication bug',
  selected_agent: 'debug',
  confidence_score: 0.92,
  routing_strategy: 'trigger_match',
  routing_time_ms: 45,
  timestamp: new Date().toISOString(),
};

/** Sample transformation event (legacy flat topic) */
const FIXTURE_TRANSFORMATION = {
  id: 'transform-001',
  correlation_id: 'corr-transform-001',
  source_agent: 'polymorphic-agent',
  target_agent: 'api-architect',
  transformation_duration_ms: 12,
  success: true,
  confidence_score: 0.88,
  timestamp: new Date().toISOString(),
};

/** Sample performance-metric event (legacy flat topic) */
const FIXTURE_PERFORMANCE_METRIC = {
  id: 'perf-001',
  correlation_id: 'corr-perf-001',
  query_text: 'Fix auth bug',
  routing_duration_ms: 35,
  cache_hit: false,
  candidates_evaluated: 8,
  trigger_match_strategy: 'keyword_match',
  timestamp: new Date().toISOString(),
};

// ============================================================================
// Unit-level tests (no Kafka needed)
// ============================================================================

describe('Layer 2: Topic Resolution', () => {
  // --------------------------------------------------------------------------
  // buildSubscriptionTopics
  // --------------------------------------------------------------------------

  it('buildSubscriptionTopics returns only canonical topic names (no legacy env prefix)', () => {
    const topics = buildSubscriptionTopics();

    expect(topics.length).toBeGreaterThan(0);

    for (const topic of topics) {
      // No topic should start with a known environment prefix followed by a dot
      for (const prefix of ENVIRONMENT_PREFIXES) {
        expect(topic.startsWith(`${prefix}.`)).toBe(false);
      }
    }
  });

  it('buildSubscriptionTopics includes legacy flat agent topics', () => {
    const topics = buildSubscriptionTopics();

    expect(topics).toContain(TOPIC_OMNICLAUDE_AGENT_ACTIONS);
    expect(topics).toContain(TOPIC_OMNICLAUDE_ROUTING_DECISIONS);
    expect(topics).toContain(TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION);
    expect(topics).toContain(TOPIC_OMNICLAUDE_PERFORMANCE_METRICS);
  });

  it('buildSubscriptionTopics includes canonical ONEX topics', () => {
    const topics = buildSubscriptionTopics();

    expect(topics).toContain(SUFFIX_OMNICLAUDE_SESSION_STARTED);
    expect(topics).toContain(SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED);
    expect(topics).toContain(SUFFIX_OMNICLAUDE_TOOL_EXECUTED);
    expect(topics).toContain(SUFFIX_NODE_HEARTBEAT);
    expect(topics).toContain(SUFFIX_NODE_INTROSPECTION);
    expect(topics).toContain(SUFFIX_VALIDATION_RUN_STARTED);
  });

  // --------------------------------------------------------------------------
  // extractSuffix
  // --------------------------------------------------------------------------

  it('extractSuffix strips all known legacy prefixes', () => {
    // dev prefix
    expect(extractSuffix('dev.onex.evt.omniclaude.session-started.v1')).toBe(
      'onex.evt.omniclaude.session-started.v1'
    );

    // staging prefix (on a legacy flat topic name that happens to be prefixed)
    expect(extractSuffix(`staging.${TOPIC_OMNICLAUDE_AGENT_ACTIONS}`)).toBe(
      TOPIC_OMNICLAUDE_AGENT_ACTIONS
    );

    // prod prefix
    expect(extractSuffix('prod.onex.evt.platform.node-heartbeat.v1')).toBe(
      'onex.evt.platform.node-heartbeat.v1'
    );

    // production prefix
    expect(extractSuffix('production.onex.evt.platform.node-heartbeat.v1')).toBe(
      'onex.evt.platform.node-heartbeat.v1'
    );

    // test prefix
    expect(extractSuffix('test.onex.evt.omniclaude.tool-executed.v1')).toBe(
      'onex.evt.omniclaude.tool-executed.v1'
    );

    // local prefix
    expect(extractSuffix('local.onex.evt.platform.node-registration.v1')).toBe(
      'onex.evt.platform.node-registration.v1'
    );
  });

  it('extractSuffix passes through canonical topics unchanged', () => {
    expect(extractSuffix('onex.evt.omniclaude.session-started.v1')).toBe(
      'onex.evt.omniclaude.session-started.v1'
    );

    expect(extractSuffix('onex.evt.platform.node-heartbeat.v1')).toBe(
      'onex.evt.platform.node-heartbeat.v1'
    );

    expect(extractSuffix('onex.cmd.platform.request-introspection.v1')).toBe(
      'onex.cmd.platform.request-introspection.v1'
    );

    expect(extractSuffix('onex.evt.omniintelligence.intent-classified.v1')).toBe(
      'onex.evt.omniintelligence.intent-classified.v1'
    );
  });

  it('extractSuffix passes through legacy flat topic names unchanged', () => {
    expect(extractSuffix(TOPIC_OMNICLAUDE_AGENT_ACTIONS)).toBe(TOPIC_OMNICLAUDE_AGENT_ACTIONS);
    expect(extractSuffix(TOPIC_OMNICLAUDE_ROUTING_DECISIONS)).toBe(
      TOPIC_OMNICLAUDE_ROUTING_DECISIONS
    );
    expect(extractSuffix(TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION)).toBe(
      TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION
    );
    expect(extractSuffix(TOPIC_OMNICLAUDE_PERFORMANCE_METRICS)).toBe(
      TOPIC_OMNICLAUDE_PERFORMANCE_METRICS
    );
  });

  // --------------------------------------------------------------------------
  // ENVIRONMENT_PREFIXES
  // --------------------------------------------------------------------------

  it('ENVIRONMENT_PREFIXES contains all known legacy prefixes', () => {
    const prefixes = [...ENVIRONMENT_PREFIXES];

    expect(prefixes).toContain('dev');
    expect(prefixes).toContain('staging');
    expect(prefixes).toContain('prod');
    expect(prefixes).toContain('production');
    expect(prefixes).toContain('test');
    expect(prefixes).toContain('local');

    // Should have exactly 6 known prefixes
    expect(prefixes).toHaveLength(6);
  });
});

// ============================================================================
// EventConsumer unit-level tests (uses injectPlaybackEvent, no Kafka needed)
// ============================================================================

describe('Layer 2: EventConsumer Processing', () => {
  // We need KAFKA_BROKERS set for the constructor, but we never actually connect.
  // Use a dummy value so the constructor does not throw.
  const originalKafkaBrokers = process.env.KAFKA_BROKERS;
  const originalKafkaBootstrap = process.env.KAFKA_BOOTSTRAP_SERVERS;

  let EventConsumer: typeof import('../../server/event-consumer').EventConsumer;

  beforeEach(async () => {
    // Set a dummy broker so the constructor succeeds without a real Kafka cluster
    process.env.KAFKA_BROKERS = 'localhost:9092';
    // Disable database preload to avoid needing a real PostgreSQL connection
    process.env.ENABLE_EVENT_PRELOAD = 'false';
    // Suppress noisy logs during tests
    process.env.LOG_LEVEL = 'error';

    // Dynamic import to pick up env vars set above.
    // Use a cache-busting query to get a fresh module each time.
    const mod = await import('../../server/event-consumer');
    EventConsumer = mod.EventConsumer;
  });

  afterEach(() => {
    // Restore original env
    if (originalKafkaBrokers !== undefined) {
      process.env.KAFKA_BROKERS = originalKafkaBrokers;
    } else {
      delete process.env.KAFKA_BROKERS;
    }
    if (originalKafkaBootstrap !== undefined) {
      process.env.KAFKA_BOOTSTRAP_SERVERS = originalKafkaBootstrap;
    } else {
      delete process.env.KAFKA_BOOTSTRAP_SERVERS;
    }
    delete process.env.ENABLE_EVENT_PRELOAD;
    delete process.env.LOG_LEVEL;
  });

  it('can be constructed when KAFKA_BROKERS is set', () => {
    const consumer = new EventConsumer();
    expect(consumer).toBeDefined();
    expect(consumer.getRecentActions()).toEqual([]);
    expect(consumer.getRoutingDecisions()).toEqual([]);
    expect(consumer.getRecentTransformations()).toEqual([]);
    expect(consumer.getPerformanceMetrics()).toEqual([]);
  });

  it('throws when KAFKA_BROKERS is not set', async () => {
    delete process.env.KAFKA_BROKERS;
    delete process.env.KAFKA_BOOTSTRAP_SERVERS;

    // Re-import to get a fresh module that reads the cleared env
    // The constructor reads env at instantiation time, so we just construct
    expect(() => {
      // Directly instantiate -- the class caches its broker value at construction
      // We need a fresh instance with no brokers
      const Ctor = EventConsumer;
      // The constructor checks process.env at call time, so clearing above suffices
      new Ctor();
    }).toThrow(/KAFKA_BROKERS/);
  });

  // --------------------------------------------------------------------------
  // injectPlaybackEvent -> getters
  // --------------------------------------------------------------------------

  it('processes agent-action events and stores them in getRecentActions()', () => {
    const consumer = new EventConsumer();

    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_AGENT_ACTIONS, FIXTURE_AGENT_ACTION);

    const actions = consumer.getRecentActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].agentName).toBe('api-architect');
    expect(actions[0].actionType).toBe('tool_call');
    expect(actions[0].actionName).toBe('read_file');
    expect(actions[0].durationMs).toBe(150);
    expect(actions[0].correlationId).toBe('corr-action-001');
  });

  it('processes routing-decision events and stores them in getRoutingDecisions()', () => {
    const consumer = new EventConsumer();

    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, FIXTURE_ROUTING_DECISION);

    const decisions = consumer.getRoutingDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].selectedAgent).toBe('debug');
    expect(decisions[0].confidenceScore).toBe(0.92);
    expect(decisions[0].routingStrategy).toBe('trigger_match');
    expect(decisions[0].routingTimeMs).toBe(45);
    expect(decisions[0].userRequest).toBe('Fix the authentication bug');
  });

  it('processes transformation events and stores them in getRecentTransformations()', () => {
    const consumer = new EventConsumer();

    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION, FIXTURE_TRANSFORMATION);

    const transforms = consumer.getRecentTransformations();
    expect(transforms).toHaveLength(1);
    expect(transforms[0].sourceAgent).toBe('polymorphic-agent');
    expect(transforms[0].targetAgent).toBe('api-architect');
    expect(transforms[0].success).toBe(true);
    expect(transforms[0].confidenceScore).toBe(0.88);
    expect(transforms[0].transformationDurationMs).toBe(12);
  });

  it('processes performance-metric events and stores them in getPerformanceMetrics()', () => {
    const consumer = new EventConsumer();

    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_PERFORMANCE_METRICS, FIXTURE_PERFORMANCE_METRIC);

    const metrics = consumer.getPerformanceMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0].queryText).toBe('Fix auth bug');
    expect(metrics[0].routingDurationMs).toBe(35);
    expect(metrics[0].cacheHit).toBe(false);
    expect(metrics[0].candidatesEvaluated).toBe(8);
  });

  it('processes OmniClaude session-started events via injectPlaybackEvent', () => {
    const consumer = new EventConsumer();

    consumer.injectPlaybackEvent(
      SUFFIX_OMNICLAUDE_SESSION_STARTED,
      FIXTURE_SESSION_STARTED as unknown as Record<string, unknown>
    );

    // Session-started events become agent actions with agentName 'omniclaude'
    const actions = consumer.getRecentActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].agentName).toBe('omniclaude');
  });

  it('processes OmniClaude tool-executed events via injectPlaybackEvent', () => {
    const consumer = new EventConsumer();

    consumer.injectPlaybackEvent(
      SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
      FIXTURE_TOOL_EXECUTED as unknown as Record<string, unknown>
    );

    const actions = consumer.getRecentActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].agentName).toBe('omniclaude');
  });

  it('getRoutingDecisions filters by agent name', () => {
    const consumer = new EventConsumer();

    // Inject decisions for different agents
    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, {
      ...FIXTURE_ROUTING_DECISION,
      id: 'decision-a',
      selected_agent: 'api-architect',
    });
    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, {
      ...FIXTURE_ROUTING_DECISION,
      id: 'decision-b',
      selected_agent: 'debug',
    });
    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, {
      ...FIXTURE_ROUTING_DECISION,
      id: 'decision-c',
      selected_agent: 'api-architect',
    });

    const apiDecisions = consumer.getRoutingDecisions({ agent: 'api-architect' });
    expect(apiDecisions).toHaveLength(2);
    apiDecisions.forEach((d) => {
      expect(d.selectedAgent).toBe('api-architect');
    });

    const debugDecisions = consumer.getRoutingDecisions({ agent: 'debug' });
    expect(debugDecisions).toHaveLength(1);
    expect(debugDecisions[0].selectedAgent).toBe('debug');
  });

  it('getRoutingDecisions filters by minimum confidence', () => {
    const consumer = new EventConsumer();

    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, {
      ...FIXTURE_ROUTING_DECISION,
      id: 'hi',
      confidence_score: 0.95,
    });
    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, {
      ...FIXTURE_ROUTING_DECISION,
      id: 'lo',
      confidence_score: 0.3,
    });

    const highConf = consumer.getRoutingDecisions({ minConfidence: 0.9 });
    expect(highConf).toHaveLength(1);
    expect(highConf[0].confidenceScore).toBe(0.95);
  });

  it('getRecentActions respects the limit parameter', () => {
    const consumer = new EventConsumer();

    for (let i = 0; i < 10; i++) {
      consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_AGENT_ACTIONS, {
        ...FIXTURE_AGENT_ACTION,
        id: `action-${i}`,
      });
    }

    expect(consumer.getRecentActions()).toHaveLength(10);
    expect(consumer.getRecentActions(3)).toHaveLength(3);
    expect(consumer.getRecentActions(100)).toHaveLength(10);
  });

  it('getAgentMetrics returns metrics after processing routing decisions', () => {
    const consumer = new EventConsumer();

    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, {
      ...FIXTURE_ROUTING_DECISION,
      selected_agent: 'code-quality-analyzer',
      confidence_score: 0.85,
      routing_time_ms: 40,
    });
    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, {
      ...FIXTURE_ROUTING_DECISION,
      id: 'decision-002',
      selected_agent: 'code-quality-analyzer',
      confidence_score: 0.9,
      routing_time_ms: 60,
    });

    const metrics = consumer.getAgentMetrics();
    const cqaMetric = metrics.find((m) => m.agent === 'code-quality-analyzer');
    expect(cqaMetric).toBeDefined();
    expect(cqaMetric!.totalRequests).toBe(2);
    expect(cqaMetric!.avgConfidence).toBeCloseTo(0.875, 2);
    expect(cqaMetric!.avgRoutingTime).toBe(50);
  });

  it('getPerformanceStats returns aggregated performance data', () => {
    const consumer = new EventConsumer();

    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_PERFORMANCE_METRICS, {
      ...FIXTURE_PERFORMANCE_METRIC,
      routing_duration_ms: 20,
      cache_hit: true,
    });
    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_PERFORMANCE_METRICS, {
      ...FIXTURE_PERFORMANCE_METRIC,
      id: 'perf-002',
      routing_duration_ms: 40,
      cache_hit: false,
    });

    const stats = consumer.getPerformanceStats();
    expect(stats.totalQueries).toBe(2);
    expect(stats.cacheHitCount).toBe(1);
    expect(stats.avgRoutingDuration).toBe(30);
  });

  it('getPlaybackStats tracks injection counts', () => {
    const consumer = new EventConsumer();

    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_AGENT_ACTIONS, FIXTURE_AGENT_ACTION);
    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, FIXTURE_ROUTING_DECISION);

    const stats = consumer.getPlaybackStats();
    expect(stats.injected).toBe(2);
    expect(stats.failed).toBe(0);
    expect(stats.successRate).toBe(100);
  });

  it('resetState clears all in-memory storage', () => {
    const consumer = new EventConsumer();

    // Populate
    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_AGENT_ACTIONS, FIXTURE_AGENT_ACTION);
    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, FIXTURE_ROUTING_DECISION);
    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION, FIXTURE_TRANSFORMATION);
    consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_PERFORMANCE_METRICS, FIXTURE_PERFORMANCE_METRIC);

    // Verify populated
    expect(consumer.getRecentActions().length).toBeGreaterThan(0);
    expect(consumer.getRoutingDecisions().length).toBeGreaterThan(0);
    expect(consumer.getRecentTransformations().length).toBeGreaterThan(0);
    expect(consumer.getPerformanceMetrics().length).toBeGreaterThan(0);

    // Reset
    consumer.resetState();

    // Verify cleared
    expect(consumer.getRecentActions()).toEqual([]);
    expect(consumer.getRoutingDecisions()).toEqual([]);
    expect(consumer.getRecentTransformations()).toEqual([]);
    expect(consumer.getPerformanceMetrics()).toEqual([]);
    expect(consumer.getPlaybackStats().injected).toBe(0);
  });

  // --------------------------------------------------------------------------
  // In-memory storage bounds
  // --------------------------------------------------------------------------

  it('in-memory actions storage respects maxActions bound (1000)', () => {
    const consumer = new EventConsumer();

    // Inject more than the limit
    const count = 1050;
    for (let i = 0; i < count; i++) {
      consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_AGENT_ACTIONS, {
        ...FIXTURE_AGENT_ACTION,
        id: `action-${i}`,
        agent_name: `agent-${i}`,
      });
    }

    const actions = consumer.getRecentActions();
    expect(actions.length).toBeLessThanOrEqual(1000);
    // The most recent action should be the last injected
    expect(actions[0].id).toBe(`action-${count - 1}`);
  });

  it('in-memory routing decisions storage respects maxDecisions bound (1000)', () => {
    const consumer = new EventConsumer();

    const count = 1050;
    for (let i = 0; i < count; i++) {
      consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, {
        ...FIXTURE_ROUTING_DECISION,
        id: `decision-${i}`,
      });
    }

    const decisions = consumer.getRoutingDecisions();
    expect(decisions.length).toBeLessThanOrEqual(1000);
    // Most recent first
    expect(decisions[0].id).toBe(`decision-${count - 1}`);
  });

  it('in-memory transformations storage respects maxTransformations bound (100)', () => {
    const consumer = new EventConsumer();

    const count = 150;
    for (let i = 0; i < count; i++) {
      consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION, {
        ...FIXTURE_TRANSFORMATION,
        id: `transform-${i}`,
      });
    }

    const transforms = consumer.getRecentTransformations();
    expect(transforms.length).toBeLessThanOrEqual(100);
    expect(transforms[0].id).toBe(`transform-${count - 1}`);
  });

  it('in-memory performance metrics storage respects buffer size bound (200)', () => {
    const consumer = new EventConsumer();

    const count = 250;
    for (let i = 0; i < count; i++) {
      consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_PERFORMANCE_METRICS, {
        ...FIXTURE_PERFORMANCE_METRIC,
        id: `perf-${i}`,
      });
    }

    const metrics = consumer.getPerformanceMetrics();
    expect(metrics.length).toBeLessThanOrEqual(200);
    expect(metrics[0].id).toBe(`perf-${count - 1}`);
  });

  // --------------------------------------------------------------------------
  // Event emitter integration
  // --------------------------------------------------------------------------

  it('emits actionUpdate when processing agent actions', () =>
    new Promise<void>((resolve) => {
      const consumer = new EventConsumer();

      consumer.on('actionUpdate', (action) => {
        expect(action.agentName).toBe('api-architect');
        resolve();
      });

      consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_AGENT_ACTIONS, FIXTURE_AGENT_ACTION);
    }));

  it('emits routingUpdate when processing routing decisions', () =>
    new Promise<void>((resolve) => {
      const consumer = new EventConsumer();

      consumer.on('routingUpdate', (decision) => {
        expect(decision.selectedAgent).toBe('debug');
        resolve();
      });

      consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_ROUTING_DECISIONS, FIXTURE_ROUTING_DECISION);
    }));

  it('emits transformationUpdate when processing transformations', () =>
    new Promise<void>((resolve) => {
      const consumer = new EventConsumer();

      consumer.on('transformationUpdate', (transform) => {
        expect(transform.sourceAgent).toBe('polymorphic-agent');
        expect(transform.targetAgent).toBe('api-architect');
        resolve();
      });

      consumer.injectPlaybackEvent(TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION, FIXTURE_TRANSFORMATION);
    }));

  it('emits performanceUpdate when processing performance metrics', () =>
    new Promise<void>((resolve) => {
      const consumer = new EventConsumer();

      consumer.on('performanceUpdate', (data) => {
        expect(data.metric.routingDurationMs).toBe(35);
        expect(data.stats.totalQueries).toBe(1);
        resolve();
      });

      consumer.injectPlaybackEvent(
        TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
        FIXTURE_PERFORMANCE_METRIC
      );
    }));
});

// ============================================================================
// Integration tests (real Kafka) -- guarded by INTEGRATION_TESTS=true
// ============================================================================

const INTEGRATION_ENABLED = process.env.INTEGRATION_TESTS === 'true';

describe.skipIf(!INTEGRATION_ENABLED)('Layer 2: EventConsumer Kafka Integration', () => {
  // These tests require a running Kafka broker at the address specified
  // in KAFKA_BROKERS / KAFKA_BOOTSTRAP_SERVERS (defaults to localhost:9092).
  // Run with: INTEGRATION_TESTS=true npx vitest run tests/integration/layer2-event-consumer.test.ts

  let EventConsumer: typeof import('../../server/event-consumer').EventConsumer;
  let consumer: InstanceType<typeof import('../../server/event-consumer').EventConsumer>;

  beforeEach(async () => {
    // Disable preload to avoid needing PostgreSQL for these tests
    process.env.ENABLE_EVENT_PRELOAD = 'false';
    process.env.LOG_LEVEL = 'error';

    const mod = await import('../../server/event-consumer');
    EventConsumer = mod.EventConsumer;
    consumer = new EventConsumer();
  });

  afterEach(async () => {
    try {
      await consumer.stop();
    } catch {
      // Ignore stop errors during cleanup
    }
    delete process.env.ENABLE_EVENT_PRELOAD;
    delete process.env.LOG_LEVEL;
  });

  it('EventConsumer can connect to Kafka and subscribe', async () => {
    // connectWithRetry should succeed if Kafka is reachable
    await consumer.connectWithRetry(3);

    const health = consumer.getHealthStatus();
    expect(health).toBeDefined();
    expect(health.status).toBeDefined();
  });

  it('EventConsumer processes a sample event through the live pipeline', async () => {
    // Start the consumer (connects, subscribes, begins processing)
    await consumer.start();

    // Give the consumer a moment to subscribe and be ready
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Now produce a test event using kafkajs directly
    const { Kafka } = await import('kafkajs');
    const brokers = (
      process.env.KAFKA_BROKERS ||
      process.env.KAFKA_BOOTSTRAP_SERVERS ||
      'localhost:9092'
    ).split(',');

    const kafka = new Kafka({
      brokers,
      clientId: 'layer2-test-producer',
    });
    const producer = kafka.producer();
    await producer.connect();

    const testAction = {
      ...FIXTURE_AGENT_ACTION,
      id: `layer2-test-${Date.now()}`,
      agent_name: 'layer2-test-agent',
    };

    await producer.send({
      topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
      messages: [{ value: JSON.stringify(testAction) }],
    });

    // Wait for the consumer to process the event
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 10000);
      const checkInterval = setInterval(() => {
        const actions = consumer.getRecentActions();
        const found = actions.find((a) => a.id === testAction.id);
        if (found) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve();
        }
      }, 200);
    });

    const actions = consumer.getRecentActions();
    const testResult = actions.find((a) => a.id === testAction.id);
    expect(testResult).toBeDefined();
    expect(testResult!.agentName).toBe('layer2-test-agent');

    await producer.disconnect();
  }, 30000); // 30s timeout for Kafka operations

  it('EventConsumer getters return data after processing events via Kafka', async () => {
    await consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const { Kafka } = await import('kafkajs');
    const brokers = (
      process.env.KAFKA_BROKERS ||
      process.env.KAFKA_BOOTSTRAP_SERVERS ||
      'localhost:9092'
    ).split(',');

    const kafka = new Kafka({
      brokers,
      clientId: 'layer2-test-producer-getters',
    });
    const producer = kafka.producer();
    await producer.connect();

    const uniqueId = `layer2-getter-${Date.now()}`;

    // Send a routing decision and an action
    await producer.send({
      topic: TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
      messages: [
        {
          value: JSON.stringify({
            ...FIXTURE_ROUTING_DECISION,
            id: `${uniqueId}-decision`,
            selected_agent: 'layer2-getter-agent',
          }),
        },
      ],
    });

    await producer.send({
      topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
      messages: [
        {
          value: JSON.stringify({
            ...FIXTURE_AGENT_ACTION,
            id: `${uniqueId}-action`,
            agent_name: 'layer2-getter-agent',
          }),
        },
      ],
    });

    // Wait for consumer to process both events
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 15000);
      const checkInterval = setInterval(() => {
        const actions = consumer.getRecentActions();
        const decisions = consumer.getRoutingDecisions();
        const hasAction = actions.some((a) => a.id === `${uniqueId}-action`);
        const hasDecision = decisions.some((d) => d.id === `${uniqueId}-decision`);
        if (hasAction && hasDecision) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve();
        }
      }, 200);
    });

    // Verify getters
    const actions = consumer.getRecentActions();
    expect(actions.some((a) => a.id === `${uniqueId}-action`)).toBe(true);

    const decisions = consumer.getRoutingDecisions();
    expect(decisions.some((d) => d.id === `${uniqueId}-decision`)).toBe(true);

    const metrics = consumer.getAgentMetrics();
    expect(metrics.some((m) => m.agent === 'layer2-getter-agent')).toBe(true);

    await producer.disconnect();
  }, 30000);
});
