/**
 * SessionOutcomeProjection — DB-backed projection for session outcomes (OMN-5184)
 *
 * Encapsulates SQL queries for the session outcome dashboard behind the
 * ProjectionView interface. Used by the Success category page.
 *
 * Source table: session_outcomes (defined in shared/intelligence-schema.ts)
 */

import { sql } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';

// ============================================================================
// Payload types
// ============================================================================

export type SessionOutcomeWindow = '24h' | '7d' | '30d';

export interface SessionOutcomeSummary {
  totalSessions: number;
  byOutcome: { success: number; failed: number; abandoned: number; unknown: number };
  successRate: number;
  window: SessionOutcomeWindow;
}

export interface SessionOutcomeTrendPoint {
  bucket: string;
  success: number;
  failed: number;
  abandoned: number;
  unknown: number;
}

export interface SessionOutcomePayload {
  summary: SessionOutcomeSummary;
  trend: SessionOutcomeTrendPoint[];
  granularity: 'hour' | 'day';
}

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

// ============================================================================
// Window helpers
// ============================================================================

function windowCutoff(window: SessionOutcomeWindow): Date {
  const now = Date.now();
  if (window === '24h') return new Date(now - 24 * 60 * 60 * 1000);
  if (window === '30d') return new Date(now - 30 * 24 * 60 * 60 * 1000);
  return new Date(now - 7 * 24 * 60 * 60 * 1000);
}

function truncUnit(window: SessionOutcomeWindow): 'hour' | 'day' {
  return window === '24h' ? 'hour' : 'day';
}

// ============================================================================
// Projection class
// ============================================================================

export class SessionOutcomeProjection extends DbBackedProjectionView<SessionOutcomePayload> {
  readonly viewId = 'session-outcomes';

  private windowCache = new Map<
    SessionOutcomeWindow,
    { payload: SessionOutcomePayload; ts: number }
  >();

  emptyPayload(): SessionOutcomePayload {
    return {
      summary: {
        totalSessions: 0,
        byOutcome: { success: 0, failed: 0, abandoned: 0, unknown: 0 },
        successRate: 0,
        window: '7d',
      },
      trend: [],
      granularity: 'day',
    };
  }

  async ensureFreshForWindow(window: SessionOutcomeWindow): Promise<SessionOutcomePayload> {
    const validWindows: SessionOutcomeWindow[] = ['24h', '7d', '30d'];
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

  protected async querySnapshot(db: Db): Promise<SessionOutcomePayload> {
    return this.queryForWindow(db, '7d');
  }

  private async queryForWindow(
    db: Db,
    window: SessionOutcomeWindow
  ): Promise<SessionOutcomePayload> {
    const cutoff = windowCutoff(window);
    const unit = truncUnit(window);

    const [summaryRows, trendRows] = await Promise.all([
      db.execute(sql`
        SELECT
          outcome,
          COUNT(*)::int AS count
        FROM session_outcomes
        WHERE emitted_at >= ${cutoff}
        GROUP BY outcome
      `) as unknown as Promise<{ rows: Array<{ outcome: string; count: number }> }>,

      db.execute(sql`
        SELECT
          date_trunc(${unit}, emitted_at) AS bucket,
          COUNT(*) FILTER (WHERE outcome = 'success')::int AS success,
          COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE outcome = 'abandoned')::int AS abandoned,
          COUNT(*) FILTER (WHERE outcome = 'unknown')::int AS unknown
        FROM session_outcomes
        WHERE emitted_at >= ${cutoff}
        GROUP BY bucket
        ORDER BY bucket ASC
      `) as unknown as Promise<{
        rows: Array<{
          bucket: unknown;
          success: number;
          failed: number;
          abandoned: number;
          unknown: number;
        }>;
      }>,
    ]);

    const byOutcome = { success: 0, failed: 0, abandoned: 0, unknown: 0 };
    let totalSessions = 0;
    for (const row of summaryRows.rows) {
      const key = row.outcome as keyof typeof byOutcome;
      const count = Number(row.count);
      if (key in byOutcome) {
        byOutcome[key] = count;
      }
      totalSessions += count;
    }

    const denominator = byOutcome.success + byOutcome.failed;
    const successRate = denominator > 0 ? byOutcome.success / denominator : 0;

    const trend = trendRows.rows.map((r) => {
      const bucket = r.bucket;
      const bucketStr = bucket instanceof Date ? bucket.toISOString() : String(bucket);
      return {
        bucket: bucketStr,
        success: Number(r.success),
        failed: Number(r.failed),
        abandoned: Number(r.abandoned),
        unknown: Number(r.unknown),
      };
    });

    return {
      summary: { totalSessions, byOutcome, successRate, window },
      trend,
      granularity: unit,
    };
  }
}
