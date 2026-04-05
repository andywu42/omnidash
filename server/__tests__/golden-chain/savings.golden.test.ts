/**
 * Golden Projection Test: onex.evt.omnibase-infra.savings-estimated.v1
 * Table: savings_estimates
 * Handler: projectSavingsEstimated
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

const TOPIC = 'onex.evt.omnibase-infra.savings-estimated.v1';

describe(`Golden Chain: ${TOPIC} -> savings_estimates`, () => {
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

  it('projects canonical savings-estimated payload to savings_estimates', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const sessionId = goldenId('savings');
    const correlationId = randomUUID();
    const payload = {
      session_id: sessionId,
      correlation_id: correlationId,
      schema_version: '2.0',
      actual_total_tokens: 5000,
      actual_cost_usd: 0.025,
      actual_model_id: 'claude-sonnet-4-6',
      counterfactual_model_id: 'claude-opus-4-6',
      direct_savings_usd: 0.05,
      direct_tokens_saved: 3000,
      estimated_total_savings_usd: 0.08,
      estimated_total_tokens_saved: 5000,
      categories: [{ name: 'routing', savings_usd: 0.03 }],
      direct_confidence: 0.95,
      heuristic_confidence_avg: 0.8,
      estimation_method: 'tiered_attribution_v1',
      treatment_group: 'treatment-a',
      is_measured: true,
      completeness_status: 'complete',
      pricing_manifest_version: '1.2',
      timestamp_iso: '2026-04-04T12:00:00Z',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(insertMock).toHaveBeenCalled();
    const row = valuesMock.mock.calls[0]?.[0];
    expect(row).toBeDefined();

    // Field-level assertions — the golden contract
    expect(row.sessionId).toBe(sessionId);
    expect(row.sourceEventId).toBe(correlationId);
    expect(row.schemaVersion).toBe('2.0');
    expect(row.actualTotalTokens).toBe(5000);
    expect(row.actualCostUsd).toBe('0.025');
    expect(row.actualModelId).toBe('claude-sonnet-4-6');
    expect(row.counterfactualModelId).toBe('claude-opus-4-6');
    expect(row.directSavingsUsd).toBe('0.05');
    expect(row.directTokensSaved).toBe(3000);
    expect(row.estimatedTotalSavingsUsd).toBe('0.08');
    expect(row.estimatedTotalTokensSaved).toBe(5000);
    expect(row.directConfidence).toBe(0.95);
    expect(row.heuristicConfidenceAvg).toBe(0.8);
    expect(row.estimationMethod).toBe('tiered_attribution_v1');
    expect(row.treatmentGroup).toBe('treatment-a');
    expect(row.isMeasured).toBe(true);
    expect(row.completenessStatus).toBe('complete');
    expect(row.pricingManifestVersion).toBe('1.2');
    expect(row.eventTimestamp).toBeInstanceOf(Date);

    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);
  });

  it('skips events with missing session_id without error', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const insertMock = vi.fn();
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const payload = {
      // session_id intentionally missing
      correlation_id: randomUUID(),
      actual_total_tokens: 1000,
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // Event is acknowledged (returned true) but no insert call for savings
    expect(insertMock).not.toHaveBeenCalled();
    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
  });

  it('handles missing DB gracefully', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await handleMessage(
      makeKafkaPayload(TOPIC, {
        session_id: goldenId('savings-no-db'),
        correlation_id: randomUUID(),
      })
    );

    expect(consumer.getStats().eventsProjected).toBe(0);
  });
});
