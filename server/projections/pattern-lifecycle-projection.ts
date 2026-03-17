/**
 * PatternLifecycleProjection — DB-backed projection for pattern lifecycle transitions (OMN-5283)
 *
 * Source table:  pattern_lifecycle_transitions (populated by read-model-consumer.ts)
 *
 * Snapshot payload shape:
 *   { recent: PatternLifecycleTransitionRow[]; stateSummary: StateSummaryRow[]; trend: TrendRow[] }
 */

import { desc, sql } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import { patternLifecycleTransitions } from '@shared/intelligence-schema';
import { z } from 'zod';

// ============================================================================
// Schema
// ============================================================================

const recentRowSchema = z.object({
  id: z.string(),
  patternId: z.string(),
  fromStatus: z.string(),
  toStatus: z.string(),
  transitionTrigger: z.string(),
  actor: z.string().nullable(),
  reason: z.string().nullable(),
  correlationId: z.string().nullable(),
  transitionAt: z.union([z.string(), z.date()]),
});

const stateSummaryRowSchema = z.object({
  state: z.string(),
  count: z.number(),
});

const trendRowSchema = z.object({
  day: z.string(),
  count: z.number(),
});

const patternLifecyclePayloadSchema = z.object({
  recent: z.array(recentRowSchema),
  stateSummary: z.array(stateSummaryRowSchema),
  trend: z.array(trendRowSchema),
});

export type PatternLifecycleRecentRow = z.infer<typeof recentRowSchema>;
export type PatternLifecycleStateSummaryRow = z.infer<typeof stateSummaryRowSchema>;
export type PatternLifecycleTrendRow = z.infer<typeof trendRowSchema>;
export type PatternLifecyclePayload = z.infer<typeof patternLifecyclePayloadSchema>;

// ============================================================================
// Projection
// ============================================================================

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

export class PatternLifecycleProjection extends DbBackedProjectionView<PatternLifecyclePayload> {
  readonly viewId = 'pattern-lifecycle';

  protected emptyPayload(): PatternLifecyclePayload {
    return { recent: [], stateSummary: [], trend: [] };
  }

  protected async querySnapshot(db: Db, limit = 100): Promise<PatternLifecyclePayload> {
    try {
      const [recent, stateSummary, trend] = await Promise.all([
        db
          .select({
            id: patternLifecycleTransitions.id,
            patternId: patternLifecycleTransitions.patternId,
            fromStatus: patternLifecycleTransitions.fromStatus,
            toStatus: patternLifecycleTransitions.toStatus,
            transitionTrigger: patternLifecycleTransitions.transitionTrigger,
            actor: patternLifecycleTransitions.actor,
            reason: patternLifecycleTransitions.reason,
            correlationId: patternLifecycleTransitions.correlationId,
            transitionAt: patternLifecycleTransitions.transitionAt,
          })
          .from(patternLifecycleTransitions)
          .orderBy(desc(patternLifecycleTransitions.transitionAt))
          .limit(limit),
        db
          .select({
            state: patternLifecycleTransitions.toStatus,
            count: sql<number>`count(*)::int`.as('count'),
          })
          .from(patternLifecycleTransitions)
          .groupBy(patternLifecycleTransitions.toStatus)
          .orderBy(sql`count(*) DESC`),
        db
          .select({
            day: sql<string>`date_trunc('day', ${patternLifecycleTransitions.transitionAt})::text`.as(
              'day'
            ),
            count: sql<number>`count(*)::int`.as('count'),
          })
          .from(patternLifecycleTransitions)
          .where(sql`${patternLifecycleTransitions.transitionAt} >= now() - interval '30 days'`)
          .groupBy(sql`date_trunc('day', ${patternLifecycleTransitions.transitionAt})`)
          .orderBy(sql`date_trunc('day', ${patternLifecycleTransitions.transitionAt}) ASC`),
      ]);

      return patternLifecyclePayloadSchema.parse({
        recent: recent.map((r) =>
          recentRowSchema.parse({
            ...r,
            id: String(r.id),
            patternId: String(r.patternId),
            correlationId: r.correlationId ? String(r.correlationId) : null,
          })
        ),
        stateSummary: stateSummary.map((r) => stateSummaryRowSchema.parse(r)),
        trend: trend.map((r) => trendRowSchema.parse(r)),
      });
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('pattern_lifecycle_transitions') && msg.includes('does not exist'))
      ) {
        return this.emptyPayload();
      }
      throw err;
    }
  }
}
