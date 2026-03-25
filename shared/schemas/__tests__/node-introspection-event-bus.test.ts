/**
 * Tests for NodeIntrospectionPayloadSchema event_bus extension (OMN-5023)
 *
 * Verifies that:
 *   1. Payloads without event_bus parse successfully (backward compat)
 *   2. Payloads with event_bus parse successfully
 *   3. EventBusTopicEntrySchema validates topic entries
 *   4. NodeEventBusConfigSchema validates the full event_bus block
 */

import { describe, it, expect } from 'vitest';
import {
  NodeIntrospectionPayloadSchema,
  EventBusTopicEntrySchema,
  NodeEventBusConfigSchema,
} from '../event-envelope';

const VALID_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('EventBusTopicEntrySchema', () => {
  it('parses a minimal topic entry (topic only)', () => {
    const result = EventBusTopicEntrySchema.parse({
      topic: 'onex.evt.platform.node-heartbeat.v1',
    });
    expect(result.topic).toBe('onex.evt.platform.node-heartbeat.v1');
    expect(result.direction).toBeUndefined();
  });

  it('parses a full topic entry with all fields', () => {
    const result = EventBusTopicEntrySchema.parse({
      topic: 'onex.evt.omniclaude.session-started.v1',
      direction: 'publish',
      schema_ref: 'ModelSessionStarted',
      description: 'Emitted when a session starts',
    });
    expect(result.direction).toBe('publish');
    expect(result.schema_ref).toBe('ModelSessionStarted');
    expect(result.description).toBe('Emitted when a session starts');
  });

  it('accepts subscribe direction', () => {
    const result = EventBusTopicEntrySchema.parse({
      topic: 'onex.cmd.platform.request-introspection.v1',
      direction: 'subscribe',
    });
    expect(result.direction).toBe('subscribe');
  });

  it('rejects invalid direction', () => {
    expect(() =>
      EventBusTopicEntrySchema.parse({
        topic: 'onex.evt.test.v1',
        direction: 'bidirectional',
      })
    ).toThrow();
  });
});

describe('NodeEventBusConfigSchema', () => {
  it('parses empty config (no topics)', () => {
    const result = NodeEventBusConfigSchema.parse({});
    expect(result.publish_topics).toBeUndefined();
    expect(result.subscribe_topics).toBeUndefined();
  });

  it('parses config with publish and subscribe topics', () => {
    const result = NodeEventBusConfigSchema.parse({
      publish_topics: [
        { topic: 'onex.evt.platform.node-heartbeat.v1', direction: 'publish' },
        { topic: 'onex.evt.platform.node-introspection.v1' },
      ],
      subscribe_topics: [
        { topic: 'onex.cmd.platform.request-introspection.v1', direction: 'subscribe' },
      ],
    });
    expect(result.publish_topics).toHaveLength(2);
    expect(result.subscribe_topics).toHaveLength(1);
  });
});

describe('NodeIntrospectionPayloadSchema with event_bus', () => {
  it('parses payload with event_bus as null (backward compat)', () => {
    const result = NodeIntrospectionPayloadSchema.parse({
      node_id: VALID_UUID,
      node_type: 'EFFECT',
      node_version: '1.0.0',
      capabilities: null,
      metadata: null,
      current_state: null,
      event_bus: null,
    });
    expect(result.node_id).toBe(VALID_UUID);
    expect(result.event_bus).toBeNull();
  });

  it('parses payload with event_bus containing publish_topics', () => {
    const result = NodeIntrospectionPayloadSchema.parse({
      node_id: VALID_UUID,
      node_type: 'EFFECT',
      node_version: '1.0.0',
      capabilities: null,
      metadata: null,
      current_state: null,
      event_bus: {
        publish_topics: [
          { topic: 'onex.evt.omniclaude.session-started.v1', direction: 'publish' },
          { topic: 'onex.evt.omniclaude.tool-executed.v1' },
        ],
      },
    });
    expect(result.event_bus).toBeDefined();
    expect(result.event_bus!.publish_topics).toHaveLength(2);
    expect(result.event_bus!.publish_topics![0].topic).toBe(
      'onex.evt.omniclaude.session-started.v1'
    );
  });

  it('parses payload with event_bus containing both publish and subscribe', () => {
    const result = NodeIntrospectionPayloadSchema.parse({
      node_id: VALID_UUID,
      node_type: 'EFFECT',
      node_version: null,
      capabilities: null,
      metadata: null,
      current_state: null,
      event_bus: {
        publish_topics: [{ topic: 'onex.evt.platform.node-heartbeat.v1' }],
        subscribe_topics: [{ topic: 'onex.cmd.platform.request-introspection.v1' }],
      },
    });
    expect(result.event_bus!.publish_topics).toHaveLength(1);
    expect(result.event_bus!.subscribe_topics).toHaveLength(1);
  });

  it('parses payload with empty event_bus object', () => {
    const result = NodeIntrospectionPayloadSchema.parse({
      node_id: VALID_UUID,
      node_type: 'COMPUTE',
      node_version: null,
      capabilities: null,
      metadata: null,
      current_state: null,
      event_bus: {},
    });
    expect(result.event_bus).toBeDefined();
    expect(result.event_bus!.publish_topics).toBeUndefined();
  });

  it('preserves all existing fields alongside event_bus', () => {
    const result = NodeIntrospectionPayloadSchema.parse({
      node_id: VALID_UUID,
      node_type: 'COMPUTE',
      node_version: { major: 2, minor: 1, patch: 0 },
      capabilities: { streaming: true },
      metadata: { region: 'us-east-1' },
      current_state: 'ACTIVE',
      event_bus: {
        publish_topics: [{ topic: 'onex.evt.test.v1' }],
      },
    });
    expect(result.node_type).toBe('COMPUTE');
    expect(result.node_version).toEqual({ major: 2, minor: 1, patch: 0 });
    expect(result.capabilities).toEqual({ streaming: true });
    expect(result.metadata).toEqual({ region: 'us-east-1' });
    expect(result.current_state).toBe('ACTIVE');
    expect(result.event_bus!.publish_topics).toHaveLength(1);
  });
});
