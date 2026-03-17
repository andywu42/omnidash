/**
 * Intent Drift API Routes (OMN-5281)
 *
 * REST endpoints for the /intent-drift dashboard:
 *   GET /api/intent-drift  — recent events + severity summary
 *
 * Source table: intent_drift_events (populated by OmniintelligenceProjectionHandler)
 * Source topic: onex.evt.omniintelligence.intent-drift-detected.v1
 */

import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { tryGetIntelligenceDb } from './storage';

const router = Router();

// ============================================================================
// GET /api/intent-drift
// ============================================================================

router.get('/', async (_req, res) => {
  const db = tryGetIntelligenceDb();
  if (!db) {
    return res.json({ recent: [], summary: [] });
  }
  try {
    const recent = await db.execute(
      sql`SELECT id, session_id, original_intent, current_intent, drift_score, severity, created_at
          FROM intent_drift_events
          ORDER BY created_at DESC
          LIMIT 100`
    );
    const summary = await db.execute(
      sql`SELECT severity, COUNT(*)::int AS count
          FROM intent_drift_events
          GROUP BY severity
          ORDER BY count DESC`
    );
    return res.json({ recent: recent.rows, summary: summary.rows });
  } catch (error) {
    console.error('[intent-drift] Error fetching data:', error);
    return res.json({ recent: [], summary: [] });
  }
});

export default router;
