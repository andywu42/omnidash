/**
 * SkillProjection — DB-backed projection for skill invocation data (OMN-5278)
 *
 * Projects from: skill_invocations table (migration 0024_skill_invocations)
 *
 * Routes access this via skillProjection.ensureFresh() — no direct DB imports
 * allowed in route files (OMN-2325).
 */

import { sql } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

export interface SkillSummaryRow {
  skillName: string;
  invocations: number;
  avgMs: number | null;
  successRate: number;
}

export interface SkillInvocationRow {
  id: number;
  skillName: string;
  sessionId: string | null;
  durationMs: number | null;
  success: boolean;
  error: string | null;
  createdAt: string;
}

export interface SkillTotals {
  totalInvocations: number;
  uniqueSkills: number;
  overallSuccessRate: number;
}

export interface SkillPayload {
  skills: SkillSummaryRow[];
  recent: SkillInvocationRow[];
  totals: SkillTotals;
}

export class SkillProjection extends DbBackedProjectionView<SkillPayload> {
  readonly viewId = 'skills';

  protected emptyPayload(): SkillPayload {
    return {
      skills: [],
      recent: [],
      totals: { totalInvocations: 0, uniqueSkills: 0, overallSuccessRate: 0 },
    };
  }

  protected async querySnapshot(db: Db): Promise<SkillPayload> {
    try {
      const [skillRows, recentRows, totalsRows] = await Promise.all([
        db.execute<{
          skill_name: string;
          invocations: string;
          avg_ms: string | null;
          success_rate: string;
        }>(sql`
          SELECT
            skill_name,
            COUNT(*)::text AS invocations,
            ROUND(AVG(duration_ms)::numeric, 0)::text AS avg_ms,
            ROUND(
              SUM(CASE WHEN success THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0),
              4
            )::text AS success_rate
          FROM skill_invocations
          GROUP BY skill_name
          ORDER BY COUNT(*) DESC
          LIMIT 20
        `),

        db.execute<{
          id: string;
          skill_name: string;
          session_id: string | null;
          duration_ms: string | null;
          success: boolean;
          error: string | null;
          created_at: string;
        }>(sql`
          SELECT id, skill_name, session_id, duration_ms, success, error, created_at
          FROM skill_invocations
          ORDER BY created_at DESC
          LIMIT 50
        `),

        db.execute<{
          total_invocations: string;
          unique_skills: string;
          overall_success_rate: string;
        }>(sql`
          SELECT
            COUNT(*)::text AS total_invocations,
            COUNT(DISTINCT skill_name)::text AS unique_skills,
            ROUND(
              SUM(CASE WHEN success THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0),
              4
            )::text AS overall_success_rate
          FROM skill_invocations
        `),
      ]);

      const t = totalsRows.rows[0];

      return {
        skills: skillRows.rows.map((r) => ({
          skillName: r.skill_name,
          invocations: Number(r.invocations),
          avgMs: r.avg_ms != null ? Number(r.avg_ms) : null,
          successRate: parseFloat(String(r.success_rate ?? 0)),
        })),
        recent: recentRows.rows.map((r) => ({
          id: Number(r.id),
          skillName: r.skill_name,
          sessionId: r.session_id ?? null,
          durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
          success: Boolean(r.success),
          error: r.error ?? null,
          createdAt: String(r.created_at),
        })),
        totals: {
          totalInvocations: Number(t?.total_invocations ?? 0),
          uniqueSkills: Number(t?.unique_skills ?? 0),
          overallSuccessRate: parseFloat(String(t?.overall_success_rate ?? 0)),
        },
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
