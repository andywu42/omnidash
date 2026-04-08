/**
 * EventBusHealthProjection Tests (OMN-3192)
 *
 * Exercises the EventBusHealthProjection class to verify:
 * 1. Empty state returns empty topic list
 * 2. Topic data updates correctly on ingest
 * 3. Silent consumer detection: no messages > threshold
 * 4. Missing topic alert when expected but not on broker
 * 5. DLQ message count tracking
 * 6. Consumer lag tracking per topic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBusHealthProjection } from '../event-bus-health-projection';
import type { TopicHealthRecord } from '../event-bus-health-projection';

// ============================================================================
// Tests
// ============================================================================

describe('EventBusHealthProjection', () => {
  let projection: EventBusHealthProjection;

  beforeEach(() => {
    projection = new EventBusHealthProjection();
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // 1. Empty state
  // --------------------------------------------------------------------------

  it('should return empty topics when no records have been ingested', () => {
    const topics = projection.getAllTopics();
    expect(topics).toEqual([]);
  });

  it('should return null for an unknown topic', () => {
    const topic = projection.getTopicHealth('onex.evt.unknown.v1');
    expect(topic).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 2. Topic data updates correctly
  // --------------------------------------------------------------------------

  it('should create a topic entry from the first record', () => {
    const record: TopicHealthRecord = {
      topic: 'onex.evt.omniclaude.gate-decision.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 0,
      lastMessageTimestamp: new Date().toISOString(),
      dlqMessageCount: 0,
      presentOnBroker: true,
    };
    projection.ingest(record);

    const topic = projection.getTopicHealth('onex.evt.omniclaude.gate-decision.v1');
    expect(topic).not.toBeNull();
    expect(topic!.topic).toBe('onex.evt.omniclaude.gate-decision.v1');
    expect(topic!.lag).toBe(0);
    expect(topic!.missingFromBroker).toBe(false);
  });

  it('should update topic health on subsequent ingest', () => {
    const ts1 = new Date(Date.now() - 10_000).toISOString();
    const ts2 = new Date().toISOString();

    projection.ingest({
      topic: 'onex.evt.omniclaude.gate-decision.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 5,
      lastMessageTimestamp: ts1,
      dlqMessageCount: 0,
      presentOnBroker: true,
    });
    projection.ingest({
      topic: 'onex.evt.omniclaude.gate-decision.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 12,
      lastMessageTimestamp: ts2,
      dlqMessageCount: 2,
      presentOnBroker: true,
    });

    const topic = projection.getTopicHealth('onex.evt.omniclaude.gate-decision.v1');
    expect(topic!.lag).toBe(12);
    expect(topic!.dlqMessageCount).toBe(2);
    expect(topic!.lastMessageTimestamp).toBe(ts2);
  });

  // --------------------------------------------------------------------------
  // 3. Silent consumer detection
  // --------------------------------------------------------------------------

  it('should mark topic as silent when last message > threshold (default 10 min)', () => {
    vi.useFakeTimers();

    const oldTs = new Date().toISOString();
    projection.ingest({
      topic: 'onex.evt.omniintelligence.pattern-discovered.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 0,
      lastMessageTimestamp: oldTs,
      dlqMessageCount: 0,
      presentOnBroker: true,
    });

    // Advance time 11 minutes
    vi.advanceTimersByTime(11 * 60_000);

    const topic = projection.getTopicHealth('onex.evt.omniintelligence.pattern-discovered.v1');
    expect(topic!.silent).toBe(true);

    vi.useRealTimers();
  });

  it('should not mark topic as silent when last message is recent', () => {
    projection.ingest({
      topic: 'onex.evt.omniintelligence.pattern-discovered.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 0,
      lastMessageTimestamp: new Date().toISOString(),
      dlqMessageCount: 0,
      presentOnBroker: true,
    });

    const topic = projection.getTopicHealth('onex.evt.omniintelligence.pattern-discovered.v1');
    expect(topic!.silent).toBe(false);
  });

  it('should mark topic as silent when lastMessageTimestamp is null', () => {
    projection.ingest({
      topic: 'onex.evt.omniintelligence.pattern-discovered.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 0,
      lastMessageTimestamp: null,
      dlqMessageCount: 0,
      presentOnBroker: true,
    });

    const topic = projection.getTopicHealth('onex.evt.omniintelligence.pattern-discovered.v1');
    expect(topic!.silent).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 4. Missing topic alert
  // --------------------------------------------------------------------------

  it('should set missingFromBroker: true when presentOnBroker is false', () => {
    projection.ingest({
      topic: 'onex.evt.omnimemory.document-ingested.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 0,
      lastMessageTimestamp: null,
      dlqMessageCount: 0,
      presentOnBroker: false,
    });

    const topic = projection.getTopicHealth('onex.evt.omnimemory.document-ingested.v1');
    expect(topic!.missingFromBroker).toBe(true);
  });

  it('should not set missingFromBroker when topic is present on broker', () => {
    projection.ingest({
      topic: 'onex.evt.omnimemory.document-ingested.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 3,
      lastMessageTimestamp: new Date().toISOString(),
      dlqMessageCount: 0,
      presentOnBroker: true,
    });

    const topic = projection.getTopicHealth('onex.evt.omnimemory.document-ingested.v1');
    expect(topic!.missingFromBroker).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 5. DLQ message count tracking
  // --------------------------------------------------------------------------

  it('should track DLQ message counts accurately', () => {
    projection.ingest({
      topic: 'onex.evt.omniclaude.epic-run-updated.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 0,
      lastMessageTimestamp: new Date().toISOString(),
      dlqMessageCount: 7,
      presentOnBroker: true,
    });

    const topic = projection.getTopicHealth('onex.evt.omniclaude.epic-run-updated.v1');
    expect(topic!.dlqMessageCount).toBe(7);
    expect(topic!.hasDlqMessages).toBe(true);
  });

  it('should report hasDlqMessages: false when DLQ is empty', () => {
    projection.ingest({
      topic: 'onex.evt.omniclaude.epic-run-updated.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 0,
      lastMessageTimestamp: new Date().toISOString(),
      dlqMessageCount: 0,
      presentOnBroker: true,
    });

    const topic = projection.getTopicHealth('onex.evt.omniclaude.epic-run-updated.v1');
    expect(topic!.hasDlqMessages).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 6. Multiple topics tracked independently
  // --------------------------------------------------------------------------

  it('should track multiple topics independently', () => {
    const ts = new Date().toISOString();

    projection.ingest({
      topic: 'onex.evt.omniclaude.gate-decision.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 0,
      lastMessageTimestamp: ts,
      dlqMessageCount: 0,
      presentOnBroker: true,
    });
    projection.ingest({
      topic: 'onex.evt.omniclaude.epic-run-updated.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 15,
      lastMessageTimestamp: ts,
      dlqMessageCount: 3,
      presentOnBroker: true,
    });
    projection.ingest({
      topic: 'onex.evt.omnimemory.document-ingested.v1',
      consumerGroup: 'omnidash-consumer',
      lag: 0,
      lastMessageTimestamp: null,
      dlqMessageCount: 0,
      presentOnBroker: false,
    });

    const all = projection.getAllTopics();
    expect(all).toHaveLength(3);

    const missing = all.find((t) => t.missingFromBroker);
    expect(missing!.topic).toBe('onex.evt.omnimemory.document-ingested.v1');

    const highLag = all.find((t) => t.lag === 15);
    expect(highLag!.topic).toBe('onex.evt.omniclaude.epic-run-updated.v1');
  });

  // --------------------------------------------------------------------------
  // 7. getSummary
  // --------------------------------------------------------------------------

  it('should return accurate summary counts', () => {
    const ts = new Date().toISOString();

    projection.ingest({
      topic: 'topic-a',
      consumerGroup: 'g1',
      lag: 0,
      lastMessageTimestamp: ts,
      dlqMessageCount: 0,
      presentOnBroker: true,
    });
    projection.ingest({
      topic: 'topic-b',
      consumerGroup: 'g1',
      lag: 5,
      lastMessageTimestamp: ts,
      dlqMessageCount: 2,
      presentOnBroker: true,
    });
    projection.ingest({
      topic: 'topic-c',
      consumerGroup: 'g1',
      lag: 0,
      lastMessageTimestamp: null,
      dlqMessageCount: 0,
      presentOnBroker: false,
    });

    const summary = projection.getSummary();
    expect(summary.totalTopics).toBe(3);
    expect(summary.missingTopics).toBe(1);
    expect(summary.topicsWithDlqMessages).toBe(1);
    // topic-c is silent (null timestamp) and missing; topic-b not silent (recent)
    expect(summary.silentTopics).toBeGreaterThanOrEqual(1);
  });
});
