/**
 * BaselinesSource Tests (OMN-2156)
 *
 * Tests for the baselines/ROI data source with API-first + mock-fallback.
 * Follows the same pattern as effectiveness-source.test.ts.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createMockResponse,
  setupFetchMock,
  resetFetchMock,
} from '../../../tests/utils/mock-fetch';
import type {
  BaselinesSummary,
  PatternComparison,
  ROITrendPoint,
  RecommendationBreakdown,
} from '@shared/baselines-types';

// Re-import fresh for each test to reset singleton state
let baselinesSource: (typeof import('../baselines-source'))['baselinesSource'];

// ===========================
// Test Fixtures
// ===========================

const createValidSummary = (overrides: Partial<BaselinesSummary> = {}): BaselinesSummary => ({
  total_comparisons: 12,
  promote_count: 5,
  shadow_count: 3,
  suppress_count: 2,
  fork_count: 2,
  avg_cost_savings: 0.24,
  avg_outcome_improvement: 0.12,
  total_token_savings: 34_800,
  total_time_savings_ms: 8_600,
  ...overrides,
});

const createValidComparisons = (): PatternComparison[] => [
  {
    pattern_id: 'pat-0001',
    pattern_name: 'Error Retry with Backoff',
    sample_size: 150,
    window_start: '2026-02-01T00:00:00Z',
    window_end: '2026-02-08T00:00:00Z',
    token_delta: {
      label: 'Token Usage',
      baseline: 12000,
      candidate: 8400,
      delta: -3600,
      direction: 'lower_is_better',
      unit: 'tokens',
    },
    time_delta: {
      label: 'Execution Time',
      baseline: 3200,
      candidate: 2240,
      delta: -960,
      direction: 'lower_is_better',
      unit: 'ms',
    },
    retry_delta: {
      label: 'Retry Count',
      baseline: 2.4,
      candidate: 1.7,
      delta: -0.7,
      direction: 'lower_is_better',
      unit: 'retries',
    },
    test_pass_rate_delta: {
      label: 'Test Pass Rate',
      baseline: 0.82,
      candidate: 0.943,
      delta: 0.123,
      direction: 'higher_is_better',
      unit: '%',
    },
    review_iteration_delta: {
      label: 'Review Iterations',
      baseline: 2.8,
      candidate: 2.0,
      delta: -0.8,
      direction: 'lower_is_better',
      unit: 'iterations',
    },
    recommendation: 'promote',
    confidence: 'high',
    rationale: 'Candidate shows consistent cost reduction.',
  },
];

const createValidBreakdown = (): RecommendationBreakdown[] => [
  { action: 'promote', count: 5, avg_confidence: 0.88 },
  { action: 'shadow', count: 3, avg_confidence: 0.62 },
];

const createValidTrend = (): ROITrendPoint[] => [
  {
    date: '2026-02-01',
    avg_cost_savings: 0.2,
    avg_outcome_improvement: 0.1,
    comparisons_evaluated: 10,
  },
];

// ===========================
// Tests
// ===========================

describe('BaselinesSource', () => {
  beforeEach(async () => {
    resetFetchMock();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const mod = await import('../baselines-source');
    baselinesSource = mod.baselinesSource;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================
  // summary() tests
  // ===========================

  describe('summary()', () => {
    it('returns API data when total_comparisons > 0', async () => {
      const mockData = createValidSummary();
      setupFetchMock(new Map([['/api/baselines/summary', createMockResponse(mockData)]]));

      const result = await baselinesSource.summary();

      expect(result.total_comparisons).toBe(12);
      expect(result.avg_cost_savings).toBe(0.24);
    });

    it('returns empty API data as-is when total_comparisons is 0', async () => {
      const emptyData = createValidSummary({ total_comparisons: 0 });
      setupFetchMock(new Map([['/api/baselines/summary', createMockResponse(emptyData)]]));

      const result = await baselinesSource.summary();

      expect(result.total_comparisons).toBe(0);
    });

    it('throws on HTTP error', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/baselines/summary',
            createMockResponse(null, { status: 500, statusText: 'Error' }),
          ],
        ])
      );

      await expect(baselinesSource.summary()).rejects.toThrow();
    });
  });

  // ===========================
  // comparisons() tests
  // ===========================

  describe('comparisons()', () => {
    it('returns API data when array is non-empty', async () => {
      const mockData = createValidComparisons();
      setupFetchMock(new Map([['/api/baselines/comparisons', createMockResponse(mockData)]]));

      const result = await baselinesSource.comparisons();

      expect(result).toHaveLength(1);
      expect(result[0].pattern_name).toBe('Error Retry with Backoff');
    });

    it('returns empty array when API returns empty', async () => {
      setupFetchMock(new Map([['/api/baselines/comparisons', createMockResponse([])]]));

      const result = await baselinesSource.comparisons();

      expect(result).toHaveLength(0);
    });

    it('throws on network error', async () => {
      setupFetchMock(new Map([['/api/baselines/comparisons', new Error('Connection refused')]]));

      await expect(baselinesSource.comparisons()).rejects.toThrow();
    });
  });

  // ===========================
  // trend() tests
  // ===========================

  describe('trend()', () => {
    it('returns API data when array is non-empty', async () => {
      const mockData = createValidTrend();
      setupFetchMock(new Map([['/api/baselines/trend', createMockResponse(mockData)]]));

      const result = await baselinesSource.trend();

      expect(result).toHaveLength(1);
      expect(result[0].avg_cost_savings).toBe(0.2);
    });

    it('returns empty array when API returns empty', async () => {
      setupFetchMock(new Map([['/api/baselines/trend', createMockResponse([])]]));

      const result = await baselinesSource.trend();

      expect(result).toHaveLength(0);
    });
  });

  // ===========================
  // breakdown() tests
  // ===========================

  describe('breakdown()', () => {
    it('returns API data when array is non-empty', async () => {
      const mockData = createValidBreakdown();
      setupFetchMock(new Map([['/api/baselines/breakdown', createMockResponse(mockData)]]));

      const result = await baselinesSource.breakdown();

      expect(result).toHaveLength(2);
      expect(result[0].action).toBe('promote');
    });

    it('returns empty array when API returns empty', async () => {
      setupFetchMock(new Map([['/api/baselines/breakdown', createMockResponse([])]]));

      const result = await baselinesSource.breakdown();

      expect(result).toHaveLength(0);
    });

    it('throws on network error', async () => {
      setupFetchMock(new Map([['/api/baselines/breakdown', new Error('Network error')]]));

      await expect(baselinesSource.breakdown()).rejects.toThrow();
    });
  });
});
