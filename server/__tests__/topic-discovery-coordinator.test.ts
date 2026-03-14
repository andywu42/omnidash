/**
 * Tests for TopicDiscoveryCoordinator (OMN-5026)
 *
 * Verifies:
 *   1. BOOTSTRAP_TOPICS contains exactly 3 control-plane topics
 *   2. waitForDiscovery stabilizes after debounce with registry topics
 *   3. waitForDiscovery times out gracefully with degraded flag
 *   4. Topics are deduplicated (bootstrap + registry)
 *   5. getCurrentTopics returns snapshot without waiting
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

describe('BOOTSTRAP_TOPICS', () => {
  it('contains exactly 3 protocol-level control-plane topics', () => {
    expect(BOOTSTRAP_TOPICS).toHaveLength(3);
    expect(BOOTSTRAP_TOPICS).toContain('onex.evt.platform.node-introspection.v1');
    expect(BOOTSTRAP_TOPICS).toContain('onex.evt.platform.node-registration.v1');
    expect(BOOTSTRAP_TOPICS).toContain('onex.cmd.platform.request-introspection.v1');
  });
});

describe('TopicDiscoveryCoordinator', () => {
  let registry: TopicRegistryService;

  beforeEach(() => {
    resetTopicRegistryService();
    registry = new TopicRegistryService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('getBootstrapTopics returns bootstrap topics', () => {
    const coordinator = new TopicDiscoveryCoordinator(registry);
    expect(coordinator.getBootstrapTopics()).toEqual([...BOOTSTRAP_TOPICS]);
  });

  it('waitForDiscovery resolves with registry topics after debounce', async () => {
    const coordinator = new TopicDiscoveryCoordinator(registry, {
      debounceMs: 100,
      timeoutMs: 5000,
    });

    // Start discovery
    const discoveryPromise = coordinator.waitForDiscovery();

    // Simulate a topic arriving from introspection
    registry.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.platform.node-heartbeat.v1' }],
    });

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(150);

    const result = await discoveryPromise;

    expect(result.source).toBe('registry');
    expect(result.degraded).toBe(false);
    expect(result.registryTopicCount).toBe(1);
    expect(result.topics).toContain('onex.evt.platform.node-heartbeat.v1');
    // Bootstrap topics are always included
    expect(result.topics).toContain('onex.evt.platform.node-introspection.v1');
    expect(result.topics).toContain('onex.evt.platform.node-registration.v1');
  });

  it('waitForDiscovery resets debounce on new topics', async () => {
    const coordinator = new TopicDiscoveryCoordinator(registry, {
      debounceMs: 100,
      timeoutMs: 5000,
    });

    const discoveryPromise = coordinator.waitForDiscovery();

    // First topic arrives at t=0
    registry.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.topic-a.v1' }],
    });

    // Advance 80ms (< debounce) — should not resolve yet
    await vi.advanceTimersByTimeAsync(80);

    // Second topic arrives — resets debounce
    registry.updateNode({
      node_id: 'node-2',
      publish_topics: [{ topic: 'onex.evt.topic-b.v1' }],
    });

    // Advance another 80ms (160ms total, but only 80ms since last change)
    await vi.advanceTimersByTimeAsync(80);

    // Should still not be resolved (debounce reset at t=80)
    // Advance past debounce from last change
    await vi.advanceTimersByTimeAsync(50);

    const result = await discoveryPromise;
    expect(result.topics).toContain('onex.evt.topic-a.v1');
    expect(result.topics).toContain('onex.evt.topic-b.v1');
    expect(result.degraded).toBe(false);
  });

  it('waitForDiscovery times out with degraded flag', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const coordinator = new TopicDiscoveryCoordinator(registry, {
      debounceMs: 100,
      timeoutMs: 200,
    });

    const discoveryPromise = coordinator.waitForDiscovery();

    // Keep sending topics past timeout
    const interval = setInterval(() => {
      registry.updateNode({
        node_id: `node-${Date.now()}`,
        publish_topics: [{ topic: `onex.evt.topic-${Date.now()}.v1` }],
      });
    }, 50);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(250);
    clearInterval(interval);

    const result = await discoveryPromise;
    expect(result.degraded).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    warnSpy.mockRestore();
  });

  it('waitForDiscovery returns bootstrap-only when no nodes report', async () => {
    const coordinator = new TopicDiscoveryCoordinator(registry, {
      debounceMs: 50,
      timeoutMs: 5000,
    });

    const discoveryPromise = coordinator.waitForDiscovery();

    // No topics arrive — debounce fires after 50ms
    await vi.advanceTimersByTimeAsync(60);

    const result = await discoveryPromise;
    expect(result.source).toBe('bootstrap');
    expect(result.registryTopicCount).toBe(0);
    expect(result.topics).toEqual([...BOOTSTRAP_TOPICS].sort());
  });

  it('deduplicates bootstrap and registry topics', async () => {
    const coordinator = new TopicDiscoveryCoordinator(registry, {
      debounceMs: 50,
      timeoutMs: 5000,
    });

    const discoveryPromise = coordinator.waitForDiscovery();

    // Node reports a topic that is also in BOOTSTRAP_TOPICS
    registry.updateNode({
      node_id: 'node-1',
      publish_topics: [
        { topic: 'onex.evt.platform.node-introspection.v1' }, // already in bootstrap
        { topic: 'onex.evt.custom.v1' },
      ],
    });

    await vi.advanceTimersByTimeAsync(60);

    const result = await discoveryPromise;
    // No duplicates
    const uniqueCheck = new Set(result.topics);
    expect(uniqueCheck.size).toBe(result.topics.length);
    expect(result.topics).toContain('onex.evt.custom.v1');
  });

  it('getCurrentTopics returns snapshot without waiting', () => {
    const coordinator = new TopicDiscoveryCoordinator(registry);

    registry.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.test.v1' }],
    });

    const topics = coordinator.getCurrentTopics();
    expect(topics).toContain('onex.evt.test.v1');
    expect(topics).toContain('onex.evt.platform.node-introspection.v1');
  });

  it('uses shorter initial debounce when registry already has topics', async () => {
    // Pre-populate registry
    registry.updateNode({
      node_id: 'node-1',
      publish_topics: [{ topic: 'onex.evt.existing.v1' }],
    });

    const coordinator = new TopicDiscoveryCoordinator(registry, {
      debounceMs: 300, // normal debounce is 300ms
      timeoutMs: 5000,
    });

    const discoveryPromise = coordinator.waitForDiscovery();

    // Should resolve faster than full debounce (300/3 = 100ms)
    await vi.advanceTimersByTimeAsync(110);

    const result = await discoveryPromise;
    expect(result.source).toBe('registry');
    expect(result.topics).toContain('onex.evt.existing.v1');
    expect(result.durationMs).toBeLessThan(300);
  });
});
