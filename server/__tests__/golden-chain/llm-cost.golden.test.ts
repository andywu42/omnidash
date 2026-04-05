/**
 * Golden Projection Test: onex.evt.omniintelligence.llm-call-completed.v1
 * Table: llm_cost_aggregates
 * Handler: projectLlmCostEvent
 *
 * @ticket OMN-7495
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeKafkaPayload, goldenId } from './runner';

// Standard mock block — required for all golden tests
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

const TOPIC = 'onex.evt.omniintelligence.llm-call-completed.v1';

describe(`Golden Chain: ${TOPIC} -> llm_cost_aggregates`, () => {
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

  it('projects canonical ContractLlmCallMetrics payload to llm_cost_aggregates', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi.fn().mockReturnValue({ values: insertValues });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const payload = {
      model_id: 'claude-sonnet-4-6',
      prompt_tokens: 2500,
      completion_tokens: 800,
      total_tokens: 3300,
      estimated_cost_usd: 0.015,
      usage_normalized: { source: 'API' },
      timestamp_iso: '2026-04-04T12:00:00Z',
      reporting_source: 'omniclaude',
      session_id: goldenId('llm-cost'),
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(insertMock).toHaveBeenCalled();
    const row = insertValues.mock.calls[0]?.[0];
    expect(row).toBeDefined();

    // Field-level assertions — the golden contract
    expect(row.modelName).toBe('claude-sonnet-4-6');
    expect(row.promptTokens).toBe(2500);
    expect(row.completionTokens).toBe(800);
    expect(row.totalTokens).toBe(3300);
    expect(row.estimatedCostUsd).toBe('0.015');
    expect(row.usageSource).toBe('API');
    expect(row.repoName).toBe('omniclaude');
    expect(row.sessionId).toBe(payload.session_id);
    expect(row.bucketTime).toBeInstanceOf(Date);
    expect(row.granularity).toBe('hour');

    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);
  });

  it('derives totalTokens from prompt+completion when total_tokens is 0', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi.fn().mockReturnValue({ values: insertValues });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const payload = {
      model_id: 'gpt-4o',
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 0,
      estimated_cost_usd: 0.01,
      timestamp_iso: '2026-04-04T12:00:00Z',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    const row = insertValues.mock.calls[0]?.[0];
    expect(row).toBeDefined();
    expect(row.totalTokens).toBe(1500);
  });

  it('handles missing DB gracefully', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await handleMessage(
      makeKafkaPayload(TOPIC, {
        model_id: 'test',
        prompt_tokens: 100,
        completion_tokens: 50,
        estimated_cost_usd: 0.001,
      })
    );

    expect(consumer.getStats().eventsProjected).toBe(0);
  });
});
