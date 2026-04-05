/**
 * Golden Projection Test: onex.evt.omniclaude.task-delegated.v1
 * Table: delegation_events
 * Handler: projectTaskDelegatedEvent
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

const TOPIC = 'onex.evt.omniclaude.task-delegated.v1';

describe(`Golden Chain: ${TOPIC} -> delegation_events`, () => {
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

  it('projects canonical task-delegated payload to delegation_events', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const correlationId = randomUUID();
    const sessionId = goldenId('delegation');
    const payload = {
      correlation_id: correlationId,
      session_id: sessionId,
      timestamp: '2026-04-04T12:00:00Z',
      task_type: 'code-review',
      delegated_to: 'claude-sonnet-4-6',
      delegated_by: 'routing-engine',
      quality_gate_passed: true,
      quality_gates_checked: ['lint', 'type-check'],
      quality_gates_failed: [],
      cost_usd: 0.015,
      cost_savings_usd: 0.035,
      delegation_latency_ms: 250,
      repo: 'omniclaude',
      is_shadow: false,
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(insertMock).toHaveBeenCalled();
    const row = valuesMock.mock.calls[0]?.[0];
    expect(row).toBeDefined();

    // Field-level assertions — the golden contract
    expect(row.correlationId).toBe(correlationId);
    expect(row.sessionId).toBe(sessionId);
    expect(row.taskType).toBe('code-review');
    expect(row.delegatedTo).toBe('claude-sonnet-4-6');
    expect(row.delegatedBy).toBe('routing-engine');
    expect(row.qualityGatePassed).toBe(true);
    expect(row.qualityGatesChecked).toEqual(['lint', 'type-check']);
    expect(row.qualityGatesFailed).toEqual([]);
    expect(row.costUsd).toBe('0.015');
    expect(row.costSavingsUsd).toBe('0.035');
    expect(row.delegationLatencyMs).toBe(250);
    expect(row.repo).toBe('omniclaude');
    expect(row.isShadow).toBe(false);
    expect(row.timestamp).toBeInstanceOf(Date);

    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);
  });

  it('calls emitDelegationInvalidate with correct correlation_id', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const { emitDelegationInvalidate } = await import('../../delegation-events');
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const correlationId = randomUUID();
    await handleMessage(
      makeKafkaPayload(TOPIC, {
        correlation_id: correlationId,
        task_type: 'refactor',
        delegated_to: 'claude-opus-4-6',
      })
    );

    expect(emitDelegationInvalidate).toHaveBeenCalledWith(correlationId);
  });

  it('skips events with missing task_type without error', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const insertMock = vi.fn();
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const payload = {
      correlation_id: randomUUID(),
      // task_type intentionally missing
      delegated_to: 'claude-sonnet-4-6',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // Skipped — no insert, but event acknowledged
    expect(insertMock).not.toHaveBeenCalled();
    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
  });

  it('skips events with missing delegated_to without error', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const insertMock = vi.fn();
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const payload = {
      correlation_id: randomUUID(),
      task_type: 'code-review',
      // delegated_to intentionally missing
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(insertMock).not.toHaveBeenCalled();
    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
  });

  it('handles missing DB gracefully', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await handleMessage(
      makeKafkaPayload(TOPIC, {
        correlation_id: randomUUID(),
        task_type: 'test',
        delegated_to: 'test-agent',
      })
    );

    expect(consumer.getStats().eventsProjected).toBe(0);
  });
});
