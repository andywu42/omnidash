import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createMockResponse,
  setupFetchMock,
  resetFetchMock,
} from '../../../tests/utils/mock-fetch';
import type {
  EffectivenessSummary,
  LatencyDetails,
  ABComparison,
  UtilizationDetails,
  EffectivenessTrendPoint,
} from '@shared/effectiveness-types';

// Re-import effectivenessSource fresh for each test via dynamic import
// to reset singleton state
let effectivenessSource: (typeof import('../effectiveness-source'))['effectivenessSource'];

// ===========================
// Test Fixtures
// ===========================

const createValidSummary = (
  overrides: Partial<EffectivenessSummary> = {}
): EffectivenessSummary => ({
  injection_rate: 0.82,
  injection_rate_target: 0.8,
  median_utilization: 0.65,
  utilization_target: 0.6,
  mean_agent_accuracy: 0.78,
  accuracy_target: 0.8,
  latency_delta_p95_ms: 120,
  latency_delta_target_ms: 150,
  total_sessions: 1247,
  treatment_sessions: 843,
  control_sessions: 404,
  throttle_active: false,
  throttle_reason: null,
  ...overrides,
});

const createValidLatency = (): LatencyDetails => ({
  breakdowns: [
    {
      cohort: 'treatment',
      p50_ms: 245,
      p95_ms: 520,
      p99_ms: 890,
      routing_avg_ms: 45,
      retrieval_avg_ms: 120,
      injection_avg_ms: 80,
      sample_count: 4320,
    },
    {
      cohort: 'control',
      p50_ms: 180,
      p95_ms: 400,
      p99_ms: 720,
      routing_avg_ms: 42,
      retrieval_avg_ms: 0,
      injection_avg_ms: 0,
      sample_count: 2180,
    },
  ],
  trend: [],
  cache: { hit_rate: 0.34, total_hits: 1470, total_misses: 2850 },
});

const createValidAB = (): ABComparison => ({
  cohorts: [
    {
      cohort: 'treatment',
      session_count: 843,
      median_utilization_pct: 65.2,
      avg_accuracy_pct: 78.4,
      success_rate_pct: 87.3,
      avg_latency_ms: 312,
    },
    {
      cohort: 'control',
      session_count: 404,
      median_utilization_pct: 0,
      avg_accuracy_pct: 0,
      success_rate_pct: 81.6,
      avg_latency_ms: 195,
    },
  ],
  total_sessions: 1247,
});

// ===========================
// Tests
// ===========================

describe('EffectivenessSource', () => {
  beforeEach(async () => {
    resetFetchMock();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Reset module cache to get fresh singleton each test
    vi.resetModules();
    const mod = await import('../effectiveness-source');
    effectivenessSource = mod.effectivenessSource;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================
  // summary() tests
  // ===========================

  describe('summary()', () => {
    it('returns API data when total_sessions > 0', async () => {
      const mockData = createValidSummary();
      setupFetchMock(new Map([['/api/effectiveness/summary', createMockResponse(mockData)]]));

      const result = await effectivenessSource.summary();

      expect(result.total_sessions).toBe(1247);
      expect(result.injection_rate).toBe(0.82);
    });

    it('throws on HTTP error when fallback disabled', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/effectiveness/summary',
            createMockResponse(null, { status: 500, statusText: 'Error' }),
          ],
        ])
      );

      await expect(effectivenessSource.summary()).rejects.toThrow('HTTP 500');
    });
  });

  // ===========================
  // latencyDetails() tests — covers the data.breakdowns bug fix
  // ===========================

  describe('latencyDetails()', () => {
    it('returns API data when breakdowns are present', async () => {
      const mockData = createValidLatency();
      setupFetchMock(new Map([['/api/effectiveness/latency', createMockResponse(mockData)]]));

      const result = await effectivenessSource.latencyDetails();

      expect(result.breakdowns).toHaveLength(2);
      expect(result.breakdowns[0].cohort).toBe('treatment');
    });

    it('does NOT fall back when breakdowns has data', async () => {
      const realData = createValidLatency();
      setupFetchMock(new Map([['/api/effectiveness/latency', createMockResponse(realData)]]));

      const result = await effectivenessSource.latencyDetails();

      // Should return the real API data, not mock
      expect(result.breakdowns[0].p50_ms).toBe(245);
      expect(result.cache.hit_rate).toBe(0.34);
    });

    // ===========================
    // abComparison() tests — covers the data.cohorts bug fix
    // ===========================

    describe('abComparison()', () => {
      it('returns API data when cohorts are present', async () => {
        const mockData = createValidAB();
        setupFetchMock(new Map([['/api/effectiveness/ab', createMockResponse(mockData)]]));

        const result = await effectivenessSource.abComparison();

        expect(result.cohorts).toHaveLength(2);
        expect(result.total_sessions).toBe(1247);
      });

      it('does NOT fall back when cohorts has data', async () => {
        const realData = createValidAB();
        setupFetchMock(new Map([['/api/effectiveness/ab', createMockResponse(realData)]]));

        const result = await effectivenessSource.abComparison();

        // Should return real API data
        expect(result.cohorts[0].session_count).toBe(843);
        expect(result.cohorts[1].cohort).toBe('control');
      });

      // ===========================
      // utilizationDetails() tests
      // ===========================

      describe('utilizationDetails()', () => {
        it('returns API data when histogram is present', async () => {
          const mockData: UtilizationDetails = {
            histogram: [{ range_start: 0, range_end: 0.1, count: 10 }],
            by_method: [],
            pattern_rates: [],
            low_utilization_sessions: [],
          };
          setupFetchMock(
            new Map([['/api/effectiveness/utilization', createMockResponse(mockData)]])
          );

          const result = await effectivenessSource.utilizationDetails();

          expect(result.histogram).toHaveLength(1);
        });

        // ===========================
        // trend() tests
        // ===========================

        describe('trend()', () => {
          it('returns API data when array is non-empty', async () => {
            const mockData: EffectivenessTrendPoint[] = [
              {
                date: '2026-01-01',
                injection_rate: 0.8,
                avg_utilization: 0.6,
                avg_accuracy: 0.75,
                avg_latency_delta_ms: 100,
              },
            ];
            setupFetchMock(new Map([['/api/effectiveness/trend', createMockResponse(mockData)]]));

            const result = await effectivenessSource.trend();

            expect(result).toHaveLength(1);
            expect(result[0].injection_rate).toBe(0.8);
          });

          // ===========================
          // ===========================
        });
      });
    });
  });
});
