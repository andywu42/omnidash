/**
 * Schema Health Endpoint Tests (OMN-3751)
 *
 * Tests the /api/health/schema endpoint that checks migration parity
 * between disk files and the database.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock storage before importing the module under test
vi.mock('../storage', () => ({
  tryGetIntelligenceDb: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
  getDatabaseError: vi.fn(() => null),
}));

// Mock fs to control what migration files exist on disk
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => {
        if (typeof p === 'string' && p.includes('migrations')) return true;
        return actual.existsSync(p);
      }),
      readdirSync: vi.fn((p: string) => {
        if (typeof p === 'string' && p.includes('migrations')) {
          return ['0001_test.sql', '0002_test.sql', '0003_test.sql'];
        }
        return actual.readdirSync(p);
      }),
    },
    existsSync: vi.fn((p: string) => {
      if (typeof p === 'string' && p.includes('migrations')) return true;
      return actual.existsSync(p);
    }),
    readdirSync: vi.fn((p: string) => {
      if (typeof p === 'string' && p.includes('migrations')) {
        return ['0001_test.sql', '0002_test.sql', '0003_test.sql'];
      }
      return actual.readdirSync(p);
    }),
  };
});

import schemaHealthRoutes, { clearSchemaHealthCache } from '../schema-health';
import { tryGetIntelligenceDb } from '../storage';

const mockTryGetDb = vi.mocked(tryGetIntelligenceDb);

function createApp() {
  const app = express();
  app.use('/api/health', schemaHealthRoutes);
  return app;
}

describe('GET /api/health/schema', () => {
  beforeEach(() => {
    clearSchemaHealthCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearSchemaHealthCache();
  });

  it('returns 200 with schema_ok=true when parity is clean', async () => {
    // Mock DB returning the same 3 migrations as disk
    mockTryGetDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        rows: [
          { filename: '0001_test.sql' },
          { filename: '0002_test.sql' },
          { filename: '0003_test.sql' },
        ],
      }),
    } as any);

    const app = createApp();
    const res = await request(app).get('/api/health/schema');

    expect(res.status).toBe(200);
    expect(res.body.schema_ok).toBe(true);
    expect(res.body.applied_migrations_count).toBe(3);
    expect(res.body.disk_migrations_count).toBe(3);
    expect(res.body.missing_in_db).toEqual([]);
    expect(res.body.missing_on_disk).toEqual([]);
    expect(res.body.checked_at).toBeDefined();
  });

  it('returns 503 with schema_ok=false when DB has fewer migrations', async () => {
    // DB only has 2 of the 3 disk migrations
    mockTryGetDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        rows: [{ filename: '0001_test.sql' }, { filename: '0002_test.sql' }],
      }),
    } as any);

    const app = createApp();
    const res = await request(app).get('/api/health/schema');

    expect(res.status).toBe(503);
    expect(res.body.schema_ok).toBe(false);
    expect(res.body.missing_in_db).toEqual(['0003_test.sql']);
  });

  it('returns 503 when DB is unavailable', async () => {
    mockTryGetDb.mockReturnValue(null);

    const app = createApp();
    const res = await request(app).get('/api/health/schema');

    expect(res.status).toBe(503);
    expect(res.body.schema_ok).toBe(false);
    expect(res.body.missing_in_db).toContain('(database unavailable)');
  });

  it('returns 503 when DB has migrations not on disk', async () => {
    mockTryGetDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        rows: [
          { filename: '0001_test.sql' },
          { filename: '0002_test.sql' },
          { filename: '0003_test.sql' },
          { filename: '0004_phantom.sql' },
        ],
      }),
    } as any);

    const app = createApp();
    const res = await request(app).get('/api/health/schema');

    expect(res.status).toBe(503);
    expect(res.body.schema_ok).toBe(false);
    expect(res.body.missing_on_disk).toEqual(['0004_phantom.sql']);
  });

  it('caches results for 30 seconds', async () => {
    const mockExecute = vi.fn().mockResolvedValue({
      rows: [
        { filename: '0001_test.sql' },
        { filename: '0002_test.sql' },
        { filename: '0003_test.sql' },
      ],
    });
    mockTryGetDb.mockReturnValue({ execute: mockExecute } as any);

    const app = createApp();

    // First request
    await request(app).get('/api/health/schema');
    expect(mockExecute).toHaveBeenCalledTimes(1);

    // Second request should hit cache
    await request(app).get('/api/health/schema');
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('sets Cache-Control: no-store header', async () => {
    mockTryGetDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as any);

    const app = createApp();
    const res = await request(app).get('/api/health/schema');

    expect(res.headers['cache-control']).toBe('no-store');
  });
});
