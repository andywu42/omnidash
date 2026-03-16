/**
 * Tests for GET /api/health/data-sources (OMN-2307)
 *
 * These tests verify that the endpoint:
 * 1. Returns the correct shape (dataSources, summary, checkedAt)
 * 2. Reads projection snapshots correctly
 * 3. Handles missing projections gracefully (status: 'mock')
 * 4. Summarises counts correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import healthDataSourcesRoutes, { clearHealthCache } from '../health-data-sources-routes';
import { projectionService } from '../projection-bootstrap';

// ============================================================================
// Mock projection-bootstrap so we can control getView() return values
// ============================================================================

vi.mock('../projection-bootstrap', () => ({
  projectionService: {
    getView: vi.fn(),
  },
}));

// ============================================================================
// Mock storage (tryGetIntelligenceDb) for DB-based probes
// ============================================================================

vi.mock('../storage', () => ({
  tryGetIntelligenceDb: vi.fn(),
}));

// ============================================================================
// Mock event-bus-data-source (getEventBusDataSource) for the execution probe
// ============================================================================

vi.mock('../event-bus-data-source', () => ({
  getEventBusDataSource: vi.fn(),
}));

// ============================================================================
// Mock read-model-consumer (OMN-4964: topic parity probe)
// ============================================================================

vi.mock('../read-model-consumer', () => ({
  READ_MODEL_TOPICS: [
    'onex.evt.omniclaude.agent-actions.v1',
    'onex.evt.omniclaude.routing-decision.v1',
  ] as const,
  readModelConsumer: {
    getStats: vi.fn().mockReturnValue({
      isRunning: true,
      eventsProjected: 0,
      errorsCount: 0,
      lastProjectedAt: null,
      topicStats: {
        'onex.evt.omniclaude.agent-actions.v1': { projected: 0, errors: 0 },
        'onex.evt.omniclaude.routing-decision.v1': { projected: 0, errors: 0 },
      },
      catalogSource: 'static',
      unsupportedCatalogTopics: [],
    }),
  },
}));

// ============================================================================
// Mock event-bus-health-poller (OMN-4964: topic parity probe)
// ============================================================================

vi.mock('../event-bus-health-poller', () => ({
  EXPECTED_TOPICS: [
    'onex.evt.omniclaude.agent-actions.v1',
    'onex.evt.omniclaude.routing-decision.v1',
  ],
}));

// ============================================================================
// Import mocks after vi.mock declarations
// ============================================================================

import { tryGetIntelligenceDb } from '../storage';
import { getEventBusDataSource } from '../event-bus-data-source';

// ============================================================================
// Helpers
// ============================================================================

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthDataSourcesRoutes);
  return app;
}

/** Build a minimal mock ProjectionView snapshot. */
function makeSnapshot(payload: unknown, snapshotTimeMs = Date.now()) {
  return {
    viewId: 'test',
    cursor: 0,
    snapshotTimeMs,
    payload,
  };
}

/** Return a mock view with getSnapshot() resolving to the given payload. */
function makeView(payload: unknown) {
  return {
    getSnapshot: vi.fn().mockReturnValue(makeSnapshot(payload)),
  };
}

/**
 * Build a mock Drizzle db object that returns `rows` from any `.select()` chain.
 * The chain is: db.select(...).from(...) => Promise<rows>
 */
function makeMockDb(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockResolvedValue(rows),
  };
  return {
    select: vi.fn().mockReturnValue(chain),
  };
}

// ============================================================================
// Default mock setup helpers
// ============================================================================

/** Set up all DB-backed probes to return empty/no-data (offline status). */
function setupEmptyDb() {
  // probeInsights() queries pattern_learning_artifacts via tryGetIntelligenceDb.
  // Returning count: 0 → status: offline (upstream_never_emitted).
  vi.mocked(tryGetIntelligenceDb).mockReturnValue(makeMockDb([{ count: 0 }]) as any);
  vi.mocked(getEventBusDataSource).mockReturnValue(null);
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/health/data-sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHealthCache();
  });

  it('returns 200 with correct top-level shape', async () => {
    vi.mocked(projectionService.getView).mockReturnValue(null);
    setupEmptyDb();

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('dataSources');
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('checkedAt');
    expect(typeof res.body.checkedAt).toBe('string');
  });

  it('reports status: mock when no projections are registered', async () => {
    vi.mocked(projectionService.getView).mockReturnValue(null);
    setupEmptyDb();

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    // Projection-based sources should be mock (or expected_idle_local in test env).
    // OMN-5149: In non-production environments, sources in LOCAL_IDLE_EXPECTED
    // are reclassified from mock/offline to expected_idle_local.
    const { dataSources } = res.body;
    expect(dataSources.eventBus.status).toBe('mock');
    expect(dataSources.effectiveness.status).toBe('mock');
    expect(dataSources.extraction.status).toBe('mock');
    // baselines is in LOCAL_IDLE_EXPECTED → reclassified in test env
    expect(dataSources.baselines.status).toBe('expected_idle_local');
    expect(dataSources.costTrends.status).toBe('mock');
    // intents is in LOCAL_IDLE_EXPECTED → reclassified in test env
    expect(dataSources.intents.status).toBe('expected_idle_local');
    expect(dataSources.nodeRegistry.status).toBe('mock');
  });

  it('reports status: live for event-bus when projection has events', async () => {
    const eventBusView = makeView({ totalEventsIngested: 42, events: [] });
    const mockView = { getSnapshot: vi.fn().mockReturnValue(null) };

    vi.mocked(projectionService.getView).mockImplementation((viewId: string) => {
      if (viewId === 'event-bus') return eventBusView as any;
      return mockView as any;
    });
    setupEmptyDb();

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    expect(res.body.dataSources.eventBus.status).toBe('live');
    // correlationTrace is a shallow copy of eventBus — it must also be live
    expect(res.body.dataSources.correlationTrace.status).toBe('live');
  });

  it('reports status: live for effectiveness when total_sessions > 0', async () => {
    const effectivenessView = makeView({
      summary: { total_sessions: 100 },
    });
    const noView = { getSnapshot: vi.fn().mockReturnValue(null) };

    vi.mocked(projectionService.getView).mockImplementation((viewId: string) => {
      if (viewId === 'effectiveness-metrics') return effectivenessView as any;
      return noView as any;
    });
    setupEmptyDb();

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    expect(res.body.dataSources.effectiveness.status).toBe('live');
  });

  it('reports status: live for extraction when last_event_at is set', async () => {
    const extractionView = makeView({
      summary: { total_injections: 5, last_event_at: '2026-02-16T00:01:23Z' },
    });
    const noView = { getSnapshot: vi.fn().mockReturnValue(null) };

    vi.mocked(projectionService.getView).mockImplementation((viewId: string) => {
      if (viewId === 'extraction-metrics') return extractionView as any;
      return noView as any;
    });
    setupEmptyDb();

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    expect(res.body.dataSources.extraction.status).toBe('live');
    expect(res.body.dataSources.extraction.lastEvent).toBe('2026-02-16T00:01:23Z');
  });

  it('reports status: live for validation when projection has totalRuns > 0', async () => {
    const validationView = makeView({ totalRuns: 12 });
    const patternsView = makeView({ totalPatterns: 5 });

    vi.mocked(projectionService.getView).mockImplementation((viewId: string) => {
      if (viewId === 'validation') return validationView as any;
      if (viewId === 'patterns') return patternsView as any;
      return null;
    });
    vi.mocked(tryGetIntelligenceDb).mockReturnValue(makeMockDb([{ count: 0 }]) as any);
    vi.mocked(getEventBusDataSource).mockReturnValue(null);

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    expect(res.body.dataSources.validation.status).toBe('live');
    expect(res.body.dataSources.patterns.status).toBe('live');
  });

  it('reports status: error for insights when DB probe throws', async () => {
    // probeInsights() uses tryGetIntelligenceDb + db.select().from() — throw from the DB
    // to exercise the catch branch that returns { status: 'error', reason: 'probe_threw' }.
    vi.mocked(projectionService.getView).mockReturnValue(null);
    vi.mocked(tryGetIntelligenceDb).mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      }),
    } as any);
    vi.mocked(getEventBusDataSource).mockReturnValue(null);

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    expect(res.body.dataSources.insights.status).toBe('error');
    expect(res.body.dataSources.insights.reason).toBe('probe_threw');
  });

  it('reports status: error for validation when projection getSnapshot() throws', async () => {
    const throwingView = {
      getSnapshot: vi.fn().mockImplementation(() => {
        throw new Error('getSnapshot failed');
      }),
    };
    const patternsView = makeView({ totalPatterns: 0 });

    vi.mocked(projectionService.getView).mockImplementation((viewId: string) => {
      if (viewId === 'validation') return throwingView as any;
      if (viewId === 'patterns') return patternsView as any;
      return null;
    });
    vi.mocked(tryGetIntelligenceDb).mockReturnValue(makeMockDb([{ count: 0 }]) as any);
    vi.mocked(getEventBusDataSource).mockReturnValue(null);

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    expect(res.body.dataSources.validation.status).toBe('error');
    expect(res.body.dataSources.validation.reason).toBe('probe_threw');
  });

  it('reports status: error for patterns when projection getSnapshot() throws', async () => {
    const validationView = makeView({ totalRuns: 0 });
    const throwingView = {
      getSnapshot: vi.fn().mockImplementation(() => {
        throw new Error('getSnapshot failed');
      }),
    };

    vi.mocked(projectionService.getView).mockImplementation((viewId: string) => {
      if (viewId === 'validation') return validationView as any;
      if (viewId === 'patterns') return throwingView as any;
      return null;
    });
    vi.mocked(tryGetIntelligenceDb).mockReturnValue(makeMockDb([{ count: 0 }]) as any);
    vi.mocked(getEventBusDataSource).mockReturnValue(null);

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    expect(res.body.dataSources.patterns.status).toBe('error');
    expect(res.body.dataSources.patterns.reason).toBe('probe_threw');
  });

  it('reports status: expected_idle_local for patterns when projection has totalPatterns === 0 in local env', async () => {
    const patternsView = makeView({ totalPatterns: 0 });

    vi.mocked(projectionService.getView).mockImplementation((viewId: string) => {
      if (viewId === 'patterns') return patternsView as any;
      return null;
    });
    vi.mocked(tryGetIntelligenceDb).mockReturnValue(makeMockDb([{ count: 0 }]) as any);
    vi.mocked(getEventBusDataSource).mockReturnValue(null);

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    // OMN-5149: patterns is in LOCAL_IDLE_EXPECTED, so offline → expected_idle_local in test env
    expect(res.body.dataSources.patterns.status).toBe('expected_idle_local');
    expect(res.body.dataSources.patterns.reason).toContain('upstream_never_emitted');
  });

  it('computes summary counts correctly', async () => {
    // Set up: 3 live (event-bus, validation, correlationTrace), rest mock/offline.
    // validation live (totalRuns: 5), patterns offline (totalPatterns: 0).
    const eventBusView = makeView({ totalEventsIngested: 5 });
    const validationView = makeView({ totalRuns: 5 });
    const patternsView = makeView({ totalPatterns: 0 });
    const noView = { getSnapshot: vi.fn().mockReturnValue(null) };

    vi.mocked(projectionService.getView).mockImplementation((viewId: string) => {
      if (viewId === 'event-bus') return eventBusView as any;
      if (viewId === 'validation') return validationView as any;
      if (viewId === 'patterns') return patternsView as any;
      return noView as any;
    });

    vi.mocked(tryGetIntelligenceDb).mockReturnValue(makeMockDb([{ count: 0 }]) as any);
    vi.mocked(getEventBusDataSource).mockReturnValue(null);

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    const { summary } = res.body;
    // OMN-5149: In test env, LOCAL_IDLE_EXPECTED sources are reclassified.
    // 4 live sources (event-bus, validation, correlationTrace, topicParity)
    expect(summary.live).toBe(4);
    // Total across all statuses must equal 15 (all data sources)
    const total =
      summary.live +
      summary.mock +
      summary.error +
      (summary.offline ?? 0) +
      (summary.expected_idle_local ?? 0);
    expect(total).toBe(15);
  });

  it('includes all 15 expected data sources', async () => {
    vi.mocked(projectionService.getView).mockReturnValue(null);
    setupEmptyDb();

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    const keys = Object.keys(res.body.dataSources);
    const expectedKeys = [
      'eventBus',
      'effectiveness',
      'extraction',
      'baselines',
      'costTrends',
      'intents',
      'nodeRegistry',
      'correlationTrace',
      'validation',
      'insights',
      'patterns',
      'executionGraph',
      'enforcement',
      'envSync',
      'topicParity',
    ];
    for (const key of expectedKeys) {
      expect(keys).toContain(key);
    }
    expect(keys.length).toBe(15);
  });

  it('returns status: expected_idle_local with reason for empty baselines projection in local env', async () => {
    const baselinesView = makeView({
      summary: { total_comparisons: 0 },
    });
    const noView = { getSnapshot: vi.fn().mockReturnValue(null) };

    vi.mocked(projectionService.getView).mockImplementation((viewId: string) => {
      if (viewId === 'baselines') return baselinesView as any;
      return noView as any;
    });
    setupEmptyDb();

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    // OMN-5149: baselines is in LOCAL_IDLE_EXPECTED, so offline → expected_idle_local in test env
    expect(res.body.dataSources.baselines.status).toBe('expected_idle_local');
    expect(res.body.dataSources.baselines.reason).toContain('upstream_service_offline');
  });

  it('reports status: error for executionGraph when probe throws', async () => {
    vi.mocked(projectionService.getView).mockReturnValue(null);
    vi.mocked(tryGetIntelligenceDb).mockReturnValue(makeMockDb([{ count: 0 }]) as any);
    // Return a non-null data source whose queryEvents() rejects — exercises the
    // catch branch in probeExecutionGraph that returns { status: 'error', reason: 'probe_threw' }.
    vi.mocked(getEventBusDataSource).mockReturnValue({
      queryEvents: vi.fn().mockRejectedValue(new Error('queryEvents failed')),
    } as any);

    const app = makeApp();
    const res = await request(app).get('/api/health/data-sources');

    expect(res.status).toBe(200);
    expect(res.body.dataSources.executionGraph.status).toBe('error');
    expect(res.body.dataSources.executionGraph.reason).toBe('probe_threw');
  });

  // ==========================================================================
  // Caching behaviour
  // ==========================================================================

  describe('caching behaviour', () => {
    it('serves the second request from cache without re-probing', async () => {
      vi.mocked(projectionService.getView).mockReturnValue(null);
      setupEmptyDb();

      const app = makeApp();

      // First request — primes the cache.
      const res1 = await request(app).get('/api/health/data-sources');
      // Second request — should be served from the 30 s TTL cache.
      const res2 = await request(app).get('/api/health/data-sources');

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      // Both responses must carry identical payload (same checkedAt timestamp).
      expect(res2.body).toEqual(res1.body);
      // getEventBusDataSource is called once per probe run (inside probeExecutionGraph).
      // If the cache worked, it must have been called exactly once across both requests.
      expect(vi.mocked(getEventBusDataSource)).toHaveBeenCalledTimes(1);
    });

    it('concurrent requests share the pending probe and probe only once', async () => {
      vi.mocked(projectionService.getView).mockReturnValue(null);
      setupEmptyDb();

      const app = makeApp();

      // Fire two requests concurrently. Because neither has a warm cache and
      // both reach the pending-probe guard before either resolves, only one
      // probe run should start; the second request attaches to the same promise.
      const [res1, res2] = await Promise.all([
        request(app).get('/api/health/data-sources'),
        request(app).get('/api/health/data-sources'),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      // Both responses must be well-formed.
      expect(res1.body).toHaveProperty('dataSources');
      expect(res2.body).toHaveProperty('dataSources');
      // Only one probe run must have started: getEventBusDataSource is called
      // once per probe run inside probeExecutionGraph.
      expect(vi.mocked(getEventBusDataSource)).toHaveBeenCalledTimes(1);
    });
  });
});
