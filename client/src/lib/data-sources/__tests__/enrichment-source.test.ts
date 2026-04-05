/**
 * EnrichmentSource Tests (OMN-2280)
 *
 * Tests for the context enrichment data source with API-first + mock-fallback.
 * Follows the same pattern as cost-source.test.ts and effectiveness-source.test.ts.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createMockResponse, setupFetchMock, resetFetchMock } from '@/tests/utils/mock-fetch';
import type { EnrichmentSummary } from '@shared/enrichment-types';

// Re-import fresh for each test to reset singleton state
let enrichmentSource: (typeof import('../enrichment-source'))['enrichmentSource'];

// ===========================
// Test Fixtures
// ===========================

const createValidSummary = (overrides: Partial<EnrichmentSummary> = {}): EnrichmentSummary => ({
  total_enrichments: 4_820,
  hit_rate: 0.73,
  net_tokens_saved: 128_400,
  p50_latency_ms: 42,
  p95_latency_ms: 185,
  avg_similarity_score: 0.81,
  inflation_alert_count: 3,
  error_rate: 0.01,
  counts: { hits: 3_519, misses: 1_108, errors: 48, inflated: 145 },
  ...overrides,
});

// ===========================
// Tests
// ===========================

describe('EnrichmentSource', () => {
  beforeEach(async () => {
    resetFetchMock();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Reset module cache to get a fresh singleton each test
    vi.resetModules();
    const mod = await import('../enrichment-source');
    enrichmentSource = mod.enrichmentSource;
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
    it('returns real API data when total_enrichments > 0', async () => {
      const mockData = createValidSummary();
      setupFetchMock(new Map([['/api/enrichment/summary', createMockResponse(mockData)]]));

      const result = await enrichmentSource.summary('7d');

      expect(result.total_enrichments).toBe(4_820);
      expect(result.hit_rate).toBe(0.73);
    });
  });
});
