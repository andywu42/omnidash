/**
 * Integration Tests: Staleness API Endpoint (OMN-6398)
 *
 * Run with: npx vitest run tests/integration/staleness-api.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import stalenessRoutes, { clearStalenessCache } from '../../server/staleness-routes';
import type { StalenessApiResponse } from '../../shared/staleness-types';

function buildTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/staleness', stalenessRoutes);
  return app;
}

describe('GET /api/staleness', () => {
  beforeEach(() => {
    clearStalenessCache();
  });

  it('returns 200 with valid response shape', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/staleness');

    expect(res.status).toBe(200);
    const body = res.body as StalenessApiResponse;

    expect(body).toHaveProperty('features');
    expect(body).toHaveProperty('checkedAt');
    expect(typeof body.features).toBe('object');
  });

  it('returns expected feature names', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/staleness');

    expect(res.status).toBe(200);
    const body = res.body as StalenessApiResponse;

    const featureNames = Object.keys(body.features);
    expect(featureNames).toContain('patterns');
    expect(featureNames).toContain('enforcement');
    expect(featureNames).toContain('effectiveness');
    expect(featureNames).toContain('llm-routing');
    expect(featureNames).toContain('intent-signals');
    expect(featureNames).toContain('session-outcomes');
  });

  it('each feature has expected fields', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/staleness');

    expect(res.status).toBe(200);
    const body = res.body as StalenessApiResponse;

    for (const feature of Object.values(body.features)) {
      expect(feature).toHaveProperty('name');
      expect(feature).toHaveProperty('lastUpdated');
      expect(feature).toHaveProperty('stale');
      expect(feature).toHaveProperty('severityLevel');
      expect(typeof feature.stale).toBe('boolean');
      expect(['fresh', 'aging', 'stale', 'critical']).toContain(feature.severityLevel);
    }
  });

  it('sets Cache-Control: no-store header', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/staleness');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
