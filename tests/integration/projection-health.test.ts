/**
 * Integration Tests: Projection Health Diagnostic Endpoint (OMN-6390)
 *
 * Tests the /api/projection-health endpoint response shape and behavior.
 * Tests run against the route handler with mocked DB where needed.
 *
 * Run with:   npx vitest run tests/integration/projection-health.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import projectionHealthRoutes, {
  clearProjectionHealthCache,
  type ProjectionHealthResponse,
} from '../../server/projection-health-routes';

// ============================================================================
// Test App Factory
// ============================================================================

function buildTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/projection-health', projectionHealthRoutes);
  return app;
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/projection-health', () => {
  beforeEach(() => {
    clearProjectionHealthCache();
  });

  it('returns 200 with valid response shape', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/projection-health');

    expect(res.status).toBe(200);
    const body = res.body as ProjectionHealthResponse;

    // Must have the expected top-level fields
    expect(body).toHaveProperty('tables');
    expect(body).toHaveProperty('watermarks');
    expect(body).toHaveProperty('summary');
    expect(body).toHaveProperty('checkedAt');

    // Summary must have the expected structure
    expect(body.summary).toHaveProperty('totalTables');
    expect(body.summary).toHaveProperty('populatedTables');
    expect(body.summary).toHaveProperty('emptyTables');
    expect(body.summary).toHaveProperty('staleTables');

    // totalTables = populated + empty
    expect(body.summary.totalTables).toBe(
      body.summary.populatedTables + body.summary.emptyTables
    );
  });

  it('returns tables as a record with expected fields per entry', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/projection-health');

    expect(res.status).toBe(200);
    const body = res.body as ProjectionHealthResponse;

    // If DB is available, tables should be populated
    // If DB is unavailable, tables will be empty object (graceful degradation)
    if (Object.keys(body.tables).length > 0) {
      const firstTable = Object.values(body.tables)[0];
      expect(firstTable).toHaveProperty('rowCount');
      expect(firstTable).toHaveProperty('lastUpdated');
      expect(firstTable).toHaveProperty('stale');
      expect(firstTable).toHaveProperty('staleThresholdMinutes');
      expect(typeof firstTable.rowCount).toBe('number');
      expect(typeof firstTable.stale).toBe('boolean');
      expect(typeof firstTable.staleThresholdMinutes).toBe('number');
    }
  });

  it('accepts custom staleThresholdMinutes query param', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/projection-health?staleThresholdMinutes=120');

    expect(res.status).toBe(200);
    const body = res.body as ProjectionHealthResponse;

    // All tables should use the custom threshold
    for (const table of Object.values(body.tables)) {
      expect(table.staleThresholdMinutes).toBe(120);
    }
  });

  it('watermarks array has expected fields when populated', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/projection-health');

    expect(res.status).toBe(200);
    const body = res.body as ProjectionHealthResponse;
    expect(Array.isArray(body.watermarks)).toBe(true);

    if (body.watermarks.length > 0) {
      const wm = body.watermarks[0];
      expect(wm).toHaveProperty('projectionName');
      expect(wm).toHaveProperty('lastOffset');
      expect(wm).toHaveProperty('eventsProjected');
      expect(wm).toHaveProperty('errorsCount');
    }
  });

  it('sets Cache-Control: no-store header', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/projection-health');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('gracefully degrades when DB is unavailable', async () => {
    // This test relies on the tryGetIntelligenceDb returning null
    // when no DB is configured (which is the case in test env without DB)
    const app = buildTestApp();
    const res = await request(app).get('/api/projection-health');

    expect(res.status).toBe(200);
    const body = res.body as ProjectionHealthResponse;

    // Should return empty but valid response, not 500
    expect(body).toHaveProperty('tables');
    expect(body).toHaveProperty('summary');
    expect(body).toHaveProperty('checkedAt');
  });
});
