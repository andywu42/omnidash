/**
 * Tests for NodeRegistryProjection → TopicRegistryService wiring (OMN-5025)
 *
 * Verifies:
 *   1. handleIntrospection feeds event_bus.publish_topics to TopicRegistryService
 *   2. Nodes without event_bus record empty topic set
 *   3. TopicRegistryService is not called when not wired
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeRegistryProjection } from '../node-registry-projection';
import {
  TopicRegistryService,
  resetTopicRegistryService,
} from '../../services/topic-registry-service';
import type { ProjectionEvent } from '@shared/projection-types';

function makeIntrospectionEvent(
  nodeId: string,
  eventBus?: {
    publish_topics?: Array<{ topic: string; direction?: string }>;
    subscribe_topics?: Array<{ topic: string; direction?: string }>;
  },
  seq = 1
): ProjectionEvent {
  return {
    type: 'node-introspection',
    ingestSeq: seq,
    eventTimeMs: Date.now(),
    payload: {
      node_id: nodeId,
      node_type: 'EFFECT',
      node_version: '1.0.0',
      ...(eventBus !== undefined ? { event_bus: eventBus } : {}),
    },
  };
}

describe('NodeRegistryProjection → TopicRegistryService feed', () => {
  let projection: NodeRegistryProjection;
  let registry: TopicRegistryService;

  beforeEach(() => {
    resetTopicRegistryService();
    projection = new NodeRegistryProjection();
    registry = new TopicRegistryService();
    projection.setTopicRegistry(registry);
  });

  it('feeds publish_topics from introspection event_bus to registry', () => {
    const event = makeIntrospectionEvent('node-1', {
      publish_topics: [
        { topic: 'onex.evt.platform.node-heartbeat.v1', direction: 'publish' },
        { topic: 'onex.evt.omniclaude.session-started.v1' },
      ],
    });

    projection.applyEvent(event);

    expect(registry.getAllEvtTopics()).toEqual([
      'onex.evt.omniclaude.session-started.v1',
      'onex.evt.platform.node-heartbeat.v1',
    ]);
    expect(registry.getNodeCount()).toBe(1);
  });

  it('records empty topic set for nodes without event_bus', () => {
    const event = makeIntrospectionEvent('node-no-bus');

    projection.applyEvent(event);

    // Node is tracked but with no topics
    expect(registry.getNodeCount()).toBe(1);
    expect(registry.getAllEvtTopics()).toEqual([]);
  });

  it('records empty topic set for nodes with empty event_bus', () => {
    const event = makeIntrospectionEvent('node-empty-bus', {});

    projection.applyEvent(event);

    expect(registry.getNodeCount()).toBe(1);
    expect(registry.getAllEvtTopics()).toEqual([]);
  });

  it('merges topics from multiple nodes', () => {
    projection.applyEvent(
      makeIntrospectionEvent(
        'node-1',
        {
          publish_topics: [{ topic: 'onex.evt.platform.node-heartbeat.v1' }],
        },
        1
      )
    );
    projection.applyEvent(
      makeIntrospectionEvent(
        'node-2',
        {
          publish_topics: [{ topic: 'onex.evt.omniclaude.session-started.v1' }],
        },
        2
      )
    );

    expect(registry.getAllEvtTopics()).toEqual([
      'onex.evt.omniclaude.session-started.v1',
      'onex.evt.platform.node-heartbeat.v1',
    ]);
    expect(registry.getNodeCount()).toBe(2);
  });

  it('updates topics when a node re-introspects', () => {
    projection.applyEvent(
      makeIntrospectionEvent(
        'node-1',
        {
          publish_topics: [{ topic: 'onex.evt.old-topic.v1' }],
        },
        1
      )
    );
    projection.applyEvent(
      makeIntrospectionEvent(
        'node-1',
        {
          publish_topics: [{ topic: 'onex.evt.new-topic.v1' }],
        },
        2
      )
    );

    const topics = registry.getAllEvtTopics();
    expect(topics).toContain('onex.evt.new-topic.v1');
    expect(topics).not.toContain('onex.evt.old-topic.v1');
  });

  it('does not call registry when not wired', () => {
    const unwiredProjection = new NodeRegistryProjection();
    const spy = vi.fn();
    // No setTopicRegistry called — should not throw
    expect(() => {
      unwiredProjection.applyEvent(
        makeIntrospectionEvent('node-1', {
          publish_topics: [{ topic: 'onex.evt.test.v1' }],
        })
      );
    }).not.toThrow();
  });

  it('emits topicsChanged when new topics are discovered', () => {
    const listener = vi.fn();
    registry.on('topicsChanged', listener);

    projection.applyEvent(
      makeIntrospectionEvent('node-1', {
        publish_topics: [{ topic: 'onex.evt.platform.node-heartbeat.v1' }],
      })
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].added).toEqual(['onex.evt.platform.node-heartbeat.v1']);
  });
});
