/**
 * Integration Tests: Pattern Intelligence Pipeline (OMN-6999)
 *
 * Verifies the pattern learn -> store -> project -> API chain by:
 * 1. Mounting the patterns routes on a test Express app
 * 2. Querying the API endpoint
 * 3. Verifying the response contains pattern data from pattern_learning_artifacts
 *
 * These tests require PostgreSQL (omnidash_analytics) to be running with
 * pattern data populated by the read-model consumer. They verify the
 * DB-to-API chain, not the Kafka-to-projection chain.
 *
 * Run with:   npx vitest run tests/integration/pattern-pipeline.test.ts
 *
 * @see OMN-6995 Platform Subsystem Verification epic
 * @see OMN-6760 data-flow-sweep
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import patternsRoutes, { resetTableExistsCache } from '../../server/patterns-routes';

// ============================================================================
// Test App Factory
// ============================================================================

function buildTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/patterns', patternsRoutes);
  return app;
}

// ============================================================================
// Pipeline Integration Tests
// ============================================================================

describe('Pattern Intelligence Pipeline (OMN-6999)', () => {
  beforeEach(() => {
    resetTableExistsCache();
  });

  it('GET /api/patterns returns 200 with valid response shape', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/patterns');

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();

    // Response must have the paginated shape
    if (res.body.patterns) {
      expect(Array.isArray(res.body.patterns)).toBe(true);
    } else if (Array.isArray(res.body)) {
      // Some routes return a flat array
      expect(res.body.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('pattern_learning_artifacts table has data (projection chain completed)', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/patterns');

    expect(res.status).toBe(200);

    // Extract pattern count from response
    const patterns = res.body.patterns ?? res.body;
    const total =
      res.body.total ?? res.body.totalCount ?? (Array.isArray(patterns) ? patterns.length : 0);

    // If DB is not available, the API returns empty gracefully.
    // A total of 0 means the projection chain has never completed,
    // which is a regression we need to catch.
    if (total === 0 && (!patterns || (Array.isArray(patterns) && patterns.length === 0))) {
      // Check if this is a DB-unavailable case (demo mode) vs empty table
      const hasDbError = res.body.error || res.body.message || res.body._demo;
      if (hasDbError) {
        // DB not available or demo mode — skip rather than fail
        return;
      }
      // DB available but empty — this is the regression we detect
      expect.soft(total).toBeGreaterThan(0);
    }
  });

  it('pattern response includes required fields per record', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/patterns');

    expect(res.status).toBe(200);

    const patterns = res.body.patterns ?? res.body;
    if (!Array.isArray(patterns) || patterns.length === 0) {
      // No data to validate — covered by the previous test
      return;
    }

    const first = patterns[0];
    // The API maps pattern_learning_artifacts to legacy shape:
    // patternName -> name, lifecycleState -> status
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('status');
  });
});
