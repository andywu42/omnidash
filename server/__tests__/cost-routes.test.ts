/**
 * Cost Routes Tests (OMN-2300)
 *
 * Exercises the /api/costs endpoints (summary, trend, by-model, by-repo,
 * by-pattern, token-usage, alerts) by mocking the CostMetricsProjection view.
 *
 * The routes access data through projectionService.getView() rather than
 * direct DB queries. Tests mock the projection's ensureFresh() and
 * ensureFreshForWindow() to return specific payloads without hitting the DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type { CostMetricsPayload } from '../projections/cost-metrics-projection';

// ---------------------------------------------------------------------------
// Mock projection service
// ---------------------------------------------------------------------------

// vi.hoisted() ensures this runs before vi.mock() factory execution
const { mockEnsureFresh, mockEnsureFreshForWindow, mockForceRefresh, mockBudgetEnsureFresh } =
  vi.hoisted(() => ({
    mockEnsureFresh: vi.fn(),
    mockEnsureFreshForWindow: vi.fn(),
    // Separate fn so accidental calls to forceRefresh() are detectable (not aliased to ensureFresh).
    mockForceRefresh: vi.fn(),
    mockBudgetEnsureFresh: vi.fn(),
  }));

vi.mock('../projection-bootstrap', () => {
  const mockView = {
    viewId: 'cost-metrics',
    ensureFresh: mockEnsureFresh,
    ensureFreshForWindow: mockEnsureFreshForWindow,
    forceRefresh: mockForceRefresh,
    getSnapshot: vi.fn(),
    getEventsSince: vi.fn(),
    applyEvent: vi.fn(() => false),
    reset: vi.fn(),
    // Public query methods (for completeness)
    querySummary: vi.fn(),
    queryTrend: vi.fn(),
    queryTrendForModel: vi.fn(),
    queryByModel: vi.fn(),
    queryByRepo: vi.fn(),
    queryByPattern: vi.fn(),
    queryTokenUsage: vi.fn(),
  };

  return {
    projectionService: {
      getView: vi.fn((viewId: string) => {
        if (viewId === 'cost-metrics') return mockView;
        return undefined;
      }),
      viewIds: ['cost-metrics'],
      registerView: vi.fn(),
      unregisterView: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    },
    eventBusProjection: { viewId: 'event-bus' },
    extractionMetricsProjection: { viewId: 'extraction-metrics' },
    effectivenessMetricsProjection: { viewId: 'effectiveness-metrics' },
    costMetricsProjection: mockView,
    pipelineBudgetProjection: {
      viewId: 'pipeline-budget',
      ensureFresh: mockBudgetEnsureFresh,
    },
    wireProjectionSources: vi.fn(() => () => {}),
  };
});

// Also mock storage to prevent DB connection attempts during import
vi.mock('../storage', () => ({
  tryGetIntelligenceDb: vi.fn(() => null),
  getIntelligenceDb: vi.fn(() => {
    throw new Error('not configured');
  }),
  isDatabaseConfigured: vi.fn(() => false),
  getDatabaseError: vi.fn(() => 'mocked'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyPayload(): CostMetricsPayload {
  return {
    summary: {
      total_cost_usd: 0,
      reported_cost_usd: 0,
      estimated_cost_usd: 0,
      reported_coverage_pct: 0,
      total_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      session_count: 0,
      model_count: 0,
      avg_cost_per_session: 0,
      cost_change_pct: 0,
      active_alerts: 0,
    },
    trend: [],
    byModel: [],
    byRepo: [],
    byPattern: [],
    tokenUsage: [],
  };
}

function makePayload(overrides: Partial<CostMetricsPayload> = {}): CostMetricsPayload {
  return { ...emptyPayload(), ...overrides };
}

// ---------------------------------------------------------------------------
// Import routes AFTER mocks are set up
// ---------------------------------------------------------------------------

import costRoutes from '../cost-routes';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Cost Routes', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureFresh.mockResolvedValue(emptyPayload());
    mockEnsureFreshForWindow.mockResolvedValue(emptyPayload());
    mockBudgetEnsureFresh.mockResolvedValue({ recent: [], summary: { total_cap_hits: 0 } });

    app = express();
    app.use(express.json());
    app.use('/api/costs', costRoutes);
  });

  // =========================================================================
  // GET /api/costs/summary
  // =========================================================================

  describe('GET /api/costs/summary', () => {
    it('should return empty summary when view returns empty payload', async () => {
      const res = await request(app).get('/api/costs/summary').expect(200);

      expect(res.body.total_cost_usd).toBe(0);
      expect(res.body.reported_cost_usd).toBe(0);
      expect(res.body.estimated_cost_usd).toBe(0);
      expect(res.body.session_count).toBe(0);
      expect(res.body.model_count).toBe(0);
      expect(res.body.active_alerts).toBe(0);
    });

    it('should return summary data from projection', async () => {
      mockEnsureFresh.mockResolvedValue(
        makePayload({
          summary: {
            total_cost_usd: 42.5,
            reported_cost_usd: 38.0,
            estimated_cost_usd: 4.5,
            reported_coverage_pct: 89.4,
            total_tokens: 500000,
            prompt_tokens: 300000,
            completion_tokens: 200000,
            session_count: 120,
            model_count: 3,
            avg_cost_per_session: 0.354,
            cost_change_pct: -12.5,
            active_alerts: 0,
          },
        })
      );
      // active_alerts is now derived from pipeline budget projection
      mockBudgetEnsureFresh.mockResolvedValue({ recent: [], summary: { total_cap_hits: 1 } });

      const res = await request(app).get('/api/costs/summary').expect(200);

      expect(res.body.total_cost_usd).toBeCloseTo(42.5);
      expect(res.body.reported_cost_usd).toBeCloseTo(38.0);
      expect(res.body.session_count).toBe(120);
      expect(res.body.model_count).toBe(3);
      expect(res.body.active_alerts).toBe(1);
      expect(res.body.cost_change_pct).toBeCloseTo(-12.5);
    });

    it('should use ensureFreshForWindow for window=24h', async () => {
      mockEnsureFreshForWindow.mockResolvedValue(
        makePayload({
          summary: {
            total_cost_usd: 5.0,
            reported_cost_usd: 5.0,
            estimated_cost_usd: 0,
            reported_coverage_pct: 100,
            total_tokens: 50000,
            prompt_tokens: 30000,
            completion_tokens: 20000,
            session_count: 10,
            model_count: 2,
            avg_cost_per_session: 0.5,
            cost_change_pct: 0,
            active_alerts: 0,
          },
        })
      );

      const res = await request(app).get('/api/costs/summary?window=24h').expect(200);

      expect(mockEnsureFreshForWindow).toHaveBeenCalledWith('24h');
      expect(mockEnsureFresh).not.toHaveBeenCalled();
      expect(res.body.total_cost_usd).toBeCloseTo(5.0);
    });

    it('should use ensureFreshForWindow for window=30d', async () => {
      mockEnsureFreshForWindow.mockResolvedValue(emptyPayload());

      await request(app).get('/api/costs/summary?window=30d').expect(200);

      expect(mockEnsureFreshForWindow).toHaveBeenCalledWith('30d');
    });

    it('should use ensureFresh for default window=7d', async () => {
      await request(app).get('/api/costs/summary?window=7d').expect(200);

      expect(mockEnsureFresh).toHaveBeenCalled();
      expect(mockEnsureFreshForWindow).not.toHaveBeenCalled();
    });

    it('should return 500 on projection error', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockEnsureFresh.mockRejectedValue(new Error('DB connection lost'));

      const res = await request(app).get('/api/costs/summary').expect(500);

      expect(res.body.error).toBe('Failed to fetch cost summary');
      consoleErrorSpy.mockRestore();
    });

    it('should return 500 when ensureFreshForWindow rejects for window=24h', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockEnsureFreshForWindow.mockRejectedValue(new Error('DB query failed'));

      const res = await request(app).get('/api/costs/summary?window=24h').expect(500);

      expect(res.body.error).toBe('Failed to fetch cost summary');
      expect(mockEnsureFreshForWindow).toHaveBeenCalledWith('24h');
      consoleErrorSpy.mockRestore();
    });

    it('should default ?window=invalid to 7d and call ensureFresh', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockEnsureFresh.mockResolvedValue(emptyPayload());

      const res = await request(app).get('/api/costs/summary?window=invalid').expect(200);

      expect(mockEnsureFresh).toHaveBeenCalled();
      expect(mockEnsureFreshForWindow).not.toHaveBeenCalled();
      expect(res.body.total_cost_usd).toBe(0);
      consoleWarnSpy.mockRestore();
    });

    it('should use ensureFresh when no ?window= param is provided (same as explicit ?window=7d)', async () => {
      mockEnsureFresh.mockResolvedValue(emptyPayload());

      await request(app).get('/api/costs/summary').expect(200);

      expect(mockEnsureFresh).toHaveBeenCalled();
      expect(mockEnsureFreshForWindow).not.toHaveBeenCalled();
    });

    it('should set X-Degraded headers and not include degraded/window in body when ensureFreshForWindow returns a degraded payload', async () => {
      const degradedPayload: CostMetricsPayload = {
        ...makePayload(),
        degraded: true,
        window: '7d',
      };
      mockEnsureFreshForWindow.mockResolvedValue(degradedPayload);

      const res = await request(app).get('/api/costs/summary?window=24h').expect(200);

      expect(mockEnsureFreshForWindow).toHaveBeenCalledWith('24h');
      // Degradation communicated via headers only — body shape is unchanged
      expect(res.headers['x-degraded']).toBe('true');
      expect(res.headers['x-degraded-window']).toBe('7d');
      // Body must not contain degraded/window fields (shape must be consistent)
      expect(res.body.degraded).toBeUndefined();
      expect(res.body.window).toBeUndefined();
    });
  });

  // =========================================================================
  // GET /api/costs/trend
  // =========================================================================

  describe('GET /api/costs/trend', () => {
    it('should return empty trend with empty data', async () => {
      const res = await request(app).get('/api/costs/trend').expect(200);

      expect(res.body).toEqual([]);
    });

    it('should return trend data points', async () => {
      mockEnsureFresh.mockResolvedValue(
        makePayload({
          trend: [
            {
              timestamp: '2026-02-10 00:00:00+00',
              total_cost_usd: 6.25,
              reported_cost_usd: 6.0,
              estimated_cost_usd: 0.25,
              session_count: 15,
            },
            {
              timestamp: '2026-02-11 00:00:00+00',
              total_cost_usd: 8.1,
              reported_cost_usd: 8.1,
              estimated_cost_usd: 0,
              session_count: 20,
            },
          ],
        })
      );

      const res = await request(app).get('/api/costs/trend').expect(200);

      expect(res.body).toHaveLength(2);
      expect(res.body[0].total_cost_usd).toBeCloseTo(6.25);
      expect(res.body[1].session_count).toBe(20);
    });

    it('should use ensureFreshForWindow for window=24h', async () => {
      mockEnsureFreshForWindow.mockResolvedValue(makePayload({ trend: [] }));

      await request(app).get('/api/costs/trend?window=24h').expect(200);

      expect(mockEnsureFreshForWindow).toHaveBeenCalledWith('24h');
    });

    it('should use ensureFreshForWindow for window=30d', async () => {
      mockEnsureFreshForWindow.mockResolvedValue(makePayload({ trend: [] }));

      await request(app).get('/api/costs/trend?window=30d').expect(200);

      expect(mockEnsureFreshForWindow).toHaveBeenCalledWith('30d');
      expect(mockEnsureFresh).not.toHaveBeenCalled();
    });

    it('should return 500 on projection error', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockEnsureFresh.mockRejectedValue(new Error('DB error'));

      const res = await request(app).get('/api/costs/trend').expect(500);

      expect(res.body.error).toBe('Failed to fetch cost trend');
      consoleErrorSpy.mockRestore();
    });

    it('should return 500 when ensureFreshForWindow rejects for window=24h', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockEnsureFreshForWindow.mockRejectedValue(new Error('DB query failed'));

      const res = await request(app).get('/api/costs/trend?window=24h').expect(500);

      expect(res.body.error).toBe('Failed to fetch cost trend');
      expect(mockEnsureFreshForWindow).toHaveBeenCalledWith('24h');
      consoleErrorSpy.mockRestore();
    });

    it('should set X-Degraded headers and return array body when ensureFreshForWindow returns a degraded payload', async () => {
      const trendData = [
        {
          timestamp: '2026-02-10 00:00:00+00',
          total_cost_usd: 3.0,
          reported_cost_usd: 3.0,
          estimated_cost_usd: 0,
          session_count: 5,
        },
      ];
      const degradedPayload: CostMetricsPayload = {
        ...makePayload({ trend: trendData }),
        degraded: true,
        window: '7d',
      };
      mockEnsureFreshForWindow.mockResolvedValue(degradedPayload);

      const res = await request(app).get('/api/costs/trend?window=24h').expect(200);

      // Body must remain a plain array regardless of degradation state
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].total_cost_usd).toBeCloseTo(3.0);
      // Degradation communicated via headers only
      expect(res.headers['x-degraded']).toBe('true');
      expect(res.headers['x-degraded-window']).toBe('7d');
    });
  });

  // =========================================================================
  // GET /api/costs/by-model
  // =========================================================================

  describe('GET /api/costs/by-model', () => {
    it('should return empty array with empty data', async () => {
      const res = await request(app).get('/api/costs/by-model').expect(200);

      expect(res.body).toEqual([]);
    });

    it('should return model breakdown from projection', async () => {
      mockEnsureFresh.mockResolvedValue(
        makePayload({
          byModel: [
            {
              model_name: 'claude-sonnet-4-6',
              total_cost_usd: 25.0,
              reported_cost_usd: 25.0,
              estimated_cost_usd: 0,
              total_tokens: 250000,
              prompt_tokens: 150000,
              completion_tokens: 100000,
              request_count: 80,
              usage_source: 'API',
            },
            {
              model_name: 'gpt-4',
              total_cost_usd: 17.5,
              reported_cost_usd: 17.5,
              estimated_cost_usd: 0,
              total_tokens: 100000,
              prompt_tokens: 60000,
              completion_tokens: 40000,
              request_count: 40,
              usage_source: 'API',
            },
          ],
        })
      );

      const res = await request(app).get('/api/costs/by-model').expect(200);

      expect(res.body).toHaveLength(2);
      expect(res.body[0].model_name).toBe('claude-sonnet-4-6');
      expect(res.body[0].total_cost_usd).toBeCloseTo(25.0);
      expect(res.body[1].model_name).toBe('gpt-4');
    });

    it('should use ensureFresh (not ensureFreshForWindow) when ?window=24h is provided', async () => {
      // by-model always shows 30d regardless of the selected trend window —
      // window param is silently ignored for breakdown endpoints.
      mockEnsureFresh.mockResolvedValue(makePayload({ byModel: [] }));

      await request(app).get('/api/costs/by-model?window=24h').expect(200);

      expect(mockEnsureFresh).toHaveBeenCalled();
      expect(mockEnsureFreshForWindow).not.toHaveBeenCalled();
    });

    it('should set X-Window-Ignored header when ?window= is provided', async () => {
      // by-model ignores the window param and always returns 30d data.
      // The X-Window-Ignored header tells clients their ?window= was received but not applied.
      mockEnsureFresh.mockResolvedValue(makePayload({ byModel: [] }));

      const res = await request(app).get('/api/costs/by-model?window=24h').expect(200);

      expect(res.headers['x-window-ignored']).toBe('true');
    });

    it('should NOT set X-Window-Ignored header when no ?window= param is provided', async () => {
      mockEnsureFresh.mockResolvedValue(makePayload({ byModel: [] }));

      const res = await request(app).get('/api/costs/by-model').expect(200);

      expect(res.headers['x-window-ignored']).toBeUndefined();
    });

    it('should return 500 on projection error', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockEnsureFresh.mockRejectedValue(new Error('DB error'));

      const res = await request(app).get('/api/costs/by-model').expect(500);

      expect(res.body.error).toBe('Failed to fetch cost by model');
      consoleErrorSpy.mockRestore();
    });
  });

  // =========================================================================
  // GET /api/costs/by-repo
  // =========================================================================

  describe('GET /api/costs/by-repo', () => {
    it('should return empty array with empty data', async () => {
      const res = await request(app).get('/api/costs/by-repo').expect(200);

      expect(res.body).toEqual([]);
    });

    it('should return repo breakdown from projection', async () => {
      mockEnsureFresh.mockResolvedValue(
        makePayload({
          byRepo: [
            {
              repo_name: 'my-repo',
              total_cost_usd: 18.0,
              reported_cost_usd: 18.0,
              estimated_cost_usd: 0,
              total_tokens: 180000,
              session_count: 45,
              usage_source: 'API',
            },
          ],
        })
      );

      const res = await request(app).get('/api/costs/by-repo').expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].repo_name).toBe('my-repo');
      expect(res.body[0].session_count).toBe(45);
    });

    it('should use ensureFresh (not ensureFreshForWindow) when ?window=24h is provided', async () => {
      // by-repo always shows 30d regardless of the selected trend window —
      // window param is silently ignored for breakdown endpoints.
      mockEnsureFresh.mockResolvedValue(makePayload({ byRepo: [] }));

      await request(app).get('/api/costs/by-repo?window=24h').expect(200);

      expect(mockEnsureFresh).toHaveBeenCalled();
      expect(mockEnsureFreshForWindow).not.toHaveBeenCalled();
    });

    it('should set X-Window-Ignored header when ?window= is provided', async () => {
      // by-repo ignores the window param and always returns 30d data.
      // The X-Window-Ignored header tells clients their ?window= was received but not applied.
      mockEnsureFresh.mockResolvedValue(makePayload({ byRepo: [] }));

      const res = await request(app).get('/api/costs/by-repo?window=24h').expect(200);

      expect(res.headers['x-window-ignored']).toBe('true');
    });

    it('should NOT set X-Window-Ignored header when no ?window= param is provided', async () => {
      mockEnsureFresh.mockResolvedValue(makePayload({ byRepo: [] }));

      const res = await request(app).get('/api/costs/by-repo').expect(200);

      expect(res.headers['x-window-ignored']).toBeUndefined();
    });

    it('should return 500 on projection error', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockEnsureFresh.mockRejectedValue(new Error('DB error'));

      const res = await request(app).get('/api/costs/by-repo').expect(500);

      expect(res.body.error).toBe('Failed to fetch cost by repo');
      consoleErrorSpy.mockRestore();
    });
  });

  // =========================================================================
  // GET /api/costs/by-pattern
  // =========================================================================

  describe('GET /api/costs/by-pattern', () => {
    it('should return empty array with empty data', async () => {
      const res = await request(app).get('/api/costs/by-pattern').expect(200);

      expect(res.body).toEqual([]);
    });

    it('should return pattern breakdown from projection', async () => {
      mockEnsureFresh.mockResolvedValue(
        makePayload({
          byPattern: [
            {
              pattern_id: 'P001',
              pattern_name: 'ONEX Node Pattern',
              total_cost_usd: 12.0,
              reported_cost_usd: 12.0,
              estimated_cost_usd: 0,
              prompt_tokens: 80000,
              completion_tokens: 40000,
              injection_count: 60,
              avg_cost_per_injection: 0.2,
              usage_source: 'API',
            },
          ],
        })
      );

      const res = await request(app).get('/api/costs/by-pattern').expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].pattern_id).toBe('P001');
      expect(res.body[0].avg_cost_per_injection).toBeCloseTo(0.2);
    });

    it('should use ensureFresh (not ensureFreshForWindow) when ?window=24h is provided', async () => {
      // by-pattern always shows 30d regardless of the selected trend window —
      // window param is silently ignored for breakdown endpoints.
      mockEnsureFresh.mockResolvedValue(makePayload({ byPattern: [] }));

      await request(app).get('/api/costs/by-pattern?window=24h').expect(200);

      expect(mockEnsureFresh).toHaveBeenCalled();
      expect(mockEnsureFreshForWindow).not.toHaveBeenCalled();
    });

    it('should set X-Window-Ignored header when ?window= is provided', async () => {
      // by-pattern ignores the window param and always returns 30d data.
      // The X-Window-Ignored header tells clients their ?window= was received but not applied.
      mockEnsureFresh.mockResolvedValue(makePayload({ byPattern: [] }));

      const res = await request(app).get('/api/costs/by-pattern?window=24h').expect(200);

      expect(res.headers['x-window-ignored']).toBe('true');
    });

    it('should NOT set X-Window-Ignored header when no ?window= param is provided', async () => {
      mockEnsureFresh.mockResolvedValue(makePayload({ byPattern: [] }));

      const res = await request(app).get('/api/costs/by-pattern').expect(200);

      expect(res.headers['x-window-ignored']).toBeUndefined();
    });

    it('should return 500 on projection error', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockEnsureFresh.mockRejectedValue(new Error('DB error'));

      const res = await request(app).get('/api/costs/by-pattern').expect(500);

      expect(res.body.error).toBe('Failed to fetch cost by pattern');
      consoleErrorSpy.mockRestore();
    });
  });

  // =========================================================================
  // GET /api/costs/token-usage
  // =========================================================================

  describe('GET /api/costs/token-usage', () => {
    it('should return empty array with empty data', async () => {
      const res = await request(app).get('/api/costs/token-usage').expect(200);

      expect(res.body).toEqual([]);
    });

    it('should return token usage time series', async () => {
      mockEnsureFresh.mockResolvedValue(
        makePayload({
          tokenUsage: [
            {
              timestamp: '2026-02-10 00:00:00+00',
              prompt_tokens: 150000,
              completion_tokens: 100000,
              total_tokens: 250000,
              usage_source: 'API',
            },
          ],
        })
      );

      const res = await request(app).get('/api/costs/token-usage').expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].total_tokens).toBe(250000);
      expect(res.body[0].usage_source).toBe('API');
    });

    it('should use ensureFreshForWindow for window=24h', async () => {
      mockEnsureFreshForWindow.mockResolvedValue(makePayload({ tokenUsage: [] }));

      await request(app).get('/api/costs/token-usage?window=24h').expect(200);

      expect(mockEnsureFreshForWindow).toHaveBeenCalledWith('24h');
    });

    it('should use ensureFreshForWindow for window=30d', async () => {
      mockEnsureFreshForWindow.mockResolvedValue(makePayload({ tokenUsage: [] }));

      await request(app).get('/api/costs/token-usage?window=30d').expect(200);

      expect(mockEnsureFreshForWindow).toHaveBeenCalledWith('30d');
      expect(mockEnsureFresh).not.toHaveBeenCalled();
    });

    it('should return 500 on projection error', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockEnsureFresh.mockRejectedValue(new Error('DB error'));

      const res = await request(app).get('/api/costs/token-usage').expect(500);

      expect(res.body.error).toBe('Failed to fetch token usage');
      consoleErrorSpy.mockRestore();
    });

    it('should return 500 when ensureFreshForWindow rejects for window=24h', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockEnsureFreshForWindow.mockRejectedValue(new Error('DB query failed'));

      const res = await request(app).get('/api/costs/token-usage?window=24h').expect(500);

      expect(res.body.error).toBe('Failed to fetch token usage');
      expect(mockEnsureFreshForWindow).toHaveBeenCalledWith('24h');
      consoleErrorSpy.mockRestore();
    });

    it('should set X-Degraded headers and return array body when ensureFreshForWindow returns a degraded payload', async () => {
      const tokenData = [
        {
          timestamp: '2026-02-10 00:00:00+00',
          prompt_tokens: 120000,
          completion_tokens: 80000,
          total_tokens: 200000,
          usage_source: 'API' as const,
        },
      ];
      const degradedPayload: CostMetricsPayload = {
        ...makePayload({ tokenUsage: tokenData }),
        degraded: true,
        window: '7d',
      };
      mockEnsureFreshForWindow.mockResolvedValue(degradedPayload);

      const res = await request(app).get('/api/costs/token-usage?window=24h').expect(200);

      // Body must remain a plain array regardless of degradation state
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].total_tokens).toBe(200000);
      // Degradation communicated via headers only
      expect(res.headers['x-degraded']).toBe('true');
      expect(res.headers['x-degraded-window']).toBe('7d');
    });
  });

  // =========================================================================
  // GET /api/costs/alerts
  // =========================================================================

  describe('GET /api/costs/alerts', () => {
    it('should return empty alerts array when no budget cap hits exist', async () => {
      mockBudgetEnsureFresh.mockResolvedValue({ recent: [], summary: { total_cap_hits: 0 } });

      const res = await request(app).get('/api/costs/alerts').expect(200);

      expect(res.body).toEqual([]);
    });

    it('should return derived alerts from cap-hit rows with dedup by (pipeline_id, budget_type)', async () => {
      mockBudgetEnsureFresh.mockResolvedValue({
        recent: [
          {
            correlation_id: 'corr-1',
            pipeline_id: 'pipeline-a',
            budget_type: 'cost',
            cap_value: 1000,
            current_value: 1200,
            cap_hit: true,
            repo: 'repo-x',
            created_at: '2026-04-01T10:00:00Z',
          },
          // Duplicate (pipeline_id, budget_type) — older, should be deduped out
          {
            correlation_id: 'corr-0',
            pipeline_id: 'pipeline-a',
            budget_type: 'cost',
            cap_value: 900,
            current_value: 950,
            cap_hit: true,
            repo: 'repo-x',
            created_at: '2026-03-31T10:00:00Z',
          },
          // Different budget_type — should appear as a separate alert
          {
            correlation_id: 'corr-2',
            pipeline_id: 'pipeline-a',
            budget_type: 'tokens',
            cap_value: 500000,
            current_value: 600000,
            cap_hit: true,
            repo: 'repo-x',
            created_at: '2026-04-01T12:00:00Z',
          },
        ],
        summary: { total_cap_hits: 3 },
      });

      const res = await request(app).get('/api/costs/alerts').expect(200);

      // Should have 2 alerts (deduped by pipeline_id + budget_type)
      expect(res.body).toHaveLength(2);

      // First: the latest cost cap hit for pipeline-a
      const costAlert = res.body.find((a: Record<string, unknown>) => a.id === 'corr-1');
      expect(costAlert).toBeDefined();
      expect(costAlert.name).toBe('pipeline-a cost cap');
      expect(costAlert.threshold_usd).toBe(1000);
      expect(costAlert.current_spend_usd).toBe(1200);
      expect(costAlert.utilization_pct).toBe(120);
      expect(costAlert.is_triggered).toBe(true);

      // Second: the token cap hit for pipeline-a
      const tokenAlert = res.body.find((a: Record<string, unknown>) => a.id === 'corr-2');
      expect(tokenAlert).toBeDefined();
      expect(tokenAlert.name).toBe('pipeline-a tokens cap');
      expect(tokenAlert.threshold_usd).toBe(500000);
      expect(tokenAlert.current_spend_usd).toBe(600000);
      expect(tokenAlert.is_triggered).toBe(true);
    });

    it('should return 500 when pipeline budget projection is unavailable', async () => {
      mockBudgetEnsureFresh.mockRejectedValue(new Error('DB error'));

      const res = await request(app).get('/api/costs/alerts').expect(500);

      expect(res.body).toEqual({ error: 'Failed to fetch budget alerts' });
    });
  });

  // =========================================================================
  // Graceful degradation — projection view unavailable
  //
  // When projectionService.getView('cost-metrics') returns undefined (e.g.
  // the view has not been registered yet during startup), every cost endpoint
  // should fall back to a hardcoded zero/empty response rather than throwing.
  // =========================================================================

  describe('graceful degradation when cost-metrics view is unavailable', () => {
    // Re-import projection-bootstrap mock so we can override getView locally
    // for this describe block without affecting other suites.
    let getViewSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      // Dynamically import the (already mocked) projection-bootstrap module
      // and override getView to return undefined for every call.
      const bootstrap = await import('../projection-bootstrap');
      getViewSpy = vi.spyOn(bootstrap.projectionService, 'getView').mockReturnValue(undefined);
    });

    afterEach(() => {
      getViewSpy.mockRestore();
    });

    it('GET /api/costs/summary returns 200 with all-zero payload', async () => {
      const res = await request(app).get('/api/costs/summary').expect(200);

      expect(res.body.total_cost_usd).toBe(0);
      expect(res.body.reported_cost_usd).toBe(0);
      expect(res.body.estimated_cost_usd).toBe(0);
      expect(res.body.reported_coverage_pct).toBe(0);
      expect(res.body.total_tokens).toBe(0);
      expect(res.body.prompt_tokens).toBe(0);
      expect(res.body.completion_tokens).toBe(0);
      expect(res.body.session_count).toBe(0);
      expect(res.body.model_count).toBe(0);
      expect(res.body.avg_cost_per_session).toBe(0);
      expect(res.body.cost_change_pct).toBe(0);
      expect(res.body.active_alerts).toBe(0);
    });

    it('GET /api/costs/trend returns 200 with empty array', async () => {
      const res = await request(app).get('/api/costs/trend').expect(200);

      expect(res.body).toEqual([]);
    });

    it('GET /api/costs/by-model returns 200 with empty array', async () => {
      const res = await request(app).get('/api/costs/by-model').expect(200);

      expect(res.body).toEqual([]);
    });

    it('GET /api/costs/by-repo returns 200 with empty array', async () => {
      const res = await request(app).get('/api/costs/by-repo').expect(200);

      expect(res.body).toEqual([]);
    });

    it('GET /api/costs/by-pattern returns 200 with empty array', async () => {
      const res = await request(app).get('/api/costs/by-pattern').expect(200);

      expect(res.body).toEqual([]);
    });

    it('GET /api/costs/token-usage returns 200 with empty array', async () => {
      const res = await request(app).get('/api/costs/token-usage').expect(200);

      expect(res.body).toEqual([]);
    });
  });
});
