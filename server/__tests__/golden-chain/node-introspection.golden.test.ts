/**
 * Golden Projection Test: onex.evt.platform.node-introspection.v1
 * Table: node_service_registry
 * Handler: projectNodeIntrospectionEvent
 *
 * @ticket OMN-7495
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeKafkaPayload } from './runner';

// Standard mock block
vi.mock('../../storage', () => ({
  tryGetIntelligenceDb: vi.fn(),
  getIntelligenceDb: vi.fn(),
  isDatabaseConfigured: vi.fn(() => false),
}));
vi.mock('kafkajs', () => ({
  Kafka: vi.fn(() => ({
    consumer: vi.fn(() => ({
      connect: vi.fn(),
      subscribe: vi.fn(),
      run: vi.fn(),
      disconnect: vi.fn(),
    })),
  })),
}));
vi.mock('../../projection-bootstrap', () => ({
  baselinesProjection: { reset: vi.fn() },
  llmRoutingProjection: { invalidateCache: vi.fn() },
}));
vi.mock('../../baselines-events', () => ({ emitBaselinesUpdate: vi.fn() }));
vi.mock('../../topic-catalog-manager', () => ({
  TopicCatalogManager: vi.fn(() => ({
    bootstrap: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    on: vi.fn(),
  })),
}));
vi.mock('../../llm-routing-events', () => ({ emitLlmRoutingInvalidate: vi.fn() }));
vi.mock('../../delegation-events', () => ({ emitDelegationInvalidate: vi.fn() }));
vi.mock('../../enrichment-events', () => ({ emitEnrichmentInvalidate: vi.fn() }));
vi.mock('../../enforcement-events', () => ({ emitEnforcementInvalidate: vi.fn() }));
vi.mock('../../omniclaude-state-events', () => ({
  emitGateDecisionInvalidate: vi.fn(),
  emitEpicRunInvalidate: vi.fn(),
  emitPrWatchInvalidate: vi.fn(),
  emitPipelineBudgetInvalidate: vi.fn(),
  emitCircuitBreakerInvalidate: vi.fn(),
}));
vi.mock('../../effectiveness-events', () => ({ emitEffectivenessUpdate: vi.fn() }));

import { ReadModelConsumer } from '../../read-model-consumer';

const TOPIC = 'onex.evt.platform.node-introspection.v1';

describe(`Golden Chain: ${TOPIC} -> node_service_registry`, () => {
  let consumer: ReadModelConsumer;
  let handleMessage: (p: import('kafkajs').EachMessagePayload) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    consumer = new ReadModelConsumer();
    handleMessage = (
      consumer as unknown as {
        handleMessage: (p: import('kafkajs').EachMessagePayload) => Promise<void>;
      }
    ).handleMessage.bind(consumer);
  });

  it('projects canonical node-introspection payload to node_service_registry', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: vi.fn(),
      execute: executeMock,
    });

    const payload = {
      node_name: 'golden-node-001',
      node_id: 'node-id-001',
      service_url: 'http://localhost:8080',
      service_type: 'intelligence',
      health_status: 'healthy',
      metadata: { version: '1.0', capabilities: ['pattern-extraction'] },
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // Uses db.execute(sql`...`) for the upsert + watermark
    expect(executeMock).toHaveBeenCalled();
    // Verify projection SQL contains expected values including merged metadata
    const allCalls = executeMock.mock.calls.map((c: unknown[]) => JSON.stringify(c));
    const projCall = allCalls.find((s: string) => s.includes('node_service_registry'));
    expect(projCall).toBeDefined();
    expect(projCall).toContain('golden-node-001');
    expect(projCall).toContain('intelligence');
    expect(projCall).toContain('healthy');
    expect(projCall).toContain('pattern-extraction');

    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);
  });

  it('uses node_name as service_name priority over node_id', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: vi.fn(),
      execute: executeMock,
    });

    const payload = {
      node_name: 'my-node',
      node_id: 'fallback-id',
      health_status: 'healthy',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(executeMock).toHaveBeenCalled();
    // Verify node_name ('my-node') is used as service_name, not node_id
    const allCalls = executeMock.mock.calls.map((c: unknown[]) => JSON.stringify(c));
    const projCall = allCalls.find((s: string) => s.includes('node_service_registry'));
    expect(projCall).toBeDefined();
    expect(projCall).toContain('my-node');
    expect(consumer.getStats().eventsProjected).toBe(1);
  });

  it('skips events missing all name fields with warning', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: vi.fn(),
      execute: executeMock,
    });

    const payload = {
      // node_name, node_id, service_name all missing
      health_status: 'healthy',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // Event is acknowledged but no projection write (only watermark)
    const allCalls = executeMock.mock.calls.map((c: unknown[]) => JSON.stringify(c));
    const projCall = allCalls.find((s: string) => s.includes('node_service_registry'));
    expect(projCall).toBeUndefined();
    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
  });

  it('defaults health_status to unknown when absent', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: vi.fn(),
      execute: executeMock,
    });

    const payload = {
      node_name: 'golden-node-no-health',
      // health_status intentionally missing
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(executeMock).toHaveBeenCalled();
    // Verify 'unknown' default health_status in the projection SQL
    const allCalls = executeMock.mock.calls.map((c: unknown[]) => JSON.stringify(c));
    const projCall = allCalls.find((s: string) => s.includes('node_service_registry'));
    expect(projCall).toBeDefined();
    expect(projCall).toContain('unknown');
    expect(consumer.getStats().eventsProjected).toBe(1);
  });

  it('handles missing DB gracefully', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await handleMessage(
      makeKafkaPayload(TOPIC, {
        node_name: 'test-node',
      })
    );

    expect(consumer.getStats().eventsProjected).toBe(0);
  });
});
