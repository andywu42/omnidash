/**
 * InfraRoutingProjection — DB-backed projection for infra routing decisions (OMN-7447)
 *
 * Projects from: onex.evt.omnibase-infra.routing-decided.v1
 * Source table:  infra_routing_decisions (populated by read-model-consumer.ts)
 *
 * Routes access this via projectionService.getView('infra-routing').getSnapshot()
 * — no direct DB imports allowed in route files (OMN-2325).
 */

import { sql } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';

// ============================================================================
// Payload types
// ============================================================================

export interface InfraRoutingDecisionRow {
  id: string;
  correlationId: string;
  sessionId: string | null;
  selectedProvider: string;
  selectedTier: string;
  selectedModel: string;
  reason: string;
  selectionMode: string;
  isFallback: boolean;
  candidatesEvaluated: number;
  taskType: string | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface InfraRoutingProviderSummary {
  provider: string;
  count: number;
}

export interface InfraRoutingModelSummary {
  model: string;
  count: number;
}

export interface InfraRoutingSummary {
  totalDecisions: number;
  fallbackCount: number;
  fallbackRate: number;
  avgLatencyMs: number | null;
  byProvider: InfraRoutingProviderSummary[];
  byModel: InfraRoutingModelSummary[];
}

export interface InfraRoutingPayload {
  recent: InfraRoutingDecisionRow[];
  summary: InfraRoutingSummary;
}

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

// ============================================================================
// Projection
// ============================================================================

export class InfraRoutingProjection extends DbBackedProjectionView<InfraRoutingPayload> {
  readonly viewId = 'infra-routing';

  protected emptyPayload(): InfraRoutingPayload {
    return {
      recent: [],
      summary: {
        totalDecisions: 0,
        fallbackCount: 0,
        fallbackRate: 0,
        avgLatencyMs: null,
        byProvider: [],
        byModel: [],
      },
    };
  }

  protected async querySnapshot(db: Db, limit = 100): Promise<InfraRoutingPayload> {
    try {
      const [recentRows, summaryRows, providerRows, modelRows] = await Promise.all([
        db.execute(sql`
          SELECT
            id,
            correlation_id AS "correlationId",
            session_id AS "sessionId",
            selected_provider AS "selectedProvider",
            selected_tier AS "selectedTier",
            selected_model AS "selectedModel",
            reason,
            selection_mode AS "selectionMode",
            is_fallback AS "isFallback",
            candidates_evaluated AS "candidatesEvaluated",
            task_type AS "taskType",
            latency_ms AS "latencyMs",
            created_at::text AS "createdAt"
          FROM infra_routing_decisions
          WHERE created_at >= NOW() - INTERVAL '24 hours'
          ORDER BY created_at DESC
          LIMIT ${limit}
        `),
        db.execute(sql`
          SELECT
            COUNT(*)::int AS "totalDecisions",
            COUNT(*) FILTER (WHERE is_fallback = TRUE)::int AS "fallbackCount",
            ROUND(AVG(latency_ms), 2) AS "avgLatencyMs"
          FROM infra_routing_decisions
          WHERE created_at >= NOW() - INTERVAL '24 hours'
        `),
        db.execute(sql`
          SELECT
            selected_provider AS provider,
            COUNT(*)::int AS count
          FROM infra_routing_decisions
          WHERE created_at >= NOW() - INTERVAL '24 hours'
          GROUP BY selected_provider
          ORDER BY count DESC
        `),
        db.execute(sql`
          SELECT
            selected_model AS model,
            COUNT(*)::int AS count
          FROM infra_routing_decisions
          WHERE created_at >= NOW() - INTERVAL '24 hours'
          GROUP BY selected_model
          ORDER BY count DESC
        `),
      ]);

      const rawSummary = ((summaryRows.rows ?? []) as unknown[])[0] as
        | {
            totalDecisions?: number;
            fallbackCount?: number;
            avgLatencyMs?: string | null;
          }
        | undefined;

      const totalDecisions = Number(rawSummary?.totalDecisions ?? 0);
      const fallbackCount = Number(rawSummary?.fallbackCount ?? 0);
      const avgLatencyMs =
        rawSummary?.avgLatencyMs != null ? Number(rawSummary.avgLatencyMs) : null;

      return {
        recent: (recentRows.rows ?? []) as unknown as InfraRoutingDecisionRow[],
        summary: {
          totalDecisions,
          fallbackCount,
          fallbackRate:
            totalDecisions > 0 ? Number(((fallbackCount / totalDecisions) * 100).toFixed(1)) : 0,
          avgLatencyMs,
          byProvider: (providerRows.rows ?? []) as unknown as InfraRoutingProviderSummary[],
          byModel: (modelRows.rows ?? []) as unknown as InfraRoutingModelSummary[],
        },
      };
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        pgCode === '42P01' ||
        (msg.includes('infra_routing_decisions') && msg.includes('does not exist'))
      ) {
        return this.emptyPayload();
      }
      throw err;
    }
  }
}
