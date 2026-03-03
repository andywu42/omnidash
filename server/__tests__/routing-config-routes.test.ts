/**
 * Unit tests for routing-config-routes (OMN-3445)
 *
 * Tests:
 *   GET /api/routing-config/:key  — returns value or null
 *   PUT /api/routing-config/:key  — upserts and returns new value
 *   PUT with empty value          — returns 400
 *   DB unavailable                — returns 503
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import routingConfigRoutes from '../routing-config-routes';

// ---------------------------------------------------------------------------
// Mock storage module
// ---------------------------------------------------------------------------

const mockExecute = vi.fn();
const mockDb = { execute: mockExecute };

vi.mock('../storage', () => ({
  tryGetIntelligenceDb: vi.fn(() => mockDb),
}));

import { tryGetIntelligenceDb } from '../storage';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('routing-config-routes (OMN-3445)', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/routing-config', routingConfigRoutes);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // GET /api/routing-config/:key
  // -------------------------------------------------------------------------

  describe('GET /api/routing-config/:key', () => {
    it('returns { key, value } when the key exists', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [{ key: 'active_routing_model', value: 'Qwen/Qwen3-14B-AWQ' }],
      });

      const res = await request(app).get('/api/routing-config/active_routing_model');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key: 'active_routing_model', value: 'Qwen/Qwen3-14B-AWQ' });
    });

    it('returns { key, value: null } when the key does not exist', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/routing-config/unknown_key');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key: 'unknown_key', value: null });
    });

    it('returns 503 when database is unavailable', async () => {
      vi.mocked(tryGetIntelligenceDb).mockReturnValueOnce(null);

      const res = await request(app).get('/api/routing-config/active_routing_model');

      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty('error');
    });

    it('returns 500 on unexpected db error', async () => {
      mockExecute.mockRejectedValueOnce(new Error('connection reset'));

      const res = await request(app).get('/api/routing-config/active_routing_model');

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/routing-config/:key
  // -------------------------------------------------------------------------

  describe('PUT /api/routing-config/:key', () => {
    it('upserts and returns { key, value }', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .put('/api/routing-config/active_routing_model')
        .send({ value: 'Qwen/Qwen3-30B-AWQ' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key: 'active_routing_model', value: 'Qwen/Qwen3-30B-AWQ' });
    });

    it('returns 400 when value is an empty string', async () => {
      const res = await request(app)
        .put('/api/routing-config/active_routing_model')
        .send({ value: '' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      // DB should not be called for invalid input
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('returns 400 when value field is missing', async () => {
      const res = await request(app).put('/api/routing-config/active_routing_model').send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('returns 503 when database is unavailable', async () => {
      vi.mocked(tryGetIntelligenceDb).mockReturnValueOnce(null);

      const res = await request(app)
        .put('/api/routing-config/active_routing_model')
        .send({ value: 'Qwen/Qwen3-30B-AWQ' });

      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty('error');
    });

    it('returns 500 on unexpected db error', async () => {
      mockExecute.mockRejectedValueOnce(new Error('deadlock'));

      const res = await request(app)
        .put('/api/routing-config/active_routing_model')
        .send({ value: 'Qwen/Qwen3-30B-AWQ' });

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });
});
