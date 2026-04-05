/**
 * Golden Projection Test: onex.evt.omniclaude.budget-cap-hit.v1
 * Table: pipeline_budget_state
 * Handler: projectBudgetCapHitEvent
 *
 * @ticket OMN-7495
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
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

const TOPIC = 'onex.evt.omniclaude.budget-cap-hit.v1';

describe(`Golden Chain: ${TOPIC} -> pipeline_budget_state`, () => {
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

  it('projects canonical budget-cap-hit payload to pipeline_budget_state', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: vi.fn(),
      execute: executeMock,
    });

    const correlationId = randomUUID();
    const payload = {
      correlation_id: correlationId,
      pipeline_id: 'pipeline-golden-001',
      budget_type: 'tokens',
      cap_value: 100000,
      current_value: 105000,
      cap_hit: true,
      repo: 'omniclaude',
      timestamp: '2026-04-04T12:00:00Z',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // Uses db.execute(sql`...`)
    expect(executeMock).toHaveBeenCalled();

    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);
  });

  it('calls emitPipelineBudgetInvalidate with correct correlation_id', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const { emitPipelineBudgetInvalidate } = await import('../../omniclaude-state-events');
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: vi.fn(),
      execute: executeMock,
    });

    const correlationId = randomUUID();
    const payload = {
      correlation_id: correlationId,
      pipeline_id: 'pipeline-golden-002',
      budget_type: 'cost',
      cap_value: 50,
      current_value: 55,
      cap_hit: true,
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(emitPipelineBudgetInvalidate).toHaveBeenCalledWith(correlationId);
  });

  it('defaults budget_type to tokens when absent', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: vi.fn(),
      execute: executeMock,
    });

    const payload = {
      correlation_id: randomUUID(),
      // budget_type intentionally missing
      cap_value: 10000,
      current_value: 12000,
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(executeMock).toHaveBeenCalled();
    // Verify the default 'tokens' budget_type was applied in the SQL
    const projCall = executeMock.mock.calls.find((c: unknown[]) =>
      JSON.stringify(c).includes('pipeline_budget_state')
    );
    expect(projCall).toBeDefined();
    expect(JSON.stringify(projCall)).toContain('tokens');
    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
  });

  it('handles missing DB gracefully', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await handleMessage(
      makeKafkaPayload(TOPIC, {
        correlation_id: randomUUID(),
        pipeline_id: 'test',
      })
    );

    expect(consumer.getStats().eventsProjected).toBe(0);
  });
});
