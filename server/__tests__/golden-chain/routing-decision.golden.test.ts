/**
 * Golden Projection Test: onex.evt.omniclaude.routing-decision.v1
 * Table: agent_routing_decisions
 * Handler: projectRoutingDecision
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

const TOPIC = 'onex.evt.omniclaude.routing-decision.v1';

describe(`Golden Chain: ${TOPIC} -> agent_routing_decisions`, () => {
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

  it('projects canonical routing-decision payload to agent_routing_decisions', async () => {
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
    const payload = {
      correlation_id: correlationId,
      session_id: goldenId('routing'),
      user_request: 'Review this PR for security issues',
      user_request_hash: 'abc123',
      context_snapshot: { repo: 'omniclaude', branch: 'main' },
      selected_agent: 'security-review-agent',
      confidence_score: 0.95,
      routing_strategy: 'capability-match',
      trigger_confidence: 0.9,
      context_confidence: 0.88,
      capability_confidence: 0.95,
      historical_confidence: 0.92,
      alternatives: [{ agent: 'code-review-agent', score: 0.8 }],
      reasoning: 'Security keywords detected in PR title',
      routing_time_ms: 45,
      cache_hit: false,
      selection_validated: true,
      execution_succeeded: true,
      actual_quality_score: 0.9,
      created_at: '2026-04-04T12:00:00Z',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(insertMock).toHaveBeenCalled();
    const row = valuesMock.mock.calls[0]?.[0];
    expect(row).toBeDefined();

    // Field-level assertions — the golden contract
    expect(row.correlationId).toBe(correlationId);
    expect(row.userRequest).toBe('Review this PR for security issues');
    expect(row.selectedAgent).toBe('security-review-agent');
    expect(row.confidenceScore).toBe('0.95');
    expect(row.routingStrategy).toBe('capability-match');
    expect(row.triggerConfidence).toBe('0.9');
    expect(row.routingTimeMs).toBe(45);
    expect(row.cacheHit).toBe(false);
    expect(row.selectionValidated).toBe(true);
    expect(row.executionSucceeded).toBe(true);
    expect(row.createdAt).toBeInstanceOf(Date);

    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);
  });

  it('maps prompt_preview to userRequest when user_request absent (OMN-3320)', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const payload = {
      correlation_id: randomUUID(),
      // user_request intentionally absent
      prompt_preview: 'Fix the build error in CI',
      selected_agent: 'build-fix-agent',
      confidence_score: 0.8,
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    const row = valuesMock.mock.calls[0]?.[0];
    expect(row).toBeDefined();
    expect(row.userRequest).toBe('Fix the build error in CI');
  });

  it('defaults routing_strategy to unknown when absent', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const payload = {
      correlation_id: randomUUID(),
      selected_agent: 'general-agent',
      confidence: 0.7, // uses 'confidence' alias
      // routing_strategy intentionally absent
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    const row = valuesMock.mock.calls[0]?.[0];
    expect(row).toBeDefined();
    expect(row.routingStrategy).toBe('unknown');
    expect(row.confidenceScore).toBe('0.7');
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
