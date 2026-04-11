// no-migration: OMN-6971 Unit test for heartbeat emitter; no schema change.
/**
 * Tests for ConsumerHealthHeartbeat (OMN-6971)
 *
 * Covers the pure payload builder and the emitter's interval plumbing
 * without reaching Kafka.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReadModelConsumerStats } from '../read-model-consumer';

const mockProducer = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
};

vi.mock('kafkajs', () => ({
  Kafka: vi.fn(function () {
    return { producer: () => mockProducer };
  }),
}));

vi.mock('../bus-config.js', () => ({
  resolveBrokers: () => ['localhost:19092'],
  getBrokerString: () => 'localhost:19092',
}));

const statsRef: { current: ReadModelConsumerStats } = {
  current: {
    isRunning: true,
    eventsProjected: 42,
    errorsCount: 1,
    lastProjectedAt: new Date(),
    topicStats: {
      'onex.evt.omnibase-infra.consumer-health.v1': { projected: 5, errors: 0 },
      'onex.evt.omnibase-infra.baselines-computed.v1': { projected: 37, errors: 1 },
    },
    catalogSource: 'fallback',
    unsupportedCatalogTopics: [],
  },
};

vi.mock('../read-model-consumer', () => ({
  readModelConsumer: {
    getStats: () => statsRef.current,
  },
  // Type re-export only used at compile time; runtime import is fine.
}));

import {
  buildHeartbeatPayload,
  ConsumerHealthHeartbeat,
} from '../consumer-health-heartbeat';

describe('buildHeartbeatPayload', () => {
  it('produces an INFO heartbeat when the consumer is running', () => {
    const now = new Date('2026-04-11T12:00:00Z');
    const payload = buildHeartbeatPayload(
      statsRef.current,
      ['topic.a', 'topic.b'],
      now
    );

    expect(payload.event_type).toBe('CONSUMER_HEARTBEAT');
    expect(payload.severity).toBe('INFO');
    expect(payload.status).toBe('healthy');
    expect(payload.consumer_group).toBe('omnidash-read-model-v1');
    expect(payload.topic).toBe('onex.evt.omnibase-infra.consumer-health.v1');
    expect(payload.topics_subscribed).toEqual(['topic.a', 'topic.b']);
    expect(payload.events_projected).toBe(42);
    expect(payload.emitted_at).toBe('2026-04-11T12:00:00.000Z');
    expect(typeof payload.event_id).toBe('string');
    expect(String(payload.event_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('downgrades to HEARTBEAT_FAILURE when the consumer is not running', () => {
    const degraded: ReadModelConsumerStats = {
      ...statsRef.current,
      isRunning: false,
    };
    const payload = buildHeartbeatPayload(degraded, [], new Date());

    expect(payload.event_type).toBe('HEARTBEAT_FAILURE');
    expect(payload.severity).toBe('WARNING');
    expect(payload.status).toBe('degraded');
  });
});

describe('ConsumerHealthHeartbeat', () => {
  beforeEach(() => {
    mockProducer.connect.mockClear();
    mockProducer.disconnect.mockClear();
    mockProducer.send.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it('connects the producer and emits a heartbeat on start', async () => {
    const hb = new ConsumerHealthHeartbeat(60_000);
    await hb.start();
    // Allow the fire-and-forget emitOnce() to resolve.
    await new Promise((r) => setImmediate(r));

    expect(mockProducer.connect).toHaveBeenCalledTimes(1);
    expect(mockProducer.send).toHaveBeenCalledTimes(1);

    const sendArgs = mockProducer.send.mock.calls[0][0];
    expect(sendArgs.topic).toBe('onex.evt.omnibase-infra.consumer-health.v1');
    const envelope = JSON.parse(sendArgs.messages[0].value);
    expect(envelope.payload.event_type).toBe('CONSUMER_HEARTBEAT');
    expect(envelope.payload.consumer_group).toBe('omnidash-read-model-v1');

    await hb.stop();
    expect(mockProducer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('skips start when the interval is 0', async () => {
    const hb = new ConsumerHealthHeartbeat(0);
    await hb.start();
    expect(mockProducer.connect).not.toHaveBeenCalled();
    expect(hb.isStarted).toBe(false);
  });

  it('fires a second heartbeat after the configured interval', async () => {
    vi.useFakeTimers();
    const hb = new ConsumerHealthHeartbeat(100);
    await hb.start();
    // Flush the immediate emit
    await vi.advanceTimersByTimeAsync(0);
    expect(mockProducer.send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(mockProducer.send).toHaveBeenCalledTimes(2);

    await hb.stop();
  });
});
