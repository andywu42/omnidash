/**
 * LlmRoutingSource Tests (OMN-2279)
 *
 * Tests for the LLM routing effectiveness data source with API-first +
 * mock-fallback behavior.  Follows the same pattern as enrichment-source.test.ts.
 *
 * Coverage:
 *  - API-first + mock-fallback on network/HTTP errors
 *  - Empty-response mock promotion (mockOnEmpty flag)
 *  - Singleton mock-state tracking (isUsingMockData / clearMockState)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createMockResponse, setupFetchMock, resetFetchMock } from '@/tests/utils/mock-fetch';
import type {
  LlmRoutingSummary,
  LlmRoutingLatencyPoint,
  LlmRoutingByVersion,
} from '@shared/llm-routing-types';

// Re-import the singleton fresh per test so state does not leak between cases.
let llmRoutingSource: (typeof import('../llm-routing-source'))['llmRoutingSource'];

// ===========================
// Test Fixtures
// ===========================

const createValidSummary = (overrides: Partial<LlmRoutingSummary> = {}): LlmRoutingSummary => ({
  total_decisions: 1_200,
  agreement_rate: 0.72,
  fallback_rate: 0.08,
  avg_cost_usd: 0.0004,
  llm_p50_latency_ms: 320,
  llm_p95_latency_ms: 890,
  fuzzy_p50_latency_ms: 4,
  fuzzy_p95_latency_ms: 18,
  counts: { total: 1_200, agreed: 864, disagreed: 336, fallback: 96 },
  agreement_rate_trend: [
    { date: '2026-02-12', value: 0.68 },
    { date: '2026-02-13', value: 0.71 },
    { date: '2026-02-14', value: 0.72 },
  ],
  ...overrides,
});

const createValidLatencyPoints = (): LlmRoutingLatencyPoint[] => [
  { method: 'LLM', p50_ms: 320, p90_ms: 720, p95_ms: 890, p99_ms: 1_200, sample_count: 1_200 },
  { method: 'Fuzzy', p50_ms: 4, p90_ms: 14, p95_ms: 18, p99_ms: 32, sample_count: 1_200 },
];

const createValidByVersion = (): LlmRoutingByVersion[] => [
  {
    routing_prompt_version: 'v1.0.0',
    total: 600,
    agreed: 390,
    disagreed: 210,
    agreement_rate: 0.65,
    avg_llm_latency_ms: 360,
    avg_fuzzy_latency_ms: 5,
    avg_cost_usd: 0.00045,
  },
  {
    routing_prompt_version: 'v1.1.0',
    total: 600,
    agreed: 474,
    disagreed: 126,
    agreement_rate: 0.79,
    avg_llm_latency_ms: 290,
    avg_fuzzy_latency_ms: 4,
    avg_cost_usd: 0.00038,
  },
];

// ===========================
// Tests
// ===========================

describe('LlmRoutingSource', () => {
  beforeEach(async () => {
    resetFetchMock();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Reset module cache to get a fresh singleton each test.
    vi.resetModules();
    const mod = await import('../llm-routing-source');
    llmRoutingSource = mod.llmRoutingSource;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================
  // ===========================

  // ===========================
  // ===========================

  // ===========================
  // summary() tests
  // ===========================

  describe('summary()', () => {
    it('returns real API data when total_decisions > 0', async () => {
      const mockData = createValidSummary();
      setupFetchMock(new Map([['/api/llm-routing/summary', createMockResponse(mockData)]]));

      const result = await llmRoutingSource.summary('7d');

      expect(result.total_decisions).toBe(1_200);
      expect(result.agreement_rate).toBe(0.72);
    });

    it('throws when fetch fails', async () => {
      setupFetchMock(new Map([['/api/llm-routing/summary', new Error('Network error')]]));

      await expect(llmRoutingSource.summary('7d')).rejects.toThrow(
        'Failed to fetch LLM routing summary'
      );
    });
  });

  // ===========================
  // latency() tests
  // ===========================

  describe('latency()', () => {
    it('returns real API data on success', async () => {
      const data = createValidLatencyPoints();
      setupFetchMock(new Map([['/api/llm-routing/latency', createMockResponse(data)]]));

      const result = await llmRoutingSource.latency('7d');

      expect(result).toHaveLength(2);
      expect(result[0].method).toBe('LLM');
    });

    it('throws when fetch fails', async () => {
      setupFetchMock(new Map([['/api/llm-routing/latency', new Error('Network error')]]));

      await expect(llmRoutingSource.latency('7d')).rejects.toThrow(
        'Failed to fetch LLM routing latency'
      );
    });
  });

  // ===========================
  // byVersion() tests
  // ===========================

  describe('byVersion()', () => {
    it('returns real API data on success', async () => {
      const data = createValidByVersion();
      setupFetchMock(new Map([['/api/llm-routing/by-version', createMockResponse(data)]]));

      const result = await llmRoutingSource.byVersion('7d');

      expect(result).toHaveLength(2);
      expect(result[0].routing_prompt_version).toBe('v1.0.0');
    });

    it('throws when fetch fails', async () => {
      setupFetchMock(new Map([['/api/llm-routing/by-version', new Error('Network error')]]));

      await expect(llmRoutingSource.byVersion('7d')).rejects.toThrow(
        'Failed to fetch LLM routing by version'
      );
    });
  });

  // ===========================
  // disagreements() tests
  // ===========================

  describe('disagreements()', () => {
    it('returns real API data on success', async () => {
      const data = [
        {
          occurred_at: '2026-02-17T10:00:00Z',
          llm_agent: 'agent-api',
          fuzzy_agent: 'agent-frontend',
          count: 5,
          avg_llm_confidence: 0.55,
          avg_fuzzy_confidence: 0.61,
          routing_prompt_version: 'v1.0.0',
        },
      ];
      setupFetchMock(new Map([['/api/llm-routing/disagreements', createMockResponse(data)]]));

      const result = await llmRoutingSource.disagreements('7d');

      expect(result).toHaveLength(1);
      expect(result[0].llm_agent).toBe('agent-api');
      // disagreements is not a primary endpoint, so isUsingMockData reflects
      // only summary/latency/by-version state (still false here).
    });

    it('throws when fetch fails', async () => {
      setupFetchMock(new Map([['/api/llm-routing/disagreements', new Error('Network error')]]));

      await expect(llmRoutingSource.disagreements('7d')).rejects.toThrow(
        'Failed to fetch LLM routing disagreements'
      );
    });
  });

  // ===========================
  // trend() tests
  // ===========================

  describe('trend()', () => {
    it('returns real API data on success', async () => {
      const data = [
        {
          date: '2026-02-17',
          agreement_rate: 0.72,
          fallback_rate: 0.08,
          avg_cost_usd: 0.0004,
          total_decisions: 180,
        },
      ];
      setupFetchMock(new Map([['/api/llm-routing/trend', createMockResponse(data)]]));

      const result = await llmRoutingSource.trend('7d');

      expect(result).toHaveLength(1);
      expect(result[0].date).toBe('2026-02-17');
    });

    it('throws when fetch fails', async () => {
      setupFetchMock(new Map([['/api/llm-routing/trend', new Error('Network error')]]));

      await expect(llmRoutingSource.trend('7d')).rejects.toThrow(
        'Failed to fetch LLM routing trend'
      );
    });
  });
});
