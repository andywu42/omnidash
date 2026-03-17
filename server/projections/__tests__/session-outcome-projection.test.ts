/**
 * SessionOutcomeProjection Tests (OMN-5184)
 *
 * Exercises the SessionOutcomeProjection class with mocked DB to verify:
 * 1. emptyPayload returns zeros
 * 2. ensureFreshForWindow rejects invalid windows
 * 3. ensureFreshForWindow returns empty when DB is null
 * 4. summary aggregation from DB rows
 * 5. trend bucketing
 * 6. empty-state behavior (no rows → zero counts, never NaN)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionOutcomeProjection } from '../session-outcome-projection';

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

describe('SessionOutcomeProjection', () => {
  let projection: SessionOutcomeProjection;

  beforeEach(() => {
    projection = new SessionOutcomeProjection();
    mockTryGet.mockReturnValue(null);
  });

  // --------------------------------------------------------------------------
  // 1. emptyPayload
  // --------------------------------------------------------------------------

  it('should return zeros from getSnapshot when DB is unavailable', () => {
    const snapshot = projection.getSnapshot();
    expect(snapshot.payload.summary.totalSessions).toBe(0);
    expect(snapshot.payload.summary.byOutcome.success).toBe(0);
    expect(snapshot.payload.summary.byOutcome.failed).toBe(0);
    expect(snapshot.payload.summary.byOutcome.abandoned).toBe(0);
    expect(snapshot.payload.summary.byOutcome.unknown).toBe(0);
    expect(snapshot.payload.summary.successRate).toBe(0);
    expect(snapshot.payload.trend).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 2. Invalid window rejection
  // --------------------------------------------------------------------------

  it('should return empty payload for invalid window', async () => {
    const result = await projection.ensureFreshForWindow('99d' as any);
    expect(result.summary.totalSessions).toBe(0);
    expect(result.trend).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 3. DB unavailable
  // --------------------------------------------------------------------------

  it('should return empty payload when DB is null', async () => {
    const result = await projection.ensureFreshForWindow('7d');
    expect(result.summary.totalSessions).toBe(0);
    expect(result.summary.successRate).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 4. Summary aggregation
  // --------------------------------------------------------------------------

  it('should compute summary from DB rows', async () => {
    const mockDb = buildMockDb([
      // summary query: outcome counts
      [
        { outcome: 'success', count: 10 },
        { outcome: 'failed', count: 3 },
        { outcome: 'abandoned', count: 2 },
        { outcome: 'unknown', count: 1 },
      ],
      // trend query: empty for this test
      [],
    ]);
    mockTryGet.mockReturnValue(mockDb);

    const result = await projection.ensureFreshForWindow('7d');
    expect(result.summary.totalSessions).toBe(16);
    expect(result.summary.byOutcome.success).toBe(10);
    expect(result.summary.byOutcome.failed).toBe(3);
    expect(result.summary.byOutcome.abandoned).toBe(2);
    expect(result.summary.byOutcome.unknown).toBe(1);
    // successRate = 10 / (10 + 3) ≈ 0.769
    expect(result.summary.successRate).toBeCloseTo(10 / 13, 3);
    expect(result.summary.window).toBe('7d');
  });

  // --------------------------------------------------------------------------
  // 5. Trend bucketing
  // --------------------------------------------------------------------------

  it('should assemble trend data from DB rows', async () => {
    const mockDb = buildMockDb([
      // summary query
      [{ outcome: 'success', count: 5 }],
      // trend query
      [
        {
          bucket: new Date('2026-03-16T00:00:00Z'),
          success: 3,
          failed: 1,
          abandoned: 0,
          unknown: 1,
        },
        {
          bucket: new Date('2026-03-17T00:00:00Z'),
          success: 2,
          failed: 0,
          abandoned: 0,
          unknown: 0,
        },
      ],
    ]);
    mockTryGet.mockReturnValue(mockDb);

    const result = await projection.ensureFreshForWindow('7d');
    expect(result.trend).toHaveLength(2);
    expect(result.trend[0].bucket).toBe('2026-03-16T00:00:00.000Z');
    expect(result.trend[0].success).toBe(3);
    expect(result.trend[0].failed).toBe(1);
    expect(result.granularity).toBe('day');
  });

  // --------------------------------------------------------------------------
  // 6. Empty-state behavior
  // --------------------------------------------------------------------------

  it('should return zero successRate when no success or failed rows', async () => {
    const mockDb = buildMockDb([
      // summary: only abandoned
      [{ outcome: 'abandoned', count: 5 }],
      // trend: empty
      [],
    ]);
    mockTryGet.mockReturnValue(mockDb);

    const result = await projection.ensureFreshForWindow('7d');
    expect(result.summary.successRate).toBe(0);
    expect(Number.isNaN(result.summary.successRate)).toBe(false);
  });

  it('should use hour granularity for 24h window', async () => {
    const mockDb = buildMockDb([[], []]);
    mockTryGet.mockReturnValue(mockDb);

    const result = await projection.ensureFreshForWindow('24h');
    expect(result.granularity).toBe('hour');
  });
});
