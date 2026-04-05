/**
 * Golden Projection Test: onex.evt.omnibase-infra.baselines-computed.v1
 * Table: baselines_snapshots + child tables
 * Handler: projectBaselinesSnapshot
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

const TOPIC = 'onex.evt.omnibase-infra.baselines-computed.v1';

describe(`Golden Chain: ${TOPIC} -> baselines_snapshots`, () => {
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

  it('projects canonical baselines snapshot with child tables', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');

    // Build a mock DB that supports transactions
    const deleteMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const capturedRows: Record<string, unknown>[][] = [];
    const valuesMock = vi.fn().mockImplementation((rows: unknown) => {
      if (Array.isArray(rows)) capturedRows.push(rows);
      else capturedRows.push([rows as Record<string, unknown>]);
      return { onConflictDoUpdate };
    });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);

    // Transaction mock — receives callback and passes self as tx
    const txMock = {
      insert: insertMock,
      delete: deleteMock,
      execute: executeMock,
    };
    const transactionMock = vi
      .fn()
      .mockImplementation(async (cb: (tx: typeof txMock) => Promise<void>) => {
        await cb(txMock);
      });

    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
      delete: deleteMock,
      transaction: transactionMock,
    });

    const snapshotId = randomUUID();
    const payload = {
      snapshot_id: snapshotId,
      contract_version: 2,
      computed_at_utc: '2026-04-04T12:00:00Z',
      window_start_utc: '2026-04-03T00:00:00Z',
      window_end_utc: '2026-04-04T00:00:00Z',
      comparisons: [
        {
          pattern_id: 'pattern-001',
          pattern_name: 'code-review-pattern',
          sample_size: 50,
          window_start: '2026-04-01',
          window_end: '2026-04-04',
          token_delta: { mean: -500 },
          time_delta: { mean: -30 },
          retry_delta: { mean: -1 },
          recommendation: 'promote',
          confidence: 'high',
          rationale: 'Consistent savings across window',
        },
      ],
      trend: [
        {
          date: '2026-04-03',
          avg_cost_savings: 0.05,
          avg_outcome_improvement: 0.12,
          comparisons_evaluated: 10,
        },
      ],
      breakdown: [
        {
          action: 'promote',
          count: 5,
          avg_confidence: 0.85,
        },
      ],
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // Transaction was called
    expect(transactionMock).toHaveBeenCalled();

    // Snapshot header was inserted
    expect(insertMock).toHaveBeenCalled();

    // Verify snapshot header row contains canonical fields
    const allRows = capturedRows.flat();
    const headerRow = allRows.find((r) => r.snapshotId === snapshotId);
    expect(headerRow).toBeDefined();
    expect(headerRow!.contractVersion).toBe(2);
    expect(new Date(headerRow!.computedAtUtc as string).toISOString()).toBe(
      '2026-04-04T12:00:00.000Z'
    );

    // Verify comparison child row
    const compRow = allRows.find((r) => r.patternId === 'pattern-001');
    expect(compRow).toBeDefined();
    expect(compRow!.snapshotId).toBe(snapshotId);
    expect(compRow!.recommendation).toBe('promote');
    expect(compRow!.confidence).toBe('high');

    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);
  });

  it('calls baselinesProjection.reset() and emitBaselinesUpdate() post-commit', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const { baselinesProjection } = await import('../../projection-bootstrap');
    const { emitBaselinesUpdate } = await import('../../baselines-events');

    const deleteMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    const txMock = { insert: insertMock, delete: deleteMock, execute: executeMock };
    const transactionMock = vi
      .fn()
      .mockImplementation(async (cb: (tx: typeof txMock) => Promise<void>) => {
        await cb(txMock);
      });

    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
      delete: deleteMock,
      transaction: transactionMock,
    });

    const payload = {
      snapshot_id: randomUUID(),
      contract_version: 1,
      computed_at_utc: '2026-04-04T12:00:00Z',
      comparisons: [],
      trend: [],
      breakdown: [],
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(baselinesProjection.reset).toHaveBeenCalled();
    expect(emitBaselinesUpdate).toHaveBeenCalled();
  });

  it('coerces invalid recommendation to shadow and invalid confidence to low', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');

    const deleteMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const capturedComparisonRows: Record<string, unknown>[] = [];
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockImplementation((rows: unknown) => {
      if (Array.isArray(rows)) capturedComparisonRows.push(...rows);
      return { onConflictDoUpdate };
    });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    const txMock = { insert: insertMock, delete: deleteMock, execute: executeMock };
    const transactionMock = vi
      .fn()
      .mockImplementation(async (cb: (tx: typeof txMock) => Promise<void>) => {
        await cb(txMock);
      });

    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
      delete: deleteMock,
      transaction: transactionMock,
    });

    const payload = {
      snapshot_id: randomUUID(),
      contract_version: 1,
      computed_at_utc: '2026-04-04T12:00:00Z',
      comparisons: [
        {
          pattern_id: 'pattern-002',
          pattern_name: 'test-pattern',
          recommendation: 'INVALID_VALUE',
          confidence: 'INVALID_LEVEL',
        },
      ],
      trend: [],
      breakdown: [],
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // The comparison rows should have coerced values
    const compRow = capturedComparisonRows.find(
      (r: Record<string, unknown>) => r.patternId === 'pattern-002'
    );
    expect(compRow).toBeDefined();
    expect(compRow!.recommendation).toBe('shadow');
    expect(compRow!.confidence).toBe('low');
  });

  it('handles missing DB gracefully', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await handleMessage(
      makeKafkaPayload(TOPIC, {
        snapshot_id: randomUUID(),
        contract_version: 1,
      })
    );

    expect(consumer.getStats().eventsProjected).toBe(0);
  });
});
