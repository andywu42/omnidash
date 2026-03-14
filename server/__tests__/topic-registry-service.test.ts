/**
 * Tests for TopicRegistryService (OMN-5024)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TopicRegistryService,
  resetTopicRegistryService,
  getTopicRegistryService,
} from '../services/topic-registry-service';

describe('TopicRegistryService', () => {
  let service: TopicRegistryService;

  beforeEach(() => {
    resetTopicRegistryService();
    service = new TopicRegistryService();
  });

  // -----------------------------------------------------------------------
  // updateNode
  // -----------------------------------------------------------------------

  it('tracks topics from a single node', () => {
    service.updateNode({
      node_id: 'node-1',
      publish_topics: [
        { topic: 'onex.evt.platform.node-heartbeat.v1' },
        { topic: 'onex.evt.platform.node-introspection.v1' },
      ],
    });

    expect(service.getAllEvtTopics()).toEqual([
      'onex.evt.platform.node-heartbeat.v1',
      'onex.evt.platform.node-introspection.v1',
    ]);
    expect(service.getNodeCount()).toBe(1);
  });

  it('merges topics across multiple nodes', () => {
    service.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.platform.node-heartbeat.v1' }],
    });
    service.updateNode({
      node_id: 'node-2',
      publish_topics: [
        { topic: 'onex.evt.platform.node-heartbeat.v1' }, // duplicate
        { topic: 'onex.evt.omniclaude.session-started.v1' },
      ],
    });

    expect(service.getAllEvtTopics()).toEqual([
      'onex.evt.omniclaude.session-started.v1',
      'onex.evt.platform.node-heartbeat.v1',
    ]);
    expect(service.getNodeCount()).toBe(2);
  });

  it('filters out non-evt topics', () => {
    service.updateNode({
      node_id: 'node-1',
      publish_topics: [
        { topic: 'onex.evt.platform.node-heartbeat.v1' },
        { topic: 'onex.cmd.platform.request-introspection.v1' },
        { topic: 'onex.intent.platform.runtime-tick.v1' },
        { topic: 'onex.snapshot.platform.registration-snapshots.v1' },
      ],
    });

    expect(service.getAllEvtTopics()).toEqual(['onex.evt.platform.node-heartbeat.v1']);
  });

  it('replaces a node when updated again', () => {
    service.updateNode({
      node_id: 'node-1',
      publish_topics: [
        { topic: 'onex.evt.platform.node-heartbeat.v1' },
        { topic: 'onex.evt.old-topic.v1' },
      ],
    });
    service.updateNode({
      node_id: 'node-1',
      publish_topics: [
        { topic: 'onex.evt.platform.node-heartbeat.v1' },
        { topic: 'onex.evt.new-topic.v1' },
      ],
    });

    const topics = service.getAllEvtTopics();
    expect(topics).toContain('onex.evt.new-topic.v1');
    expect(topics).not.toContain('onex.evt.old-topic.v1');
  });

  // -----------------------------------------------------------------------
  // removeNode
  // -----------------------------------------------------------------------

  it('removes a node and recomputes topics', () => {
    service.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.only-on-node-1.v1' }],
    });
    service.updateNode({
      node_id: 'node-2',
      publish_topics: [{ topic: 'onex.evt.shared.v1' }],
    });

    service.removeNode('node-1');

    expect(service.getAllEvtTopics()).toEqual(['onex.evt.shared.v1']);
    expect(service.getNodeCount()).toBe(1);
  });

  it('removeNode is a no-op for unknown nodes', () => {
    const listener = vi.fn();
    service.on('topicsChanged', listener);
    service.removeNode('nonexistent');
    expect(listener).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // topicsChanged event
  // -----------------------------------------------------------------------

  it('emits topicsChanged when topics change', () => {
    const listener = vi.fn();
    service.on('topicsChanged', listener);

    service.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.test.v1' }],
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toEqual({
      topics: ['onex.evt.test.v1'],
      added: ['onex.evt.test.v1'],
      removed: [],
    });
  });

  it('does NOT emit topicsChanged when global set is unchanged', () => {
    service.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.test.v1' }],
    });

    const listener = vi.fn();
    service.on('topicsChanged', listener);

    // Second node publishes the same topic — global set unchanged
    service.updateNode({
      node_id: 'node-2',
      publish_topics: [{ topic: 'onex.evt.test.v1' }],
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('emits topicsChanged with removed topics', () => {
    service.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.to-be-removed.v1' }],
    });

    const listener = vi.fn();
    service.on('topicsChanged', listener);

    service.removeNode('node-1');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toEqual({
      topics: [],
      added: [],
      removed: ['onex.evt.to-be-removed.v1'],
    });
  });

  // -----------------------------------------------------------------------
  // snapshot
  // -----------------------------------------------------------------------

  it('returns a diagnostic snapshot', () => {
    service.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.platform.node-heartbeat.v1' }],
      subscribe_topics: [{ topic: 'onex.cmd.platform.request-introspection.v1' }],
    });

    const snap = service.snapshot();
    expect(snap.evt_topics).toEqual(['onex.evt.platform.node-heartbeat.v1']);
    expect(snap.node_count).toBe(1);
    expect(snap.nodes['node-1']).toEqual({
      publish_topics: ['onex.evt.platform.node-heartbeat.v1'],
      subscribe_topics: ['onex.cmd.platform.request-introspection.v1'],
    });
    expect(snap.last_update_utc).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // singleton
  // -----------------------------------------------------------------------

  it('getTopicRegistryService returns a singleton', () => {
    const a = getTopicRegistryService();
    const b = getTopicRegistryService();
    expect(a).toBe(b);
  });

  it('resetTopicRegistryService clears and recreates', () => {
    const a = getTopicRegistryService();
    a.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.test.v1' }],
    });
    resetTopicRegistryService();
    const b = getTopicRegistryService();
    expect(b).not.toBe(a);
    expect(b.getAllEvtTopics()).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // clear
  // -----------------------------------------------------------------------

  it('clear resets all state', () => {
    service.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.test.v1' }],
    });
    service.clear();

    expect(service.getAllEvtTopics()).toEqual([]);
    expect(service.getNodeCount()).toBe(0);
    expect(service.snapshot().nodes).toEqual({});
  });
});
