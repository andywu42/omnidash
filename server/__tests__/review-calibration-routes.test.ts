/**
 * Review Calibration Routes Tests (OMN-6176)
 *
 * Exercises the /api/review-calibration endpoints (history, scores, fewshot-log)
 * by mocking the ReviewCalibrationProjection. Tests cover both happy path
 * (data present) and empty state (projection returns empty payload).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// ---------------------------------------------------------------------------
// Mock projection-bootstrap
// ---------------------------------------------------------------------------

const mockQueryHistory = vi.fn();
const mockEnsureFresh = vi.fn();

vi.mock('../projection-bootstrap', () => ({
  projectionService: {
    getView: vi.fn(),
    viewIds: [],
    registerView: vi.fn(),
    unregisterView: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  },
  wireProjectionSources: vi.fn(() => () => {}),
  reviewCalibrationProjection: {
    queryHistory: (...args: unknown[]) => mockQueryHistory(...args),
    ensureFresh: (...args: unknown[]) => mockEnsureFresh(...args),
  },
}));

// Mock storage to prevent import side effects
vi.mock('../storage', () => ({
  tryGetIntelligenceDb: vi.fn(() => null),
  getIntelligenceDb: vi.fn(() => {
    throw new Error('not configured');
  }),
  isDatabaseConfigured: vi.fn(() => false),
  getDatabaseError: vi.fn(() => 'mocked'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let app: Express;

async function setupApp() {
  const routeModule = await import('../review-calibration-routes');
  app = express();
  app.use(express.json());
  app.use('/api/review-calibration', routeModule.default);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Review Calibration Routes', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // Default: return empty data
    mockQueryHistory.mockResolvedValue([]);
    mockEnsureFresh.mockResolvedValue({
      runs: [],
      models: [],
      fewshot: { prompt_version: null, example_count: 0, last_updated: null },
    });
    await setupApp();
  });

  describe('GET /api/review-calibration/history', () => {
    it('returns empty runs array when no data', async () => {
      const res = await request(app).get('/api/review-calibration/history');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ runs: [] });
      expect(mockQueryHistory).toHaveBeenCalledWith(undefined, 50);
    });

    it('returns formatted runs when data exists', async () => {
      const mockRuns = [
        {
          run_id: 'run-1',
          ground_truth_model: 'claude-opus',
          challenger_model: 'deepseek-r1',
          precision: 0.85,
          recall: 0.9,
          f1: 0.875,
          noise_ratio: 0.1,
          created_at: '2026-03-23T10:00:00.000Z',
        },
      ];
      mockQueryHistory.mockResolvedValue(mockRuns);

      const res = await request(app).get(
        '/api/review-calibration/history?model=deepseek-r1&limit=10'
      );
      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0]).toMatchObject({
        run_id: 'run-1',
        ground_truth_model: 'claude-opus',
        challenger_model: 'deepseek-r1',
        precision: 0.85,
        recall: 0.9,
        f1: 0.875,
        noise_ratio: 0.1,
      });
      expect(mockQueryHistory).toHaveBeenCalledWith('deepseek-r1', 10);
    });

    it('caps limit at 500', async () => {
      await request(app).get('/api/review-calibration/history?limit=9999');
      expect(mockQueryHistory).toHaveBeenCalledWith(undefined, 500);
    });
  });

  describe('GET /api/review-calibration/scores', () => {
    it('returns empty models array when no data', async () => {
      const res = await request(app).get('/api/review-calibration/scores');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ models: [] });
    });

    it('returns model scores when data exists', async () => {
      mockEnsureFresh.mockResolvedValue({
        runs: [],
        models: [
          {
            model_id: 'deepseek-r1',
            score_correctness: 0.875,
            run_count: 10,
            calibration_run_count: 5,
          },
        ],
        fewshot: { prompt_version: null, example_count: 0, last_updated: null },
      });

      const res = await request(app).get('/api/review-calibration/scores');
      expect(res.status).toBe(200);
      expect(res.body.models).toHaveLength(1);
      expect(res.body.models[0]).toMatchObject({
        model_id: 'deepseek-r1',
        score_correctness: 0.875,
        run_count: 10,
        calibration_run_count: 5,
      });
    });
  });

  describe('GET /api/review-calibration/fewshot-log', () => {
    it('returns empty fewshot log when no data', async () => {
      const res = await request(app).get('/api/review-calibration/fewshot-log');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt_version: null,
        example_count: 0,
        last_updated: null,
      });
    });

    it('returns fewshot metadata when data exists', async () => {
      mockEnsureFresh.mockResolvedValue({
        runs: [],
        models: [],
        fewshot: {
          prompt_version: 'v1',
          example_count: 42,
          last_updated: '2026-03-23 10:00:00+00',
        },
      });

      const res = await request(app).get('/api/review-calibration/fewshot-log');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        prompt_version: 'v1',
        example_count: 42,
      });
    });
  });
});
