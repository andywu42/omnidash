/**
 * ComplianceProjection — DB-backed projection for compliance evaluation data (OMN-5285)
 *
 * Projects from: compliance_evaluations table (migration 0024_compliance_evaluations)
 *
 * Snapshot payload holds aggregated summaries across the default (7d) window.
 * Routes can request specific windows via ensureFresh() and then filter/query
 * the snapshot client-side, or this projection can be extended with window-specific
 * snapshots in the future.
 *
 * Routes access this via complianceProjection.ensureFresh() — no direct DB imports
 * allowed in route files (OMN-2325).
 */

import { sql } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import { complianceEvaluations } from '@shared/intelligence-schema';
import type { ComplianceEvaluationRow } from '@shared/intelligence-schema';

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

export interface ComplianceSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgScore: number;
}

export interface ComplianceByRepo {
  repo: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgScore: number;
}

export interface ComplianceByRuleSet {
  ruleSet: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgScore: number;
}

export interface ComplianceTrendPoint {
  period: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgScore: number;
}

export interface CompliancePayload {
  summary: ComplianceSummary;
  evaluations: ComplianceEvaluationRow[];
  byRepo: ComplianceByRepo[];
  byRuleSet: ComplianceByRuleSet[];
  trend: ComplianceTrendPoint[];
}

export class ComplianceProjection extends DbBackedProjectionView<CompliancePayload> {
  readonly viewId = 'compliance';

  protected emptyPayload(): CompliancePayload {
    return {
      summary: { total: 0, passed: 0, failed: 0, passRate: 0, avgScore: 0 },
      evaluations: [],
      byRepo: [],
      byRuleSet: [],
      trend: [],
    };
  }

  protected async querySnapshot(db: Db): Promise<CompliancePayload> {
    try {
      const [summaryRows, evaluationRows, byRepoRows, byRuleSetRows, trendRows] = await Promise.all(
        [
          // Summary (last 7 days by default)
          db.execute<{
            total: string;
            passed: string;
            failed: string;
            avg_score: string | null;
          }>(sql`
            SELECT
              COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE pass = true)::text AS passed,
              COUNT(*) FILTER (WHERE pass = false)::text AS failed,
              ROUND(AVG(score)::numeric, 4)::text AS avg_score
            FROM compliance_evaluations
            WHERE event_timestamp > NOW() - INTERVAL '7 days'
          `),

          // Recent evaluations (last 7 days, up to 50)
          db.execute<Record<string, unknown>>(sql`
            SELECT id, evaluation_id, repo, rule_set, score, violations, pass, event_timestamp
            FROM compliance_evaluations
            WHERE event_timestamp > NOW() - INTERVAL '7 days'
            ORDER BY event_timestamp DESC
            LIMIT 50
          `),

          // By repo
          db.execute<{
            repo: string;
            total: string;
            passed: string;
            avg_score: string | null;
          }>(sql`
            SELECT
              repo,
              COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE pass = true)::text AS passed,
              ROUND(AVG(score)::numeric, 4)::text AS avg_score
            FROM compliance_evaluations
            WHERE event_timestamp > NOW() - INTERVAL '7 days'
            GROUP BY repo
          `),

          // By rule_set
          db.execute<{
            rule_set: string;
            total: string;
            passed: string;
            avg_score: string | null;
          }>(sql`
            SELECT
              rule_set,
              COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE pass = true)::text AS passed,
              ROUND(AVG(score)::numeric, 4)::text AS avg_score
            FROM compliance_evaluations
            WHERE event_timestamp > NOW() - INTERVAL '7 days'
            GROUP BY rule_set
          `),

          // Daily trend (last 7 days)
          db.execute<{
            period: string;
            total: string;
            passed: string;
            avg_score: string | null;
          }>(sql`
            SELECT
              DATE_TRUNC('day', event_timestamp)::text AS period,
              COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE pass = true)::text AS passed,
              ROUND(AVG(score)::numeric, 4)::text AS avg_score
            FROM compliance_evaluations
            WHERE event_timestamp > NOW() - INTERVAL '7 days'
            GROUP BY DATE_TRUNC('day', event_timestamp)
            ORDER BY period ASC
          `),
        ]
      );

      const s = summaryRows.rows[0];
      const total = Number(s?.total ?? 0);
      const passed = Number(s?.passed ?? 0);

      return {
        summary: {
          total,
          passed,
          failed: Number(s?.failed ?? 0),
          passRate: total > 0 ? parseFloat(((passed / total) * 100).toFixed(1)) : 0,
          avgScore: parseFloat(String(s?.avg_score ?? 0)),
        },
        evaluations: evaluationRows.rows as unknown as ComplianceEvaluationRow[],
        byRepo: byRepoRows.rows.map((r) => {
          const t = Number(r.total);
          const p = Number(r.passed);
          return {
            repo: String(r.repo),
            total: t,
            passed: p,
            failed: t - p,
            passRate: t > 0 ? parseFloat(((p / t) * 100).toFixed(1)) : 0,
            avgScore: parseFloat(String(r.avg_score ?? 0)),
          };
        }),
        byRuleSet: byRuleSetRows.rows.map((r) => {
          const t = Number(r.total);
          const p = Number(r.passed);
          return {
            ruleSet: String(r.rule_set),
            total: t,
            passed: p,
            failed: t - p,
            passRate: t > 0 ? parseFloat(((p / t) * 100).toFixed(1)) : 0,
            avgScore: parseFloat(String(r.avg_score ?? 0)),
          };
        }),
        trend: trendRows.rows.map((r) => {
          const t = Number(r.total);
          const p = Number(r.passed);
          return {
            period: String(r.period),
            total: t,
            passed: p,
            failed: t - p,
            passRate: t > 0 ? parseFloat(((p / t) * 100).toFixed(1)) : 0,
            avgScore: parseFloat(String(r.avg_score ?? 0)),
          };
        }),
      };
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '42P01') {
        // PostgreSQL "undefined_table" — migration not yet applied
        return this.emptyPayload();
      }
      throw err;
    }
  }
}
