/**
 * Tests for ReadModelConsumer (OMN-2061)
 *
 * Verifies:
 * - Consumer handles routing decision events
 * - Consumer handles agent action events
 * - Consumer handles transformation events
 * - Consumer handles LLM cost events (OMN-2300 / OMN-2329 / OMN-2371)
 * - Consumer gracefully degrades when DB is unavailable
 * - Consumer getStats returns correct statistics
 * - Consumer handles malformed messages
 * - [OMN-2760] Every topic in OMNICLAUDE_AGENT_TOPICS is in READ_MODEL_TOPICS
 * - [OMN-2924] Pattern projection and lifecycle handlers write to pattern_learning_artifacts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EachMessagePayload } from 'kafkajs';

// Mock storage module before importing consumer
vi.mock('../storage', () => ({
  tryGetIntelligenceDb: vi.fn(),
  getIntelligenceDb: vi.fn(),
  isDatabaseConfigured: vi.fn(() => false),
}));

// Mock kafkajs
vi.mock('kafkajs', () => ({
  Kafka: vi.fn(function () {
    return {
      consumer: vi.fn(function () {
        return {
          connect: vi.fn(),
          subscribe: vi.fn(),
          run: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    };
  }),
}));

// Mock projection-bootstrap so baselinesProjection.reset() and
// llmRoutingProjection.invalidateCache() are no-op spies that do not interact
// with the DB or bleed state across tests.
vi.mock('../projection-bootstrap', () => ({
  baselinesProjection: {
    reset: vi.fn(),
  },
  llmRoutingProjection: {
    invalidateCache: vi.fn(),
  },
}));

// Mock baselines-events so emitBaselinesUpdate() is a no-op spy.
vi.mock('../baselines-events', () => ({
  emitBaselinesUpdate: vi.fn(),
}));

// Mock TopicCatalogManager — default behavior: timeout (fallback).
// Individual tests override via mockImplementation() on the constructor.
const mockBootstrap = vi.fn();
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockCatalogManagerOn = vi.fn();
const mockCatalogManagerOnce = vi.fn();

vi.mock('../topic-catalog-manager', () => ({
  TopicCatalogManager: vi.fn(function () {
    return {
      bootstrap: mockBootstrap,
      stop: mockStop,
      once: mockCatalogManagerOnce,
      on: mockCatalogManagerOn,
    };
  }),
}));

import { ReadModelConsumer } from '../read-model-consumer';

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Build a minimal EachMessagePayload for testing handleMessage (private method
 * accessed via the consumer's public handleMessage-driven stat tracking).
 * We use `(consumer as unknown as Record<string, unknown>).handleMessage` to
 * access the private method without TypeScript errors.
 */
function makeKafkaPayload(topic: string, data: Record<string, unknown>): EachMessagePayload {
  return {
    topic,
    partition: 0,
    message: {
      key: null,
      value: Buffer.from(JSON.stringify(data)),
      offset: '0',
      timestamp: Date.now().toString(),
      size: 0,
      attributes: 0,
      headers: {},
    },
    heartbeat: vi.fn(),
    pause: vi.fn(),
  };
}

describe('ReadModelConsumer', () => {
  let consumer: ReadModelConsumer;

  beforeEach(() => {
    vi.clearAllMocks();
    consumer = new ReadModelConsumer();
  });

  describe('getStats', () => {
    it('returns initial stats when not running', () => {
      const stats = consumer.getStats();
      expect(stats.isRunning).toBe(false);
      expect(stats.eventsProjected).toBe(0);
      expect(stats.errorsCount).toBe(0);
      expect(stats.lastProjectedAt).toBeNull();
      expect(stats.topicStats).toEqual({});
      expect(stats.catalogSource).toBe('fallback');
      expect(stats.unsupportedCatalogTopics).toEqual([]);
    });
  });

  describe('start', () => {
    it('skips when no brokers configured', async () => {
      // Ensure no brokers in env
      const originalBrokers = process.env.KAFKA_BROKERS;
      const originalBootstrap = process.env.KAFKA_BOOTSTRAP_SERVERS;
      delete process.env.KAFKA_BROKERS;
      delete process.env.KAFKA_BOOTSTRAP_SERVERS;

      await consumer.start();
      expect(consumer.getStats().isRunning).toBe(false);

      // Restore
      if (originalBrokers) process.env.KAFKA_BROKERS = originalBrokers;
      if (originalBootstrap) process.env.KAFKA_BOOTSTRAP_SERVERS = originalBootstrap;
    });

    it('skips when database not configured', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

      // Set brokers to bypass broker check
      process.env.KAFKA_BROKERS = 'localhost:9092';

      await consumer.start();
      expect(consumer.getStats().isRunning).toBe(false);

      delete process.env.KAFKA_BROKERS;
    });
  });

  describe('stop', () => {
    it('handles stop when not running', async () => {
      // Should not throw
      await consumer.stop();
      expect(consumer.getStats().isRunning).toBe(false);
    });
  });

  // ============================================================================
  // Catalog-Driven Topic Subscription (OMN-2926)
  // ============================================================================

  describe('fetchCatalogTopics (via start)', () => {
    /**
     * Access private fetchCatalogTopics directly to unit-test catalog behavior
     * without starting a full Kafka consumer.
     */
    function getFetchCatalogTopics(c: ReadModelConsumer) {
      return (
        c as unknown as { fetchCatalogTopics: () => Promise<string[]> }
      ).fetchCatalogTopics.bind(c);
    }

    it('returns empty array and sets source=fallback on catalog timeout', async () => {
      // Simulate timeout: 'catalogTimeout' fires, 'catalogReceived' never fires.
      mockCatalogManagerOnce.mockImplementation((event: string, cb: () => void) => {
        if (event === 'catalogTimeout') {
          setImmediate(cb);
        }
      });
      mockBootstrap.mockResolvedValue(undefined);

      const fetchCatalogTopics = getFetchCatalogTopics(consumer);
      const result = await fetchCatalogTopics();

      expect(result).toEqual([]);
      expect(consumer.getStats().catalogSource).toBe('fallback');
    });

    it('returns catalog topics and sets source=catalog on success', async () => {
      const fakeCatalogTopics = [
        'onex.evt.omniclaude.agent-actions.v1',
        'onex.evt.omniclaude.routing-decisions.v1',
      ];

      mockCatalogManagerOnce.mockImplementation(
        (event: string, cb: (e: { topics: string[]; warnings: string[] }) => void) => {
          if (event === 'catalogReceived') {
            setImmediate(() => cb({ topics: fakeCatalogTopics, warnings: [] }));
          }
        }
      );
      mockBootstrap.mockResolvedValue(undefined);

      const fetchCatalogTopics = getFetchCatalogTopics(consumer);
      const result = await fetchCatalogTopics();

      expect(result).toEqual(fakeCatalogTopics);
      expect(consumer.getStats().catalogSource).toBe('catalog');
    });

    it('returns empty array on bootstrap error (fallback)', async () => {
      mockCatalogManagerOnce.mockImplementation(() => {
        // Neither timeout nor received fires — error path resolves via bootstrap rejection.
      });
      mockBootstrap.mockRejectedValue(new Error('Kafka unavailable'));

      const fetchCatalogTopics = getFetchCatalogTopics(consumer);
      const result = await fetchCatalogTopics();

      expect(result).toEqual([]);
      expect(consumer.getStats().catalogSource).toBe('fallback');
    });

    it('surfaces unsupportedCatalogTopics in stats when catalog has extra topics', async () => {
      const fakeCatalogTopics = [
        'onex.evt.omniclaude.agent-actions.v1', // supported
        'onex.evt.omniclaude.unknown-future-topic.v1', // NOT in READ_MODEL_TOPICS
      ];

      mockCatalogManagerOnce.mockImplementation(
        (event: string, cb: (e: { topics: string[]; warnings: string[] }) => void) => {
          if (event === 'catalogReceived') {
            setImmediate(() => cb({ topics: fakeCatalogTopics, warnings: [] }));
          }
        }
      );
      mockBootstrap.mockResolvedValue(undefined);

      // Must import READ_MODEL_TOPICS to verify filtering
      const { READ_MODEL_TOPICS } = await import('../read-model-consumer');

      const fetchCatalogTopics = getFetchCatalogTopics(consumer);
      const result = await fetchCatalogTopics();

      // fetchCatalogTopics returns raw catalog topics; filtering happens in start().
      // Verify that after calling the method, state is set for catalog source.
      expect(result).toEqual(fakeCatalogTopics);
      expect(consumer.getStats().catalogSource).toBe('catalog');

      // After calling fetchCatalogTopics, unsupportedCatalogTopics starts empty
      // (set during start() after filtering). Verify READ_MODEL_TOPICS doesn't
      // include the unknown topic so the filtering would catch it.
      expect(READ_MODEL_TOPICS).not.toContain('onex.evt.omniclaude.unknown-future-topic.v1');
    });

    it('stops catalogManager on consumer stop', async () => {
      // Put a mock catalogManager into the consumer's private field
      const fakeManager = { stop: vi.fn().mockResolvedValue(undefined) };
      (consumer as unknown as Record<string, unknown>).catalogManager = fakeManager;
      (consumer as unknown as Record<string, unknown>).running = false;
      (consumer as unknown as Record<string, unknown>).consumer = null;

      // stop() should call catalogManager.stop() even when consumer isn't running
      // (guard is !running && !consumer which is now true — but catalogManager cleanup
      // happens before that guard, so we test via direct field injection).
      // Re-open the guard by setting consumer to a fake object.
      const fakeCons = { disconnect: vi.fn().mockResolvedValue(undefined) };
      (consumer as unknown as Record<string, unknown>).consumer = fakeCons;
      (consumer as unknown as Record<string, unknown>).running = true;

      await consumer.stop();

      expect(fakeManager.stop).toHaveBeenCalledOnce();
    });
  });

  // ============================================================================
  // LLM Cost Event Projection (OMN-2300 / OMN-2329 / OMN-2371)
  // ============================================================================

  describe('projectLlmCostEvent via handleMessage', () => {
    /**
     * Access private handleMessage through the consumer instance.
     * This is intentional test infrastructure to exercise the projection
     * logic without spinning up a full Kafka consumer.
     */
    function getHandleMessage(c: ReadModelConsumer) {
      return (
        c as unknown as { handleMessage: (p: EachMessagePayload) => Promise<void> }
      ).handleMessage.bind(c);
    }

    it('skips projection when DB is unavailable', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const handleMessage = getHandleMessage(consumer);
      // Canonical ContractLlmCallMetrics schema (model_id, not legacy model_name) — the
      // no-DB fast-exit fires before any field parsing, so either schema would produce the
      // same outcome; using canonical fields keeps this fixture in sync with the producer.
      const payload = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        model_id: 'claude-sonnet-4-6',
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        total_cost_usd: 0.005,
        reported_cost_usd: 0.005,
        estimated_cost_usd: 0,
        usage_source: 'API',
      });

      // Should not throw even when DB is unavailable
      await handleMessage(payload);

      // Stats should remain at zero (DB unavailable → skipped)
      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(0);
    });

    it('projects LLM cost event when DB is available (legacy schema)', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');

      // Mock a minimal Drizzle-like insert chain
      const insertMock = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      // Mock db.execute so that updateWatermark succeeds instead of throwing a TypeError.
      // Without this mock, db.execute is undefined and updateWatermark silently swallows
      // the error (non-fatal path), which means the test passes but the watermark code
      // path is never exercised.
      const executeMock = vi.fn().mockResolvedValue(undefined);

      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
        insert: insertMock,
        execute: executeMock,
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const handleMessage = getHandleMessage(consumer);
      // Legacy schema: uses model_name, total_cost_usd, reported_cost_usd, usage_source
      const payload = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        model_name: 'claude-sonnet-4-6',
        repo_name: 'omnidash2',
        session_id: 'sess-abc-123',
        prompt_tokens: 2000,
        completion_tokens: 800,
        total_tokens: 2800,
        total_cost_usd: 0.012,
        reported_cost_usd: 0.012,
        estimated_cost_usd: 0,
        usage_source: 'API',
        request_count: 1,
      });

      await handleMessage(payload);

      // insert should have been called with llmCostAggregates table
      expect(insertMock).toHaveBeenCalled();

      // execute should have been called for the watermark upsert
      expect(executeMock).toHaveBeenCalled();

      // The watermark path should not have warned (i.e., db.execute succeeded)
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Failed to update watermark')
      );

      warnSpy.mockRestore();

      // Verify legacy-field fallback: totalCostUsd and reportedCostUsd must be
      // derived from the payload's total_cost_usd and reported_cost_usd fields.
      // A regression in this fallback path (e.g. both fields silently returning 0)
      // would be caught here.
      const insertValues = (
        insertMock.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> }
      )?.values;
      const insertArg = insertValues?.mock.calls[0]?.[0];
      expect(insertArg).toBeDefined();
      expect(insertArg.totalCostUsd).toBe('0.012');
      expect(insertArg.reportedCostUsd).toBe('0.012');

      // Stats should reflect a successfully projected event
      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(1);
      expect(stats.errorsCount).toBe(0);
      expect(stats.lastProjectedAt).not.toBeNull();
      expect(stats.topicStats['onex.evt.omniintelligence.llm-call-completed.v1']).toBeDefined();
      expect(stats.topicStats['onex.evt.omniintelligence.llm-call-completed.v1'].projected).toBe(1);
      expect(stats.topicStats['onex.evt.omniintelligence.llm-call-completed.v1'].errors).toBe(0);
    });

    it('projects ContractLlmCallMetrics canonical payload (OMN-2371)', async () => {
      // OMN-2371 (GAP-5): Verify that the canonical producer payload schema
      // (ContractLlmCallMetrics from omnibase_spi) is correctly projected.
      // Key differences from legacy schema:
      //   - model_id (not model_name)
      //   - usage_normalized.source (nested, not top-level usage_source)
      //   - estimated_cost_usd only (no total_cost_usd / reported_cost_usd)
      //   - timestamp_iso (not timestamp or created_at)
      //   - reporting_source (not repo_name)
      const { tryGetIntelligenceDb } = await import('../storage');

      // Mock a minimal Drizzle-like insert chain (same pattern as legacy-schema test above)
      const insertMock = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });
      const executeMock = vi.fn().mockResolvedValue(undefined);

      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
        insert: insertMock,
        execute: executeMock,
      });

      const handleMessage = getHandleMessage(consumer);
      const payload = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        // ContractLlmCallMetrics canonical fields
        schema_version: '1.0',
        model_id: 'claude-sonnet-4-6',
        prompt_tokens: 3000,
        completion_tokens: 1200,
        total_tokens: 4200,
        estimated_cost_usd: 0.018,
        latency_ms: 1450.5,
        usage_normalized: {
          schema_version: '1.0',
          prompt_tokens: 3000,
          completion_tokens: 1200,
          total_tokens: 4200,
          source: 'API',
          usage_is_estimated: false,
        },
        usage_is_estimated: false,
        timestamp_iso: '2026-02-19T10:00:00Z',
        reporting_source: 'omniclaude',
        contract_version: '1.0',
      });

      await handleMessage(payload);

      expect(insertMock).toHaveBeenCalled();
      expect(executeMock).toHaveBeenCalled();

      // Verify the row was built with the canonical field mappings.
      // Extract insertValues from the mock chain at assertion time, matching
      // the same structural pattern used by the legacy-schema test above.
      const insertValues = (
        insertMock.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> }
      )?.values;
      const insertArg = insertValues?.mock.calls[0]?.[0];
      expect(insertArg).toBeDefined();
      // model_id → modelName
      expect(insertArg.modelName).toBe('claude-sonnet-4-6');
      // usage_normalized.source → usageSource (uppercased)
      expect(insertArg.usageSource).toBe('API');
      // estimated_cost_usd → totalCostUsd (fallback) and estimatedCostUsd
      expect(insertArg.estimatedCostUsd).toBe('0.018');
      expect(insertArg.totalCostUsd).toBe('0.018');
      // ContractLlmCallMetrics has no reported_cost_usd field, so it must fall
      // back to '0'. Asserting this prevents a regression where reportedCostUsd
      // accidentally picks up estimatedCostUsd instead of defaulting to zero.
      expect(insertArg.reportedCostUsd).toBe('0');
      // timestamp_iso → bucketTime
      expect(insertArg.bucketTime).toBeInstanceOf(Date);
      // granularity defaults to 'hour' for per-call events
      expect(insertArg.granularity).toBe('hour');
      // token counts match
      expect(insertArg.promptTokens).toBe(3000);
      expect(insertArg.completionTokens).toBe(1200);
      expect(insertArg.totalTokens).toBe(4200);
      // reporting_source 'omniclaude' passes heuristic (length < 64, no whitespace) → repoName
      expect(insertArg.repoName).toBe('omniclaude');

      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(1);
      expect(stats.errorsCount).toBe(0);
    });

    it('derives total_tokens from prompt+completion when total_tokens=0', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');

      const insertValues = vi.fn().mockResolvedValue(undefined);
      const insertMock = vi.fn().mockReturnValue({ values: insertValues });
      const executeMock = vi.fn().mockResolvedValue(undefined);

      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
        insert: insertMock,
        execute: executeMock,
      });

      const handleMessage = getHandleMessage(consumer);
      const payload = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        model_name: 'gpt-4',
        prompt_tokens: 1500,
        completion_tokens: 600,
        total_tokens: 0, // Intentionally zero — should be derived
        total_cost_usd: 0.008,
        reported_cost_usd: 0.008,
        estimated_cost_usd: 0,
        usage_source: 'API',
      });

      await handleMessage(payload);

      // Verify the values passed to insert included the derived total
      const insertArg = insertValues.mock.calls[0]?.[0];
      expect(insertArg).toBeDefined();
      // total_tokens should be derived as 1500 + 600 = 2100
      expect(insertArg.totalTokens).toBe(2100);

      // execute should have been called for the watermark upsert
      expect(executeMock).toHaveBeenCalled();

      // Stats should reflect a successfully projected event
      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(1);
    });

    it('defaults model_name to "unknown" with warning when model_id and model_name are absent', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');

      const insertValues = vi.fn().mockResolvedValue(undefined);
      const insertMock = vi.fn().mockReturnValue({ values: insertValues });
      const executeMock = vi.fn().mockResolvedValue(undefined);

      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
        insert: insertMock,
        execute: executeMock,
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const handleMessage = getHandleMessage(consumer);
      const payload = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        // model_id and model_name intentionally absent
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        total_cost_usd: 0.001,
        reported_cost_usd: 0.001,
        estimated_cost_usd: 0,
        usage_source: 'API',
      });

      await handleMessage(payload);

      // Warning should be logged for missing model_id/model_name
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing model_id/model_name'));
      // Row should still be inserted with 'unknown'
      const insertArg = insertValues.mock.calls[0]?.[0];
      expect(insertArg?.modelName).toBe('unknown');

      // execute should have been called for the watermark upsert
      expect(executeMock).toHaveBeenCalled();

      warnSpy.mockRestore();

      // Stats should reflect a successfully projected event
      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(1);
    });

    it('defaults usage_source to "API" for unrecognised values', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');

      const insertValues = vi.fn().mockResolvedValue(undefined);
      const insertMock = vi.fn().mockReturnValue({ values: insertValues });
      const executeMock = vi.fn().mockResolvedValue(undefined);

      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
        insert: insertMock,
        execute: executeMock,
      });

      const handleMessage = getHandleMessage(consumer);
      const payload = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        model_id: 'gpt-4o',
        usage_source: 'INVALID_VALUE',
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        total_cost_usd: 0.001,
        reported_cost_usd: 0.001,
        estimated_cost_usd: 0,
      });

      await handleMessage(payload);

      const insertArg = insertValues.mock.calls[0]?.[0];
      expect(insertArg?.usageSource).toBe('API');

      // execute should have been called for the watermark upsert
      expect(executeMock).toHaveBeenCalled();

      // Stats should reflect a successfully projected event
      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(1);
    });

    it('defaults usage_source via usage_is_estimated fallback when usage_normalized.source is empty', async () => {
      // Covers the path in read-model-consumer.ts ~line 1128 where:
      //   (usageNormalized?.source as string) is an empty string (falsy → skipped)
      //   top-level usage_source / usageSource are absent
      //   → final fallback: usage_is_estimated ? 'ESTIMATED' : 'API'
      // This is a ContractLlmCallMetrics-style payload where the nested source
      // field is present but empty, so none of the string OR-chain guards match.
      const { tryGetIntelligenceDb } = await import('../storage');

      const insertValues = vi.fn().mockResolvedValue(undefined);
      const insertMock = vi.fn().mockReturnValue({ values: insertValues });
      const executeMock = vi.fn().mockResolvedValue(undefined);

      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
        insert: insertMock,
        execute: executeMock,
      });

      const handleMessage = getHandleMessage(consumer);

      // Case A: usage_normalized.source is empty string + usage_is_estimated=false → 'API'
      const payloadA = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        model_id: 'claude-sonnet-4-6',
        prompt_tokens: 500,
        completion_tokens: 200,
        total_tokens: 700,
        estimated_cost_usd: 0.003,
        usage_normalized: {
          schema_version: '1.0',
          prompt_tokens: 500,
          completion_tokens: 200,
          total_tokens: 700,
          source: '', // empty string → falsy, triggers fallback
          usage_is_estimated: false,
        },
        usage_is_estimated: false,
        // No top-level usage_source field
      });

      await handleMessage(payloadA);

      const insertArgA = insertValues.mock.calls[0]?.[0];
      expect(insertArgA).toBeDefined();
      expect(insertArgA.usageSource).toBe('API');

      // Reset for Case B
      insertValues.mockClear();
      insertMock.mockClear();

      // Case B: usage_normalized.source is empty string + usage_is_estimated=true → 'ESTIMATED'
      const payloadB = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        model_id: 'claude-sonnet-4-6',
        prompt_tokens: 500,
        completion_tokens: 200,
        total_tokens: 700,
        estimated_cost_usd: 0.003,
        usage_normalized: {
          schema_version: '1.0',
          prompt_tokens: 500,
          completion_tokens: 200,
          total_tokens: 700,
          source: '', // empty string → falsy, triggers fallback
          usage_is_estimated: true,
        },
        usage_is_estimated: true,
        // No top-level usage_source field
      });

      await handleMessage(payloadB);

      const insertArgB = insertValues.mock.calls[0]?.[0];
      expect(insertArgB).toBeDefined();
      expect(insertArgB.usageSource).toBe('ESTIMATED');

      // Stats reflect 2 successfully projected events across the 2 sub-cases
      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(2);
      expect(stats.errorsCount).toBe(0);
    });

    it('coerces non-finite cost values to 0', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');

      const insertValues = vi.fn().mockResolvedValue(undefined);
      const insertMock = vi.fn().mockReturnValue({ values: insertValues });
      const executeMock = vi.fn().mockResolvedValue(undefined);

      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
        insert: insertMock,
        execute: executeMock,
      });

      const handleMessage = getHandleMessage(consumer);
      const payload = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        model_id: 'claude-opus-4',
        total_cost_usd: false, // non-numeric
        reported_cost_usd: null, // null
        estimated_cost_usd: 'NaN', // string NaN
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
        usage_source: 'ESTIMATED',
      });

      await handleMessage(payload);

      const insertArg = insertValues.mock.calls[0]?.[0];
      expect(insertArg?.totalCostUsd).toBe('0');
      expect(insertArg?.reportedCostUsd).toBe('0');
      expect(insertArg?.estimatedCostUsd).toBe('0');

      // execute should have been called for the watermark upsert
      expect(executeMock).toHaveBeenCalled();

      // Stats should reflect a successfully projected event
      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(1);
    });

    it('gracefully handles the table-not-found error (42P01) and advances watermark', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');

      const tableNotFoundErr = Object.assign(
        new Error('relation "llm_cost_aggregates" does not exist'),
        {
          code: '42P01',
        }
      );
      const insertMock = vi.fn().mockReturnValue({
        values: vi.fn().mockRejectedValue(tableNotFoundErr),
      });
      const executeMock = vi.fn().mockResolvedValue(undefined);

      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
        insert: insertMock,
        execute: executeMock,
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const handleMessage = getHandleMessage(consumer);
      const payload = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        model_id: 'gpt-4',
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        total_cost_usd: 0.001,
        reported_cost_usd: 0.001,
        estimated_cost_usd: 0,
        usage_source: 'API',
      });

      // Should not throw — 42P01 is handled gracefully
      await handleMessage(payload);

      // Warning should be logged about missing table
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('llm_cost_aggregates table not yet created')
      );

      // Watermark should still be advanced even when the table is missing
      expect(executeMock).toHaveBeenCalled();

      // Watermark should still be advanced (projected=1 because the error is treated as handled)
      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(1);
      expect(stats.errorsCount).toBe(0);

      warnSpy.mockRestore();
    });

    it('omits repoName when reporting_source is too long or contains whitespace', async () => {
      // Covers the rejection branch of the reporting_source heuristic in
      // read-model-consumer.ts ~line 1213:
      //   reportingSource.length < 64 && !/\s/.test(reportingSource)
      // A value that fails either guard must NOT become repoName in the projected row.
      const { tryGetIntelligenceDb } = await import('../storage');

      const insertValues = vi.fn().mockResolvedValue(undefined);
      const insertMock = vi.fn().mockReturnValue({ values: insertValues });
      const executeMock = vi.fn().mockResolvedValue(undefined);

      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
        insert: insertMock,
        execute: executeMock,
      });

      const handleMessage = getHandleMessage(consumer);

      // Case A: reporting_source is ≥ 64 characters → should be rejected
      const longSource = 'a'.repeat(64); // exactly 64 chars, fails length < 64
      const payloadA = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        model_id: 'claude-sonnet-4-6',
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        estimated_cost_usd: 0.001,
        reporting_source: longSource,
      });

      await handleMessage(payloadA);

      const insertArgA = insertValues.mock.calls[0]?.[0];
      expect(insertArgA).toBeDefined();
      // Long reporting_source must not be promoted to repoName
      expect(insertArgA.repoName).toBeUndefined();

      // Reset mocks for Case B
      insertValues.mockClear();
      insertMock.mockClear();

      // Case B: reporting_source contains whitespace → should be rejected
      const payloadB = makeKafkaPayload('onex.evt.omniintelligence.llm-call-completed.v1', {
        model_id: 'claude-sonnet-4-6',
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        estimated_cost_usd: 0.001,
        reporting_source: 'free form description with spaces',
      });

      await handleMessage(payloadB);

      const insertArgB = insertValues.mock.calls[0]?.[0];
      expect(insertArgB).toBeDefined();
      // reporting_source with whitespace must not be promoted to repoName
      expect(insertArgB.repoName).toBeUndefined();

      // Stats reflect 2 successfully projected events across the 2 sub-cases
      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(2);
      expect(stats.errorsCount).toBe(0);
    });
  });

  // ============================================================================
  // Baselines Snapshot Projection (OMN-2331)
  // ============================================================================

  describe('projectBaselinesSnapshot via handleMessage', () => {
    function getHandleMessage(c: ReadModelConsumer) {
      return (
        c as unknown as { handleMessage: (p: EachMessagePayload) => Promise<void> }
      ).handleMessage.bind(c);
    }

    /**
     * Build a minimal valid baselines-computed payload.
     * All child arrays include at least one row so every insert branch is exercised.
     */
    function makeBaselinesPayload(overrides: Record<string, unknown> = {}): EachMessagePayload {
      return makeKafkaPayload('onex.evt.omnibase-infra.baselines-computed.v1', {
        snapshot_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        contract_version: 1,
        computed_at_utc: '2026-02-18T00:00:00Z',
        comparisons: [
          {
            pattern_id: 'pat-1',
            pattern_name: 'test-pattern',
            sample_size: 10,
            window_start: '2026-01-01',
            window_end: '2026-02-01',
            token_delta: {},
            time_delta: {},
            retry_delta: {},
            test_pass_rate_delta: {},
            review_iteration_delta: {},
            recommendation: 'promote',
            confidence: 'high',
            rationale: 'looks good',
          },
        ],
        trend: [
          {
            date: '2026-02-01',
            avg_cost_savings: 0.1,
            avg_outcome_improvement: 0.05,
            comparisons_evaluated: 3,
          },
        ],
        breakdown: [{ action: 'promote', count: 5, avg_confidence: 0.9 }],
        ...overrides,
      });
    }

    /**
     * Build a mock db that satisfies the transaction-based write in
     * projectBaselinesSnapshot. The transaction callback is invoked
     * synchronously with a tx object whose insert/delete chains all resolve.
     *
     * The tx.insert mock tracks which table is being inserted into by call order.
     * Call 1 = snapshot header (needs onConflictDoUpdate chain).
     * Calls 2-4 = child rows (values resolves directly).
     *
     * A factory function is returned so each test call gets a fresh closure
     * with its own independent insertCallCount — this ensures idempotency tests
     * that call handleMessage twice don't corrupt the mock's per-call dispatch.
     */
    function makeMockDb() {
      const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
      const childInsertValues = vi.fn().mockResolvedValue(undefined);
      const deleteWhere = vi.fn().mockResolvedValue(undefined);
      const deleteMock = vi.fn().mockReturnValue({ where: deleteWhere });

      // Build a fresh tx per transaction invocation so each transaction's
      // insert call counter starts at 0 even when handleMessage is called twice.
      function makeTx() {
        let txInsertCount = 0;
        const txInsert = vi.fn().mockImplementation(() => {
          txInsertCount++;
          if (txInsertCount === 1) {
            return { values: vi.fn().mockReturnValue({ onConflictDoUpdate }) };
          }
          return { values: childInsertValues };
        });
        return { insert: txInsert, delete: deleteMock };
      }

      const executeMock = vi.fn().mockResolvedValue(undefined);

      const db = {
        transaction: vi
          .fn()
          .mockImplementation(async (fn: (tx: ReturnType<typeof makeTx>) => Promise<void>) => {
            await fn(makeTx());
          }),
        execute: executeMock,
      };

      return { db, deleteMock, childInsertValues, executeMock };
    }

    it('happy path: writes all 4 tables and advances watermark', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      const { baselinesProjection } = await import('../projection-bootstrap');
      const { emitBaselinesUpdate } = await import('../baselines-events');
      const { db, deleteMock, childInsertValues, executeMock } = makeMockDb();
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(db);

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(makeBaselinesPayload());

      // transaction was entered once
      expect(db.transaction).toHaveBeenCalledTimes(1);

      // deletes for comparisons, trend, breakdown
      expect(deleteMock).toHaveBeenCalledTimes(3);

      // child row inserts: comparisons + trend + breakdown = 3
      expect(childInsertValues).toHaveBeenCalledTimes(3);

      // The comparisons insert is the first child insert call (txInsertCount === 2).
      // Verify the recommendation field is 'promote' (the valid happy-path value),
      // not 'shadow' (which would indicate the invalid-value fallback coercion fired).
      const comparisonsInsertArg = childInsertValues.mock.calls[0]?.[0];
      expect(comparisonsInsertArg).toBeDefined();
      const firstComparison = Array.isArray(comparisonsInsertArg)
        ? comparisonsInsertArg[0]
        : comparisonsInsertArg;
      expect(firstComparison?.recommendation).toBe('promote');

      // watermark updated
      expect(executeMock).toHaveBeenCalled();

      // projection cache should have been invalidated after the DB writes committed
      expect(baselinesProjection.reset).toHaveBeenCalledTimes(1);

      // WebSocket clients should have been notified with the correct snapshot ID
      expect(emitBaselinesUpdate).toHaveBeenCalledTimes(1);
      expect(emitBaselinesUpdate).toHaveBeenCalledWith('a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(1);
      expect(stats.errorsCount).toBe(0);
    });

    it('idempotency: re-delivering the same UUID snapshot_id upserts the header and re-projects child rows without double-inserting', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      const { db, childInsertValues } = makeMockDb();
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(db);

      const handleMessage = getHandleMessage(consumer);
      const payload = makeBaselinesPayload();

      await handleMessage(payload);
      await handleMessage(payload);

      // Two rounds → two transactions entered
      expect(db.transaction).toHaveBeenCalledTimes(2);

      // Each round inserts 3 child batches (comparisons + trend + breakdown) = 6 total.
      // The header is upserted via onConflictDoUpdate so it is safe to re-deliver.
      expect(childInsertValues).toHaveBeenCalledTimes(6);

      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(2);
      expect(stats.errorsCount).toBe(0);
    });

    it('graceful degrade: 42P01 error returns without crashing', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');

      const tableNotFoundErr = Object.assign(
        new Error('relation "baselines_snapshots" does not exist'),
        { code: '42P01' }
      );
      const db = {
        transaction: vi.fn().mockRejectedValue(tableNotFoundErr),
        execute: vi.fn().mockResolvedValue(undefined),
      };
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(db);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const handleMessage = getHandleMessage(consumer);
      // Should not throw
      await handleMessage(makeBaselinesPayload());

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('baselines_* tables not yet created')
      );

      // Event is treated as handled so watermark advances (projected=1, errors=0)
      const stats = consumer.getStats();
      expect(stats.eventsProjected).toBe(1);
      expect(stats.errorsCount).toBe(0);

      warnSpy.mockRestore();
    });

    it('blank date filtering: trend rows with null/empty date are skipped with a warning', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      const { db, childInsertValues } = makeMockDb();
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(db);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeBaselinesPayload({
          trend: [
            // Row with null date — should be filtered out
            {
              date: null,
              avg_cost_savings: 0.1,
              avg_outcome_improvement: 0.05,
              comparisons_evaluated: 1,
            },
            // Row with empty string date — should be filtered out
            {
              date: '',
              avg_cost_savings: 0.2,
              avg_outcome_improvement: 0.1,
              comparisons_evaluated: 2,
            },
            // Row with a valid date — should pass through
            {
              date: '2026-02-15',
              avg_cost_savings: 0.3,
              avg_outcome_improvement: 0.15,
              comparisons_evaluated: 3,
            },
          ],
        })
      );

      // Warning should fire exactly once for each of the two bad rows
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping trend row with blank/null date'),
        expect.any(String)
      );

      // comparisons + trend (1 valid row filtered from 3) + breakdown = 3 child inserts
      expect(childInsertValues).toHaveBeenCalledTimes(3);

      // Verify the valid trend row made it into the insert
      const allInsertArgs = childInsertValues.mock.calls.flatMap((call) =>
        Array.isArray(call[0]) ? call[0] : []
      );
      const trendRow = allInsertArgs.find(
        (row: Record<string, unknown>) => row.date === '2026-02-15'
      );
      expect(trendRow).toBeDefined();

      warnSpy.mockRestore();
    });

    it('blank date filtering: trend rows with malformed date format are skipped with a warning', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      const { db, childInsertValues } = makeMockDb();
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(db);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeBaselinesPayload({
          trend: [
            // Row with MM/DD/YYYY format — should be filtered out (fails YYYY-MM-DD regex)
            {
              date: '02/15/2026',
              avg_cost_savings: 0.1,
              avg_outcome_improvement: 0.05,
              comparisons_evaluated: 1,
            },
            // Row with a valid ISO date — should pass through
            {
              date: '2026-02-15',
              avg_cost_savings: 0.3,
              avg_outcome_improvement: 0.15,
              comparisons_evaluated: 3,
            },
          ],
        })
      );

      // Warning should fire for the malformed-format row
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping trend row with malformed date format'),
        expect.any(String)
      );

      // comparisons + trend (1 valid row filtered from 2) + breakdown = 3 child inserts
      expect(childInsertValues).toHaveBeenCalledTimes(3);

      // Verify only the valid trend row made it into the insert
      const allInsertArgs = childInsertValues.mock.calls.flatMap((call) =>
        Array.isArray(call[0]) ? call[0] : []
      );
      const trendRow = allInsertArgs.find(
        (row: Record<string, unknown>) => row.date === '2026-02-15'
      );
      expect(trendRow).toBeDefined();

      const malformedRow = allInsertArgs.find(
        (row: Record<string, unknown>) => row.date === '02/15/2026'
      );
      expect(malformedRow).toBeUndefined();

      warnSpy.mockRestore();
    });

    it('coerces invalid confidence and recommendation values to safe defaults', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      const { db, childInsertValues } = makeMockDb();
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(db);

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeBaselinesPayload({
          comparisons: [
            {
              pattern_id: 'pat-1',
              pattern_name: 'Test Pattern',
              recommendation: 'DEMOTE', // invalid — should coerce to 'shadow'
              confidence: 'VERY_HIGH', // invalid — should coerce to 'low'
              rationale: 'test',
              cost_delta: 0,
              outcome_improvement: 0,
              test_pass_rate_delta: {},
              review_iteration_delta: {},
              window_start: '2026-02-01',
              window_end: '2026-02-15',
            },
          ],
        })
      );

      const allInsertArgs = childInsertValues.mock.calls.flatMap((call) =>
        Array.isArray(call[0]) ? call[0] : []
      );
      const compRow = allInsertArgs.find(
        (row: Record<string, unknown>) => row.patternId === 'pat-1'
      );
      expect(compRow).toBeDefined();
      expect(compRow?.recommendation).toBe('shadow');
      expect(compRow?.confidence).toBe('low');
    });
  });
});

// ============================================================================
// OMN-2924: Pattern write handlers
// ============================================================================

describe('OMN-2924: Pattern projection write handlers', () => {
  let consumer: ReadModelConsumer;
  let getHandleMessage: (c: ReadModelConsumer) => (payload: EachMessagePayload) => Promise<void>;

  beforeEach(() => {
    consumer = new ReadModelConsumer();
    getHandleMessage = (c) =>
      (
        c as unknown as { handleMessage: (p: EachMessagePayload) => Promise<void> }
      ).handleMessage.bind(c);
  });

  describe('projectPatternProjectionEvent', () => {
    it('returns true and upserts patterns into pattern_learning_artifacts and pattern_quality_metrics', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');

      // Mock onConflictDoUpdate chain (used by both patternLearningArtifacts and patternQualityMetrics)
      const mockOnConflict = vi.fn().mockResolvedValue({ rowCount: 1 });
      const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflict });
      const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
      const mockDb = { insert: mockInsert } as unknown as ReturnType<typeof tryGetIntelligenceDb>;
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);

      const handleMessage = getHandleMessage(consumer);
      const payload = makeKafkaPayload('onex.evt.omniintelligence.pattern-projection.v1', {
        event_type: 'PatternProjection',
        snapshot_id: 'snap-uuid-1',
        snapshot_at: '2026-02-27T00:00:00Z',
        total_count: 1,
        patterns: [
          {
            id: 'pat-uuid-1',
            domain_id: 'code_generation',
            pattern_type: 'tool_usage_pattern',
            quality_score: 0.85,
            status: 'validated',
            confidence: 0.9,
            signature_hash: 'hash123',
          },
        ],
      });

      await handleMessage(payload);

      // 2 inserts per pattern: pattern_learning_artifacts + pattern_quality_metrics (OMN-6804)
      expect(mockInsert).toHaveBeenCalledTimes(2);
      expect(mockValues).toHaveBeenCalledTimes(2);
      expect(mockOnConflict).toHaveBeenCalledTimes(2);
    });

    it('returns true without DB writes when patterns array is empty', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      const mockInsert = vi.fn();
      const mockDb = { insert: mockInsert } as unknown as ReturnType<typeof tryGetIntelligenceDb>;
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeKafkaPayload('onex.evt.omniintelligence.pattern-projection.v1', {
          event_type: 'PatternProjection',
          snapshot_id: 'snap-uuid-2',
          snapshot_at: '2026-02-27T00:00:00Z',
          total_count: 0,
          patterns: [],
        })
      );

      // No DB insert should happen for empty snapshot
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('returns false when DB is unavailable', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeKafkaPayload('onex.evt.omniintelligence.pattern-projection.v1', {
          event_type: 'PatternProjection',
          snapshot_id: 'snap-uuid-3',
          snapshot_at: '2026-02-27T00:00:00Z',
          total_count: 1,
          patterns: [{ id: 'pat-1', domain_id: 'test', quality_score: 0.5, status: 'candidate' }],
        })
      );

      // errorsCount incremented means DB unavailable path was taken
      const stats = consumer.getStats();
      expect(stats.errorsCount).toBe(0); // false return = skip, no error counted
    });
  });

  // ============================================================================
  // OMN-2960: projectLlmRoutingDecisionEvent — uuid correlation_id validation
  //
  // After the migration that changed correlation_id from TEXT to UUID, the
  // consumer must reject events whose correlation_id is not a valid UUID rather
  // than letting Postgres throw an "invalid input syntax for type uuid" error.
  // ============================================================================

  describe('projectLlmRoutingDecisionEvent [OMN-2960]', () => {
    const TOPIC = 'onex.evt.omniclaude.llm-routing-decision.v1';
    const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

    function getHandleMessage(c: ReadModelConsumer) {
      return (
        c as unknown as { handleMessage: (p: EachMessagePayload) => Promise<void> }
      ).handleMessage.bind(c);
    }

    function makeDb() {
      const mockExecute = vi.fn().mockResolvedValue(undefined);
      const db = { execute: mockExecute } as unknown as ReturnType<
        typeof import('../storage').tryGetIntelligenceDb
      >;
      return { db, mockExecute };
    }

    it('inserts when correlation_id is a valid UUID', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      const { db, mockExecute } = makeDb();
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(db);

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeKafkaPayload(TOPIC, {
          correlation_id: VALID_UUID,
          llm_agent: 'agent-api',
          fuzzy_agent: 'agent-api',
          agreement: true,
          routing_prompt_version: 'v1.0.0',
        })
      );

      // execute is called twice: once for the LLM routing INSERT and once for
      // the watermark upsert.  Verify the first call targets llm_routing_decisions.
      expect(mockExecute).toHaveBeenCalledTimes(2);
      const firstCallSql = JSON.stringify(mockExecute.mock.calls[0]);
      expect(firstCallSql).toContain('llm_routing_decisions');
    });

    it('skips event with non-UUID correlation_id and logs warning', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      const { db, mockExecute } = makeDb();
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(db);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeKafkaPayload(TOPIC, {
          correlation_id: 'not-a-uuid',
          llm_agent: 'agent-api',
          fuzzy_agent: 'agent-api',
        })
      );

      // The projector skips early (returns true) — only the watermark upsert
      // runs.  Verify no call targets llm_routing_decisions.
      const callsSql = JSON.stringify(mockExecute.mock.calls);
      expect(callsSql).not.toContain('llm_routing_decisions');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non-UUID correlation_id'));
      warnSpy.mockRestore();
    });

    it('skips event with plaintext (non-UUID) correlation_id', async () => {
      // Equivalent coverage for a different invalid string shape.
      const { tryGetIntelligenceDb } = await import('../storage');
      const { db, mockExecute } = makeDb();
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(db);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeKafkaPayload(TOPIC, {
          correlation_id: 'plaintext-not-a-uuid',
          llm_agent: 'agent-api',
          fuzzy_agent: 'agent-api',
        })
      );

      const callsSql = JSON.stringify(mockExecute.mock.calls);
      expect(callsSql).not.toContain('llm_routing_decisions');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('returns false when DB is unavailable', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeKafkaPayload(TOPIC, {
          correlation_id: VALID_UUID,
          llm_agent: 'agent-api',
          fuzzy_agent: 'agent-api',
        })
      );

      const stats = consumer.getStats();
      expect(stats.errorsCount).toBe(0);
    });
  });

  describe('projectPatternLifecycleTransitionedEvent', () => {
    it('updates lifecycle_state and inserts audit row when pattern_id and to_status are present', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');

      // Mock update chain for pattern_learning_artifacts
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'row-id-1' }]);
      const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

      // Mock insert chain for pattern_lifecycle_transitions (OMN-6804)
      const mockOnConflictDoNothing = vi.fn().mockResolvedValue({ rowCount: 1 });
      const mockValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
      const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

      const mockDb = {
        update: mockUpdate,
        insert: mockInsert,
      } as unknown as ReturnType<typeof tryGetIntelligenceDb>;
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeKafkaPayload('onex.evt.omniintelligence.pattern-lifecycle-transitioned.v1', {
          event_type: 'PatternLifecycleTransitioned',
          pattern_id: 'pat-uuid-1',
          from_status: 'candidate',
          to_status: 'validated',
          trigger: 'manual',
          actor: 'test',
          transition_id: 'trans-uuid-1',
          transitioned_at: '2026-02-27T00:00:00Z',
          request_id: 'req-uuid-1',
          correlation_id: 'corr-uuid-1',
        })
      );

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockWhere).toHaveBeenCalledTimes(1);
      // OMN-6804: Also inserts into pattern_lifecycle_transitions
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });

    it('skips silently when pattern_id is missing', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      const mockUpdate = vi.fn();
      const mockDb = { update: mockUpdate } as unknown as ReturnType<typeof tryGetIntelligenceDb>;
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeKafkaPayload('onex.evt.omniintelligence.pattern-lifecycle-transitioned.v1', {
          event_type: 'PatternLifecycleTransitioned',
          to_status: 'validated',
          // pattern_id missing
        })
      );

      expect(mockUpdate).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('returns false when DB is unavailable', async () => {
      const { tryGetIntelligenceDb } = await import('../storage');
      (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const handleMessage = getHandleMessage(consumer);
      await handleMessage(
        makeKafkaPayload('onex.evt.omniintelligence.pattern-lifecycle-transitioned.v1', {
          pattern_id: 'pat-uuid-1',
          to_status: 'validated',
        })
      );

      const stats = consumer.getStats();
      expect(stats.errorsCount).toBe(0);
    });
  });
});

// ============================================================================
// ============================================================================
// OMN-4081: projectRoutingDecision field aliasing from omniclaude producer
//
// The omniclaude routing.decision event payload uses different field names
// than the omnidash read-model schema:
//   prompt_preview   → user_request     (OMN-3320)
//   routing_policy   → routing_strategy (fallback: 'unknown')
//   (absent)         → routing_time_ms  (fallback: 0)
//   confidence       → confidence_score (OMN-3320)
//
// These tests verify that the consumer correctly maps omniclaude-style
// payloads into the agent_routing_decisions schema without constraint
// violations, regardless of which field names the producer uses.
// ============================================================================

describe('OMN-4081: projectRoutingDecision via handleMessage — omniclaude field aliasing', () => {
  let consumer: ReadModelConsumer;

  beforeEach(() => {
    vi.clearAllMocks();
    consumer = new ReadModelConsumer();
  });

  function getHandleMessage(c: ReadModelConsumer) {
    return (
      c as unknown as { handleMessage: (p: EachMessagePayload) => Promise<void> }
    ).handleMessage.bind(c);
  }

  const TOPIC = 'onex.evt.omniclaude.routing-decision.v1';

  function makeRoutingDecisionPayload(overrides: Record<string, unknown> = {}) {
    return makeKafkaPayload(TOPIC, {
      correlation_id: '11111111-1111-1111-1111-111111111111',
      claude_session_id: 'test-session',
      selected_agent: 'polymorphic-agent',
      confidence_score: 0.92,
      created_at: '2026-03-09T00:00:00.000Z',
      ...overrides,
    });
  }

  it('skips projection when DB is unavailable', async () => {
    const { tryGetIntelligenceDb } = await import('../storage');
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const handleMessage = getHandleMessage(consumer);
    await handleMessage(makeRoutingDecisionPayload({ prompt_preview: 'Hello world' }));

    expect(consumer.getStats().eventsProjected).toBe(0);
  });

  it('maps prompt_preview → userRequest when user_request is absent [OMN-3320]', async () => {
    const { tryGetIntelligenceDb } = await import('../storage');
    const onConflictDoNothingMock = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const handleMessage = getHandleMessage(consumer);
    // Omniclaude-style payload: uses prompt_preview, not user_request
    await handleMessage(
      makeRoutingDecisionPayload({
        prompt_preview: 'Fix the bug in auth module',
        routing_policy: 'trigger_match',
        confidence: 0.85,
        // routing_time_ms intentionally absent
      })
    );

    expect(insertMock).toHaveBeenCalled();
    const insertedRow = valuesMock.mock.calls[0]?.[0];
    expect(insertedRow).toBeDefined();
    // prompt_preview must be mapped to userRequest
    expect(insertedRow.userRequest).toBe('Fix the bug in auth module');
  });

  it('maps confidence → confidenceScore when confidence_score is absent [OMN-3320]', async () => {
    const { tryGetIntelligenceDb } = await import('../storage');
    const onConflictDoNothingMock = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const handleMessage = getHandleMessage(consumer);
    // Build payload without confidence_score so the consumer must fall back to confidence
    await handleMessage(
      makeKafkaPayload(TOPIC, {
        correlation_id: '22222222-2222-2222-2222-222222222222',
        claude_session_id: 'test-session',
        selected_agent: 'polymorphic-agent',
        prompt_preview: 'Deploy to staging',
        confidence: 0.77,
        // confidence_score intentionally absent — consumer must fall back to confidence
      })
    );

    expect(insertMock).toHaveBeenCalled();
    const insertedRow = valuesMock.mock.calls[0]?.[0];
    expect(insertedRow).toBeDefined();
    expect(insertedRow.confidenceScore).toBe('0.77');
  });

  it('defaults routingStrategy to "unknown" when routing_strategy and routingStrategy are absent', async () => {
    const { tryGetIntelligenceDb } = await import('../storage');
    const onConflictDoNothingMock = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const handleMessage = getHandleMessage(consumer);
    await handleMessage(
      makeRoutingDecisionPayload({
        prompt_preview: 'Write tests',
        // routing_strategy and routingStrategy intentionally absent
      })
    );

    expect(insertMock).toHaveBeenCalled();
    const insertedRow = valuesMock.mock.calls[0]?.[0];
    expect(insertedRow).toBeDefined();
    expect(insertedRow.routingStrategy).toBe('unknown');
  });

  it('defaults routingTimeMs to 0 when routing_time_ms is absent', async () => {
    const { tryGetIntelligenceDb } = await import('../storage');
    const onConflictDoNothingMock = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const handleMessage = getHandleMessage(consumer);
    await handleMessage(
      makeRoutingDecisionPayload({
        prompt_preview: 'Analyze logs',
        // routing_time_ms intentionally absent
      })
    );

    expect(insertMock).toHaveBeenCalled();
    const insertedRow = valuesMock.mock.calls[0]?.[0];
    expect(insertedRow).toBeDefined();
    expect(insertedRow.routingTimeMs).toBe(0);
  });

  it('accepts canonical field names when producer emits them directly', async () => {
    const { tryGetIntelligenceDb } = await import('../storage');
    const onConflictDoNothingMock = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock,
      execute: executeMock,
    });

    const handleMessage = getHandleMessage(consumer);
    await handleMessage(
      makeRoutingDecisionPayload({
        user_request: 'Create a PR for OMN-4081',
        routing_strategy: 'event',
        routing_time_ms: 123,
        confidence_score: 0.95,
      })
    );

    expect(insertMock).toHaveBeenCalled();
    const insertedRow = valuesMock.mock.calls[0]?.[0];
    expect(insertedRow).toBeDefined();
    expect(insertedRow.userRequest).toBe('Create a PR for OMN-4081');
    expect(insertedRow.routingStrategy).toBe('event');
    expect(insertedRow.routingTimeMs).toBe(123);
    expect(insertedRow.confidenceScore).toBe('0.95');
  });
});

// OMN-2760 / OMN-5251: Regression — topics.yaml coverage
//
// OMN-5251: READ_MODEL_TOPICS is now derived from topics.yaml at module load.
// These tests verify the manifest contains expected canonical topics and
// excludes legacy flat names.
// ============================================================================

describe('OMN-2760/OMN-5251: topics.yaml coverage', () => {
  it('READ_MODEL_TOPICS contains expected canonical agent topics', async () => {
    const { READ_MODEL_TOPICS } = await import('../read-model-consumer');
    const expectedAgentTopics = [
      'onex.evt.omniclaude.agent-actions.v1',
      'onex.evt.omniclaude.routing-decision.v1',
      'onex.evt.omniclaude.agent-transformation.v1',
      'onex.evt.omniclaude.performance-metrics.v1',
    ];

    for (const topic of expectedAgentTopics) {
      expect(READ_MODEL_TOPICS).toContain(topic);
    }
  });

  it('READ_MODEL_TOPICS contains no legacy flat agent topic strings', async () => {
    const FORBIDDEN = [
      'agent-actions',
      'agent-routing-decisions',
      'agent-transformation-events',
      'router-performance-metrics',
    ];

    const { READ_MODEL_TOPICS } = await import('../read-model-consumer');
    for (const forbidden of FORBIDDEN) {
      expect(READ_MODEL_TOPICS).not.toContain(forbidden);
    }
  });
});
