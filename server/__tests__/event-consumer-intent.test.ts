/**
 * EventConsumer intent/action event processing tests.
 *
 * Validates that the EventConsumer correctly forwards IntentClassified and
 * IntentStored Kafka events to the IntentEventEmitter, handling both the
 * current structured format and legacy field-name variants.
 *
 * Mock strategy:
 *   - `vi.hoisted()` runs before any imports, creating mock functions and
 *     setting environment variables so that module-level initialization in
 *     `event-consumer.ts` sees the test values.
 *   - `vi.mock()` replaces `kafkajs`, `../storage`, and `../intent-events`
 *     with lightweight stubs that reference the hoisted mocks.
 *
 * Environment variables:
 *   - `KAFKA_BROKERS` and `KAFKA_BOOTSTRAP_SERVERS` are set inside
 *     `vi.hoisted()` so they are available at module-load time.
 *   - They are reset to the same test value in `beforeEach` to ensure a
 *     clean slate between tests.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Use vi.hoisted to set environment variables and create mocks before module loading
const {
  mockConsumerConnect,
  mockConsumerDisconnect,
  mockConsumerSubscribe,
  mockConsumerRun,
  mockAdminConnect,
  mockAdminDisconnect,
  mockAdminListTopics,
  mockEmitIntentStored,
  mockIntentEventEmitter,
} = vi.hoisted(() => {
  // Set env vars immediately (must use a clearly-fake broker so tests
  // never accidentally connect to a real Kafka instance)
  process.env.KAFKA_BROKERS = 'test-broker:29092'; // # cloud-bus-ok OMN-4494
  process.env.KAFKA_BOOTSTRAP_SERVERS = 'test-broker:29092'; // # cloud-bus-ok OMN-4494

  const mockEmitIntentStored = vi.fn();
  const mockIntentEventEmitter = {
    emitIntentStored: mockEmitIntentStored,
    emitDistributionUpdate: vi.fn(),
    emitSessionUpdate: vi.fn(),
    emitRecentIntents: vi.fn(),
    emitIntentEvent: vi.fn(),
    emitFromQueryResponse: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  };

  return {
    mockConsumerConnect: vi.fn(),
    mockConsumerDisconnect: vi.fn(),
    mockConsumerSubscribe: vi.fn(),
    mockConsumerRun: vi.fn(),
    mockAdminConnect: vi.fn(),
    mockAdminDisconnect: vi.fn(),
    mockAdminListTopics: vi.fn(),
    mockEmitIntentStored,
    mockIntentEventEmitter,
  };
});

// Mock kafkajs module
vi.mock('kafkajs', () => ({
  Kafka: vi.fn().mockImplementation(() => ({
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
  })),
}));

// Mock storage module
vi.mock('../storage', () => ({
  getIntelligenceDb: vi.fn(() => ({
    execute: vi.fn(),
  })),
}));

// Mock the intent-events module
vi.mock('../intent-events', () => ({
  getIntentEventEmitter: vi.fn(() => mockIntentEventEmitter),
  IntentEventEmitter: vi.fn(),
  intentEventEmitter: mockIntentEventEmitter,
}));

// Import after mocks are set up
import { EventConsumer } from '../event-consumer';
import { EVENT_TYPE_NAMES, INTENT_STORED_TOPIC } from '@shared/intent-types';

describe('EventConsumer Intent Forwarding', () => {
  let consumer: InstanceType<typeof EventConsumer>;
  let eachMessageHandler: (params: { topic: string; message: { value: Buffer } }) => Promise<void>;

  beforeEach(async () => {
    // Clear all mock calls
    vi.clearAllMocks();
    vi.useRealTimers();

    // Reset environment variables (keep in sync with vi.hoisted values)
    process.env.KAFKA_BROKERS = 'test-broker:29092'; // # cloud-bus-ok OMN-4494
    process.env.KAFKA_BOOTSTRAP_SERVERS = 'test-broker:29092'; // # cloud-bus-ok OMN-4494
    process.env.ENABLE_EVENT_PRELOAD = 'false';

    // Create new consumer instance
    consumer = new EventConsumer();

    // Set up mocks for Kafka operations
    mockConsumerConnect.mockResolvedValueOnce(undefined);
    mockConsumerSubscribe.mockResolvedValueOnce(undefined);
    mockConsumerRun.mockImplementation(async ({ eachMessage }) => {
      eachMessageHandler = eachMessage;
    });

    // Start the consumer to capture the message handler
    await consumer.start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await consumer.stop();
    } catch (error) {
      // Consumer may not be fully initialized in some test scenarios
      // (e.g., if start() was mocked or test failed before consumer.start() completed).
      // Log at debug level for troubleshooting but don't fail the test.
      console.debug('Cleanup: consumer.stop() error (expected in some tests):', error);
    }
  });

  describe('handleIntentClassified', () => {
    it('should forward intent classified events to IntentEventEmitter', async () => {
      // Create a properly formatted IntentClassifiedEvent (matching shared interface)
      const event = {
        id: 'test-classified-id-123',
        event_type: EVENT_TYPE_NAMES.INTENT_CLASSIFIED, // 'IntentClassified'
        session_id: 'session-abc-456',
        correlation_id: '550e8400-e29b-41d4-a716-446655440000',
        intent_category: 'code_generation',
        confidence: 0.92,
        timestamp: '2026-01-26T10:30:00.000Z',
      };

      await eachMessageHandler({
        topic: 'dev.onex.evt.omniintelligence.intent-classified.v1',
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      // Verify emitIntentStored was called
      expect(mockEmitIntentStored).toHaveBeenCalledTimes(1);

      // Verify the payload structure
      const calledPayload = mockEmitIntentStored.mock.calls[0][0];
      expect(calledPayload).toHaveProperty('intent_id');
      expect(calledPayload).toHaveProperty('session_ref', 'session-abc-456');
      expect(calledPayload).toHaveProperty('intent_category', 'code_generation');
      expect(calledPayload).toHaveProperty('confidence', 0.92);
      expect(calledPayload).toHaveProperty('keywords');
      expect(calledPayload).toHaveProperty('created_at');
    });

    it('should construct correct IntentRecordPayload from classified event', async () => {
      const event = {
        id: 'intent-uuid-789',
        event_type: EVENT_TYPE_NAMES.INTENT_CLASSIFIED,
        session_id: 'my-session-ref',
        correlation_id: '550e8400-e29b-41d4-a716-446655440001',
        intent_category: 'debugging',
        confidence: 0.85,
        timestamp: '2026-01-26T11:00:00.000Z',
      };

      await eachMessageHandler({
        topic: 'dev.onex.evt.omniintelligence.intent-classified.v1',
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      expect(mockEmitIntentStored).toHaveBeenCalledTimes(1);

      const payload = mockEmitIntentStored.mock.calls[0][0];
      // IntentClassifiedEvent doesn't include keywords, so it should be empty array
      expect(payload.keywords).toEqual([]);
      // intent_id should be the event id
      expect(payload.intent_id).toBe('intent-uuid-789');
      // session_ref should be mapped from session_id
      expect(payload.session_ref).toBe('my-session-ref');
      // intent_category should be passed through
      expect(payload.intent_category).toBe('debugging');
      // confidence should be passed through
      expect(payload.confidence).toBe(0.85);
      // created_at should be a valid ISO string
      expect(typeof payload.created_at).toBe('string');
    });

    it('should not forward events with wrong event_type', async () => {
      // Event with different event_type should not pass type guard
      const event = {
        id: 'test-id',
        event_type: 'SomeOtherEvent', // Not 'IntentClassified'
        session_id: 'session-123',
        correlation_id: '550e8400-e29b-41d4-a716-446655440002',
        intent_category: 'testing',
        confidence: 0.75,
        timestamp: '2026-01-26T12:00:00.000Z',
      };

      await eachMessageHandler({
        topic: 'dev.onex.evt.omniintelligence.intent-classified.v1',
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      // Should NOT be forwarded because isIntentClassifiedEvent returns false
      expect(mockEmitIntentStored).not.toHaveBeenCalled();
    });

    it('should handle legacy format with intentType instead of intent_category', async () => {
      // Legacy format event - should still be processed for internal storage
      // but may not pass the type guard for forwarding
      const event = {
        id: 'legacy-id',
        intentType: 'refactoring', // Legacy field name
        confidence: 0.88,
        timestamp: '2026-01-26T13:00:00.000Z',
      };

      await eachMessageHandler({
        topic: 'dev.onex.evt.omniintelligence.intent-classified.v1',
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      // Legacy format without proper event_type won't pass type guard
      // So emitIntentStored should NOT be called
      expect(mockEmitIntentStored).not.toHaveBeenCalled();
    });
  });

  describe('handleIntentStored', () => {
    it('should forward intent stored events to IntentEventEmitter', async () => {
      // Create a properly formatted IntentStoredEvent (matching shared interface)
      const event = {
        event_type: INTENT_STORED_TOPIC, // 'onex.evt.omnimemory.intent-stored.v1'
        correlation_id: '550e8400-e29b-41d4-a716-446655440003',
        intent_id: 'stored-intent-uuid-123',
        session_ref: 'session-xyz-789',
        intent_category: 'documentation',
        confidence: 0.95,
        keywords: ['api', 'docs', 'swagger'],
        created: true,
        stored_at: '2026-01-26T14:00:00.000Z',
        execution_time_ms: 45,
        status: 'success',
      };

      await eachMessageHandler({
        topic: 'dev.onex.evt.omnimemory.intent-stored.v1',
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      expect(mockEmitIntentStored).toHaveBeenCalledTimes(1);

      const payload = mockEmitIntentStored.mock.calls[0][0];
      expect(payload.intent_id).toBe('stored-intent-uuid-123');
      expect(payload.session_ref).toBe('session-xyz-789');
      expect(payload.intent_category).toBe('documentation');
      expect(payload.confidence).toBe(0.95);
      expect(payload.keywords).toEqual(['api', 'docs', 'swagger']);
      expect(payload.created_at).toBe('2026-01-26T14:00:00.000Z');
    });

    it('should handle legacy format events and create minimal payload', async () => {
      // Legacy format without all the required fields for full IntentStoredEvent
      const event = {
        id: 'legacy-stored-id',
        intent_id: 'legacy-intent-123',
        intent_type: 'analysis',
        storage_location: '/data/intents',
        correlation_id: '550e8400-e29b-41d4-a716-446655440004',
        timestamp: '2026-01-26T15:00:00.000Z',
        // Missing: event_type, session_ref, confidence, keywords, created, stored_at, execution_time_ms, status
      };

      await eachMessageHandler({
        topic: 'dev.onex.evt.omnimemory.intent-stored.v1',
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      // Legacy format should still trigger emitIntentStored with minimal payload
      expect(mockEmitIntentStored).toHaveBeenCalledTimes(1);

      const payload = mockEmitIntentStored.mock.calls[0][0];
      expect(payload.intent_id).toBe('legacy-intent-123');
      // Legacy format doesn't have session_ref, uses 'unknown' sentinel value
      expect(payload.session_ref).toBe('unknown');
      // Legacy format uses intent_type which maps to intent_category
      expect(payload.intent_category).toBe('analysis');
      // Legacy format doesn't have confidence
      expect(payload.confidence).toBe(0);
      // Legacy format doesn't have keywords
      expect(payload.keywords).toEqual([]);
      // created_at should be a valid ISO string
      expect(typeof payload.created_at).toBe('string');
    });

    it('should use intentId (camelCase) when intent_id is not present', async () => {
      const event = {
        id: 'event-id',
        intentId: 'camel-case-intent-id', // camelCase variant
        intentType: 'testing',
        timestamp: '2026-01-26T16:00:00.000Z',
      };

      await eachMessageHandler({
        topic: 'dev.onex.evt.omnimemory.intent-stored.v1',
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      expect(mockEmitIntentStored).toHaveBeenCalledTimes(1);
      const payload = mockEmitIntentStored.mock.calls[0][0];
      expect(payload.intent_id).toBe('camel-case-intent-id');
    });

    it('should generate UUID when no intent_id or intentId is present', async () => {
      const event = {
        id: 'event-id',
        // No intent_id or intentId
        intent_type: 'configuration',
        timestamp: '2026-01-26T17:00:00.000Z',
      };

      await eachMessageHandler({
        topic: 'dev.onex.evt.omnimemory.intent-stored.v1',
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      expect(mockEmitIntentStored).toHaveBeenCalledTimes(1);
      const payload = mockEmitIntentStored.mock.calls[0][0];
      // Should have generated a UUID
      expect(payload.intent_id).toBeTruthy();
      expect(typeof payload.intent_id).toBe('string');
      // UUID format validation (basic check)
      expect(payload.intent_id.length).toBeGreaterThan(0);
    });
  });

  describe('error handling', () => {
    it('should skip malformed JSON with console.warn instead of emitting error', async () => {
      const errorSpy = vi.fn();
      consumer.on('error', errorSpy);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Send malformed event - now handled by inner try/catch with console.warn + return
      await eachMessageHandler({
        topic: 'dev.onex.evt.omniintelligence.intent-classified.v1',
        message: {
          value: Buffer.from('{ invalid json'),
        },
      });

      // Malformed JSON is silently skipped (no error event emitted)
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EventConsumer] Skipping malformed JSON message'),
        expect.any(Object)
      );

      warnSpy.mockRestore();
    });

    it('should skip malformed JSON on intent stored topic with console.warn', async () => {
      const errorSpy = vi.fn();
      consumer.on('error', errorSpy);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Send malformed event - now handled by inner try/catch with console.warn + return
      await eachMessageHandler({
        topic: 'dev.onex.evt.omnimemory.intent-stored.v1',
        message: {
          value: Buffer.from('not valid json at all'),
        },
      });

      // Malformed JSON is silently skipped (no error event emitted)
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EventConsumer] Skipping malformed JSON message'),
        expect.any(Object)
      );

      warnSpy.mockRestore();
    });

    it('should continue processing after malformed JSON is skipped', async () => {
      const errorSpy = vi.fn();
      consumer.on('error', errorSpy);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Send malformed event (now skipped via inner try/catch, no error emitted)
      await eachMessageHandler({
        topic: 'dev.onex.evt.omniintelligence.intent-classified.v1',
        message: {
          value: Buffer.from('{ invalid'),
        },
      });

      // Clear mock to track next call
      mockEmitIntentStored.mockClear();

      // Send valid event
      const validEvent = {
        id: 'valid-id',
        event_type: EVENT_TYPE_NAMES.INTENT_CLASSIFIED,
        session_id: 'session-123',
        correlation_id: '550e8400-e29b-41d4-a716-446655440005',
        intent_category: 'code_generation',
        confidence: 0.9,
        timestamp: '2026-01-26T18:00:00.000Z',
      };

      await eachMessageHandler({
        topic: 'dev.onex.evt.omniintelligence.intent-classified.v1',
        message: {
          value: Buffer.from(JSON.stringify(validEvent)),
        },
      });

      // Malformed JSON is silently skipped (no error event), but valid events still process
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // Valid event should still be processed
      expect(mockEmitIntentStored).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });
  });

  describe('internal event emission', () => {
    it('should emit intent-event for classified events (legacy EventEmitter pattern)', async () => {
      const intentEventSpy = vi.fn();
      consumer.on('intent-event', intentEventSpy);

      const event = {
        id: 'test-id',
        event_type: EVENT_TYPE_NAMES.INTENT_CLASSIFIED,
        session_id: 'session-123',
        correlation_id: '550e8400-e29b-41d4-a716-446655440006',
        intent_category: 'debugging',
        confidence: 0.88,
        timestamp: '2026-01-26T19:00:00.000Z',
      };

      await eachMessageHandler({
        topic: 'dev.onex.evt.omniintelligence.intent-classified.v1',
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      expect(intentEventSpy).toHaveBeenCalledTimes(1);
      expect(intentEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'onex.evt.omniintelligence.intent-classified.v1',
          payload: expect.objectContaining({
            intentType: 'debugging',
            confidence: 0.88,
          }),
        })
      );
    });

    it('should emit intent-event for stored events (legacy EventEmitter pattern)', async () => {
      const intentEventSpy = vi.fn();
      consumer.on('intent-event', intentEventSpy);

      const event = {
        id: 'stored-event-id',
        intent_id: 'stored-intent-id',
        intent_type: 'analysis',
        storage_location: '/data',
        timestamp: '2026-01-26T20:00:00.000Z',
      };

      await eachMessageHandler({
        topic: 'dev.onex.evt.omnimemory.intent-stored.v1',
        message: {
          value: Buffer.from(JSON.stringify(event)),
        },
      });

      expect(intentEventSpy).toHaveBeenCalledTimes(1);
      expect(intentEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'onex.evt.omnimemory.intent-stored.v1',
          payload: expect.objectContaining({
            intentId: 'stored-intent-id',
            intentType: 'analysis',
          }),
        })
      );
    });
  });
});
