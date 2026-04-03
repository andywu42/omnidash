/**
 * Health Regression Guard (OMN-5820)
 *
 * Validates that the health data source endpoint conforms to the health
 * probe contract. These tests catch regressions where data sources
 * silently fall to "mock" status when they should be "live."
 *
 * Two categories of tests:
 * 1. Contract completeness — every source in the contract is returned by
 *    the endpoint, and every source returned by the endpoint is covered
 *    by the contract.
 * 2. Regression detection — when projections report live data, the
 *    endpoint must not return "mock" for those sources.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import healthDataSourcesRoutes, { clearHealthCache } from '../health-data-sources-routes';
import { projectionService } from '../projection-bootstrap';
import {
  HEALTH_PROBE_CONTRACT,
  ALL_DATA_SOURCE_KEYS,
  REGRESSION_STATUSES,
  HEALTHY_STATUSES,
} from '@shared/health-probe-contract';
import type { DataSourceStatus } from '../health-data-sources-routes';

// ============================================================================
// Mocks — same pattern as health-data-sources-routes.test.ts
// ============================================================================

vi.mock('../projection-bootstrap', () => ({
  projectionService: {
    getView: vi.fn(),
  },
  enforcementProjection: {
    probeRecentCount: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../storage', () => ({
  tryGetIntelligenceDb: vi.fn(),
}));

vi.mock('../event-bus-data-source', () => ({
  getEventBusDataSource: vi.fn(),
}));

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

vi.mock('../event-bus-health-poller', () => ({
  EXPECTED_TOPICS: [
    'onex.evt.omniclaude.agent-actions.v1',
    'onex.evt.omniclaude.routing-decision.v1',
  ],
}));

import { tryGetIntelligenceDb } from '../storage';
import { getEventBusDataSource } from '../event-bus-data-source';
import { enforcementProjection } from '../projection-bootstrap';

// ============================================================================
// Helpers
// ============================================================================

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthDataSourcesRoutes);
  return app;
}

function makeSnapshot(payload: unknown, snapshotTimeMs = Date.now()) {
  return { viewId: 'test', cursor: 0, snapshotTimeMs, payload };
}

function makeView(payload: unknown) {
  return { getSnapshot: vi.fn().mockReturnValue(makeSnapshot(payload)) };
}

function makeMockDb(rows: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue(rows),
    }),
  };
}

function setupEmptyDb() {
  vi.mocked(tryGetIntelligenceDb).mockReturnValue(makeMockDb([{ count: 0 }]) as any);
  vi.mocked(getEventBusDataSource).mockReturnValue(null);
}

// ============================================================================
// Tests
// ============================================================================

describe('Health Probe Contract Compliance (OMN-5820)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHealthCache();
  });

  // --------------------------------------------------------------------------
  // Contract completeness
  // --------------------------------------------------------------------------

  describe('contract completeness', () => {
    it('ALL_DATA_SOURCE_KEYS matches the keys returned by the endpoint', async () => {
      vi.mocked(projectionService.getView).mockReturnValue(null);
      setupEmptyDb();

      const app = makeApp();
      const res = await request(app).get('/api/health/data-sources');

      expect(res.status).toBe(200);
      const endpointKeys = Object.keys(res.body.dataSources).sort();
      const contractKeys = [...ALL_DATA_SOURCE_KEYS].sort();
      expect(endpointKeys).toEqual(contractKeys);
    });

    it('every profile in the contract covers only valid data source keys', () => {
      const validKeys = new Set<string>(ALL_DATA_SOURCE_KEYS);

      for (const [_profile, expectation] of Object.entries(HEALTH_PROBE_CONTRACT)) {
        for (const key of expectation.mustBeLive) {
          expect(validKeys.has(key)).toBe(true);
        }
        for (const key of expectation.acceptableIdle) {
          expect(validKeys.has(key)).toBe(true);
        }
        // mustBeLive and acceptableIdle should not overlap
        const overlap = expectation.mustBeLive.filter((k) =>
          expectation.acceptableIdle.includes(k)
        );
        expect(overlap).toEqual([]);
      }
    });

    it('every data source key appears in at least one profile (mustBeLive or acceptableIdle)', () => {
      const coveredKeys = new Set<string>();
      for (const expectation of Object.values(HEALTH_PROBE_CONTRACT)) {
        for (const key of expectation.mustBeLive) coveredKeys.add(key);
        for (const key of expectation.acceptableIdle) coveredKeys.add(key);
      }

      for (const key of ALL_DATA_SOURCE_KEYS) {
        expect(coveredKeys.has(key)).toBe(true);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Regression detection — when projections have data, sources must be live
  // --------------------------------------------------------------------------

  describe('regression detection', () => {
    it('sources with live projections must not report mock status', async () => {
      // Wire up projections with real data
      const eventBusView = makeView({ totalEventsIngested: 42, events: [] });
      const effectivenessView = makeView({ summary: { total_sessions: 10 } });
      const extractionView = makeView({
        summary: { total_injections: 5, last_event_at: '2026-03-22T00:00:00Z' },
      });
      const validationView = makeView({ totalRuns: 3 });
      const patternsView = makeView({ totalPatterns: 7 });
      const intentView = makeView({ totalIntents: 5, lastEventTimeMs: Date.now() });
      const nodeRegistryView = makeView({ stats: { totalNodes: 2 } });
      const baselinesView = makeView({ summary: { total_comparisons: 1 } });
      const costView = makeView({ summary: { session_count: 1, total_tokens: 100 } });

      vi.mocked(projectionService.getView).mockImplementation((viewId: string) => {
        const views: Record<string, any> = {
          'event-bus': eventBusView,
          'effectiveness-metrics': effectivenessView,
          'extraction-metrics': extractionView,
          validation: validationView,
          patterns: patternsView,
          intent: intentView,
          'node-registry': nodeRegistryView,
          baselines: baselinesView,
          'cost-metrics': costView,
        };
        return views[viewId] ?? null;
      });

      // DB-backed probes: insights has data, execution graph has data
      vi.mocked(tryGetIntelligenceDb).mockReturnValue(makeMockDb([{ total: 5 }]) as any);
      vi.mocked(getEventBusDataSource).mockReturnValue({
        queryEvents: vi.fn().mockResolvedValue([{ id: 1 }]),
      } as any);
      // Enforcement probe returns non-null count = live
      vi.mocked(enforcementProjection.probeRecentCount).mockResolvedValue(3);

      const app = makeApp();
      const res = await request(app).get('/api/health/data-sources');

      expect(res.status).toBe(200);

      // When all projections have data, no source should be "mock"
      const dataSources = res.body.dataSources as Record<string, { status: DataSourceStatus }>;
      const mockSources = Object.entries(dataSources)
        .filter(([, info]) => info.status === 'mock')
        .map(([key]) => key);

      expect(mockSources).toEqual([]);
    });

    it('sources in LOCAL_IDLE_EXPECTED are reclassified to expected_idle_local, not left as mock', async () => {
      // All projections empty — simulates "no runtime" scenario
      vi.mocked(projectionService.getView).mockReturnValue(null);
      setupEmptyDb();
      // Enforcement returns null (no DB connection) → mock → reclassified
      vi.mocked(enforcementProjection.probeRecentCount).mockResolvedValue(null);

      const app = makeApp();
      const res = await request(app).get('/api/health/data-sources');

      expect(res.status).toBe(200);

      const dataSources = res.body.dataSources as Record<string, { status: DataSourceStatus }>;

      // The 3 newly added sources (OMN-5820) should be expected_idle_local, not mock
      expect(dataSources.executionGraph.status).toBe('expected_idle_local');
      expect(dataSources.enforcement.status).toBe('expected_idle_local');
      expect(dataSources.nodeRegistry.status).toBe('expected_idle_local');
    });
  });

  // --------------------------------------------------------------------------
  // Contract status classification
  // --------------------------------------------------------------------------

  describe('status classification constants', () => {
    it('HEALTHY_STATUSES and REGRESSION_STATUSES are disjoint', () => {
      for (const status of HEALTHY_STATUSES) {
        expect(REGRESSION_STATUSES.has(status)).toBe(false);
      }
    });

    it('every possible DataSourceStatus is classified as healthy or regression', () => {
      const allStatuses: DataSourceStatus[] = [
        'live',
        'mock',
        'error',
        'offline',
        'expected_idle_local',
        'not_applicable',
      ];
      for (const status of allStatuses) {
        const classified = HEALTHY_STATUSES.has(status) || REGRESSION_STATUSES.has(status);
        expect(classified).toBe(true);
      }
    });
  });
});
