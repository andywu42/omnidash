/**
 * Health Probe Honesty Tests (OMN-6973, OMN-6982, updated for OMN-7125 single-consumer)
 *
 * Validates that health probes distinguish between:
 * - Dependency truly unavailable -> report 'down'
 * - Probe logic error -> report 'degraded' with error detail, NOT false 'down'
 * - Partial state -> report 'degraded' with specifics
 *
 * Internal probe exceptions must NEVER collapse into false "service down" status.
 * This applies to ALL three probes: database, event consumer, and event bus.
 *
 * OMN-7125: event-consumer was deleted. The health probe now checks consumer
 * liveness via projection_watermarks DB query instead of eventConsumer.getHealthStatus().
 *
 * OMN-6982: Extended honesty to event consumer and event bus probes.
 * Previously only the database probe had the degraded/error distinction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock dependencies — OMN-7125: storage replaces event-consumer for consumer health
vi.mock('../storage', () => ({
  tryGetIntelligenceDb: vi.fn(),
}));

vi.mock('../event-bus-data-source', () => ({
  getEventBusDataSource: vi.fn().mockReturnValue({ isActive: () => true }),
}));

vi.mock('../schema-health', () => ({
  checkSchemaParity: vi.fn(),
}));

import healthProbeRoutes, { clearHealthProbeCache } from '../health-probe-routes';
import { checkSchemaParity } from '../schema-health';
import { tryGetIntelligenceDb } from '../storage';
import { getEventBusDataSource } from '../event-bus-data-source';

const mockCheckSchemaParity = vi.mocked(checkSchemaParity);
const mockTryGetIntelligenceDb = vi.mocked(tryGetIntelligenceDb);
const mockGetEventBusDataSource = vi.mocked(getEventBusDataSource);

/**
 * Create a mock DB that returns watermark rows indicating healthy consumer.
 */
function mockHealthyDb() {
  const now = new Date().toISOString();
  return {
    execute: vi.fn().mockResolvedValue({
      rows: [
        { projection_name: 'topic-a:0', last_offset: 100, updated_at: now },
        { projection_name: 'topic-b:0', last_offset: 200, updated_at: now },
        { projection_name: 'topic-c:0', last_offset: 300, updated_at: now },
      ],
    }),
  };
}

function mockSchemaOk() {
  mockCheckSchemaParity.mockResolvedValue({
    applied_migrations_count: 72,
    disk_migrations_count: 72,
    schema_ok: true,
    missing_in_db: [],
    missing_on_disk: [],
    checked_at: new Date().toISOString(),
  });
}

function createApp() {
  const app = express();
  app.use('/api/health-probe', healthProbeRoutes);
  return app;
}

describe('Health Probe Honesty (OMN-6973)', () => {
  beforeEach(() => {
    clearHealthProbeCache();
    vi.clearAllMocks();
    // Default: DB available with healthy watermarks, bus active, schema OK
    mockTryGetIntelligenceDb.mockReturnValue(mockHealthyDb() as any);
    mockGetEventBusDataSource.mockReturnValue({ isActive: () => true } as any);
    mockSchemaOk();
  });

  afterEach(() => {
    clearHealthProbeCache();
  });

  // -------------------------------------------------------------------------
  // Database probe honesty
  // -------------------------------------------------------------------------

  it('should report database "up" when schema parity is clean', async () => {
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
    expect(res.body.probeErrors.some((e: string) => e.includes('__dirname is not defined'))).toBe(
      true
    );

    // Aggregate should be degraded (other services up, database degraded)
    expect(res.body.status).toBe('degraded');
  });

  it('should report database "down" when schema_ok is false (real drift)', async () => {
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
  });

  it('should not include probeErrors when no probe errors occurred', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    expect(res.body.probeErrors).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Event consumer probe honesty (OMN-6982)
  // -------------------------------------------------------------------------

  it('should report eventConsumer "degraded" when DB query throws, NOT "down"', async () => {
    // Simulate a DB connection error during watermark query
    const brokenDb = {
      execute: vi.fn().mockRejectedValue(new Error('connection terminated unexpectedly')),
    };
    mockTryGetIntelligenceDb.mockReturnValue(brokenDb as any);

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    // CRITICAL: probe logic error must NOT report false 'down'
    expect(res.body.services.eventConsumer).toBe('degraded');
    expect(res.body.services.eventConsumer).not.toBe('down');

    // Should include error detail for the consumer probe
    expect(res.body.probeErrors).toBeDefined();
    expect(res.body.probeErrors.some((e: string) => e.includes('event-consumer probe error'))).toBe(
      true
    );
    expect(
      res.body.probeErrors.some((e: string) => e.includes('connection terminated unexpectedly'))
    ).toBe(true);
  });

  it('should report eventConsumer "down" when no watermarks exist (real absence)', async () => {
    // Consumer is truly not running: DB is up but watermarks table is empty
    const emptyDb = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };
    mockTryGetIntelligenceDb.mockReturnValue(emptyDb as any);

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    // No watermarks = consumer genuinely not processing -> 'down' is honest
    expect(res.body.services.eventConsumer).toBe('down');
    // No probe error — the probe ran correctly, it just found nothing
    expect(res.body.probeErrors?.some((e: string) => e.includes('event-consumer'))).toBeFalsy();
  });

  it('should report eventConsumer "down" when watermarks are stale (real lag)', async () => {
    // Watermarks exist but are old — consumer has stopped processing
    const staleTime = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    const staleDb = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { projection_name: 'topic-a:0', last_offset: 100, updated_at: staleTime },
          { projection_name: 'topic-b:0', last_offset: 200, updated_at: staleTime },
          { projection_name: 'topic-c:0', last_offset: 300, updated_at: staleTime },
        ],
      }),
    };
    mockTryGetIntelligenceDb.mockReturnValue(staleDb as any);

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    // Stale watermarks = consumer genuinely behind -> 'down' is honest
    expect(res.body.services.eventConsumer).toBe('down');
  });

  // -------------------------------------------------------------------------
  // Event bus probe honesty (OMN-6982)
  // -------------------------------------------------------------------------

  it('should report eventBus "degraded" when getEventBusDataSource throws, NOT "down"', async () => {
    // Simulate a runtime error in the bus probe (e.g., config parse failure)
    mockGetEventBusDataSource.mockImplementation(() => {
      throw new TypeError('Cannot read properties of undefined');
    });

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    // CRITICAL: probe logic error must NOT report false 'down'
    expect(res.body.services.eventBus).toBe('degraded');
    expect(res.body.services.eventBus).not.toBe('down');

    // Should include error detail for the bus probe
    expect(res.body.probeErrors).toBeDefined();
    expect(res.body.probeErrors.some((e: string) => e.includes('event-bus probe error'))).toBe(
      true
    );
  });

  it('should report eventBus "down" when data source is not active (real absence)', async () => {
    // Bus data source exists but is not active — genuinely not connected
    mockGetEventBusDataSource.mockReturnValue({ isActive: () => false } as any);

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    // Bus genuinely not active -> 'down' is honest
    expect(res.body.services.eventBus).toBe('down');
    // No probe error — the probe ran correctly
    expect(res.body.probeErrors?.some((e: string) => e.includes('event-bus'))).toBeFalsy();
  });

  it('should report eventBus "degraded" when isActive() throws, NOT "down"', async () => {
    // Simulate isActive() throwing (e.g., internal state corruption)
    mockGetEventBusDataSource.mockReturnValue({
      isActive: () => {
        throw new Error('internal state corrupted');
      },
    } as any);

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    expect(res.body.services.eventBus).toBe('degraded');
    expect(res.body.services.eventBus).not.toBe('down');
    expect(res.body.probeErrors).toBeDefined();
    expect(res.body.probeErrors.some((e: string) => e.includes('internal state corrupted'))).toBe(
      true
    );
  });

  // -------------------------------------------------------------------------
  // Multi-probe error accumulation (OMN-6982)
  // -------------------------------------------------------------------------

  it('should accumulate probeErrors from multiple failing probes', async () => {
    // All three probes throw
    const brokenDb = {
      execute: vi.fn().mockRejectedValue(new Error('DB gone')),
    };
    mockTryGetIntelligenceDb.mockReturnValue(brokenDb as any);
    mockGetEventBusDataSource.mockImplementation(() => {
      throw new Error('bus config missing');
    });
    mockCheckSchemaParity.mockRejectedValue(new Error('schema check failed'));

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    // All probes errored -> all degraded, none falsely 'down'
    expect(res.body.services.eventConsumer).toBe('degraded');
    expect(res.body.services.eventBus).toBe('degraded');
    expect(res.body.services.database).toBe('degraded');

    // Aggregate: all degraded = 'degraded' (not 'down')
    expect(res.body.status).toBe('degraded');

    // All three probe errors should be listed
    expect(res.body.probeErrors).toHaveLength(3);
    expect(res.body.probeErrors.some((e: string) => e.includes('event-consumer'))).toBe(true);
    expect(res.body.probeErrors.some((e: string) => e.includes('event-bus'))).toBe(true);
    expect(res.body.probeErrors.some((e: string) => e.includes('schema-parity'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Aggregate status correctness
  // -------------------------------------------------------------------------

  it('should report aggregate "up" only when ALL services are up', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    expect(res.body.status).toBe('up');
    expect(res.body.services.eventConsumer).toBe('up');
    expect(res.body.services.eventBus).toBe('up');
    expect(res.body.services.database).toBe('up');
  });

  it('should report aggregate "degraded" when mix of up and down', async () => {
    // Bus inactive (real down), others up
    mockGetEventBusDataSource.mockReturnValue({ isActive: () => false } as any);

    const app = createApp();
    const res = await request(app).get('/api/health-probe');

    expect(res.body.status).toBe('degraded');
    expect(res.body.services.eventBus).toBe('down');
    expect(res.body.services.eventConsumer).toBe('up');
    expect(res.body.services.database).toBe('up');
  });
});
