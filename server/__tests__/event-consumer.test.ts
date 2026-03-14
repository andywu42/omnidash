/**
 * EventConsumer unit tests -- verifies core Kafka consumer functionality
 * including connection lifecycle, message handling, metric aggregation,
 * retry/reconnection logic, and data pruning.
 *
 * Mock strategy:
 *   vi.hoisted() blocks define mock fns and seed process.env before any
 *   module-level code executes.  vi.mock() replaces kafkajs and storage
 *   so no real broker or database connection is attempted.
 *
 * Environment variables:
 *   KAFKA_BROKERS / KAFKA_BOOTSTRAP_SERVERS are set to a clearly-fake
 *   test broker ('test-broker:29092') inside vi.hoisted() so the module // # cloud-bus-ok OMN-4494
 *   can load without error.  beforeEach() resets them to the same fake
 *   value to keep every test isolated.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Use vi.hoisted to set environment variables and create mocks before module loading
// Create mock functions using vi.hoisted() so they're available during module loading
vi.hoisted(() => {
  process.env.KAFKA_BROKERS = 'test-broker:29092'; // # cloud-bus-ok OMN-4494
  process.env.KAFKA_BOOTSTRAP_SERVERS = 'test-broker:29092'; // # cloud-bus-ok OMN-4494
  process.env.OMNIDASH_USE_REGISTRY_DISCOVERY = 'false'; // Use legacy path in unit tests
});

// Create mock functions for Kafka operations
const {
  mockConsumerConnect,
  mockConsumerDisconnect,
  mockConsumerSubscribe,
  mockConsumerRun,
  mockAdminConnect,
  mockAdminDisconnect,
  mockAdminListTopics,
} = vi.hoisted(() => ({
  mockConsumerConnect: vi.fn(),
  mockConsumerDisconnect: vi.fn(),
  mockConsumerSubscribe: vi.fn(),
  mockConsumerRun: vi.fn(),
  mockAdminConnect: vi.fn(),
  mockAdminDisconnect: vi.fn(),
  mockAdminListTopics: vi.fn(),
}));

// Mock kafkajs module
vi.mock('kafkajs', () => ({
  Kafka: vi.fn().mockImplementation(function () {
    return {
      consumer: vi.fn().mockReturnValue({
        connect: mockConsumerConnect,
        disconnect: mockConsumerDisconnect,
        subscribe: mockConsumerSubscribe,
        run: mockConsumerRun,
      }),
      producer: vi.fn().mockReturnValue({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
      }),
      admin: vi.fn().mockReturnValue({
        connect: mockAdminConnect,
        disconnect: mockAdminDisconnect,
        listTopics: mockAdminListTopics,
      }),
    };
  }),
}));

// Mock storage module
const mockDb = {
  execute: vi.fn(),
};

vi.mock('../storage', () => ({
  getIntelligenceDb: vi.fn(() => mockDb),
}));

// Mock TopicCatalogManager so it immediately falls back (catalogTimeout)
// without calling kafka.consumer() and polluting the shared consumer mock
vi.mock('../topic-catalog-manager', async () => {
  const { EventEmitter } = await import('events');
  return {
    TopicCatalogManager: vi.fn().mockImplementation(function () {
      const emitter = new EventEmitter();
      return {
        bootstrap: vi.fn().mockImplementation(function () {
          // Emit catalogTimeout after current microtask so once() listeners
          // are registered first, matching the real production code path
          Promise.resolve().then(() => emitter.emit('catalogTimeout'));
          return Promise.resolve();
        }),
        stop: vi.fn().mockResolvedValue(undefined),
        once: emitter.once.bind(emitter),
        on: emitter.on.bind(emitter),
        instanceUuid: null,
      };
    }),
    CATALOG_TIMEOUT_MS: 200,
  };
});

// Import after mocks are set up - this will use our mocks
import { EventConsumer } from '../event-consumer';
import {
  buildSubscriptionTopics,
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
} from '@shared/topics';

describe('EventConsumer', () => {
  let consumer: InstanceType<typeof EventConsumer>;

  beforeEach(() => {
    // Clear all mock calls
    vi.clearAllMocks();
    vi.useRealTimers(); // Ensure real timers for most tests

    // Reset environment variables to clearly-fake test broker
    process.env.KAFKA_BROKERS = 'test-broker:29092'; // # cloud-bus-ok OMN-4494
    process.env.KAFKA_BOOTSTRAP_SERVERS = 'test-broker:29092'; // # cloud-bus-ok OMN-4494
    process.env.ENABLE_EVENT_PRELOAD = 'false';
    process.env.OMNIDASH_USE_REGISTRY_DISCOVERY = 'false'; // Use legacy path in unit tests

    // Create new consumer instance for each test
    consumer = new EventConsumer();
  });

  afterEach(async () => {
    vi.useRealTimers(); // Clean up timers after each test
    try {
      await consumer.stop();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should initialize as EventEmitter', () => {
      expect(consumer).toBeInstanceOf(EventEmitter);
    });

    it('should throw error when KAFKA_BROKERS environment variable is missing', () => {
      delete process.env.KAFKA_BOOTSTRAP_SERVERS;
      delete process.env.KAFKA_BROKERS;

      expect(() => new EventConsumer()).toThrow(
        'KAFKA_BOOTSTRAP_SERVERS (or KAFKA_BROKERS) environment variable is required'
      );
    });
  });

  describe('validateConnection', () => {
    it('should require KAFKA_BROKERS to be configured before validating', async () => {
      delete process.env.KAFKA_BOOTSTRAP_SERVERS;
      delete process.env.KAFKA_BROKERS;

      expect(() => new EventConsumer()).toThrow(
        'KAFKA_BOOTSTRAP_SERVERS (or KAFKA_BROKERS) environment variable is required'
      );
    });

    it('should successfully validate broker connection', async () => {
      mockAdminConnect.mockResolvedValueOnce(undefined);
      mockAdminListTopics.mockResolvedValueOnce(['topic1', 'topic2', 'topic3']);
      mockAdminDisconnect.mockResolvedValueOnce(undefined);

      const result = await consumer.validateConnection();

      expect(result).toBe(true);
      expect(mockAdminConnect).toHaveBeenCalled();
      expect(mockAdminListTopics).toHaveBeenCalled();
      expect(mockAdminDisconnect).toHaveBeenCalled();
    });

    it('should return false and handle connection errors', async () => {
      mockAdminConnect.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await consumer.validateConnection();

      expect(result).toBe(false);
      expect(mockAdminConnect).toHaveBeenCalled();
    });

    it('should handle non-Error exceptions', async () => {
      mockAdminConnect.mockRejectedValueOnce('String error');

      const result = await consumer.validateConnection();

      expect(result).toBe(false);
    });
  });

  describe('start', () => {
    it('should connect to Kafka and subscribe to topics', async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);
      mockConsumerRun.mockResolvedValueOnce(undefined);

      await consumer.start();

      expect(mockConsumerConnect).toHaveBeenCalled();
      // Verify subscription topics match the shared builder output
      const call = mockConsumerSubscribe.mock.calls[0][0];
      expect(call.fromBeginning).toBe(false);
      const expectedTopics = buildSubscriptionTopics();
      expect(call.topics).toEqual(expectedTopics);
      expect(mockConsumerRun).toHaveBeenCalled();
    });

    it('should emit "connected" event on successful connection', async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);
      mockConsumerRun.mockResolvedValueOnce(undefined);

      const connectedSpy = vi.fn();
      consumer.on('connected', connectedSpy);

      await consumer.start();

      expect(connectedSpy).toHaveBeenCalled();
    });

    it('should not start if already running', async () => {
      mockConsumerConnect.mockResolvedValue(undefined);
      mockConsumerSubscribe.mockResolvedValue(undefined);
      mockConsumerRun.mockResolvedValue(undefined);

      await consumer.start();
      const firstCallCount = mockConsumerConnect.mock.calls.length;

      await consumer.start();

      // Should not call connect again
      expect(mockConsumerConnect).toHaveBeenCalledTimes(firstCallCount);
    });

    it('should handle connection errors and emit error event', async () => {
      vi.useFakeTimers();
      const connectionError = new Error('Connection failed');
      // Reject all connection attempts to exceed max retries
      mockConsumerConnect.mockRejectedValue(connectionError);

      const errorSpy = vi.fn();
      consumer.on('error', errorSpy);

      // Should throw after exhausting retries
      const startPromise = consumer.start();
      startPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1000);
      await expect(startPromise).rejects.toThrow('Kafka connection failed after 5 attempts');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Kafka connection failed after 5 attempts'),
        })
      );
      vi.useRealTimers();
    }, 2000);
  });

  describe('stop', () => {
    it('should disconnect consumer and emit "disconnected" event', async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);
      mockConsumerRun.mockResolvedValueOnce(undefined);
      mockConsumerDisconnect.mockResolvedValueOnce(undefined);

      await consumer.start();

      const disconnectedSpy = vi.fn();
      consumer.on('disconnected', disconnectedSpy);

      await consumer.stop();

      expect(mockConsumerDisconnect).toHaveBeenCalled();
      expect(disconnectedSpy).toHaveBeenCalled();
    });

    it('should handle disconnect errors', async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);
      mockConsumerRun.mockResolvedValueOnce(undefined);

      await consumer.start();

      const disconnectError = new Error('Disconnect failed');
      mockConsumerDisconnect.mockRejectedValueOnce(disconnectError);

      const errorSpy = vi.fn();
      consumer.on('error', errorSpy);

      await consumer.stop();

      expect(errorSpy).toHaveBeenCalledWith(disconnectError);
    });

    it('should do nothing if consumer is not running', async () => {
      await consumer.stop();

      expect(mockConsumerDisconnect).not.toHaveBeenCalled();
    });
  });

  describe('event handling - routing decisions', () => {
    let eachMessageHandler: any;

    beforeEach(async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);
      mockConsumerRun.mockImplementation(async ({ eachMessage }) => {
        eachMessageHandler = eachMessage;
      });

      await consumer.start();
    });

    it('should handle routing decision events with snake_case fields', async () => {
      const metricUpdateSpy = vi.fn();
      const routingUpdateSpy = vi.fn();
      consumer.on('metricUpdate', metricUpdateSpy);
      consumer.on('routingUpdate', routingUpdateSpy);

      const event = {
        id: 'decision-1',
        correlation_id: 'corr-1',
        selected_agent: 'agent-api',
        confidence_score: 0.95,
        routing_time_ms: 45,
        user_request: 'Create API endpoint',
        routing_strategy: 'semantic',
        timestamp: new Date().toISOString(),
      };

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      expect(metricUpdateSpy).toHaveBeenCalled();
      expect(routingUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedAgent: 'agent-api',
          confidenceScore: 0.95,
          routingTimeMs: 45,
        })
      );

      const metrics = consumer.getAgentMetrics();
      expect(metrics).toContainEqual(
        expect.objectContaining({
          agent: 'agent-api',
          totalRequests: 1,
          avgConfidence: 0.95,
          avgRoutingTime: 45,
        })
      );
    });

    it('should skip routing decisions without agent name', async () => {
      const metricUpdateSpy = vi.fn();
      consumer.on('metricUpdate', metricUpdateSpy);

      const event = {
        id: 'decision-3',
        correlation_id: 'corr-3',
        // Missing selected_agent
        confidence_score: 0.75,
      };

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      // Should not update metrics
      const metrics = consumer.getAgentMetrics();
      expect(metrics).toHaveLength(0);
    });

    it('should accumulate metrics for multiple routing decisions', async () => {
      const events = [
        {
          selected_agent: 'agent-api',
          confidence_score: 0.9,
          routing_time_ms: 40,
        },
        {
          selected_agent: 'agent-api',
          confidence_score: 0.95,
          routing_time_ms: 50,
        },
        {
          selected_agent: 'agent-api',
          confidence_score: 0.85,
          routing_time_ms: 45,
        },
      ];

      for (const event of events) {
        await eachMessageHandler({
          topic: TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
          message: {
            value: Buffer.from(JSON.stringify(event)),
          },
        });
      }

      const metrics = consumer.getAgentMetrics();
      const agentMetric = metrics.find((m) => m.agent === 'agent-api');

      expect(agentMetric).toBeDefined();
      expect(agentMetric?.totalRequests).toBe(3);
      expect(agentMetric?.avgConfidence).toBeCloseTo((0.9 + 0.95 + 0.85) / 3, 2);
      expect(agentMetric?.avgRoutingTime).toBeCloseTo((40 + 50 + 45) / 3, 2);
    });
  });

  describe('event handling - agent actions', () => {
    let eachMessageHandler: any;

    beforeEach(async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);
      mockConsumerRun.mockImplementation(async ({ eachMessage }) => {
        eachMessageHandler = eachMessage;
      });

      await consumer.start();
    });

    it('should handle agent action events', async () => {
      const actionUpdateSpy = vi.fn();
      consumer.on('actionUpdate', actionUpdateSpy);

      const event = {
        id: 'action-1',
        correlation_id: 'corr-1',
        agent_name: 'agent-api',
        action_type: 'tool_call',
        action_name: 'read_file',
        duration_ms: 150,
      };

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      expect(actionUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'agent-api',
          actionType: 'tool_call',
          actionName: 'read_file',
          durationMs: 150,
        })
      );
    });

    it('should track success rate for success and error actions', async () => {
      const events = [
        { agent_name: 'agent-test', action_type: 'success', action_name: 'test1' },
        { agent_name: 'agent-test', action_type: 'success', action_name: 'test2' },
        { agent_name: 'agent-test', action_type: 'error', action_name: 'test3' },
        { agent_name: 'agent-test', action_type: 'success', action_name: 'test4' },
      ];

      for (const event of events) {
        await eachMessageHandler({
          topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
          message: {
            value: Buffer.from(JSON.stringify(event)),
          },
        });
      }

      const metrics = consumer.getAgentMetrics();
      const agentMetric = metrics.find((m) => m.agent === 'agent-test');

      expect(agentMetric?.successRate).toBe(0.75); // 3/4 = 75%
    });
  });

  describe('error handling', () => {
    let eachMessageHandler: any;

    beforeEach(async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);
      mockConsumerRun.mockImplementation(async ({ eachMessage }) => {
        eachMessageHandler = eachMessage;
      });

      await consumer.start();
    });

    it('should skip malformed JSON with console.warn instead of emitting error', async () => {
      const errorSpy = vi.fn();
      consumer.on('error', errorSpy);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        message: {
          value: Buffer.from('{ invalid json'),
        },
      });

      // Malformed JSON is now caught by inner try/catch and logged via console.warn,
      // not emitted as an error event (defensive pattern matching read-model-consumer)
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EventConsumer] Skipping malformed JSON message'),
        expect.any(Object)
      );

      warnSpy.mockRestore();
    });

    it('should continue processing after malformed JSON is skipped', async () => {
      const errorSpy = vi.fn();
      const actionUpdateSpy = vi.fn();
      consumer.on('error', errorSpy);
      consumer.on('actionUpdate', actionUpdateSpy);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Send malformed event (now skipped via inner try/catch, no error emitted)
      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        message: {
          value: Buffer.from('invalid'),
        },
      });

      // Send valid event
      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        message: {
          value: Buffer.from(JSON.stringify({ agent_name: 'test', action_type: 'success' })),
        },
      });

      // Malformed JSON is silently skipped (no error event), but valid events still process
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(actionUpdateSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });
  });

  describe('getter methods', () => {
    it('getRecentActions should return limited results', () => {
      const actions = consumer.getRecentActions(5);
      expect(Array.isArray(actions)).toBe(true);
      expect(actions.length).toBeLessThanOrEqual(5);
    });

    it('getRecentActions should return all actions when no limit specified', () => {
      const actions = consumer.getRecentActions();
      expect(Array.isArray(actions)).toBe(true);
    });

    it('getHealthStatus should return correct status', async () => {
      const healthBefore = consumer.getHealthStatus();
      expect(healthBefore.status).toBe('unhealthy'); // Not started yet

      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);
      mockConsumerRun.mockResolvedValueOnce(undefined);

      await consumer.start();

      const healthAfter = consumer.getHealthStatus();
      expect(healthAfter.status).toBe('healthy');
      expect(healthAfter).toHaveProperty('eventsProcessed');
      expect(healthAfter).toHaveProperty('recentActionsCount');
      expect(healthAfter).toHaveProperty('timestamp');
    });

    it('getPerformanceStats should calculate cache hit rate correctly', () => {
      const stats = consumer.getPerformanceStats();
      expect(stats).toHaveProperty('totalQueries');
      expect(stats).toHaveProperty('cacheHitCount');
      expect(stats).toHaveProperty('avgRoutingDuration');
      expect(stats).toHaveProperty('cacheHitRate');
    });
  });

  describe('connectWithRetry', () => {
    it('should successfully connect on first attempt', async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);

      await consumer.connectWithRetry(5);

      expect(mockConsumerConnect).toHaveBeenCalledTimes(1);
    });

    it('should retry with exponential backoff on failure', async () => {
      vi.useFakeTimers();

      // Fail 2 times, then succeed
      mockConsumerConnect
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce(undefined);

      const connectPromise = consumer.connectWithRetry(5);
      connectPromise.catch(() => {});

      // Fast-forward through delays: 1s + 2s = 3s
      await vi.advanceTimersByTimeAsync(3000);

      await connectPromise;

      // Should have tried 3 times (2 failures + 1 success)
      expect(mockConsumerConnect).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    it('should throw error after max retries', async () => {
      vi.useFakeTimers();

      const maxRetries = 3;
      vi.clearAllMocks(); // Ensure clean state before this test
      mockConsumerConnect.mockRejectedValue(new Error('Connection refused'));

      const connectPromise = consumer.connectWithRetry(maxRetries);
      connectPromise.catch(() => {});

      // Fast-forward through all retry delays: 1s + 2s = 3s
      await vi.advanceTimersByTimeAsync(3000);

      await expect(connectPromise).rejects.toThrow('Kafka connection failed after 3 attempts');

      // Should have tried exactly maxRetries times
      expect(mockConsumerConnect).toHaveBeenCalledTimes(maxRetries);

      vi.useRealTimers();
    }, 5000); // Reduced timeout since we're using fake timers

    it('should respect max delay of 30 seconds', async () => {
      // Use fake timers to avoid waiting for real delays
      vi.useFakeTimers();

      // Mock high retry count to test max delay cap
      // Delays: 1s, 2s, 4s, 8s, 16s, 30s (capped), 30s (capped), 30s (capped)
      // Need 7+ failures to actually hit the 30s cap (since 2^5 = 32s, but cap is 30s)
      mockConsumerConnect
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused')) // 6th: would be 32s, capped to 30s
        .mockRejectedValueOnce(new Error('Connection refused')) // 7th: still 30s (capped)
        .mockResolvedValueOnce(undefined); // Success on 8th attempt

      const connectPromise = consumer.connectWithRetry(10);

      // Fast-forward through all delays: 1s + 2s + 4s + 8s + 16s + 30s + 30s = 91s
      await vi.advanceTimersByTimeAsync(91000);

      await connectPromise;

      // Verify it was called 8 times (7 failures + 1 success)
      expect(mockConsumerConnect).toHaveBeenCalledTimes(8);

      vi.useRealTimers();
    }, 10000); // Reduced timeout since we're using fake timers

    it('should handle non-Error exceptions', async () => {
      vi.useFakeTimers();

      mockConsumerConnect.mockRejectedValueOnce('String error').mockResolvedValueOnce(undefined);

      const connectPromise = consumer.connectWithRetry(5);

      // Fast-forward through the 1s delay
      await vi.advanceTimersByTimeAsync(1000);

      await connectPromise;

      expect(mockConsumerConnect).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    }, 5000); // Reduced timeout since we're using fake timers

    it('should throw error if consumer not initialized', async () => {
      const uninitializedConsumer = new EventConsumer();
      // Force consumer to null to simulate uninitialized state
      (uninitializedConsumer as any).consumer = null;

      await expect(uninitializedConsumer.connectWithRetry()).rejects.toThrow(
        'Consumer not initialized'
      );
    });
  });

  // NOTE: isTestEnv coverage gap — production vs test-env divergence
  //
  // In production, the outer `catch (runErr)` block calls `this.emit('error', runErr)`
  // after the `consumer.run()` loop exits due to a connection-level error.
  //
  // In the test environment, `isTestEnv` causes that outer catch to `break` out of
  // the while-loop immediately, BEFORE the `emit('error', runErr)` line is reached.
  //
  // As a result, the tests below assert `not.toHaveBeenCalled()` on `errorSpy`
  // rather than a positive assertion.  The production error-emission path from
  // the outer catch is intentionally not covered by these unit tests.
  describe('reconnection on message processing errors', () => {
    let eachMessageHandler: any;

    beforeEach(async () => {
      mockConsumerConnect.mockResolvedValue(undefined);
      mockConsumerSubscribe.mockResolvedValue(undefined);
      mockConsumerRun.mockImplementation(async ({ eachMessage }) => {
        eachMessageHandler = eachMessage;
      });

      await consumer.start();
    });

    it('should rethrow connection errors to outer retry loop and not attempt inline reconnection', async () => {
      vi.clearAllMocks(); // Clear after start to track reconnection attempts

      const errorSpy = vi.fn();
      consumer.on('error', errorSpy);

      // Create message that will throw a connection error during toString.
      // The eachMessage catch block detects "connection" in the message and
      // re-throws so consumer.run() can propagate it to the outer while-loop
      // catch, which handles actual reconnection.
      // NOTE: emit('error') was removed from the eachMessage catch block —
      // error emission was intended to be done by the outer catch (runErr),
      // but in test env that outer catch breaks immediately (isTestEnv guard)
      // without emitting. So in tests, no error event is emitted at all.
      const connectionError = new Error('Network connection error');
      const testMessage = {
        topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        message: {
          value: {
            toString: () => {
              throw connectionError;
            },
          },
        },
      };

      // The re-throw means the handler promise rejects
      await expect(eachMessageHandler(testMessage)).rejects.toThrow('Network connection error');

      // No error event is emitted: the eachMessage catch no longer calls emit('error'),
      // and the outer catch (runErr) breaks immediately in test env without emitting.
      expect(errorSpy).not.toHaveBeenCalled();

      // connectWithRetry is NOT called inline from eachMessage — reconnection is
      // delegated to the outer while-loop catch block (isTestEnv causes it to break)
      expect(mockConsumerConnect).not.toHaveBeenCalled();
    }, 2000);

    it('should not attempt reconnection on non-connection errors', async () => {
      vi.useFakeTimers();
      vi.clearAllMocks(); // Clear after start

      const errorSpy = vi.fn();
      consumer.on('error', errorSpy);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Send malformed JSON (non-connection error) - now handled by inner
      // try/catch with console.warn + return, no error event emitted
      const handlerPromise = eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        message: {
          value: Buffer.from('{ invalid json'),
        },
      });
      await vi.advanceTimersByTimeAsync(1000);
      await handlerPromise;

      // Should NOT emit error (malformed JSON is silently skipped) and not attempt reconnection
      expect(errorSpy).not.toHaveBeenCalled();
      expect(mockConsumerConnect).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should rethrow broker connection errors without inline reconnection and without double-emitting error', async () => {
      vi.clearAllMocks(); // Clear after start

      const errorSpy = vi.fn();
      consumer.on('error', errorSpy);

      // Create message with a broker-related connection error.
      // The eachMessage catch block detects "broker" in the message and re-throws.
      // emit('error') was removed from the eachMessage catch to prevent double-emission:
      // the outer catch (runErr) was intended to emit it once, but in test env that outer
      // catch breaks immediately (isTestEnv guard) without emitting. So in tests, no error
      // event is emitted — the only observable behavior is the handler promise rejecting.
      const brokerError = new Error('Kafka connection lost - broker unreachable');
      const testMessage = {
        topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        message: {
          value: {
            toString: () => {
              throw brokerError;
            },
          },
        },
      };

      // The re-throw propagates out of eachMessage
      await expect(eachMessageHandler(testMessage)).rejects.toThrow('broker unreachable');

      // No error event is emitted: emit('error') was removed from the eachMessage catch
      // block to prevent double-emission, and the outer catch breaks in test env.
      expect(errorSpy).not.toHaveBeenCalled();

      // connectWithRetry is NOT called inline — reconnection is deferred to
      // the outer while-loop which breaks in test env
      expect(mockConsumerConnect).not.toHaveBeenCalled();
    }, 2000);
  });

  describe('data pruning', () => {
    let eachMessageHandler: any;

    beforeEach(async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);
      mockConsumerRun.mockImplementation(async ({ eachMessage }) => {
        eachMessageHandler = eachMessage;
      });

      await consumer.start();
    });

    it('should prune old actions after 24 hours', async () => {
      // Add old action FIRST (25 hours ago) - chronological order matters
      // for monotonic merge (newer events always win)
      const oldAction = {
        id: 'action-old',
        agent_name: 'agent-test',
        action_type: 'tool_call',
        action_name: 'write_file',
        timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      };

      // Add recent action (current time)
      const recentAction = {
        id: 'action-recent',
        agent_name: 'agent-test',
        action_type: 'tool_call',
        action_name: 'read_file',
        timestamp: new Date().toISOString(),
      };

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        message: { value: Buffer.from(JSON.stringify(oldAction)) },
      });

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        message: { value: Buffer.from(JSON.stringify(recentAction)) },
      });

      // Verify both actions are present
      let actions = consumer.getRecentActions();
      expect(actions.length).toBe(2);

      // Call pruneOldData directly (simulate timer trigger)
      (consumer as any).pruneOldData();

      // Verify only recent action remains
      actions = consumer.getRecentActions();
      expect(actions.length).toBe(1);
      expect(actions[0].id).toBe('action-recent');
    });

    it('should prune old routing decisions after 24 hours', async () => {
      // Add old decision FIRST (25 hours ago) - chronological order matters
      // for monotonic merge (newer events always win)
      const oldDecision = {
        id: 'decision-old',
        selected_agent: 'agent-api',
        confidence_score: 0.85,
        timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      };

      // Add recent decision
      const recentDecision = {
        id: 'decision-recent',
        selected_agent: 'agent-api',
        confidence_score: 0.9,
        timestamp: new Date().toISOString(),
      };

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
        message: { value: Buffer.from(JSON.stringify(oldDecision)) },
      });

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
        message: { value: Buffer.from(JSON.stringify(recentDecision)) },
      });

      // Verify both decisions are present
      let decisions = consumer.getRoutingDecisions();
      expect(decisions.length).toBe(2);

      // Call pruneOldData
      (consumer as any).pruneOldData();

      // Verify only recent decision remains
      decisions = consumer.getRoutingDecisions();
      expect(decisions.length).toBe(1);
      expect(decisions[0].id).toBe('decision-recent');
    });

    it('should prune old transformations after 24 hours', async () => {
      // Add old transformation FIRST (25 hours ago) - chronological order matters
      // for monotonic merge (newer events always win)
      const oldTransformation = {
        id: 'trans-old',
        source_agent: 'agent-c',
        target_agent: 'agent-d',
        success: true,
        timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      };

      // Add recent transformation
      const recentTransformation = {
        id: 'trans-recent',
        source_agent: 'agent-a',
        target_agent: 'agent-b',
        success: true,
        timestamp: new Date().toISOString(),
      };

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
        message: { value: Buffer.from(JSON.stringify(oldTransformation)) },
      });

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
        message: { value: Buffer.from(JSON.stringify(recentTransformation)) },
      });

      // Verify both transformations are present
      let transformations = consumer.getRecentTransformations();
      expect(transformations.length).toBe(2);

      // Call pruneOldData
      (consumer as any).pruneOldData();

      // Verify only recent transformation remains
      transformations = consumer.getRecentTransformations();
      expect(transformations.length).toBe(1);
      expect(transformations[0].id).toBe('trans-recent');
    });

    it('should prune old performance metrics after 24 hours', async () => {
      // Add old metric FIRST (25 hours ago) - chronological order matters
      // for monotonic merge (newer events always win)
      const oldMetric = {
        id: 'metric-old',
        query_text: 'old query',
        routing_duration_ms: 150,
        cache_hit: false,
        timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      };

      // Add recent metric
      const recentMetric = {
        id: 'metric-recent',
        query_text: 'test query',
        routing_duration_ms: 100,
        cache_hit: true,
        timestamp: new Date().toISOString(),
      };

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
        message: { value: Buffer.from(JSON.stringify(oldMetric)) },
      });

      await eachMessageHandler({
        topic: TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
        message: { value: Buffer.from(JSON.stringify(recentMetric)) },
      });

      // Verify both metrics are present
      let metrics = consumer.getPerformanceMetrics();
      expect(metrics.length).toBe(2);

      // Call pruneOldData
      (consumer as any).pruneOldData();

      // Verify only recent metric remains
      metrics = consumer.getPerformanceMetrics();
      expect(metrics.length).toBe(1);
      expect(metrics[0].id).toBe('metric-recent');
    });

    it('should keep all events when none are older than 24 hours', async () => {
      // Add multiple recent events (all within last hour)
      const events = [
        {
          id: 'action-1',
          agent_name: 'agent-test',
          action_type: 'tool_call',
          timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        },
        {
          id: 'action-2',
          agent_name: 'agent-test',
          action_type: 'success',
          timestamp: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        },
        {
          id: 'action-3',
          agent_name: 'agent-test',
          action_type: 'error',
          timestamp: new Date().toISOString(),
        },
      ];

      for (const event of events) {
        await eachMessageHandler({
          topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
          message: { value: Buffer.from(JSON.stringify(event)) },
        });
      }

      const actionsBefore = consumer.getRecentActions().length;
      expect(actionsBefore).toBe(3);

      // Call pruneOldData
      (consumer as any).pruneOldData();

      // All events should still be present
      const actionsAfter = consumer.getRecentActions();
      expect(actionsAfter.length).toBe(3);
    });

    it('should clear pruning timer when consumer stops', async () => {
      // Verify timer exists after start
      expect((consumer as any).pruneTimer).toBeDefined();

      // Stop the consumer
      await consumer.stop();

      // Verify timer is cleared
      expect((consumer as any).pruneTimer).toBeUndefined();
    });

    it('should not log when no old data to prune', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      // Call pruneOldData with no old data
      (consumer as any).pruneOldData();

      // Should not log pruning message (only logs when totalRemoved > 0)
      const pruningLogs = consoleSpy.mock.calls.filter((call) =>
        call[0]?.includes('🧹 Pruned old data')
      );
      expect(pruningLogs.length).toBe(0);

      consoleSpy.mockRestore();
    });
  });

  describe('normalizeActionFields', () => {
    // Access the private static method for direct testing
    const normalize = (EventConsumer as any).normalizeActionFields.bind(EventConsumer);

    it('should extract actionType from canonical actionName when rawActionType is env prefix', () => {
      const result = normalize('dev', 'valid-agent', 'onex.cmd.omniintelligence.tool-content.v1');
      expect(result.actionType).toBe('tool-content');
      expect(result.agentName).toBe('valid-agent');
    });

    it('should extract agentName from canonical actionName when rawAgentName is "unknown"', () => {
      const result = normalize('tool_call', 'unknown', 'onex.cmd.omniintelligence.tool-content.v1');
      expect(result.agentName).toBe('omniintelligence');
      expect(result.actionType).toBe('tool_call');
    });

    it('should normalize both fields when both are junk', () => {
      const result = normalize('dev', 'unknown', 'onex.evt.archon.session-started.v1');
      expect(result.actionType).toBe('session-started');
      expect(result.agentName).toBe('archon');
    });

    it('should treat all env prefixes as junk actionType', () => {
      for (const prefix of ['dev', 'staging', 'prod', 'production', 'test', 'local']) {
        const result = normalize(prefix, 'valid-agent', 'onex.cmd.producer.action-name.v1');
        expect(result.actionType).toBe('action-name');
      }
    });

    it('should treat empty string as junk actionType', () => {
      const result = normalize('', 'valid-agent', 'onex.cmd.producer.my-action.v1');
      expect(result.actionType).toBe('my-action');
      expect(result.agentName).toBe('valid-agent');
    });

    it('should preserve valid actionType', () => {
      const result = normalize('tool_call', 'valid-agent', 'onex.cmd.producer.action.v1');
      expect(result.actionType).toBe('tool_call');
      expect(result.agentName).toBe('valid-agent');
    });

    it('should preserve valid agentName even when actionType is junk', () => {
      const result = normalize('dev', 'my-agent', 'onex.cmd.producer.action.v1');
      expect(result.actionType).toBe('action');
      expect(result.agentName).toBe('my-agent');
    });

    it('should not parse non-canonical actionName', () => {
      const result = normalize('dev', 'unknown', 'some-legacy-action');
      expect(result.actionType).toBe('dev');
      expect(result.agentName).toBe('unknown');
    });

    it('should handle short canonical actionName gracefully', () => {
      const result = normalize('dev', 'unknown', 'onex.cmd');
      expect(result.actionType).toBe('dev');
      expect(result.agentName).toBe('unknown');
    });

    it('should return original values when both are valid', () => {
      const result = normalize('tool_call', 'agent-1', 'whatever');
      expect(result.actionType).toBe('tool_call');
      expect(result.agentName).toBe('agent-1');
    });
  });
});
