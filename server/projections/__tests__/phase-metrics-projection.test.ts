/**
 * PhaseMetricsProjection Tests (OMN-5184)
 *
 * Exercises the PhaseMetricsProjection class with mocked DB to verify:
 * 1. emptyPayload returns zeros
 * 2. ensureFreshForWindow rejects invalid windows
 * 3. ensureFreshForWindow returns empty when DB is null
 * 4. summary aggregation from DB rows
 * 5. by-phase grouping and rate calculation
 * 6. empty-state behavior (no rows → zero counts, never NaN)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhaseMetricsProjection } from '../phase-metrics-projection';

// ============================================================================
// Mock storage
// ============================================================================

const mockTryGet = vi.fn(() => null);

vi.mock('../../storage', () => ({
  tryGetIntelligenceDb: (...args: unknown[]) => mockTryGet(...args),
  getIntelligenceDb: vi.fn(() => {
    throw new Error('not configured');
  }),
  isDatabaseConfigured: vi.fn(() => false),
  getDatabaseError: vi.fn(() => 'mocked'),
}));

// ============================================================================
// Mock DB builder
// ============================================================================

function buildMockDb(results: Record<string, unknown>[][]) {
  let callIndex = 0;
  return {
    execute: vi.fn(() => {
      const rows = results[callIndex] ?? [];
      callIndex++;
      return Promise.resolve({ rows });
    }),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('PhaseMetricsProjection', () => {
  let projection: PhaseMetricsProjection;

  beforeEach(() => {
    projection = new PhaseMetricsProjection();
    mockTryGet.mockReturnValue(null);
  });

  // --------------------------------------------------------------------------
  // 1. emptyPayload
  // --------------------------------------------------------------------------

  it('should return zeros from getSnapshot when DB is unavailable', () => {
    const snapshot = projection.getSnapshot();
    expect(snapshot.payload.summary.totalPhaseRuns).toBe(0);
    expect(snapshot.payload.summary.avgDurationMs).toBe(0);
    expect(snapshot.payload.summary.byStatus.success).toBe(0);
    expect(snapshot.payload.summary.byStatus.failure).toBe(0);
    expect(snapshot.payload.summary.byStatus.skipped).toBe(0);
    expect(snapshot.payload.byPhase).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 2. Invalid window rejection
  // --------------------------------------------------------------------------

  it('should return empty payload for invalid window', async () => {
    const result = await projection.ensureFreshForWindow('99d' as any);
    expect(result.summary.totalPhaseRuns).toBe(0);
    expect(result.byPhase).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 3. DB unavailable
  // --------------------------------------------------------------------------

  it('should return empty payload when DB is null', async () => {
    const result = await projection.ensureFreshForWindow('7d');
    expect(result.summary.totalPhaseRuns).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 4. Summary aggregation
  // --------------------------------------------------------------------------

  it('should compute summary from DB rows', async () => {
    const mockDb = buildMockDb([
      // summary query
      [
        {
          total: 25,
          avg_duration_ms: 1234.5,
          success_count: 18,
          failure_count: 5,
          skipped_count: 2,
        },
      ],
      // by-phase query
      [],
    ]);
    mockTryGet.mockReturnValue(mockDb);

    const result = await projection.ensureFreshForWindow('7d');
    expect(result.summary.totalPhaseRuns).toBe(25);
    expect(result.summary.avgDurationMs).toBeCloseTo(1234.5, 1);
    expect(result.summary.byStatus.success).toBe(18);
    expect(result.summary.byStatus.failure).toBe(5);
    expect(result.summary.byStatus.skipped).toBe(2);
    expect(result.summary.window).toBe('7d');
  });

  // --------------------------------------------------------------------------
  // 5. by-phase grouping and rate calculation
  // --------------------------------------------------------------------------

  it('should compute by-phase metrics with success rate', async () => {
    const mockDb = buildMockDb([
      // summary query
      [{ total: 30, avg_duration_ms: 1000, success_count: 20, failure_count: 8, skipped_count: 2 }],
      // by-phase query
      [
        { phase: 'implement', count: 15, avg_duration_ms: 2000, success_count: 12, failure_count: 3 },
        { phase: 'local_review', count: 10, avg_duration_ms: 500, success_count: 8, failure_count: 2 },
        { phase: 'create_pr', count: 5, avg_duration_ms: 300, success_count: 0, failure_count: 0 },
      ],
    ]);
    mockTryGet.mockReturnValue(mockDb);

    const result = await projection.ensureFreshForWindow('7d');
    expect(result.byPhase).toHaveLength(3);

    expect(result.byPhase[0].phase).toBe('implement');
    expect(result.byPhase[0].count).toBe(15);
    expect(result.byPhase[0].avgDurationMs).toBe(2000);
    // successRate = 12 / (12 + 3) = 0.8
    expect(result.byPhase[0].successRate).toBeCloseTo(0.8, 3);

    expect(result.byPhase[1].phase).toBe('local_review');
    // successRate = 8 / (8 + 2) = 0.8
    expect(result.byPhase[1].successRate).toBeCloseTo(0.8, 3);

    // create_pr: 0 success + 0 failure → successRate = 0
    expect(result.byPhase[2].successRate).toBe(0);
    expect(Number.isNaN(result.byPhase[2].successRate)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 6. Empty-state behavior
  // --------------------------------------------------------------------------

  it('should handle empty DB with zero counts', async () => {
    const mockDb = buildMockDb([
      // summary: all zeros
      [{ total: 0, avg_duration_ms: 0, success_count: 0, failure_count: 0, skipped_count: 0 }],
      // by-phase: empty
      [],
    ]);
    mockTryGet.mockReturnValue(mockDb);

    const result = await projection.ensureFreshForWindow('30d');
    expect(result.summary.totalPhaseRuns).toBe(0);
    expect(result.summary.avgDurationMs).toBe(0);
    expect(Number.isNaN(result.summary.avgDurationMs)).toBe(false);
    expect(result.byPhase).toEqual([]);
    expect(result.summary.window).toBe('30d');
  });
});
