/**
 * LlmRoutingProjection.queryByOmninodeMode tests (OMN-3450)
 *
 * Exercises queryByOmninodeMode() with a mocked DB to verify:
 *   1. Returns empty array when no rows
 *   2. Maps DB row fields to LlmRoutingByOmninodeMode shape
 *   3. Returns both true and false rows when data exists for both paths
 *   4. Handles null/zero values defensively
 *   5. Boolean coercion works for both true and false
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmRoutingProjection } from '../llm-routing-projection';

// ============================================================================
// Mock storage (prevent real DB connections on import)
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
// Helpers
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

describe('LlmRoutingProjection.queryByOmninodeMode', () => {
  let projection: LlmRoutingProjection;

  beforeEach(() => {
    projection = new LlmRoutingProjection();
  });

  it('returns empty array when no rows', async () => {
    const db = buildMockDb([[]]);
    const result = await projection.queryByOmninodeMode(db as never, '7d');
    expect(result).toEqual([]);
  });

  it('maps a single ONEX path row correctly', async () => {
    const db = buildMockDb([
      [
        {
          omninode_enabled: true,
          total: 120,
          agreement_rate: 0.75,
          avg_cost_usd: 0.0005,
          avg_total_tokens: 1200,
          avg_llm_latency_ms: 350,
        },
      ],
    ]);
    const result = await projection.queryByOmninodeMode(db as never, '7d');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      omninode_enabled: true,
      total: 120,
      agreement_rate: 0.75,
      avg_cost_usd: 0.0005,
      avg_total_tokens: 1200,
      avg_llm_latency_ms: 350,
    });
  });

  it('returns both ONEX and legacy path rows', async () => {
    const db = buildMockDb([
      [
        {
          omninode_enabled: true,
          total: 200,
          agreement_rate: 0.8,
          avg_cost_usd: 0.0004,
          avg_total_tokens: 1500,
          avg_llm_latency_ms: 320,
        },
        {
          omninode_enabled: false,
          total: 80,
          agreement_rate: 0.55,
          avg_cost_usd: 0.0006,
          avg_total_tokens: 900,
          avg_llm_latency_ms: 410,
        },
      ],
    ]);
    const result = await projection.queryByOmninodeMode(db as never, '7d');
    expect(result).toHaveLength(2);

    const onexRow = result.find((r) => r.omninode_enabled === true);
    const legacyRow = result.find((r) => r.omninode_enabled === false);

    expect(onexRow).toBeDefined();
    expect(onexRow?.total).toBe(200);
    expect(onexRow?.agreement_rate).toBe(0.8);

    expect(legacyRow).toBeDefined();
    expect(legacyRow?.total).toBe(80);
    expect(legacyRow?.agreement_rate).toBe(0.55);
  });

  it('handles null/zero values defensively', async () => {
    const db = buildMockDb([
      [
        {
          omninode_enabled: false,
          total: null,
          agreement_rate: null,
          avg_cost_usd: null,
          avg_total_tokens: null,
          avg_llm_latency_ms: null,
        },
      ],
    ]);
    const result = await projection.queryByOmninodeMode(db as never, '7d');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      omninode_enabled: false,
      total: 0,
      agreement_rate: 0,
      avg_cost_usd: 0,
      avg_total_tokens: 0,
      avg_llm_latency_ms: 0,
    });
  });

  it('coerces DB boolean values correctly', async () => {
    const db = buildMockDb([
      [
        {
          omninode_enabled: 1,
          total: 10,
          agreement_rate: 0.9,
          avg_cost_usd: 0,
          avg_total_tokens: 0,
          avg_llm_latency_ms: 0,
        },
        {
          omninode_enabled: 0,
          total: 5,
          agreement_rate: 0.4,
          avg_cost_usd: 0,
          avg_total_tokens: 0,
          avg_llm_latency_ms: 0,
        },
      ],
    ]);
    const result = await projection.queryByOmninodeMode(db as never, '7d');
    expect(result[0].omninode_enabled).toBe(true);
    expect(result[1].omninode_enabled).toBe(false);
  });

  it('works with 24h and 30d windows', async () => {
    for (const window of ['24h', '30d'] as const) {
      const db = buildMockDb([
        [
          {
            omninode_enabled: true,
            total: 50,
            agreement_rate: 0.7,
            avg_cost_usd: 0.0003,
            avg_total_tokens: 800,
            avg_llm_latency_ms: 280,
          },
        ],
      ]);
      const result = await projection.queryByOmninodeMode(db as never, window);
      expect(result).toHaveLength(1);
      expect(result[0].omninode_enabled).toBe(true);
    }
  });
});
