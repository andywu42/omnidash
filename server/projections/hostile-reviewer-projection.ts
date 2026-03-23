/**
 * HostileReviewerProjection — DB-backed projection for hostile reviewer events (OMN-5864)
 *
 * Projects from: onex.evt.omniclaude.hostile-reviewer-completed.v1
 * Source table:  hostile_reviewer_runs (populated by read-model-consumer.ts)
 *
 * Snapshot payload shape:
 *   { recent: HostileReviewerRunRow[]; summary: HostileReviewerSummary }
 *
 * Routes access this via projectionService.getView('hostile-reviewer').getSnapshot()
 * — no direct DB imports allowed in route files (OMN-2325).
 */

import { sql } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import {
  hostileReviewerRunRowSchema,
  hostileReviewerSummarySchema,
  hostileReviewerPayloadSchema,
  type HostileReviewerRunRow,
  type HostileReviewerSummary,
  type HostileReviewerPayload,
} from '@shared/omniclaude-state-schema';

// ============================================================================
// Re-exports for route files
// ============================================================================

export type { HostileReviewerRunRow, HostileReviewerSummary, HostileReviewerPayload };

// ============================================================================
// Projection
// ============================================================================

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

export class HostileReviewerProjection extends DbBackedProjectionView<HostileReviewerPayload> {
  readonly viewId = 'hostile-reviewer';

  protected emptyPayload(): HostileReviewerPayload {
    return {
      recent: [],
      summary: { total_runs: 0, verdict_counts: {} },
    };
  }

  protected async querySnapshot(db: Db, limit = 50): Promise<HostileReviewerPayload> {
    try {
      const [recentRows, verdictRows] = await Promise.all([
        db.execute(sql`
          SELECT
            event_id,
            correlation_id,
            mode,
            target,
            verdict,
            total_findings,
            critical_count,
            major_count,
            created_at::text
          FROM hostile_reviewer_runs
          ORDER BY created_at DESC
          LIMIT ${limit}
        `),
        db.execute(sql`
          SELECT
            verdict,
            COUNT(*)::int AS count
          FROM hostile_reviewer_runs
          GROUP BY verdict
        `),
      ]);

      const recent = (recentRows.rows ?? []).map((row) =>
        hostileReviewerRunRowSchema.parse(row)
      );

      const verdictCounts: Record<string, number> = {};
      let totalRuns = 0;
      for (const row of (verdictRows.rows ?? []) as { verdict: string; count: number }[]) {
        verdictCounts[row.verdict] = row.count;
        totalRuns += row.count;
      }

      const summary = hostileReviewerSummarySchema.parse({
        total_runs: totalRuns,
        verdict_counts: verdictCounts,
      });

      return hostileReviewerPayloadSchema.parse({ recent, summary });
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('hostile_reviewer_runs') && msg.includes('does not exist'))
      ) {
        return this.emptyPayload();
      }
      throw err;
    }
  }
}
