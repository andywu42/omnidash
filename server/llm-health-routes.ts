/**
 * LLM Health API Routes (OMN-5279)
 *
 * REST endpoints for the LLM Health Dashboard:
 *   GET /api/llm-health         — latest snapshot per model + recent history
 *   GET /api/llm-health/history — paginated history for a specific model_id
 *
 * Data is served via LlmHealthProjection (DB-backed, TTL-cached).
 * Per OMN-2325: no direct DB imports in route files.
 */

import { Router } from 'express';
import { llmHealthProjection } from './projection-bootstrap';

const router = Router();

// ============================================================================
// GET /api/llm-health
// Returns: { models: LlmModelHealth[], history: LlmModelHealth[], generatedAt: string }
// ============================================================================

router.get('/', async (_req, res) => {
  try {
    const payload = await llmHealthProjection.ensureFresh();
    return res.json(payload);
  } catch (err) {
    console.error('[llm-health] Error fetching LLM health data:', err);
    return res.status(500).json({ error: 'Failed to fetch LLM health data' });
  }
});

// ============================================================================
// GET /api/llm-health/history?modelId=<id>&limit=<n>
// Returns last N rows for a specific model from the cached snapshot
// ============================================================================

router.get('/history', async (req, res) => {
  const modelId = String(req.query.modelId ?? '').trim();
  const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);

  if (!modelId) {
    return res.status(400).json({ error: 'modelId query param required' });
  }

  try {
    const payload = await llmHealthProjection.ensureFresh();
    const rows = payload.history.filter((r) => r.modelId === modelId).slice(0, limit);
    return res.json({ rows });
  } catch (err) {
    console.error('[llm-health] Error fetching history:', err);
    return res.status(500).json({ error: 'Failed to fetch LLM health history' });
  }
});

export default router;
