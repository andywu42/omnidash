/**
 * Integration test — Baselines & ROI API endpoints
 *
 * Tests the full path: PostgreSQL baselines_* tables -> Drizzle ORM ->
 * baselines-routes.ts Express handler -> JSON API response.
 *
 * Requires TEST_DATABASE_URL pointing to a PostgreSQL database whose name
 * ends with _test or -test. The baselines_* tables must already exist
 * (run migrations/0004_baselines_roi.sql, 0005_baselines_trend_unique.sql,
 * and 0006_baselines_breakdown_unique.sql).
 *
 * In CI, missing TEST_DATABASE_URL is a hard failure.
 * Outside CI, tests are skipped with a warning.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import type { Express } from 'express';
import {
  getTestDb,
  closeTestDb,
  createTestApp,
  resetBaselinesProjectionCache,
  truncateBaselines,
} from './helpers';
import {
  baselinesSnapshots,
  baselinesTrend,
  baselinesComparisons,
  baselinesBreakdown,
} from '@shared/intelligence-schema';
import { resetIntelligenceDb } from '../../storage';

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const canRunIntegrationTests = !!TEST_DB_URL;

// CI guard: fail fast at module scope so describe.skipIf cannot silently swallow
// the missing URL. When CI=true and TEST_DB_URL is absent the suite would be
// skipped before beforeAll runs, meaning a guard placed inside beforeAll would
// never fire in the environment where it is most needed.
if (process.env.CI && !TEST_DB_URL) {
  throw new Error(
    'TEST_DATABASE_URL is required in CI. Set it to a PostgreSQL database ending with _test.'
  );
}

if (!canRunIntegrationTests) {
  console.warn(
    '\n⚠️  TEST_DATABASE_URL not set — skipping baselines integration tests.\n' +
      '   Set TEST_DATABASE_URL=postgresql://.../<dbname>_test to enable.\n'
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!canRunIntegrationTests)('Baselines API Integration Tests', () => {
  let app: Express;

  beforeAll(async () => {
    getTestDb();

    app = await createTestApp(async (expressApp) => {
      const { default: baselinesRoutes } = await import('../../baselines-routes');
      expressApp.use('/api/baselines', baselinesRoutes);
    });
  });

  beforeEach(async () => {
    // Truncate all baselines_* tables so prior test runs cannot leave rows
    // that cause TC1 ('returns empty-state payload when no snapshot data exists')
    // to fail non-deterministically. Child tables are deleted before the parent
    // to satisfy FK constraints (same order used by truncateBaselines()).
    await truncateBaselines();
    // Reset the in-memory TTL cache so each test queries the (now-empty) DB
    // rather than serving stale rows from a prior test's seed data.
    resetBaselinesProjectionCache();
  });

  afterAll(async () => {
    try {
      await closeTestDb();
    } finally {
      try {
        await resetIntelligenceDb();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  // -------------------------------------------------------------------------
  // TC1: /summary returns an empty-state payload when no snapshot exists
  // -------------------------------------------------------------------------
  it('TC1: /summary returns empty-state payload when no snapshot data exists', async () => {
    const response = await request(app).get('/api/baselines/summary').expect(200);

    // Assert all BaselinesSummary fields exist and have numeric type
    expect(response.body).toHaveProperty('total_comparisons');
    expect(response.body).toHaveProperty('promote_count');
    expect(response.body).toHaveProperty('shadow_count');
    expect(response.body).toHaveProperty('suppress_count');
    expect(response.body).toHaveProperty('fork_count');
    expect(response.body).toHaveProperty('avg_cost_savings');
    expect(response.body).toHaveProperty('avg_outcome_improvement');
    expect(response.body).toHaveProperty('total_token_savings');
    expect(response.body).toHaveProperty('total_time_savings_ms');
    expect(response.body).toHaveProperty('trend_point_count');

    expect(typeof response.body.total_comparisons).toBe('number');
    expect(typeof response.body.trend_point_count).toBe('number');
  });

  // -------------------------------------------------------------------------
  // TC2: /trend returns an array
  // -------------------------------------------------------------------------
  it('TC2: /trend returns an array', async () => {
    const response = await request(app).get('/api/baselines/trend').expect(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TC3: /comparisons returns an array
  // -------------------------------------------------------------------------
  it('TC3: /comparisons returns an array', async () => {
    const response = await request(app).get('/api/baselines/comparisons').expect(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TC4: /breakdown returns an array
  // -------------------------------------------------------------------------
  it('TC4: /breakdown returns an array', async () => {
    const response = await request(app).get('/api/baselines/breakdown').expect(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TC5: /trend respects the ?days query parameter
  //
  // Seeds a snapshot with two trend rows: one 10 days ago (outside the 7-day
  // window) and one 3 days ago (inside the window). Asserts that ?days=7
  // returns exactly the in-window row and excludes the out-of-window row,
  // verifying that ensureFreshForDays() actually filters by cutoff date.
  // -------------------------------------------------------------------------
  it('TC5: /trend respects valid ?days parameter', async () => {
    const db = getTestDb();
    const snapshotId = randomUUID();

    // Insert the parent snapshot row (required by FK constraint).
    await db.insert(baselinesSnapshots).values({
      snapshotId,
      contractVersion: 1,
      computedAtUtc: new Date(),
    });

    // Build ISO date strings for the two trend points.
    const msPerDay = 24 * 60 * 60 * 1000;
    const dateTenDaysAgo = new Date(Date.now() - 10 * msPerDay).toISOString().slice(0, 10);
    const dateThreeDaysAgo = new Date(Date.now() - 3 * msPerDay).toISOString().slice(0, 10);

    // Insert trend row outside the 7-day window (10 days ago).
    await db.insert(baselinesTrend).values({
      snapshotId,
      date: dateTenDaysAgo,
      avgCostSavings: '0.100000',
      avgOutcomeImprovement: '0.050000',
      comparisonsEvaluated: 5,
    });

    // Insert trend row inside the 7-day window (3 days ago).
    await db.insert(baselinesTrend).values({
      snapshotId,
      date: dateThreeDaysAgo,
      avgCostSavings: '0.200000',
      avgOutcomeImprovement: '0.150000',
      comparisonsEvaluated: 10,
    });

    // Reset the projection cache so the route re-queries the newly seeded DB.
    resetBaselinesProjectionCache();

    const response = await request(app).get('/api/baselines/trend?days=7').expect(200);

    expect(Array.isArray(response.body)).toBe(true);

    // Exactly the in-window row (3 days ago) must be present.
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({ date: dateThreeDaysAgo });

    // The out-of-window row (10 days ago) must not appear.
    const returnedDates: string[] = response.body.map((r: { date: string }) => r.date);
    expect(returnedDates).not.toContain(dateTenDaysAgo);
  });

  // -------------------------------------------------------------------------
  // TC6: /summary reflects comparisons and breakdown rows seeded in the DB
  //
  // Seeds a snapshot with one trend row, one comparisons row (recommendation
  // 'promote'), and one breakdown row (action 'promote', count 3).
  // Asserts that _deriveSummary() propagates these into the summary fields
  // total_comparisons, promote_count, and trend_point_count so that the
  // end-to-end path from DB rows through BaselinesProjection to the API
  // response is exercised for all three child tables simultaneously.
  // -------------------------------------------------------------------------
  it('TC6: /summary correctly derives summary fields from comparisons and breakdown rows', async () => {
    const db = getTestDb();
    const snapshotId = randomUUID();

    // Insert the parent snapshot row (required by FK constraint on all child tables).
    await db.insert(baselinesSnapshots).values({
      snapshotId,
      contractVersion: 1,
      computedAtUtc: new Date(),
    });

    // Seed one trend row so trend_point_count is non-zero.
    const msPerDay = 24 * 60 * 60 * 1000;
    const dateYesterday = new Date(Date.now() - 1 * msPerDay).toISOString().slice(0, 10);
    await db.insert(baselinesTrend).values({
      snapshotId,
      date: dateYesterday,
      avgCostSavings: '0.300000',
      avgOutcomeImprovement: '0.200000',
      comparisonsEvaluated: 8,
    });

    // Seed one comparisons row with recommendation 'promote' so total_comparisons = 1.
    const emptyDelta = {
      label: '',
      baseline: 0,
      candidate: 0,
      delta: 0,
      direction: 'lower_is_better',
      unit: '',
    };
    await db.insert(baselinesComparisons).values({
      snapshotId,
      patternId: `pattern-${randomUUID().slice(0, 8)}`,
      patternName: 'test-pattern',
      sampleSize: 10,
      windowStart: dateYesterday,
      windowEnd: dateYesterday,
      tokenDelta: emptyDelta,
      timeDelta: emptyDelta,
      retryDelta: emptyDelta,
      testPassRateDelta: emptyDelta,
      reviewIterationDelta: emptyDelta,
      recommendation: 'promote',
      confidence: 'high',
      rationale: 'TC6 seeded row',
    });

    // Seed one breakdown row with action 'promote' and count 3 so promote_count = 3.
    await db.insert(baselinesBreakdown).values({
      snapshotId,
      action: 'promote',
      count: 3,
      avgConfidence: '0.9000',
    });

    // Reset the projection cache so the route re-queries the newly seeded DB.
    resetBaselinesProjectionCache();

    const response = await request(app).get('/api/baselines/summary').expect(200);

    // total_comparisons counts rows in the comparisons table → must be 1.
    expect(response.body.total_comparisons).toBe(1);

    // promote_count comes from the breakdown table (count field) → must be 3.
    expect(response.body.promote_count).toBe(3);

    // shadow/suppress/fork breakdown rows were not seeded → must be 0.
    expect(response.body.shadow_count).toBe(0);
    expect(response.body.suppress_count).toBe(0);
    expect(response.body.fork_count).toBe(0);

    // trend_point_count reflects the one seeded trend row → must be 1.
    expect(response.body.trend_point_count).toBe(1);

    // avg_cost_savings is the mean of the single trend row's value → ~0.3.
    expect(typeof response.body.avg_cost_savings).toBe('number');
    expect(response.body.avg_cost_savings).toBeCloseTo(0.3, 4);
  });
});
