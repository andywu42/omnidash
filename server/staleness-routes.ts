/**
 * Staleness API Endpoint (OMN-6398)
 *
 * GET /api/staleness
 *
 * Returns per-feature staleness info by querying projection_watermarks
 * and the max timestamp from key tables. The frontend StalenessIndicator
 * component consumes this.
 *
 * Response shape:
 * {
 *   features: { [name]: { name, lastUpdated, stale, severityLevel } },
 *   checkedAt: string
 * }
 */

import { Router } from 'express';
import { tryGetIntelligenceDb } from './storage';
import {
  getStaleSeverity,
  type StalenessInfo,
  type StalenessApiResponse,
} from '@shared/staleness-types';
import { safeMaxTimestampQuery } from './sql-safety';

// ---------------------------------------------------------------------------
// Feature-to-table mapping
// ---------------------------------------------------------------------------

/**
 * Maps dashboard feature names to the table + timestamp column used
 * to determine data freshness.
 */
const FEATURE_TABLE_MAP: Record<string, { table: string; tsCol: string }> = {
  patterns: { table: 'pattern_learning_artifacts', tsCol: 'created_at' },
  enforcement: { table: 'pattern_enforcement_events', tsCol: 'created_at' },
  effectiveness: { table: 'injection_effectiveness', tsCol: 'created_at' },
  'rl-episodes': { table: 'rl_episodes', tsCol: 'created_at' },
  'llm-routing': { table: 'llm_routing_decisions', tsCol: 'created_at' },
  'intent-signals': { table: 'intent_signals', tsCol: 'created_at' },
  'session-outcomes': { table: 'session_outcomes', tsCol: 'created_at' },
  'latency-breakdowns': { table: 'latency_breakdowns', tsCol: 'created_at' },
  enrichment: { table: 'context_enrichment_events', tsCol: 'created_at' },
  delegation: { table: 'delegation_events', tsCol: 'created_at' },
  'gate-decisions': { table: 'gate_decisions', tsCol: 'created_at' },
  'epic-runs': { table: 'epic_run_events', tsCol: 'created_at' },
  'pr-watch': { table: 'pr_watch_state', tsCol: 'updated_at' },
  compliance: { table: 'compliance_evaluations', tsCol: 'created_at' },
};

// ---------------------------------------------------------------------------
// Cache (30s TTL)
// ---------------------------------------------------------------------------

let cache: { response: StalenessApiResponse; expiresAt: number } | null = null;

/** Clear cache (exported for tests). */
export function clearStalenessCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export async function getStalenessInfo(): Promise<StalenessApiResponse> {
  const db = tryGetIntelligenceDb();
  const features: Record<string, StalenessInfo> = {};

  if (!db) {
    // No DB -- return all features as critical staleness
    for (const name of Object.keys(FEATURE_TABLE_MAP)) {
      features[name] = {
        name,
        lastUpdated: null,
        stale: true,
        severityLevel: 'critical',
      };
    }
    return { features, checkedAt: new Date().toISOString() };
  }

  for (const [name, { table, tsCol }] of Object.entries(FEATURE_TABLE_MAP)) {
    try {
      const result = await db.execute(safeMaxTimestampQuery(table, tsCol));
      const rows = Array.isArray(result) ? result : ((result as any).rows ?? []);
      const rawTs = rows[0]?.last_updated;
      const lastUpdated = rawTs ? new Date(rawTs as string).toISOString() : null;
      const severityLevel = getStaleSeverity(lastUpdated);

      features[name] = {
        name,
        lastUpdated,
        stale: severityLevel !== 'fresh',
        severityLevel,
      };
    } catch {
      features[name] = {
        name,
        lastUpdated: null,
        stale: true,
        severityLevel: 'critical',
      };
    }
  }

  return { features, checkedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

router.get('/', async (_req, res) => {
  try {
    if (cache && Date.now() < cache.expiresAt) {
      res.set('Cache-Control', 'no-store');
      return res.json(cache.response);
    }

    const response = await getStalenessInfo();
    cache = { response, expiresAt: Date.now() + 30_000 };

    res.set('Cache-Control', 'no-store');
    return res.json(response);
  } catch (err) {
    console.error('[staleness] Probe failed:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
      checkedAt: new Date().toISOString(),
    });
  }
});

export default router;
