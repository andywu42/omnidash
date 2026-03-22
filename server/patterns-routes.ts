/**
 * Patterns API Routes (OMN-2924)
 *
 * Legacy `/api/patterns` endpoint redirected to canonical `pattern_learning_artifacts`
 * table. The learnedPatterns table has been removed; all pattern data now flows
 * through the pattern-projection.v1 Kafka topic into pattern_learning_artifacts.
 *
 * The canonical REST endpoint is `/api/patterns/patlearn`
 * (mounted via routes.ts -> pattern-routes.ts). This module preserves the
 * `/api/patterns` surface by querying pattern_learning_artifacts directly.
 */

import { Router } from 'express';
import { z } from 'zod';
import { tryGetIntelligenceDb } from './storage';
import { patternLearningArtifacts } from '@shared/intelligence-schema';
import type { PaginatedPatternsResponse } from '@shared/intelligence-schema';
import { desc, eq, gte, and, count, getTableName } from 'drizzle-orm';

const router = Router();

// Valid lifecycle states in pattern_learning_artifacts
const VALID_STATUSES = ['candidate', 'provisional', 'validated', 'deprecated'] as const;
export type PatternStatus = (typeof VALID_STATUSES)[number];

// Cache: once the table is confirmed to exist, skip re-checking on every request.
let tableExistenceLogged = false;
let tableExistsCache: boolean | null = null;

/** Reset the table-existence cache. Exported for use in tests only. */
export function resetTableExistsCache(): void {
  tableExistsCache = null;
  tableExistenceLogged = false;
}

async function checkTableExists(): Promise<boolean> {
  if (tableExistsCache) return true;
  const db = tryGetIntelligenceDb();
  if (!db) return false;
  try {
    await db.select().from(patternLearningArtifacts).limit(1);
    tableExistsCache = true;
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('does not exist') && !tableExistenceLogged) {
      console.warn(
        `[Patterns] ${getTableName(patternLearningArtifacts)} table does not exist - ` +
          'returning empty response (run migrations)'
      );
      tableExistenceLogged = true;
    }
    return false;
  }
}

// Query parameter validation schema
const PatternsQuerySchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  min_confidence: z
    .string()
    .optional()
    .transform((val) => (val ? parseFloat(val) : undefined))
    .refine((val) => val === undefined || (val >= 0 && val <= 1), {
      message: 'min_confidence must be between 0.0 and 1.0',
    }),
  limit: z
    .string()
    .optional()
    .transform((val) => {
      const parsed = val ? parseInt(val, 10) : 50;
      return Math.min(Math.max(parsed, 1), 250); // Clamp between 1 and 250
    }),
  offset: z
    .string()
    .optional()
    .transform((val) => {
      const parsed = val ? parseInt(val, 10) : 0;
      return Math.max(parsed, 0); // Ensure non-negative
    }),
});

/**
 * GET /api/patterns
 *
 * Returns paginated list of patterns from pattern_learning_artifacts.
 * Canonical data source replaces the removed learned_patterns table.
 *
 * Query Parameters:
 * - status: candidate|provisional|validated|deprecated
 * - min_confidence: 0.0-1.0 (maps to composite_score)
 * - limit: 1-250 (default 50)
 * - offset: pagination offset (default 0)
 */
router.get('/', async (req, res) => {
  try {
    const queryResult = PatternsQuerySchema.safeParse(req.query);

    if (!queryResult.success) {
      return res.status(400).json({
        error: 'Invalid query parameters',
        details: queryResult.error.format(),
      });
    }

    const { status, min_confidence, limit, offset } = queryResult.data;

    const db = tryGetIntelligenceDb();
    if (!db) {
      console.log('[Patterns] Database not configured - returning empty response (demo mode)');
      return res.json({
        patterns: [],
        total: 0,
        limit,
        offset,
        _demo: true,
        _message: 'Database not configured. Running in demo-only mode.',
      } as PaginatedPatternsResponse & { _demo: boolean; _message: string });
    }

    const exists = await checkTableExists();
    if (!exists) {
      return res.json({
        patterns: [],
        total: 0,
        limit,
        offset,
      } as PaginatedPatternsResponse);
    }

    // Build filter conditions
    const conditions = [];
    if (status) {
      conditions.push(eq(patternLearningArtifacts.lifecycleState, status));
    }
    if (min_confidence !== undefined) {
      conditions.push(gte(patternLearningArtifacts.compositeScore, String(min_confidence)));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult, rows] = await Promise.all([
      db.select({ count: count() }).from(patternLearningArtifacts).where(where),
      db
        .select({
          id: patternLearningArtifacts.id,
          patternId: patternLearningArtifacts.patternId,
          patternName: patternLearningArtifacts.patternName,
          patternType: patternLearningArtifacts.patternType,
          lifecycleState: patternLearningArtifacts.lifecycleState,
          compositeScore: patternLearningArtifacts.compositeScore,
          createdAt: patternLearningArtifacts.createdAt,
          updatedAt: patternLearningArtifacts.updatedAt,
          projectedAt: patternLearningArtifacts.projectedAt,
        })
        .from(patternLearningArtifacts)
        .where(where)
        .orderBy(
          desc(patternLearningArtifacts.compositeScore),
          desc(patternLearningArtifacts.createdAt)
        )
        .limit(limit)
        .offset(offset),
    ]);

    const total = countResult[0]?.count ?? 0;

    // Map to legacy PatternListItem shape for backwards compatibility
    const patterns = rows.map((row) => ({
      id: row.id,
      name: row.patternName,
      signature: row.patternType,
      status: row.lifecycleState as PatternStatus,
      confidence: parseFloat(row.compositeScore ?? '0'),
      quality_score: parseFloat(row.compositeScore ?? '0'),
      usage_count_rolling_20: 0,
      success_rate_rolling_20: null,
      last_seen_at: row.updatedAt?.toISOString() ?? null,
      created_at: row.createdAt?.toISOString() ?? null,
    }));

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });

    res.json({ patterns, total, limit, offset });
  } catch (error) {
    console.error('Error fetching patterns:', error);
    res.status(500).json({
      error: 'Failed to fetch patterns',
      message: 'Internal server error',
    });
  }
});

export default router;
