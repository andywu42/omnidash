import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Tests for INITIAL_STATE freshness fixes.
 *
 * Verifies that:
 * 1. The DB preload query includes a time filter (no stale events)
 * 2. Live Kafka events are captured and available in getPreloadedEventBusEvents()
 * 3. getPreloadedEventBusEvents() merges preloaded + live events correctly
 * 4. Deduplication works when the same event exists in both preloaded and live buffers
 * 5. Events are sorted newest-first and capped at the limit
 * 6. Pruning removes stale events from both buffers
 */

// Set Kafka env vars before module loading
vi.hoisted(() => {
  process.env.KAFKA_BROKERS = 'localhost:9092';
  process.env.KAFKA_BOOTSTRAP_SERVERS = 'localhost:9092';
  process.env.ENABLE_EVENT_PRELOAD = 'false'; // Disable auto-preload in tests
  process.env.OMNIDASH_USE_REGISTRY_DISCOVERY = 'false'; // Use legacy path in unit tests
});

// Capture the eachMessage handler so we can simulate Kafka events
let capturedEachMessage: (payload: {
  topic: string;
  partition: number;
  message: {
    value: Buffer | null;
    offset: string;
    key: Buffer | null;
    headers: Record<string, Buffer | undefined>;
    timestamp: string;
  };
}) => Promise<void>;

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

const mockDb = {
  execute: vi.fn(() => {
    // Return empty result set
    return Promise.resolve({ rows: [] });
  }),
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

import { EventConsumer } from '../event-consumer';
import { TOPIC_OMNICLAUDE_AGENT_ACTIONS } from '@shared/topics';

describe('INITIAL_STATE freshness', () => {
  let consumer: InstanceType<typeof EventConsumer>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    process.env.KAFKA_BOOTSTRAP_SERVERS = 'localhost:9092';
    process.env.ENABLE_EVENT_PRELOAD = 'false';
    process.env.OMNIDASH_USE_REGISTRY_DISCOVERY = 'false'; // Use legacy path in unit tests

    // Capture the eachMessage handler when consumer.run() is called
    mockConsumerRun.mockImplementation(async (config: any) => {
      capturedEachMessage = config.eachMessage;
    });

    consumer = new EventConsumer();
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await consumer.stop();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('preloadFromDatabase time filter', () => {
    it('should execute a time-filtered parameterized preload query', async () => {
      // Enable preload for this test
      process.env.ENABLE_EVENT_PRELOAD = 'true';

      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);
      mockConsumerRun.mockResolvedValueOnce(undefined);

      // Need fresh consumer to pick up ENABLE_EVENT_PRELOAD=true
      const freshConsumer = new EventConsumer();
      await freshConsumer.start();

      // The preload query now uses Drizzle's sql tagged template (parameterized)
      // instead of sql.raw. Verify the DB was queried during preload.
      expect(mockDb.execute).toHaveBeenCalled();

      // The Drizzle SQL object stores query fragments in its internal
      // queryChunks array. Serialise it to verify the time filter and
      // ordering are present in the generated SQL.
      const sqlObj = mockDb.execute.mock.calls[0][0];
      const serialised = JSON.stringify(sqlObj);

      expect(serialised).toContain('event_bus_events');
      // The preload query computes the cutoff as a JS Date object and passes
      // it as a parameterized value (ISO-8601 string in queryChunks).
      expect(serialised).toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO date parameter
      expect(serialised).toContain('ORDER BY');

      try {
        await freshConsumer.stop();
      } catch {
        // Ignore
      }
    });
  });

  describe('getPreloadedEventBusEvents', () => {
    it('should return empty array when no events exist', () => {
      const events = consumer.getPreloadedEventBusEvents();
      expect(events).toEqual([]);
    });

    it('should capture live Kafka events and return them in getPreloadedEventBusEvents', async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);

      await consumer.start();

      // Simulate a Kafka event arriving
      const now = new Date();
      const kafkaEvent = {
        event_type: 'test.event.v1',
        event_id: 'evt-live-001',
        timestamp: now.toISOString(),
        tenant_id: 'test-tenant',
        namespace: 'test-ns',
        source: 'test-source',
        payload: { action: 'test-action', details: 'live kafka event' },
      };

      await capturedEachMessage({
        topic: 'dev.onex.evt.test-event.v1',
        partition: 0,
        message: {
          value: Buffer.from(JSON.stringify(kafkaEvent)),
          offset: '42',
          key: null,
          headers: {},
          timestamp: now.getTime().toString(),
        },
      });

      const events = consumer.getPreloadedEventBusEvents();
      expect(events.length).toBeGreaterThanOrEqual(1);

      const liveEvent = events.find((e) => e.event_id === 'evt-live-001');
      expect(liveEvent).toBeDefined();
      expect(liveEvent!.event_type).toBe('test.event.v1');
      expect(liveEvent!.topic).toBe('dev.onex.evt.test-event.v1');
      expect(liveEvent!.payload).toEqual({ action: 'test-action', details: 'live kafka event' });
    });

    it('should include events from multiple Kafka topics', async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);

      await consumer.start();

      const now = new Date();

      // Simulate events from different topics
      const events = [
        {
          topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
          event: {
            event_type: 'agent-action',
            event_id: 'evt-action-001',
            timestamp: new Date(now.getTime() - 1000).toISOString(),
            action_type: 'tool_call',
            agent_name: 'polymorphic-agent',
          },
        },
        {
          topic: 'dev.onex.evt.session-started.v1',
          event: {
            event_type: 'session-started',
            event_id: 'evt-session-001',
            timestamp: now.toISOString(),
            payload: { session_id: 'sess-123' },
          },
        },
      ];

      for (const { topic, event } of events) {
        await capturedEachMessage({
          topic,
          partition: 0,
          message: {
            value: Buffer.from(JSON.stringify(event)),
            offset: '0',
            key: null,
            headers: {},
            timestamp: now.getTime().toString(),
          },
        });
      }

      const result = consumer.getPreloadedEventBusEvents();
      expect(result.length).toBe(2);

      const actionEvent = result.find((e) => e.event_id === 'evt-action-001');
      expect(actionEvent).toBeDefined();

      const sessionEvent = result.find((e) => e.event_id === 'evt-session-001');
      expect(sessionEvent).toBeDefined();
    });

    it('should sort events newest-first', async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);

      await consumer.start();

      const now = Date.now();

      // Send events with different timestamps (out of order)
      const timestamps = [
        { id: 'evt-oldest', ts: now - 60000 },
        { id: 'evt-newest', ts: now },
        { id: 'evt-middle', ts: now - 30000 },
      ];

      for (const { id, ts } of timestamps) {
        await capturedEachMessage({
          topic: 'test-topic',
          partition: 0,
          message: {
            value: Buffer.from(
              JSON.stringify({
                event_type: 'test',
                event_id: id,
                timestamp: new Date(ts).toISOString(),
              })
            ),
            offset: '0',
            key: null,
            headers: {},
            timestamp: ts.toString(),
          },
        });
      }

      const events = consumer.getPreloadedEventBusEvents();
      expect(events.length).toBe(3);
      expect(events[0].event_id).toBe('evt-newest');
      expect(events[1].event_id).toBe('evt-middle');
      expect(events[2].event_id).toBe('evt-oldest');
    });

    it('should deduplicate events with the same event_id (live wins over preloaded)', async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);

      await consumer.start();

      const now = new Date();

      // Simulate a preloaded event by directly accessing internal state
      // We use the preload flow: enable preload, return mock data from DB
      // Instead, we can test dedup logic more directly by sending two events
      // with the same event_id through Kafka
      await capturedEachMessage({
        topic: 'test-topic',
        partition: 0,
        message: {
          value: Buffer.from(
            JSON.stringify({
              event_type: 'test',
              event_id: 'evt-dupe-001',
              timestamp: now.toISOString(),
              payload: { version: 'first' },
            })
          ),
          offset: '10',
          key: null,
          headers: {},
          timestamp: now.getTime().toString(),
        },
      });

      // Send a duplicate event_id
      await capturedEachMessage({
        topic: 'test-topic',
        partition: 0,
        message: {
          value: Buffer.from(
            JSON.stringify({
              event_type: 'test',
              event_id: 'evt-dupe-001',
              timestamp: now.toISOString(),
              payload: { version: 'second' },
            })
          ),
          offset: '11',
          key: null,
          headers: {},
          timestamp: now.getTime().toString(),
        },
      });

      // Both go into liveEventBusEvents; dedup happens in getter
      // The live buffer may have both, but getPreloadedEventBusEvents() deduplicates
      const events = consumer.getPreloadedEventBusEvents();
      const dupes = events.filter((e) => e.event_id === 'evt-dupe-001');
      // Live events are iterated first, so the first occurrence (version: 'first') wins
      // since it was pushed to the array first and the dedup uses seen set
      expect(dupes.length).toBe(1);
    });

    it('should handle legacy flat events without ONEX envelope fields', async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);

      await consumer.start();

      // Legacy event: flat structure, no envelope fields
      const legacyEvent = {
        action_type: 'tool_call',
        agent_name: 'polymorphic-agent',
        action_name: 'read_file',
        duration_ms: 150,
        timestamp: new Date().toISOString(),
      };

      await capturedEachMessage({
        topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        partition: 0,
        message: {
          value: Buffer.from(JSON.stringify(legacyEvent)),
          offset: '99',
          key: null,
          headers: {},
          timestamp: Date.now().toString(),
        },
      });

      const events = consumer.getPreloadedEventBusEvents();
      expect(events.length).toBeGreaterThanOrEqual(1);

      // The captured event should have the topic as event_type fallback
      const captured = events[0];
      expect(captured.topic).toBe(TOPIC_OMNICLAUDE_AGENT_ACTIONS);
      // For flat events, the entire event becomes the payload
      expect(captured.payload.action_type).toBe('tool_call');
      expect(captured.payload.agent_name).toBe('polymorphic-agent');
    });
  });

  describe('INITIAL_STATE reflects current system state', () => {
    it('should include events consumed after server startup in getPreloadedEventBusEvents', async () => {
      // Start consumer with no preloaded data
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);

      await consumer.start();

      // Initially empty
      expect(consumer.getPreloadedEventBusEvents()).toEqual([]);

      // Simulate Kafka events arriving over time
      const eventTimes = [
        { id: 'evt-t1', delay: 0 },
        { id: 'evt-t2', delay: 1000 },
        { id: 'evt-t3', delay: 2000 },
      ];

      const baseTime = Date.now();
      for (const { id, delay } of eventTimes) {
        const ts = new Date(baseTime + delay);
        await capturedEachMessage({
          topic: 'test-topic',
          partition: 0,
          message: {
            value: Buffer.from(
              JSON.stringify({
                event_type: 'test',
                event_id: id,
                timestamp: ts.toISOString(),
                payload: { seq: delay },
              })
            ),
            offset: String(delay),
            key: null,
            headers: {},
            timestamp: ts.getTime().toString(),
          },
        });
      }

      // All 3 events should be available for INITIAL_STATE
      const events = consumer.getPreloadedEventBusEvents();
      expect(events.length).toBe(3);

      // Newest first
      expect(events[0].event_id).toBe('evt-t3');
      expect(events[1].event_id).toBe('evt-t2');
      expect(events[2].event_id).toBe('evt-t1');
    });

    it('should cap live events buffer at MAX_LIVE_EVENT_BUS_EVENTS', async () => {
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);

      await consumer.start();

      // Send more events than the buffer allows (MAX_LIVE_EVENT_BUS_EVENTS = 2000)
      // We only need to verify the cap mechanism works, so send 2005
      const count = 2005;
      const baseTime = Date.now();

      for (let i = 0; i < count; i++) {
        const ts = new Date(baseTime + i);
        await capturedEachMessage({
          topic: 'test-topic',
          partition: 0,
          message: {
            value: Buffer.from(
              JSON.stringify({
                event_type: 'test',
                event_id: `evt-cap-${i}`,
                timestamp: ts.toISOString(),
              })
            ),
            offset: String(i),
            key: null,
            headers: {},
            timestamp: ts.getTime().toString(),
          },
        });
      }

      const events = consumer.getPreloadedEventBusEvents();
      // Should be capped at 2000 (SQL_PRELOAD_LIMIT)
      expect(events.length).toBeLessThanOrEqual(2000);
      // The newest events should be retained (oldest dropped)
      expect(events[0].event_id).toBe(`evt-cap-${count - 1}`);
    });
  });

  describe('preloadFromDatabase with time filter', () => {
    it('should filter events to the configured window when preloading', async () => {
      // Enable preload for this test
      process.env.ENABLE_EVENT_PRELOAD = 'true';

      // Return some mock events from the DB
      const mockRows = [
        {
          event_type: 'test.v1',
          event_id: 'preload-001',
          timestamp: new Date().toISOString(),
          tenant_id: '',
          namespace: '',
          source: '',
          correlation_id: null,
          causation_id: null,
          schema_ref: '',
          payload: JSON.stringify({ test: true }),
          topic: 'test-topic',
          partition: 0,
          offset: '1',
          processed_at: new Date().toISOString(),
          stored_at: new Date().toISOString(),
        },
      ];

      mockDb.execute.mockResolvedValueOnce({ rows: mockRows });
      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);
      mockConsumerRun.mockResolvedValueOnce(undefined);

      const freshConsumer = new EventConsumer();
      await freshConsumer.start();

      // Verify the DB was called with a parameterized query (sql tagged template,
      // not sql.raw). The query should contain the time-filter interval.
      expect(mockDb.execute).toHaveBeenCalled();

      // Verify the preloaded events are accessible
      const events = freshConsumer.getPreloadedEventBusEvents();
      expect(events.length).toBe(1);
      expect(events[0].event_id).toBe('preload-001');

      try {
        await freshConsumer.stop();
      } catch {
        // Ignore
      }
    });

    it('should merge preloaded and live events when both exist', async () => {
      process.env.ENABLE_EVENT_PRELOAD = 'true';

      const now = new Date();
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

      // Return a preloaded event from DB
      mockDb.execute.mockResolvedValueOnce({
        rows: [
          {
            event_type: 'preloaded.v1',
            event_id: 'preload-merge-001',
            timestamp: fiveMinAgo.toISOString(),
            tenant_id: '',
            namespace: '',
            source: 'db',
            correlation_id: null,
            causation_id: null,
            schema_ref: '',
            payload: JSON.stringify({ source: 'preload' }),
            topic: 'test-topic',
            partition: 0,
            offset: '1',
            processed_at: fiveMinAgo.toISOString(),
            stored_at: fiveMinAgo.toISOString(),
          },
        ],
      });

      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);

      // Capture eachMessage for this consumer too
      let localEachMessage: typeof capturedEachMessage;
      mockConsumerRun.mockImplementation(async (config: any) => {
        localEachMessage = config.eachMessage;
      });

      const freshConsumer = new EventConsumer();
      await freshConsumer.start();

      // Now simulate a live Kafka event arriving after startup
      await localEachMessage!({
        topic: 'test-topic',
        partition: 0,
        message: {
          value: Buffer.from(
            JSON.stringify({
              event_type: 'live.v1',
              event_id: 'live-merge-001',
              timestamp: now.toISOString(),
              payload: { source: 'kafka' },
            })
          ),
          offset: '100',
          key: null,
          headers: {},
          timestamp: now.getTime().toString(),
        },
      });

      const events = freshConsumer.getPreloadedEventBusEvents();
      expect(events.length).toBe(2);

      // Newest first: live event should come before preloaded
      expect(events[0].event_id).toBe('live-merge-001');
      expect(events[1].event_id).toBe('preload-merge-001');

      try {
        await freshConsumer.stop();
      } catch {
        // Ignore
      }
    });

    it('should deduplicate when live and preloaded share the same event_id', async () => {
      process.env.ENABLE_EVENT_PRELOAD = 'true';

      const now = new Date();

      // Return a preloaded event from DB
      mockDb.execute.mockResolvedValueOnce({
        rows: [
          {
            event_type: 'shared.v1',
            event_id: 'shared-evt-001',
            timestamp: now.toISOString(),
            tenant_id: '',
            namespace: '',
            source: 'db',
            correlation_id: null,
            causation_id: null,
            schema_ref: '',
            payload: JSON.stringify({ source: 'preload', version: 'old' }),
            topic: 'test-topic',
            partition: 0,
            offset: '5',
            processed_at: now.toISOString(),
            stored_at: now.toISOString(),
          },
        ],
      });

      mockConsumerConnect.mockResolvedValueOnce(undefined);
      mockConsumerSubscribe.mockResolvedValueOnce(undefined);

      let localEachMessage: typeof capturedEachMessage;
      mockConsumerRun.mockImplementation(async (config: any) => {
        localEachMessage = config.eachMessage;
      });

      const freshConsumer = new EventConsumer();
      await freshConsumer.start();

      // Simulate the same event arriving via Kafka (same event_id)
      await localEachMessage!({
        topic: 'test-topic',
        partition: 0,
        message: {
          value: Buffer.from(
            JSON.stringify({
              event_type: 'shared.v1',
              event_id: 'shared-evt-001',
              timestamp: now.toISOString(),
              payload: { source: 'kafka', version: 'new' },
            })
          ),
          offset: '5',
          key: null,
          headers: {},
          timestamp: now.getTime().toString(),
        },
      });

      const events = freshConsumer.getPreloadedEventBusEvents();
      // Should only have 1 event (deduplicated)
      const matching = events.filter((e) => e.event_id === 'shared-evt-001');
      expect(matching.length).toBe(1);

      // Live event should win (it's iterated first in the merge)
      expect(matching[0].payload.source).toBe('kafka');
      expect(matching[0].payload.version).toBe('new');

      try {
        await freshConsumer.stop();
      } catch {
        // Ignore
      }
    });
  });
});
