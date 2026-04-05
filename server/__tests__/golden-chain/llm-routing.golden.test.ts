/**
 * Golden Projection Test: onex.evt.omniclaude.llm-routing-decision.v1
 * Table: llm_routing_decisions
 * Handler: projectLlmRoutingDecisionEvent
 *
 * @ticket OMN-7495
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { makeKafkaPayload, goldenId } from './runner';

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

const TOPIC = 'onex.evt.omniclaude.llm-routing-decision.v1';

describe(`Golden Chain: ${TOPIC} -> llm_routing_decisions`, () => {
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

  it('projects canonical LLM routing decision to llm_routing_decisions', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: vi.fn(),
      execute: executeMock,
    });

    const correlationId = randomUUID();
    const payload = {
      correlation_id: correlationId,
      session_id: goldenId('llm-routing'),
      selected_agent: 'code-review-agent',
      fuzzy_top_candidate: 'refactor-agent',
      agreement: false,
      llm_confidence: 0.92,
      fuzzy_confidence: 0.78,
      llm_latency_ms: 150,
      fuzzy_latency_ms: 5,
      routing_prompt_version: 'v3.2',
      intent: 'code-review',
      model: 'claude-sonnet-4-6',
      cost_usd: 0.003,
      prompt_tokens: 500,
      completion_tokens: 100,
      total_tokens: 600,
      emitted_at: '2026-04-04T12:00:00Z',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // Uses db.execute(sql`...`) not db.insert(), so verify execute was called
    expect(executeMock).toHaveBeenCalled();
    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);
  });

  it('skips fallback_used=true events without error', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const insertMock = vi.fn();
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const payload = {
      correlation_id: randomUUID(),
      selected_agent: 'fallback-agent',
      fallback_used: true,
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // Should NOT call insert for the routing insert (only watermark)
    // The handler returns true without writing — event is acknowledged
    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);

    // Verify routing decision was not inserted (fallback should not be persisted)
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('skips non-UUID correlation_id with warning', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const insertMock = vi.fn();
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const payload = {
      correlation_id: 'not-a-uuid',
      selected_agent: 'code-review-agent',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // Event is acknowledged (eventsProjected=1) but no DB write for routing decision
    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);

    // Verify routing decision was not inserted (non-UUID skip)
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('handles missing DB gracefully', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await handleMessage(
      makeKafkaPayload(TOPIC, {
        correlation_id: randomUUID(),
        selected_agent: 'test-agent',
      })
    );

    expect(consumer.getStats().eventsProjected).toBe(0);
  });
});
