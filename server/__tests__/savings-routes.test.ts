import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import savingsRoutes from '../savings-routes';

// Mock the projection's ensureFreshForWindow to return test data
vi.mock('../projections/savings-projection', () => {
  const payload = {
    summary: {
      totalEstimatedSavingsUsd: 125.50,
      totalDirectSavingsUsd: 80.25,
      totalTokensSaved: 50000,
      totalDirectTokensSaved: 32000,
      eventCount: 100,
      sessionCount: 25,
      avgConfidence: 0.72,
      avgDirectConfidence: 0.95,
      window: '7d',
    },
    trend: [
      {
        bucket: '2026-03-15T00:00:00.000Z',
        estimatedSavingsUsd: 18.5,
        directSavingsUsd: 11.2,
        tokensSaved: 7200,
        eventCount: 15,
      },
    ],
    categories: [
      {
        category: 'context_caching',
        totalSavingsUsd: 45.0,
        totalTokensSaved: 18000,
        avgConfidence: 0.85,
        eventCount: 40,
      },
    ],
    granularity: 'day',
  };

  class MockSavingsProjection {
    ensureFreshForWindow = vi.fn().mockResolvedValue(payload);
  }
  return { SavingsProjection: MockSavingsProjection };
});

describe('Savings Routes (DB-backed)', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/savings', savingsRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/savings/summary', () => {
    it('should return savings summary', async () => {
      const response = await request(app).get('/api/savings/summary').expect(200);

      expect(response.body).toHaveProperty('totalEstimatedSavingsUsd', 125.50);
      expect(response.body).toHaveProperty('totalDirectSavingsUsd', 80.25);
      expect(response.body).toHaveProperty('totalTokensSaved', 50000);
      expect(response.body).toHaveProperty('eventCount', 100);
      expect(response.body).toHaveProperty('sessionCount', 25);
      expect(response.body).toHaveProperty('window', '7d');
    });

    it('should accept window parameter', async () => {
      const response = await request(app).get('/api/savings/summary?window=24h').expect(200);
      expect(response.body).toHaveProperty('totalEstimatedSavingsUsd');
    });
  });

  describe('GET /api/savings/trend', () => {
    it('should return savings trend data', async () => {
      const response = await request(app).get('/api/savings/trend').expect(200);

      expect(response.body).toHaveProperty('trend');
      expect(Array.isArray(response.body.trend)).toBe(true);
      expect(response.body).toHaveProperty('granularity', 'day');
      expect(response.body).toHaveProperty('window', '7d');
    });
  });

  describe('GET /api/savings/categories', () => {
    it('should return category breakdown', async () => {
      const response = await request(app).get('/api/savings/categories').expect(200);

      expect(response.body).toHaveProperty('categories');
      expect(Array.isArray(response.body.categories)).toBe(true);
      expect(response.body.categories[0]).toHaveProperty('category', 'context_caching');
    });
  });

  describe('GET /api/savings/metrics (legacy)', () => {
    it('should return backwards-compatible metrics shape', async () => {
      const response = await request(app).get('/api/savings/metrics').expect(200);

      expect(response.body).toHaveProperty('totalSavings', 125.50);
      expect(response.body).toHaveProperty('monthlySavings');
      expect(response.body).toHaveProperty('weeklySavings');
      expect(response.body).toHaveProperty('dailySavings');
      expect(response.body).toHaveProperty('intelligenceRuns', 100);
      expect(response.body).toHaveProperty('dataAvailable', true);
    });

    it('should accept timeRange parameter', async () => {
      const response = await request(app).get('/api/savings/metrics?timeRange=30d').expect(200);
      expect(response.body).toHaveProperty('totalSavings');
    });
  });
});
