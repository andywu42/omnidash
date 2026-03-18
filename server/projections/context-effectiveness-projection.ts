/**
 * ContextEffectivenessProjection — DB-backed projection for context effectiveness data (OMN-5286)
 *
 * Projects from: injection_effectiveness table (event_type='context_utilization')
 *
 * Snapshot payload contains data for all three supported time windows (24h, 7d, 30d).
 * Routes access this via contextEffectivenessProjection.ensureFresh() — no direct
 * DB imports allowed in route files (OMN-2325).
 */

import { sql } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import type {
  ContextEffectivenessSummary,
  UtilizationByMethod,
  EffectivenessTrendPoint,
  OutcomeBreakdown,
  LowUtilizationSession,
} from '@shared/context-effectiveness-types';

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

export interface ContextEffectivenessWindowPayload {
  summary: ContextEffectivenessSummary;
  byMethod: UtilizationByMethod[];
  trend: EffectivenessTrendPoint[];
  outcomes: OutcomeBreakdown[];
  lowUtilization: LowUtilizationSession[];
}

export interface ContextEffectivenessPayload {
  '24h': ContextEffectivenessWindowPayload;
  '7d': ContextEffectivenessWindowPayload;
  '30d': ContextEffectivenessWindowPayload;
}

function emptyWindow(): ContextEffectivenessWindowPayload {
  return {
    summary: {
      avg_utilization_score: 0,
      total_injected_sessions: 0,
      injection_occurred_count: 0,
      injection_rate: 0,
      avg_patterns_count: 0,
      cache_hit_rate: 0,
      top_utilization_method: null,
    },
    byMethod: [],
    trend: [],
    outcomes: [],
    lowUtilization: [],
  };
}

async function query24h(db: Db): Promise<ContextEffectivenessWindowPayload> {
  const [summaryRows, topMethodRows, byMethodRows, trendRows, outcomeRows, lowUtilRows] =
    await Promise.all([
      db.execute<{
        avg_utilization_score: string | null;
        total_injected_sessions: string;
        injection_occurred_count: string;
        avg_patterns_count: string | null;
        cache_hit_count: string;
      }>(sql`
        SELECT
          AVG(CAST(utilization_score AS NUMERIC))::text AS avg_utilization_score,
          COUNT(*)::text AS total_injected_sessions,
          SUM(CASE WHEN injection_occurred THEN 1 ELSE 0 END)::text AS injection_occurred_count,
          AVG(patterns_count)::text AS avg_patterns_count,
          SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END)::text AS cache_hit_count
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '24 hours'
      `),
      db.execute<{ method: string | null }>(sql`
        SELECT detection_method AS method
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY utilization_method
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `),
      db.execute<{
        method: string | null;
        avg_score: string;
        session_count: string;
        injection_occurred_count: string;
      }>(sql`
        SELECT
          detection_method AS method,
          AVG(CAST(utilization_score AS NUMERIC))::text AS avg_score,
          COUNT(*)::text AS session_count,
          SUM(CASE WHEN injection_occurred THEN 1 ELSE 0 END)::text AS injection_occurred_count
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY detection_method
        ORDER BY COUNT(*) DESC
      `),
      db.execute<{
        date: string;
        avg_utilization_score: string;
        session_count: string;
        injection_occurred_count: string;
      }>(sql`
        SELECT
          DATE_TRUNC('hour', created_at)::text AS date,
          AVG(CAST(utilization_score AS NUMERIC))::text AS avg_utilization_score,
          COUNT(*)::text AS session_count,
          SUM(CASE WHEN injection_occurred THEN 1 ELSE 0 END)::text AS injection_occurred_count
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY DATE_TRUNC('hour', created_at)
        ORDER BY DATE_TRUNC('hour', created_at) ASC
      `),
      db.execute<{
        outcome: string | null;
        count: string;
        avg_utilization_score: string;
      }>(sql`
        SELECT
          session_outcome AS outcome,
          COUNT(*)::text AS count,
          AVG(NULLIF(CAST(utilization_score AS NUMERIC), 0))::text AS avg_utilization_score
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY session_outcome
        ORDER BY COUNT(*) DESC
      `),
      db.execute<{
        session_id: string | null;
        correlation_id: string | null;
        agent_name: string | null;
        detection_method: string | null;
        utilization_score: string | null;
        patterns_count: number | null;
        session_outcome: string | null;
        created_at: string | null;
      }>(sql`
        SELECT
          session_id, correlation_id, agent_name, detection_method,
          utilization_score, patterns_count, session_outcome, created_at
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '24 hours'
          AND CAST(utilization_score AS NUMERIC) < 0.3
        ORDER BY created_at DESC
        LIMIT 50
      `),
    ]);
  return buildWindowPayload(
    summaryRows,
    topMethodRows,
    byMethodRows,
    trendRows,
    outcomeRows,
    lowUtilRows
  );
}

async function query7d(db: Db): Promise<ContextEffectivenessWindowPayload> {
  const [summaryRows, topMethodRows, byMethodRows, trendRows, outcomeRows, lowUtilRows] =
    await Promise.all([
      db.execute<{
        avg_utilization_score: string | null;
        total_injected_sessions: string;
        injection_occurred_count: string;
        avg_patterns_count: string | null;
        cache_hit_count: string;
      }>(sql`
        SELECT
          AVG(CAST(utilization_score AS NUMERIC))::text AS avg_utilization_score,
          COUNT(*)::text AS total_injected_sessions,
          SUM(CASE WHEN injection_occurred THEN 1 ELSE 0 END)::text AS injection_occurred_count,
          AVG(patterns_count)::text AS avg_patterns_count,
          SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END)::text AS cache_hit_count
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '7 days'
      `),
      db.execute<{ method: string | null }>(sql`
        SELECT detection_method AS method
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY utilization_method
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `),
      db.execute<{
        method: string | null;
        avg_score: string;
        session_count: string;
        injection_occurred_count: string;
      }>(sql`
        SELECT
          detection_method AS method,
          AVG(CAST(utilization_score AS NUMERIC))::text AS avg_score,
          COUNT(*)::text AS session_count,
          SUM(CASE WHEN injection_occurred THEN 1 ELSE 0 END)::text AS injection_occurred_count
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY detection_method
        ORDER BY COUNT(*) DESC
      `),
      db.execute<{
        date: string;
        avg_utilization_score: string;
        session_count: string;
        injection_occurred_count: string;
      }>(sql`
        SELECT
          DATE_TRUNC('day', created_at)::text AS date,
          AVG(CAST(utilization_score AS NUMERIC))::text AS avg_utilization_score,
          COUNT(*)::text AS session_count,
          SUM(CASE WHEN injection_occurred THEN 1 ELSE 0 END)::text AS injection_occurred_count
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY DATE_TRUNC('day', created_at) ASC
      `),
      db.execute<{
        outcome: string | null;
        count: string;
        avg_utilization_score: string;
      }>(sql`
        SELECT
          session_outcome AS outcome,
          COUNT(*)::text AS count,
          AVG(NULLIF(CAST(utilization_score AS NUMERIC), 0))::text AS avg_utilization_score
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY session_outcome
        ORDER BY COUNT(*) DESC
      `),
      db.execute<{
        session_id: string | null;
        correlation_id: string | null;
        agent_name: string | null;
        detection_method: string | null;
        utilization_score: string | null;
        patterns_count: number | null;
        session_outcome: string | null;
        created_at: string | null;
      }>(sql`
        SELECT
          session_id, correlation_id, agent_name, detection_method,
          utilization_score, patterns_count, session_outcome, created_at
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '7 days'
          AND CAST(utilization_score AS NUMERIC) < 0.3
        ORDER BY created_at DESC
        LIMIT 50
      `),
    ]);
  return buildWindowPayload(
    summaryRows,
    topMethodRows,
    byMethodRows,
    trendRows,
    outcomeRows,
    lowUtilRows
  );
}

async function query30d(db: Db): Promise<ContextEffectivenessWindowPayload> {
  const [summaryRows, topMethodRows, byMethodRows, trendRows, outcomeRows, lowUtilRows] =
    await Promise.all([
      db.execute<{
        avg_utilization_score: string | null;
        total_injected_sessions: string;
        injection_occurred_count: string;
        avg_patterns_count: string | null;
        cache_hit_count: string;
      }>(sql`
        SELECT
          AVG(CAST(utilization_score AS NUMERIC))::text AS avg_utilization_score,
          COUNT(*)::text AS total_injected_sessions,
          SUM(CASE WHEN injection_occurred THEN 1 ELSE 0 END)::text AS injection_occurred_count,
          AVG(patterns_count)::text AS avg_patterns_count,
          SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END)::text AS cache_hit_count
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '30 days'
      `),
      db.execute<{ method: string | null }>(sql`
        SELECT detection_method AS method
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY utilization_method
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `),
      db.execute<{
        method: string | null;
        avg_score: string;
        session_count: string;
        injection_occurred_count: string;
      }>(sql`
        SELECT
          detection_method AS method,
          AVG(CAST(utilization_score AS NUMERIC))::text AS avg_score,
          COUNT(*)::text AS session_count,
          SUM(CASE WHEN injection_occurred THEN 1 ELSE 0 END)::text AS injection_occurred_count
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY detection_method
        ORDER BY COUNT(*) DESC
      `),
      db.execute<{
        date: string;
        avg_utilization_score: string;
        session_count: string;
        injection_occurred_count: string;
      }>(sql`
        SELECT
          DATE_TRUNC('day', created_at)::text AS date,
          AVG(CAST(utilization_score AS NUMERIC))::text AS avg_utilization_score,
          COUNT(*)::text AS session_count,
          SUM(CASE WHEN injection_occurred THEN 1 ELSE 0 END)::text AS injection_occurred_count
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY DATE_TRUNC('day', created_at) ASC
      `),
      db.execute<{
        outcome: string | null;
        count: string;
        avg_utilization_score: string;
      }>(sql`
        SELECT
          session_outcome AS outcome,
          COUNT(*)::text AS count,
          AVG(NULLIF(CAST(utilization_score AS NUMERIC), 0))::text AS avg_utilization_score
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY session_outcome
        ORDER BY COUNT(*) DESC
      `),
      db.execute<{
        session_id: string | null;
        correlation_id: string | null;
        agent_name: string | null;
        detection_method: string | null;
        utilization_score: string | null;
        patterns_count: number | null;
        session_outcome: string | null;
        created_at: string | null;
      }>(sql`
        SELECT
          session_id, correlation_id, agent_name, detection_method,
          utilization_score, patterns_count, session_outcome, created_at
        FROM injection_effectiveness
        WHERE event_type = 'context_utilization'
          AND created_at >= NOW() - INTERVAL '30 days'
          AND CAST(utilization_score AS NUMERIC) < 0.3
        ORDER BY created_at DESC
        LIMIT 50
      `),
    ]);
  return buildWindowPayload(
    summaryRows,
    topMethodRows,
    byMethodRows,
    trendRows,
    outcomeRows,
    lowUtilRows
  );
}

function buildWindowPayload(
  summaryRows: {
    rows: {
      avg_utilization_score: string | null;
      total_injected_sessions: string;
      injection_occurred_count: string;
      avg_patterns_count: string | null;
      cache_hit_count: string;
    }[];
  },
  topMethodRows: { rows: { method: string | null }[] },
  byMethodRows: {
    rows: {
      method: string | null;
      avg_score: string;
      session_count: string;
      injection_occurred_count: string;
    }[];
  },
  trendRows: {
    rows: {
      date: string;
      avg_utilization_score: string;
      session_count: string;
      injection_occurred_count: string;
    }[];
  },
  outcomeRows: { rows: { outcome: string | null; count: string; avg_utilization_score: string }[] },
  lowUtilRows: {
    rows: {
      session_id: string | null;
      correlation_id: string | null;
      agent_name: string | null;
      detection_method: string | null;
      utilization_score: string | null;
      patterns_count: number | null;
      session_outcome: string | null;
      created_at: string | null;
    }[];
  }
): ContextEffectivenessWindowPayload {
  const s = summaryRows.rows[0];
  const total = Number(s?.total_injected_sessions ?? 0);
  const injected = Number(s?.injection_occurred_count ?? 0);
  const cacheHits = Number(s?.cache_hit_count ?? 0);

  return {
    summary: {
      avg_utilization_score: Number(s?.avg_utilization_score ?? 0),
      total_injected_sessions: total,
      injection_occurred_count: injected,
      injection_rate: total > 0 ? injected / total : 0,
      avg_patterns_count: Number(s?.avg_patterns_count ?? 0),
      cache_hit_rate: total > 0 ? cacheHits / total : 0,
      top_utilization_method: topMethodRows.rows[0]?.method ?? null,
    },
    byMethod: byMethodRows.rows.map((r) => {
      const sc = Number(r.session_count);
      return {
        method: r.method ?? 'unknown',
        avg_score: Number(r.avg_score),
        session_count: sc,
        injection_rate: sc > 0 ? Number(r.injection_occurred_count) / sc : 0,
      };
    }),
    trend: trendRows.rows.map((r) => {
      const sc = Number(r.session_count);
      return {
        date: String(r.date),
        avg_utilization_score: Number(r.avg_utilization_score),
        session_count: sc,
        injection_rate: sc > 0 ? Number(r.injection_occurred_count) / sc : 0,
      };
    }),
    outcomes: outcomeRows.rows.map((r) => ({
      outcome: r.outcome ?? 'unknown',
      count: Number(r.count),
      avg_utilization_score: Number(r.avg_utilization_score),
    })),
    lowUtilization: lowUtilRows.rows.map((r) => ({
      session_id: String(r.session_id ?? ''),
      correlation_id: String(r.correlation_id ?? ''),
      agent_name: r.agent_name ?? null,
      detection_method: r.detection_method ?? null,
      utilization_score: Number(r.utilization_score ?? 0),
      patterns_count: r.patterns_count ?? null,
      session_outcome: r.session_outcome ?? null,
      occurred_at: r.created_at ?? new Date().toISOString(),
    })),
  };
}

export class ContextEffectivenessProjection extends DbBackedProjectionView<ContextEffectivenessPayload> {
  readonly viewId = 'context-effectiveness';

  protected emptyPayload(): ContextEffectivenessPayload {
    return {
      '24h': emptyWindow(),
      '7d': emptyWindow(),
      '30d': emptyWindow(),
    };
  }

  protected async querySnapshot(db: Db): Promise<ContextEffectivenessPayload> {
    try {
      const [data24h, data7d, data30d] = await Promise.all([
        query24h(db),
        query7d(db),
        query30d(db),
      ]);
      return { '24h': data24h, '7d': data7d, '30d': data30d };
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '42P01') {
        // Table not yet migrated — return empty gracefully
        return this.emptyPayload();
      }
      throw err;
    }
  }
}
