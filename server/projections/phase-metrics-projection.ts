/**
 * PhaseMetricsProjection — DB-backed projection for phase metrics (OMN-5184)
 *
 * Encapsulates SQL queries for the pipeline phase metrics dashboard behind the
 * ProjectionView interface. Used by the Speed category page.
 *
 * Source table: phase_metrics_events (defined in shared/intelligence-schema.ts)
 */

import { sql } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';

// ============================================================================
// Payload types
// ============================================================================

export type PhaseMetricsWindow = '24h' | '7d' | '30d';

export interface PhaseMetricsSummary {
  totalPhaseRuns: number;
  avgDurationMs: number;
  byStatus: { success: number; failure: number; skipped: number };
  window: PhaseMetricsWindow;
}

export interface PhaseMetricsByPhase {
  phase: string;
  count: number;
  avgDurationMs: number;
  successRate: number;
}

export interface PhaseMetricsPayload {
  summary: PhaseMetricsSummary;
  byPhase: PhaseMetricsByPhase[];
}

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

// ============================================================================
// Window helpers
// ============================================================================

function windowCutoff(window: PhaseMetricsWindow): Date {
  const now = Date.now();
  if (window === '24h') return new Date(now - 24 * 60 * 60 * 1000);
  if (window === '30d') return new Date(now - 30 * 24 * 60 * 60 * 1000);
  return new Date(now - 7 * 24 * 60 * 60 * 1000);
}

// ============================================================================
// Projection class
// ============================================================================

export class PhaseMetricsProjection extends DbBackedProjectionView<PhaseMetricsPayload> {
  readonly viewId = 'phase-metrics';

  private windowCache = new Map<PhaseMetricsWindow, { payload: PhaseMetricsPayload; ts: number }>();

  emptyPayload(): PhaseMetricsPayload {
    return {
      summary: {
        totalPhaseRuns: 0,
        avgDurationMs: 0,
        byStatus: { success: 0, failure: 0, skipped: 0 },
        window: '7d',
      },
      byPhase: [],
    };
  }

  async ensureFreshForWindow(window: PhaseMetricsWindow): Promise<PhaseMetricsPayload> {
    const validWindows: PhaseMetricsWindow[] = ['24h', '7d', '30d'];
    if (!validWindows.includes(window)) {
      return this.emptyPayload();
    }

    const cached = this.windowCache.get(window);
    if (cached && Date.now() - cached.ts < 5000) {
      return cached.payload;
    }

    const db = tryGetIntelligenceDb();
    if (!db) {
      return cached?.payload ?? this.emptyPayload();
    }

    try {
      const payload = await this.queryForWindow(db, window);
      this.windowCache.set(window, { payload, ts: Date.now() });
      return payload;
    } catch {
      return cached?.payload ?? this.emptyPayload();
    }
  }

  protected async querySnapshot(db: Db): Promise<PhaseMetricsPayload> {
    return this.queryForWindow(db, '7d');
  }

  private async queryForWindow(db: Db, window: PhaseMetricsWindow): Promise<PhaseMetricsPayload> {
    const cutoff = windowCutoff(window);

    const [summaryRows, byPhaseRows] = await Promise.all([
      db.execute(sql`
        SELECT
          COUNT(*)::int AS total,
          COALESCE(AVG(duration_ms), 0)::float AS avg_duration_ms,
          COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
          COUNT(*) FILTER (WHERE status = 'failure')::int AS failure_count,
          COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped_count
        FROM phase_metrics_events
        WHERE emitted_at >= ${cutoff}
      `) as unknown as Promise<{
        rows: Array<{
          total: number;
          avg_duration_ms: number;
          success_count: number;
          failure_count: number;
          skipped_count: number;
        }>;
      }>,

      db.execute(sql`
        SELECT
          phase,
          COUNT(*)::int AS count,
          COALESCE(AVG(duration_ms), 0)::float AS avg_duration_ms,
          COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
          COUNT(*) FILTER (WHERE status = 'failure')::int AS failure_count
        FROM phase_metrics_events
        WHERE emitted_at >= ${cutoff}
        GROUP BY phase
        ORDER BY count DESC
      `) as unknown as Promise<{
        rows: Array<{
          phase: string;
          count: number;
          avg_duration_ms: number;
          success_count: number;
          failure_count: number;
        }>;
      }>,
    ]);

    const summaryRow = summaryRows.rows[0] ?? {
      total: 0,
      avg_duration_ms: 0,
      success_count: 0,
      failure_count: 0,
      skipped_count: 0,
    };

    const summary: PhaseMetricsSummary = {
      totalPhaseRuns: Number(summaryRow.total),
      avgDurationMs: Number(summaryRow.avg_duration_ms),
      byStatus: {
        success: Number(summaryRow.success_count),
        failure: Number(summaryRow.failure_count),
        skipped: Number(summaryRow.skipped_count),
      },
      window,
    };

    const byPhase: PhaseMetricsByPhase[] = byPhaseRows.rows.map((r) => {
      const successCount = Number(r.success_count);
      const failureCount = Number(r.failure_count);
      const denominator = successCount + failureCount;
      return {
        phase: r.phase,
        count: Number(r.count),
        avgDurationMs: Number(r.avg_duration_ms),
        successRate: denominator > 0 ? successCount / denominator : 0,
      };
    });

    return { summary, byPhase };
  }
}
