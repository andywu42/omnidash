/**
 * Doc Freshness Sweep API Routes (feature-hookup Phase 2)
 *
 * REST endpoints for doc freshness sweep results:
 *   GET /api/doc-freshness         — recent sweep runs + summary stats
 *   GET /api/doc-freshness/history — full history with pagination
 *
 * Reads from the skill_invocations table, filtering by skill_name = 'doc_freshness_sweep'.
 * The doc freshness sweep skill emits onex.evt.omniclaude.doc_freshness_sweep-completed.v1
 * events which are consumed by the read-model consumer and projected to skill_invocations.
 */

import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { tryGetIntelligenceDb } from './storage';

const router = Router();

// ============================================================================
// GET /api/doc-freshness
// Recent runs + summary
// ============================================================================

router.get('/', async (_req, res) => {
  const db = tryGetIntelligenceDb();
  if (!db) {
    return res.json({
      runs: [],
      summary: { total: 0, succeeded: 0, failed: 0, success_rate: 0, avg_duration_ms: 0 },
    });
  }

  try {
    const [recentResult, summaryResult] = await Promise.all([
      db.execute(sql`
        SELECT
          id,
          skill_name,
          session_id,
          duration_ms,
          success,
          status,
          error,
          created_at::text,
          emitted_at::text
        FROM skill_invocations
        WHERE skill_name = 'doc_freshness_sweep'
        ORDER BY created_at DESC
        LIMIT 20
      `),
      db.execute(sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE success = true)::int AS succeeded,
          COUNT(*) FILTER (WHERE success = false)::int AS failed,
          ROUND(
            COALESCE(
              SUM(CASE WHEN success THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0),
              0
            ),
            4
          ) AS success_rate,
          ROUND(AVG(duration_ms)::numeric, 0)::int AS avg_duration_ms
        FROM skill_invocations
        WHERE skill_name = 'doc_freshness_sweep'
      `),
    ]);

    const summary = summaryResult.rows[0] as
      | {
          total?: number;
          succeeded?: number;
          failed?: number;
          success_rate?: number;
          avg_duration_ms?: number;
        }
      | undefined;

    return res.json({
      runs: recentResult.rows,
      summary: {
        total: Number(summary?.total ?? 0),
        succeeded: Number(summary?.succeeded ?? 0),
        failed: Number(summary?.failed ?? 0),
        success_rate: parseFloat(String(summary?.success_rate ?? 0)),
        avg_duration_ms: Number(summary?.avg_duration_ms ?? 0),
      },
    });
  } catch (err) {
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '42P01') {
      return res.json({
        runs: [],
        summary: { total: 0, succeeded: 0, failed: 0, success_rate: 0, avg_duration_ms: 0 },
      });
    }
    console.error('[doc-freshness] query failed:', err);
    return res.status(500).json({ error: 'Failed to fetch doc freshness data' });
  }
});

// ============================================================================
// GET /api/doc-freshness/history?limit=50&offset=0
// Paginated history
// ============================================================================

router.get('/history', async (req, res) => {
  const db = tryGetIntelligenceDb();
  if (!db) {
    return res.json({ runs: [], limit: 50, offset: 0 });
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const result = await db.execute(sql`
      SELECT
        id,
        skill_name,
        session_id,
        duration_ms,
        success,
        status,
        error,
        created_at::text,
        emitted_at::text
      FROM skill_invocations
      WHERE skill_name = 'doc_freshness_sweep'
      ORDER BY created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    return res.json({ runs: result.rows, limit, offset });
  } catch (err) {
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '42P01') {
      return res.json({ runs: [], limit, offset });
    }
    console.error('[doc-freshness] history query failed:', err);
    return res.status(500).json({ error: 'Failed to fetch doc freshness history' });
  }
});

export default router;
