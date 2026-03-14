/**
 * Integration test — multi-replica convergence (OMN-5033)
 *
 * Verifies that two TopicDiscoveryCoordinator instances receiving the same
 * introspection events produce identical topic sets — critical for preventing
 * the multi-replica rebalance storms that motivated the original OMN-4587 fix.
 *
 * Also verifies timeout fallback produces bootstrap-only topics.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TopicDiscoveryCoordinator,
  BOOTSTRAP_TOPICS,
} from '../services/topic-discovery-coordinator';
import {
  TopicRegistryService,
  resetTopicRegistryService,
} from '../services/topic-registry-service';

describe('Multi-replica convergence', () => {
  let registryA: TopicRegistryService;
  let registryB: TopicRegistryService;

  beforeEach(() => {
    resetTopicRegistryService();
    registryA = new TopicRegistryService();
    registryB = new TopicRegistryService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('two coordinators with same input produce identical topic sets', async () => {
    const coordinatorA = new TopicDiscoveryCoordinator(registryA, {
      debounceMs: 100,
      timeoutMs: 5000,
    });
    const coordinatorB = new TopicDiscoveryCoordinator(registryB, {
      debounceMs: 100,
      timeoutMs: 5000,
    });

    // Start both coordinators
    const promiseA = coordinatorA.waitForDiscovery();
    const promiseB = coordinatorB.waitForDiscovery();

    // Simulate the same introspection events arriving at both replicas
    const introspectionData = [
      {
        node_id: 'node-1',
        publish_topics: [
          { topic: 'onex.evt.platform.node-heartbeat.v1' },
          { topic: 'onex.evt.omniclaude.session-started.v1' },
        ],
      },
      {
        node_id: 'node-2',
        publish_topics: [
          { topic: 'onex.evt.omniclaude.tool-executed.v1' },
          { topic: 'onex.evt.omniintelligence.pattern-scored.v1' },
        ],
      },
      {
        node_id: 'node-3',
        publish_topics: [
          { topic: 'onex.evt.platform.node-heartbeat.v1' }, // duplicate across nodes
          { topic: 'onex.evt.validation.cross-repo-run-completed.v1' },
        ],
      },
    ];

    // Both registries receive the same events
    for (const data of introspectionData) {
      registryA.updateNode(data);
      registryB.updateNode(data);
    }

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(150);

    const resultA = await promiseA;
    const resultB = await promiseB;

    // Core assertion: both replicas produce IDENTICAL topic sets
    expect(resultA.topics).toEqual(resultB.topics);

    // Both should use registry source
    expect(resultA.source).toBe('registry');
    expect(resultB.source).toBe('registry');

    // Neither should be degraded
    expect(resultA.degraded).toBe(false);
    expect(resultB.degraded).toBe(false);

    // Verify the merged set contains bootstrap + discovered topics
    expect(resultA.topics).toContain('onex.evt.platform.node-introspection.v1'); // bootstrap
    expect(resultA.topics).toContain('onex.evt.omniclaude.session-started.v1'); // discovered
    expect(resultA.topics).toContain('onex.evt.validation.cross-repo-run-completed.v1'); // discovered

    // Verify deduplication
    const uniqueCount = new Set(resultA.topics).size;
    expect(uniqueCount).toBe(resultA.topics.length);
  });

  it('two coordinators converge even with different event arrival order', async () => {
    const coordinatorA = new TopicDiscoveryCoordinator(registryA, {
      debounceMs: 100,
      timeoutMs: 5000,
    });
    const coordinatorB = new TopicDiscoveryCoordinator(registryB, {
      debounceMs: 100,
      timeoutMs: 5000,
    });

    const promiseA = coordinatorA.waitForDiscovery();
    const promiseB = coordinatorB.waitForDiscovery();

    // Replica A receives node-1 first, then node-2
    registryA.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.topic-alpha.v1' }],
    });
    registryA.updateNode({
      node_id: 'node-2',
      publish_topics: [{ topic: 'onex.evt.topic-beta.v1' }],
    });

    // Replica B receives node-2 first, then node-1 (different order)
    registryB.updateNode({
      node_id: 'node-2',
      publish_topics: [{ topic: 'onex.evt.topic-beta.v1' }],
    });
    registryB.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.topic-alpha.v1' }],
    });

    await vi.advanceTimersByTimeAsync(150);

    const resultA = await promiseA;
    const resultB = await promiseB;

    // Despite different arrival order, results are identical (sorted)
    expect(resultA.topics).toEqual(resultB.topics);
  });

  it('timeout fallback produces bootstrap-only topics identically across replicas', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const coordinatorA = new TopicDiscoveryCoordinator(registryA, {
      debounceMs: 100,
      timeoutMs: 200,
    });
    const coordinatorB = new TopicDiscoveryCoordinator(registryB, {
      debounceMs: 100,
      timeoutMs: 200,
    });

    const promiseA = coordinatorA.waitForDiscovery();
    const promiseB = coordinatorB.waitForDiscovery();

    // Continuously send different topics to prevent debounce stabilization
    const interval = setInterval(() => {
      const ts = Date.now();
      registryA.updateNode({
        node_id: `node-${ts}`,
        publish_topics: [{ topic: `onex.evt.stream-${ts}.v1` }],
      });
      registryB.updateNode({
        node_id: `node-${ts}`,
        publish_topics: [{ topic: `onex.evt.stream-${ts}.v1` }],
      });
    }, 50);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(250);
    clearInterval(interval);

    const resultA = await promiseA;
    const resultB = await promiseB;

    // Both should be degraded
    expect(resultA.degraded).toBe(true);
    expect(resultB.degraded).toBe(true);

    // Both should have the same topics (degraded but converged)
    expect(resultA.topics).toEqual(resultB.topics);

    warnSpy.mockRestore();
  });

  it('empty registry produces only bootstrap topics', async () => {
    const coordinator = new TopicDiscoveryCoordinator(registryA, {
      debounceMs: 50,
      timeoutMs: 5000,
    });

    const promise = coordinator.waitForDiscovery();

    // No events arrive — debounce fires
    await vi.advanceTimersByTimeAsync(60);

    const result = await promise;
    expect(result.source).toBe('bootstrap');
    expect(result.topics).toEqual([...BOOTSTRAP_TOPICS].sort());
    expect(result.registryTopicCount).toBe(0);
    expect(result.nodeCount).toBe(0);
  });
});
