/**
 * SavingsProjection — DB-backed projection for token savings estimates (OMN-5553)
 *
 * Queries the savings_estimates table (populated by the savings-estimated.v1
 * projection handler) and serves summary, trend, and category breakdown data
 * to the savings dashboard routes.
 *
 * Source table: savings_estimates (defined in shared/intelligence-schema.ts)
 */

import { sql, gte } from 'drizzle-orm';
import { savingsEstimates } from '@shared/intelligence-schema';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import { safeTruncUnit } from '../sql-safety';

// ============================================================================
// Payload types
// ============================================================================

export type SavingsWindow = '24h' | '7d' | '30d';

export interface SavingsSummary {
  totalEstimatedSavingsUsd: number;
  totalDirectSavingsUsd: number;
  totalTokensSaved: number;
  totalDirectTokensSaved: number;
  eventCount: number;
  sessionCount: number;
  avgConfidence: number;
  avgDirectConfidence: number;
  window: SavingsWindow;
}

export interface SavingsTrendPoint {
  bucket: string;
  estimatedSavingsUsd: number;
  directSavingsUsd: number;
  tokensSaved: number;
  eventCount: number;
}

export interface SavingsCategoryBreakdown {
  category: string;
  totalSavingsUsd: number;
  totalTokensSaved: number;
  avgConfidence: number;
  eventCount: number;
}

export interface SavingsPayload {
  summary: SavingsSummary;
  trend: SavingsTrendPoint[];
  categories: SavingsCategoryBreakdown[];
  granularity: 'hour' | 'day';
}

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

// ============================================================================
// Window helpers
// ============================================================================

function windowCutoff(window: SavingsWindow): Date {
  const now = Date.now();
  if (window === '24h') return new Date(now - 24 * 60 * 60 * 1000);
  if (window === '30d') return new Date(now - 30 * 24 * 60 * 60 * 1000);
  return new Date(now - 7 * 24 * 60 * 60 * 1000);
}

function truncUnit(window: SavingsWindow): 'hour' | 'day' {
  return window === '24h' ? 'hour' : 'day';
}

// ============================================================================
// Projection class
// ============================================================================

export class SavingsProjection extends DbBackedProjectionView<SavingsPayload> {
  readonly viewId = 'savings-estimates';

  private windowCache = new Map<SavingsWindow, { payload: SavingsPayload; ts: number }>();

  emptyPayload(): SavingsPayload {
    return {
      summary: {
        totalEstimatedSavingsUsd: 0,
        totalDirectSavingsUsd: 0,
        totalTokensSaved: 0,
        totalDirectTokensSaved: 0,
        eventCount: 0,
        sessionCount: 0,
        avgConfidence: 0,
        avgDirectConfidence: 0,
        window: '7d',
      },
      trend: [],
      categories: [],
      granularity: 'day',
    };
  }

  async ensureFreshForWindow(window: SavingsWindow): Promise<SavingsPayload> {
    const validWindows: SavingsWindow[] = ['24h', '7d', '30d'];
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

  protected async querySnapshot(db: Db): Promise<SavingsPayload> {
    return this.queryForWindow(db, '7d');
  }

  private async queryForWindow(db: Db, window: SavingsWindow): Promise<SavingsPayload> {
    const cutoff = windowCutoff(window);
    const unit = truncUnit(window);
    const se = savingsEstimates;

    const [summaryRows, trendRows, categoryRows] = await Promise.all([
      // Summary aggregates
      db
        .select({
          totalEstimatedSavings: sql<string>`COALESCE(SUM(${se.estimatedTotalSavingsUsd}::numeric), 0)::text`,
          totalDirectSavings: sql<string>`COALESCE(SUM(${se.directSavingsUsd}::numeric), 0)::text`,
          totalTokensSaved: sql<number>`COALESCE(SUM(${se.estimatedTotalTokensSaved}), 0)::bigint`,
          totalDirectTokensSaved: sql<number>`COALESCE(SUM(${se.directTokensSaved}), 0)::bigint`,
          eventCount: sql<number>`COUNT(*)::int`,
          sessionCount: sql<number>`COUNT(DISTINCT ${se.sessionId})::int`,
          avgConfidence: sql<number>`COALESCE(AVG(${se.heuristicConfidenceAvg}), 0)::real`,
          avgDirectConfidence: sql<number>`COALESCE(AVG(${se.directConfidence}), 0)::real`,
        })
        .from(se)
        .where(gte(se.eventTimestamp, cutoff)),

      // Trend bucketed by hour or day
      db
        .select({
          bucket: sql<string>`date_trunc(${safeTruncUnit(unit)}, ${se.eventTimestamp})::text`,
          estimatedSavings: sql<string>`COALESCE(SUM(${se.estimatedTotalSavingsUsd}::numeric), 0)::text`,
          directSavings: sql<string>`COALESCE(SUM(${se.directSavingsUsd}::numeric), 0)::text`,
          tokensSaved: sql<number>`COALESCE(SUM(${se.estimatedTotalTokensSaved}), 0)::bigint`,
          eventCount: sql<number>`COUNT(*)::int`,
        })
        .from(se)
        .where(gte(se.eventTimestamp, cutoff))
        .groupBy(sql`date_trunc(${safeTruncUnit(unit)}, ${se.eventTimestamp})`)
        .orderBy(sql`date_trunc(${safeTruncUnit(unit)}, ${se.eventTimestamp})`),

      // Category breakdown from JSONB categories array
      db.execute(sql`
        SELECT
          cat->>'category' AS category,
          COALESCE(SUM((cat->>'savings_usd')::numeric), 0)::text AS total_savings_usd,
          COALESCE(SUM((cat->>'tokens_saved')::int), 0)::bigint AS total_tokens_saved,
          COALESCE(AVG((cat->>'confidence')::real), 0)::real AS avg_confidence,
          COUNT(*)::int AS event_count
        FROM ${se},
             jsonb_array_elements(${se.categories}) AS cat
        WHERE ${se.eventTimestamp} >= ${cutoff}
          AND cat->>'category' IS NOT NULL
        GROUP BY cat->>'category'
        ORDER BY SUM((cat->>'savings_usd')::numeric) DESC NULLS LAST
      `) as unknown as Promise<{
        rows: Array<{
          category: string;
          total_savings_usd: string;
          total_tokens_saved: number;
          avg_confidence: number;
          event_count: number;
        }>;
      }>,
    ]);

    const s = summaryRows[0];
    const summary: SavingsSummary = {
      totalEstimatedSavingsUsd: parseFloat(s?.totalEstimatedSavings ?? '0'),
      totalDirectSavingsUsd: parseFloat(s?.totalDirectSavings ?? '0'),
      totalTokensSaved: Number(s?.totalTokensSaved ?? 0),
      totalDirectTokensSaved: Number(s?.totalDirectTokensSaved ?? 0),
      eventCount: Number(s?.eventCount ?? 0),
      sessionCount: Number(s?.sessionCount ?? 0),
      avgConfidence: Number(s?.avgConfidence ?? 0),
      avgDirectConfidence: Number(s?.avgDirectConfidence ?? 0),
      window,
    };

    const trend: SavingsTrendPoint[] = trendRows.map((r) => ({
      bucket: r.bucket,
      estimatedSavingsUsd: parseFloat(r.estimatedSavings),
      directSavingsUsd: parseFloat(r.directSavings),
      tokensSaved: Number(r.tokensSaved),
      eventCount: Number(r.eventCount),
    }));

    const categories: SavingsCategoryBreakdown[] = categoryRows.rows.map((r) => ({
      category: r.category,
      totalSavingsUsd: parseFloat(r.total_savings_usd),
      totalTokensSaved: Number(r.total_tokens_saved),
      avgConfidence: Number(r.avg_confidence),
      eventCount: Number(r.event_count),
    }));

    return { summary, trend, categories, granularity: unit };
  }
}
