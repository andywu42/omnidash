/**
 * GateDecisionsProjection — DB-backed projection for gate decision events (OMN-2602)
 *
 * Projects from: onex.evt.omniclaude.gate-decision.v1
 * Source table:  gate_decisions (populated by read-model-consumer.ts)
 *
 * Snapshot payload shape:
 *   { recent: GateDecisionRow[]; summary: GateDecisionSummary }
 *
 * Routes access this via projectionService.getView('gate-decisions').getSnapshot()
 * — no direct DB imports allowed in route files (OMN-2325).
 */

import { sql } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import {
  gateDecisionRowSchema,
  gateDecisionSummarySchema,
  gateDecisionsPayloadSchema,
  type GateDecisionRow,
  type GateDecisionSummary,
  type GateDecisionsPayload,
} from '@shared/omniclaude-state-schema';

// ============================================================================
// Payload types — derived from Drizzle schema + Zod (OMN-2602)
// Re-export so client code can import from this projection file directly.
// ============================================================================

export type { GateDecisionRow, GateDecisionSummary, GateDecisionsPayload };

// ============================================================================
// Projection
// ============================================================================

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

export class GateDecisionsProjection extends DbBackedProjectionView<GateDecisionsPayload> {
  readonly viewId = 'gate-decisions';

  protected emptyPayload(): GateDecisionsPayload {
    return {
      recent: [],
      summary: { total: 0, passed: 0, failed: 0, blocked: 0, pass_rate: 0 },
    };
  }

  protected async querySnapshot(db: Db, limit = 50): Promise<GateDecisionsPayload> {
    try {
      const [recentRows, summaryRows] = await Promise.all([
        db.execute(sql`
          SELECT
            correlation_id,
            pr_number,
            repo,
            gate_name,
            outcome,
            blocking,
            created_at::text
          FROM gate_decisions
          ORDER BY created_at DESC
          LIMIT ${limit}
        `),
        db.execute(sql`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE outcome = 'ACCEPTED')::int AS passed,
            COUNT(*) FILTER (WHERE outcome IN ('REJECTED', 'TIMEOUT'))::int AS failed,
            COUNT(*) FILTER (WHERE blocking = true)::int AS blocked
          FROM gate_decisions
          WHERE created_at >= NOW() - INTERVAL '7 days'
        `),
      ]);

      const rawSummary = ((summaryRows.rows ?? []) as unknown[])[0];
      const total = Number((rawSummary as { total?: unknown })?.total ?? 0);
      const passed = Number((rawSummary as { passed?: unknown })?.passed ?? 0);
      const failed = Number((rawSummary as { failed?: unknown })?.failed ?? 0);
      const blocked = Number((rawSummary as { blocked?: unknown })?.blocked ?? 0);

      const recent = (recentRows.rows ?? []).map((row) => gateDecisionRowSchema.parse(row));
      const summary = gateDecisionSummarySchema.parse({
        total,
        passed,
        failed,
        blocked,
        pass_rate: total > 0 ? passed / total : 0,
      });

      return gateDecisionsPayloadSchema.parse({ recent, summary });
    } catch (err) {
      // Graceful degrade: table may not exist yet
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('gate_decisions') && msg.includes('does not exist'))
      ) {
        return this.emptyPayload();
      }
      throw err;
    }
  }
}
