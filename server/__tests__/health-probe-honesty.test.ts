/**
 * Health Probe Honesty Tests (OMN-6973)
 *
 * Validates that health probes distinguish between:
 * - Dependency truly unavailable -> report 'down'
 * - Probe logic error -> report 'degraded' with error detail, NOT false 'down'
 * - Partial state -> report 'degraded' with specifics
 *
 * Internal probe exceptions must NEVER collapse into false "service down" status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock dependencies
vi.mock('../event-consumer', () => ({
  eventConsumer: {
    getHealthStatus: vi.fn().mockReturnValue({ status: 'healthy' }),
  },
}));

vi.mock('../event-bus-data-source', () => ({
  getEventBusDataSource: vi.fn().mockReturnValue({ isActive: () => true }),
}));

vi.mock('../schema-health', () => ({
  checkSchemaParity: vi.fn(),
}));

import healthProbeRoutes, { clearHealthProbeCache } from '../health-probe-routes';
import { checkSchemaParity } from '../schema-health';

const mockCheckSchemaParity = vi.mocked(checkSchemaParity);

function createApp() {
  const app = express();
  app.use('/api/health-probe', healthProbeRoutes);
  return app;
}

describe('Health Probe Honesty (OMN-6973)', () => {
  beforeEach(() => {
    clearHealthProbeCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearHealthProbeCache();
  });

  it('should report database "up" when schema parity is clean', async () => {
    mockCheckSchemaParity.mockResolvedValue({
      applied_migrations_count: 72,
      disk_migrations_count: 72,
      schema_ok: true,
      missing_in_db: [],
      missing_on_disk: [],
      checked_at: new Date().toISOString(),
    });

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    expect(res.body.services.database).toBe('up');
    expect(res.body.status).toBe('up');
    expect(res.body.probeErrors).toBeUndefined();
  });

  it('should report database "degraded" when probe throws, NOT "down"', async () => {
    // Simulate the __dirname ESM bug: checkSchemaParity throws internally
    mockCheckSchemaParity.mockRejectedValue(new ReferenceError('__dirname is not defined'));

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    // CRITICAL: database must NOT be reported as 'down' for probe logic errors
    expect(res.body.services.database).toBe('degraded');
    expect(res.body.services.database).not.toBe('down');

    // Should include probe error detail
    expect(res.body.probeErrors).toBeDefined();
    expect(res.body.probeErrors).toHaveLength(1);
    expect(res.body.probeErrors[0]).toContain('__dirname is not defined');

    // Aggregate should be degraded (other services up, database degraded)
    expect(res.body.status).toBe('degraded');
  });

  it('should report database "down" when schema_ok is false (real drift)', async () => {
    // Simulate actual schema drift: probe runs successfully but finds issues
    mockCheckSchemaParity.mockResolvedValue({
      applied_migrations_count: 70,
      disk_migrations_count: 72,
      schema_ok: false,
      missing_in_db: ['0071_new.sql', '0072_new.sql'],
      missing_on_disk: [],
      checked_at: new Date().toISOString(),
    });

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    // Real drift -> legitimately 'down'
    expect(res.body.services.database).toBe('down');
    expect(res.body.probeErrors).toBeUndefined();
  });

  it('should not include probeErrors when no probe errors occurred', async () => {
    mockCheckSchemaParity.mockResolvedValue({
      applied_migrations_count: 72,
      disk_migrations_count: 72,
      schema_ok: true,
      missing_in_db: [],
      missing_on_disk: [],
      checked_at: new Date().toISOString(),
    });

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    expect(res.body.probeErrors).toBeUndefined();
  });
});
