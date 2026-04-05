/**
 * Golden Projection Test: onex.evt.omniclaude.session-outcome.v1
 * Table: session_outcomes
 * Handler: projectSessionOutcome
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

const TOPIC = 'onex.evt.omniclaude.session-outcome.v1';

describe(`Golden Chain: ${TOPIC} -> session_outcomes`, () => {
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

  it('projects canonical session-outcome payload to session_outcomes', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const sessionId = goldenId('session-outcome');
    const payload = {
      session_id: sessionId,
      outcome: 'success',
      emitted_at: '2026-04-04T12:00:00Z',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(insertMock).toHaveBeenCalled();
    const row = valuesMock.mock.calls[0]?.[0];
    expect(row).toBeDefined();

    // Field-level assertions — the golden contract
    expect(row.sessionId).toBe(sessionId);
    expect(row.outcome).toBe('success');
    expect(row.emittedAt).toBeInstanceOf(Date);

    // Verify upsert behavior (onConflictDoUpdate, not DoNothing)
    expect(onConflictDoUpdate).toHaveBeenCalled();

    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);
  });

  it('defaults outcome to unknown when absent', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const sessionId = goldenId('session-no-outcome');
    const payload = {
      session_id: sessionId,
      // outcome intentionally missing
      emitted_at: '2026-04-04T12:00:00Z',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    const row = valuesMock.mock.calls[0]?.[0];
    expect(row).toBeDefined();
    expect(row.outcome).toBe('unknown');
  });

  it('falls back to correlation_id when session_id absent', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const correlationId = randomUUID();
    const payload = {
      // session_id intentionally missing
      correlation_id: correlationId,
      outcome: 'failure',
      emitted_at: '2026-04-04T12:00:00Z',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    const row = valuesMock.mock.calls[0]?.[0];
    expect(row).toBeDefined();
    expect(row.sessionId).toBe(correlationId);
  });

  it('skips events with completely missing session identifiers', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const insertMock = vi.fn();
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const payload = {
      // All session identifiers intentionally missing
      outcome: 'success',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // Skipped — no insert, but event acknowledged
    expect(insertMock).not.toHaveBeenCalled();
    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
  });

  it('handles missing DB gracefully', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await handleMessage(
      makeKafkaPayload(TOPIC, {
        session_id: goldenId('session-no-db'),
        outcome: 'success',
      })
    );

    expect(consumer.getStats().eventsProjected).toBe(0);
  });
});
