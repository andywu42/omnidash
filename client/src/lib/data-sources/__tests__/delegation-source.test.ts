/**
 * DelegationSource Tests (OMN-2284)
 *
 * Tests for the delegation metrics data source with API-first behavior.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createMockResponse, setupFetchMock, resetFetchMock } from '@/tests/utils/mock-fetch';
import type { DelegationSummary } from '@shared/delegation-types';

// Re-import the singleton fresh per test so state does not leak between cases.
let delegationSource: (typeof import('../delegation-source'))['delegationSource'];

// ===========================
// Test Fixtures
// ===========================

const createValidSummary = (overrides: Partial<DelegationSummary> = {}): DelegationSummary => ({
  total_delegations: 2_940,
  delegation_rate: 0.68,
  quality_gate_pass_rate: 0.83,
  total_cost_savings_usd: 7.056,
  avg_cost_savings_usd: 0.0024,
  shadow_divergence_rate: 0.14,
  total_shadow_comparisons: 1_323,
  avg_delegation_latency_ms: 42,
  counts: {
    total: 2_940,
    quality_gate_passed: 2_440,
    quality_gate_failed: 500,
    shadow_diverged: 185,
    shadow_agreed: 1_138,
  },
  quality_gate_trend: [
    { date: '2026-02-12', value: 0.79 },
    { date: '2026-02-13', value: 0.81 },
    { date: '2026-02-14', value: 0.83 },
  ],
  ...overrides,
});

// ===========================
// Tests
// ===========================

describe('DelegationSource', () => {
  beforeEach(async () => {
    resetFetchMock();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const mod = await import('../delegation-source');
    delegationSource = mod.delegationSource;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('summary()', () => {
    it('returns real API data on success', async () => {
      const mockData = createValidSummary();
      setupFetchMock(new Map([['/api/delegation/summary', createMockResponse(mockData)]]));

      const result = await delegationSource.summary('7d');

      expect(result.total_delegations).toBe(2_940);
      expect(result.quality_gate_pass_rate).toBe(0.83);
    });

    it('throws on HTTP error', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/delegation/summary',
            createMockResponse(null, { status: 503, statusText: 'Service Unavailable' }),
          ],
        ])
      );

      await expect(delegationSource.summary('7d')).rejects.toThrow();
    });

    it('throws on network error', async () => {
      setupFetchMock(new Map([['/api/delegation/summary', new Error('Network error')]]));

      await expect(delegationSource.summary('7d')).rejects.toThrow();
    });
  });

  describe('byTaskType()', () => {
    it('returns real API data on success', async () => {
      const data = [
        {
          task_type: 'code-review',
          total: 1840,
          quality_gate_passed: 1585,
          quality_gate_pass_rate: 0.861,
          total_cost_savings_usd: 5.704,
          avg_cost_savings_usd: 0.0031,
          avg_latency_ms: 38,
          shadow_divergences: 64,
        },
      ];
      setupFetchMock(new Map([['/api/delegation/by-task-type', createMockResponse(data)]]));

      const result = await delegationSource.byTaskType('7d');

      expect(result).toHaveLength(1);
      expect(result[0].task_type).toBe('code-review');
    });

    it('throws on network error', async () => {
      setupFetchMock(new Map([['/api/delegation/by-task-type', new Error('Connection refused')]]));

      await expect(delegationSource.byTaskType('7d')).rejects.toThrow();
    });
  });

  describe('costSavings()', () => {
    it('returns real API data on success', async () => {
      const data = [
        {
          date: '2026-02-17',
          cost_savings_usd: 1.008,
          total_cost_usd: 1.596,
          total_delegations: 420,
          avg_savings_usd: 0.0024,
        },
      ];
      setupFetchMock(new Map([['/api/delegation/cost-savings', createMockResponse(data)]]));

      const result = await delegationSource.costSavings('7d');

      expect(result).toHaveLength(1);
      expect(result[0].date).toBe('2026-02-17');
    });

    it('throws on network error', async () => {
      setupFetchMock(new Map([['/api/delegation/cost-savings', new Error('Network error')]]));

      await expect(delegationSource.costSavings('7d')).rejects.toThrow();
    });
  });

  describe('qualityGates()', () => {
    it('returns real API data on success', async () => {
      const data = [
        { date: '2026-02-17', pass_rate: 0.83, total_checked: 420, passed: 349, failed: 71 },
      ];
      setupFetchMock(new Map([['/api/delegation/quality-gates', createMockResponse(data)]]));

      const result = await delegationSource.qualityGates('7d');

      expect(result).toHaveLength(1);
      expect(result[0].pass_rate).toBe(0.83);
    });

    it('throws on HTTP error', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/delegation/quality-gates',
            createMockResponse(null, { status: 502, statusText: 'Bad Gateway' }),
          ],
        ])
      );

      await expect(delegationSource.qualityGates('7d')).rejects.toThrow();
    });
  });

  describe('shadowDivergence()', () => {
    it('returns real API data on success', async () => {
      const data = [
        {
          occurred_at: '2026-02-17T10:00:00Z',
          primary_agent: 'python-fastapi-expert',
          shadow_agent: 'testing',
          task_type: 'code-review',
          count: 128,
          avg_divergence_score: 0.34,
          avg_primary_latency_ms: 88,
          avg_shadow_latency_ms: 142,
        },
      ];
      setupFetchMock(new Map([['/api/delegation/shadow-divergence', createMockResponse(data)]]));

      const result = await delegationSource.shadowDivergence('7d');

      expect(result).toHaveLength(1);
      expect(result[0].primary_agent).toBe('python-fastapi-expert');
    });

    it('throws on network error', async () => {
      setupFetchMock(new Map([['/api/delegation/shadow-divergence', new Error('Network error')]]));

      await expect(delegationSource.shadowDivergence('7d')).rejects.toThrow();
    });
  });

  describe('trend()', () => {
    it('returns real API data on success', async () => {
      const data = [
        {
          date: '2026-02-17',
          quality_gate_pass_rate: 0.83,
          shadow_divergence_rate: 0.14,
          cost_savings_usd: 1.008,
          total_delegations: 420,
        },
      ];
      setupFetchMock(new Map([['/api/delegation/trend', createMockResponse(data)]]));

      const result = await delegationSource.trend('7d');

      expect(result).toHaveLength(1);
      expect(result[0].date).toBe('2026-02-17');
    });

    it('throws on network error', async () => {
      setupFetchMock(new Map([['/api/delegation/trend', new Error('Network error')]]));

      await expect(delegationSource.trend('7d')).rejects.toThrow();
    });
  });
});
