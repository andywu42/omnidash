import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// Mock storage module before importing routes
vi.mock('../storage', () => {
  const mockDb = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    groupBy: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };

  // Chain all methods
  mockDb.select.mockReturnValue(mockDb);
  mockDb.from.mockReturnValue(mockDb);
  mockDb.where.mockReturnValue(mockDb);
  mockDb.groupBy.mockReturnValue(mockDb);
  mockDb.orderBy.mockReturnValue(mockDb);
  mockDb.limit.mockReturnValue(mockDb);

  return {
    tryGetIntelligenceDb: vi.fn(() => mockDb),
    getIntelligenceDb: vi.fn(() => mockDb),
    __mockDb: mockDb,
  };
});

import traceRoutes from '../trace-routes';
import { tryGetIntelligenceDb } from '../storage';

let app: Express;
let mockDb: any;

describe('Trace Routes (OMN-5047)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/traces', traceRoutes);

    // Get mock db reference
    mockDb = (tryGetIntelligenceDb as any)();
  });

  describe('GET /api/traces/recent', () => {
    it('should return 503 when database is not available', async () => {
      vi.mocked(tryGetIntelligenceDb).mockReturnValueOnce(null);

      const response = await request(app).get('/api/traces/recent').expect(503);

      expect(response.body).toHaveProperty('error', 'Database not available');
    });

    it('should return empty array when no traces exist', async () => {
      // Reset and set up the mock chain to resolve
      mockDb.select.mockReturnValue(mockDb);
      mockDb.from.mockReturnValue(mockDb);
      mockDb.groupBy.mockReturnValue(mockDb);
      mockDb.orderBy.mockReturnValue(mockDb);
      mockDb.limit.mockResolvedValueOnce([]);

      const response = await request(app).get('/api/traces/recent').expect(200);

      expect(response.body).toEqual([]);
    });

    it('should accept a limit parameter', async () => {
      mockDb.select.mockReturnValue(mockDb);
      mockDb.from.mockReturnValue(mockDb);
      mockDb.groupBy.mockReturnValue(mockDb);
      mockDb.orderBy.mockReturnValue(mockDb);
      mockDb.limit.mockResolvedValueOnce([]);

      await request(app).get('/api/traces/recent?limit=5').expect(200);

      expect(mockDb.limit).toHaveBeenCalledWith(5);
    });

    it('should cap limit at 100', async () => {
      mockDb.select.mockReturnValue(mockDb);
      mockDb.from.mockReturnValue(mockDb);
      mockDb.groupBy.mockReturnValue(mockDb);
      mockDb.orderBy.mockReturnValue(mockDb);
      mockDb.limit.mockResolvedValueOnce([]);

      await request(app).get('/api/traces/recent?limit=999').expect(200);

      expect(mockDb.limit).toHaveBeenCalledWith(100);
    });
  });

  describe('GET /api/traces/sessions/recent', () => {
    it('should return 503 when database is not available', async () => {
      vi.mocked(tryGetIntelligenceDb).mockReturnValueOnce(null);

      const response = await request(app).get('/api/traces/sessions/recent').expect(503);

      expect(response.body).toHaveProperty('error', 'Database not available');
    });
  });

  describe('GET /api/traces/:traceId/spans', () => {
    it('should return 503 when database is not available', async () => {
      vi.mocked(tryGetIntelligenceDb).mockReturnValueOnce(null);

      const response = await request(app).get('/api/traces/trace-abc-123/spans').expect(503);

      expect(response.body).toHaveProperty('error', 'Database not available');
    });

    it('should return empty spans array when no spans found', async () => {
      mockDb.select.mockReturnValue(mockDb);
      mockDb.from.mockReturnValue(mockDb);
      mockDb.where.mockReturnValue(mockDb);
      mockDb.orderBy.mockResolvedValueOnce([]);

      const response = await request(app).get('/api/traces/trace-abc-123/spans').expect(200);

      expect(response.body).toEqual({
        traceId: 'trace-abc-123',
        spans: [],
        summary: null,
      });
    });
  });

  describe('GET /api/traces/session/:sessionId', () => {
    it('should return 503 when database is not available', async () => {
      vi.mocked(tryGetIntelligenceDb).mockReturnValueOnce(null);

      const response = await request(app).get('/api/traces/session/session-001').expect(503);

      expect(response.body).toHaveProperty('error', 'Database not available');
    });

    it('should return session traces when data exists', async () => {
      mockDb.select.mockReturnValue(mockDb);
      mockDb.from.mockReturnValue(mockDb);
      mockDb.where.mockReturnValue(mockDb);
      mockDb.groupBy.mockReturnValue(mockDb);
      mockDb.orderBy.mockResolvedValueOnce([]);

      const response = await request(app).get('/api/traces/session/session-001').expect(200);

      expect(response.body).toEqual({
        sessionId: 'session-001',
        traceCount: 0,
        traces: [],
      });
    });
  });
});
