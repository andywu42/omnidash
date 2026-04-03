/**
 * AgentMetricsProjection — DB-backed projection replacing EventConsumer
 * in-memory agent metrics, actions, and performance data (OMN-7132)
 *
 * Replaces the following EventConsumer methods with DB queries:
 *   - getAgentMetrics()        → queryAgentSummary()
 *   - getRecentActions()       → queryRecentActions()
 *   - getActionsByAgent()      → queryActionsByAgent()
 *   - getRoutingDecisions()    → queryRoutingDecisions()
 *   - getRecentTransformations() → queryRecentTransformations()
 *   - getPerformanceMetrics()  → queryPerformanceMetrics()
 *   - getPerformanceStats()    → queryPerformanceStats()
 *   - getHealthStatus()        → queryHealthStatus()
 *   - getNodeRegistryStats()   → queryNodeRegistryStats()
 *
 * Source tables: agent_routing_decisions, agent_actions,
 *   agent_transformation_events, projection_watermarks
 */

import { sql } from 'drizzle-orm';
import { agentActions, agentTransformationEvents } from '@shared/intelligence-schema';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';

// ============================================================================
// Payload types
// ============================================================================

export interface AgentMetricsSummary {
  agent: string;
  totalRequests: number;
  avgRoutingTime: number;
  avgConfidence: number;
  successRate: number | null;
  lastSeen: Date;
}

export interface AgentActionRecord {
  id: string;
  correlationId: string;
  agentName: string;
  actionType: string;
  actionName: string;
  actionDetails: unknown;
  debugMode: boolean;
  durationMs: number;
  createdAt: string;
}

export interface PerformanceStatsRecord {
  avgRoutingDuration: number;
  cacheHitRate: number;
  totalDecisions: number;
  successRate: number;
}

export interface AgentMetricsPayload {
  agentSummary: AgentMetricsSummary[];
  recentActions: AgentActionRecord[];
  performanceStats: PerformanceStatsRecord;
}

// ============================================================================
// Projection
// ============================================================================

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

let tableCheckLogged = false;

export class AgentMetricsProjection extends DbBackedProjectionView<AgentMetricsPayload> {
  readonly viewId = 'agent-metrics';

  protected emptyPayload(): AgentMetricsPayload {
    return {
      agentSummary: [],
      recentActions: [],
      performanceStats: {
        avgRoutingDuration: 0,
        cacheHitRate: 0,
        totalDecisions: 0,
        successRate: 0,
      },
    };
  }

  protected async querySnapshot(db: Db): Promise<AgentMetricsPayload> {
    const [agentSummary, recentActions, performanceStats] = await Promise.all([
      this.queryAgentSummary(db),
      this.queryRecentActions(db, 100),
      this.queryPerformanceStats(db),
    ]);
    return { agentSummary, recentActions, performanceStats };
  }

  // --------------------------------------------------------------------------
  // Public query methods (called directly from routes after ensureFresh())
  // --------------------------------------------------------------------------

  async getAgentSummary(timeWindow = '24h'): Promise<AgentMetricsSummary[]> {
    const db = tryGetIntelligenceDb();
    if (!db) return [];
    try {
      return await this.queryAgentSummary(db, timeWindow);
    } catch {
      return [];
    }
  }

  async getRecentActions(limit = 100): Promise<AgentActionRecord[]> {
    const db = tryGetIntelligenceDb();
    if (!db) return [];
    try {
      return await this.queryRecentActions(db, limit);
    } catch {
      return [];
    }
  }

  async getActionsByAgent(
    agentName: string,
    timeWindow = '1h',
    limit = 1000
  ): Promise<AgentActionRecord[]> {
    const db = tryGetIntelligenceDb();
    if (!db) return [];
    try {
      const interval = timeWindowToInterval(timeWindow);
      const rows = await db.execute(sql`
        SELECT id, correlation_id, agent_name, action_type, action_name,
               action_details, debug_mode, duration_ms, created_at
        FROM agent_actions
        WHERE agent_name = ${agentName}
          AND created_at >= NOW() - INTERVAL ${interval}
        ORDER BY created_at DESC
        LIMIT ${Math.max(1, Math.min(limit, 1000))}
      `);
      const resultRows = Array.isArray(rows) ? rows : rows?.rows || [];
      return (resultRows as any[]).map(mapActionRow);
    } catch {
      return [];
    }
  }

  async getRoutingDecisions(filters?: { agent?: string; minConfidence?: number }): Promise<any[]> {
    const db = tryGetIntelligenceDb();
    if (!db) return [];
    try {
      const rows = await db.execute(sql`
        SELECT id, correlation_id, user_request, selected_agent,
               confidence_score, routing_strategy, routing_time_ms,
               execution_succeeded, created_at
        FROM agent_routing_decisions
        ORDER BY created_at DESC
        LIMIT 1000
      `);
      const resultRows = Array.isArray(rows) ? rows : rows?.rows || [];
      let results = (resultRows as any[]).map((r) => ({
        id: r.id,
        correlationId: r.correlation_id,
        userRequest: r.user_request,
        selectedAgent: r.selected_agent,
        confidenceScore: parseFloat(r.confidence_score || '0'),
        routingStrategy: r.routing_strategy,
        routingTimeMs: Number(r.routing_time_ms || 0),
        executionSucceeded: r.execution_succeeded,
        createdAt: r.created_at,
      }));

      if (filters?.agent) {
        results = results.filter((d) => d.selectedAgent === filters.agent);
      }
      if (filters?.minConfidence != null) {
        results = results.filter((d) => d.confidenceScore >= filters.minConfidence!);
      }
      return results;
    } catch {
      return [];
    }
  }

  async getRecentTransformations(limit = 50): Promise<any[]> {
    const db = tryGetIntelligenceDb();
    if (!db) return [];
    try {
      const rows = await db
        .select()
        .from(agentTransformationEvents)
        .orderBy(sql`${agentTransformationEvents.createdAt} DESC`)
        .limit(Math.max(1, Math.min(limit, 500)));
      return rows;
    } catch {
      return [];
    }
  }

  async getPerformanceMetrics(limit = 100): Promise<any[]> {
    const db = tryGetIntelligenceDb();
    if (!db) return [];
    try {
      const rows = await db.execute(sql`
        SELECT id, correlation_id, selected_agent, routing_time_ms,
               confidence_score, created_at
        FROM agent_routing_decisions
        ORDER BY created_at DESC
        LIMIT ${Math.max(1, Math.min(limit, 1000))}
      `);
      const resultRows = Array.isArray(rows) ? rows : rows?.rows || [];
      return (resultRows as any[]).map((r) => ({
        id: r.id,
        correlationId: r.correlation_id,
        agent: r.selected_agent,
        routingDurationMs: Number(r.routing_time_ms || 0),
        confidence: parseFloat(r.confidence_score || '0'),
        timestamp: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  async getPerformanceStatsPublic(): Promise<PerformanceStatsRecord> {
    const db = tryGetIntelligenceDb();
    if (!db) return this.emptyPayload().performanceStats;
    try {
      return await this.queryPerformanceStats(db);
    } catch {
      return this.emptyPayload().performanceStats;
    }
  }

  async getHealthStatus(): Promise<{
    status: 'healthy' | 'degraded' | 'unavailable';
    eventsProcessed: number;
    recentActionsCount: number;
  }> {
    const db = tryGetIntelligenceDb();
    if (!db) {
      return { status: 'unavailable', eventsProcessed: 0, recentActionsCount: 0 };
    }
    try {
      const totalRaw = await db.execute(sql`
        SELECT COUNT(*)::int AS total FROM agent_actions
      `);
      const totalRows = Array.isArray(totalRaw) ? totalRaw : totalRaw?.rows || [];
      const totalResult = (totalRows as any[])[0];
      const recentRaw = await db.execute(sql`
        SELECT COUNT(*)::int AS recent FROM agent_actions
        WHERE created_at >= NOW() - INTERVAL '5 minutes'
      `);
      const recentRows = Array.isArray(recentRaw) ? recentRaw : recentRaw?.rows || [];
      const recentResult = (recentRows as any[])[0];
      const total = totalResult?.total ?? 0;
      const recent = recentResult?.recent ?? 0;
      return {
        status: recent > 0 ? 'healthy' : total > 0 ? 'degraded' : 'unavailable',
        eventsProcessed: total,
        recentActionsCount: recent,
      };
    } catch {
      return { status: 'unavailable', eventsProcessed: 0, recentActionsCount: 0 };
    }
  }

  // --------------------------------------------------------------------------
  // Internal query methods
  // --------------------------------------------------------------------------

  private async queryAgentSummary(db: Db, timeWindow = '24h'): Promise<AgentMetricsSummary[]> {
    const interval = timeWindowToInterval(timeWindow);
    const rows = await db.execute(sql`
      SELECT
        COALESCE(ard.selected_agent, aa.agent_name) AS agent,
        COUNT(DISTINCT COALESCE(aa.id, ard.id))::int AS total_requests,
        AVG(COALESCE(ard.routing_time_ms, aa.duration_ms, 0)) AS avg_routing_time,
        AVG(COALESCE(ard.confidence_score, 0)) AS avg_confidence
      FROM agent_actions aa
      FULL OUTER JOIN agent_routing_decisions ard
        ON aa.correlation_id = ard.correlation_id
      WHERE (aa.created_at >= NOW() - INTERVAL ${interval})
         OR (ard.created_at >= NOW() - INTERVAL ${interval})
      GROUP BY COALESCE(ard.selected_agent, aa.agent_name)
      HAVING COUNT(DISTINCT COALESCE(aa.id, ard.id)) > 0
      ORDER BY total_requests DESC
      LIMIT 50
    `);

    const resultRows = Array.isArray(rows) ? rows : rows?.rows || [];
    return (resultRows as any[]).map((r) => {
      const totalRequests = Number(r.total_requests || 0);
      const avgConfidence = Number(r.avg_confidence || 0);
      return {
        agent: r.agent || 'unknown',
        totalRequests,
        avgRoutingTime: Number(r.avg_routing_time || 0),
        avgConfidence,
        successRate: avgConfidence > 0 ? avgConfidence : null,
        lastSeen: new Date(),
      };
    });
  }

  private async queryRecentActions(db: Db, limit: number): Promise<AgentActionRecord[]> {
    const rows = await db.execute(sql`
      SELECT id, correlation_id, agent_name, action_type, action_name,
             action_details, debug_mode, duration_ms, created_at
      FROM agent_actions
      ORDER BY created_at DESC
      LIMIT ${Math.max(1, Math.min(limit, 1000))}
    `);
    const resultRows = Array.isArray(rows) ? rows : rows?.rows || [];
    return (resultRows as any[]).map(mapActionRow);
  }

  private async queryPerformanceStats(db: Db): Promise<PerformanceStatsRecord> {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total_decisions,
        AVG(routing_time_ms) AS avg_routing_duration,
        COUNT(*) FILTER (WHERE execution_succeeded = TRUE)::int AS success_count
      FROM agent_routing_decisions
    `);
    const resultRows = Array.isArray(rows) ? rows : rows?.rows || [];
    const row = (resultRows as any[])[0] || {};
    const total = Number(row.total_decisions || 0);
    const successCount = Number(row.success_count || 0);
    return {
      avgRoutingDuration: Number(row.avg_routing_duration || 0),
      cacheHitRate: 0, // No cache in DB-backed path
      totalDecisions: total,
      successRate: total > 0 ? successCount / total : 0,
    };
  }

  private async tableExists(db: Db): Promise<boolean> {
    try {
      await db.select({ id: agentActions.id }).from(agentActions).limit(1);
      return true;
    } catch (err: unknown) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '42P01' || (err instanceof Error && err.message.includes('does not exist'))) {
        if (!tableCheckLogged) {
          console.log('[agent-metrics] agent_actions table does not exist — returning empty');
          tableCheckLogged = true;
        }
        return false;
      }
      throw err;
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function mapActionRow(r: any): AgentActionRecord {
  return {
    id: r.id,
    correlationId: r.correlation_id,
    agentName: r.agent_name,
    actionType: r.action_type,
    actionName: r.action_name,
    actionDetails: r.action_details,
    debugMode: !!r.debug_mode,
    durationMs: Number(r.duration_ms || 0),
    createdAt: r.created_at,
  };
}

function timeWindowToInterval(tw: string): string {
  const match = tw.match(/^(\d+)([hmd])$/);
  if (!match) return '24 hours';
  const [, num, unit] = match;
  switch (unit) {
    case 'h':
      return `${num} hours`;
    case 'm':
      return `${num} minutes`;
    case 'd':
      return `${num} days`;
    default:
      return '24 hours';
  }
}
