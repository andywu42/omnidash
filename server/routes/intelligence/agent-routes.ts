/**
 * Agent routing, actions, transformations, and agent detail routes.
 * Extracted from intelligence-routes.ts (OMN-5193).
 *
 * Data access: DB-backed via AgentMetricsProjection (OMN-7132)
 */
import type { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getIntelligenceDb } from '../../storage';
import { agentMetricsProjection } from '../../projection-bootstrap';
import { agentRoutingDecisions, agentTransformationEvents } from '@shared/intelligence-schema';
import { safeInterval, timeWindowToInterval } from '../../sql-safety';
import type {
  RoutingStrategyBreakdown,
  TransformationSummary,
  TransformationNode,
  TransformationLink,
} from './types';

export function registerAgentRoutes(router: Router): void {
  // GET /agents/summary
  router.get('/agents/summary', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '24h';

      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      });

      const metrics = await agentMetricsProjection.getAgentSummary(timeWindow);
      if (metrics.length > 0) {
        console.log(`[API] Returning ${metrics.length} agents from agent-metrics projection`);
        return res.json(metrics);
      }

      console.log(`[API] Agent metrics projection empty, falling back to database query`);

      // Fallback: query PostgreSQL directly when projection is empty
      const interval = timeWindowToInterval(timeWindow);
      const rowsResult = await getIntelligenceDb().execute(sql`
        SELECT
          COALESCE(ard.selected_agent, aa.agent_name) AS agent,
          COUNT(DISTINCT COALESCE(aa.id, ard.id)) AS total_requests,
          AVG(COALESCE(ard.routing_time_ms, aa.duration_ms, 0)) AS avg_routing_time,
          AVG(COALESCE(ard.confidence_score, 0)) AS avg_confidence
        FROM agent_actions aa
        FULL OUTER JOIN agent_routing_decisions ard
          ON aa.correlation_id = ard.correlation_id
        WHERE (aa.created_at >= NOW() - INTERVAL ${safeInterval(interval)})
           OR (ard.created_at >= NOW() - INTERVAL ${safeInterval(interval)})
        GROUP BY COALESCE(ard.selected_agent, aa.agent_name)
        HAVING COUNT(DISTINCT COALESCE(aa.id, ard.id)) > 0
        ORDER BY total_requests DESC
        LIMIT 50
      `);

      const rows = Array.isArray(rowsResult) ? rowsResult : rowsResult?.rows || rowsResult || [];

      const transformed = (rows as any[]).map((r) => {
        const totalRequests = Number(r.total_requests || 0);
        const avgConfidence = Number(r.avg_confidence || 0);
        const successRate = avgConfidence > 0 ? avgConfidence : null;

        return {
          agent: r.agent || 'unknown',
          totalRequests,
          avgRoutingTime: Number(r.avg_routing_time || 0),
          avgConfidence,
          successRate,
          lastSeen: new Date(),
        };
      });

      return res.json(transformed);
    } catch (error) {
      console.error('Error fetching agent summary:', error);
      res.status(500).json({
        error: 'Failed to fetch agent summary',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /actions/recent
  router.get('/actions/recent', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);

      const actionsMem = await agentMetricsProjection.getRecentActions(limit);
      if (actionsMem.length > 0) {
        console.log(`[API] Returning ${actionsMem.length} actions from agent-metrics projection`);
        return res.json(actionsMem.slice(0, limit));
      }

      console.log(`[API] Agent-metrics projection actions empty, falling back to database`);

      // Fallback: pull most recent actions from PostgreSQL
      try {
        const rowsResult = await getIntelligenceDb().execute(sql`
          SELECT id, correlation_id, agent_name, action_type, action_name, action_details, debug_mode, duration_ms, created_at
          FROM agent_actions
          ORDER BY created_at DESC
          LIMIT ${Math.max(1, Math.min(limit, 1000))}
        `);

        const rows = Array.isArray(rowsResult) ? rowsResult : rowsResult?.rows || rowsResult || [];

        const transformed = (rows as any[]).map((r) => ({
          id: r.id,
          correlationId: r.correlation_id,
          agentName: r.agent_name,
          actionType: r.action_type,
          actionName: r.action_name,
          actionDetails: r.action_details,
          debugMode: !!r.debug_mode,
          durationMs: Number(r.duration_ms || 0),
          createdAt: r.created_at,
        }));
        return res.json(transformed);
      } catch (dbError) {
        console.log(
          '[API] Database query failed, returning empty:',
          dbError instanceof Error ? dbError.message : 'Unknown error'
        );
      }

      // No data available from projection or database
      return res.json([]);
    } catch (error) {
      console.error('Error in /actions/recent endpoint:', error);
      res.status(500).json({
        error: 'Failed to fetch recent actions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /agents/:agent/actions
  router.get('/agents/:agent/actions', async (req, res) => {
    try {
      const { agent } = req.params;
      const timeWindow = (req.query.timeWindow as string) || '1h';
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);

      const actions = await agentMetricsProjection.getActionsByAgent(agent, timeWindow, limit);
      res.json(actions);
    } catch (error) {
      console.error('Error fetching agent actions:', error);
      res.status(500).json({
        error: 'Failed to fetch agent actions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /agents/routing-strategy
  router.get('/agents/routing-strategy', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '24h';
      const interval = timeWindowToInterval(timeWindow);

      const strategyData = await getIntelligenceDb()
        .select({
          strategy: agentRoutingDecisions.routingStrategy,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(agentRoutingDecisions)
        .where(sql`${agentRoutingDecisions.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`)
        .groupBy(agentRoutingDecisions.routingStrategy)
        .orderBy(sql`COUNT(*) DESC`);

      const total = strategyData.reduce((sum, s) => sum + s.count, 0);
      const formattedData: RoutingStrategyBreakdown[] = strategyData.map((s) => ({
        strategy: s.strategy ?? 'unknown',
        count: s.count,
        percentage: total > 0 ? parseFloat(((s.count / total) * 100).toFixed(1)) : 0,
      }));

      res.json(formattedData);
    } catch (error) {
      console.error('Error fetching routing strategy breakdown:', error);
      res.status(500).json({
        error: 'Failed to fetch routing strategy breakdown',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /routing/decisions
  router.get('/routing/decisions', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
      const agentFilter = req.query.agent as string;
      const minConfidence = req.query.minConfidence
        ? parseFloat(req.query.minConfidence as string)
        : undefined;

      const decisions = await agentMetricsProjection.getRoutingDecisions({
        agent: agentFilter,
        minConfidence,
      });

      const sliced = decisions.slice(0, limit);
      console.log(
        `[API] Returning ${sliced.length} routing decisions from agent-metrics projection`
      );
      res.json(sliced);
    } catch (error) {
      console.error('Error fetching routing decisions:', error);
      res.status(500).json({
        error: 'Failed to fetch routing decisions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /transformations/summary
  router.get('/transformations/summary', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '24h';
      const interval = timeWindowToInterval(timeWindow);

      const [summaryResult] = await getIntelligenceDb()
        .select({
          totalTransformations: sql<number>`COUNT(*)::int`,
          uniqueSourceAgents: sql<number>`COUNT(DISTINCT ${agentTransformationEvents.sourceAgent})::int`,
          uniqueTargetAgents: sql<number>`COUNT(DISTINCT ${agentTransformationEvents.targetAgent})::int`,
          avgTransformationTimeMs: sql<number>`ROUND(AVG(${agentTransformationEvents.transformationDurationMs}), 1)::numeric`,
          successRate: sql<number>`ROUND(
            COUNT(*) FILTER (WHERE ${agentTransformationEvents.success} = TRUE)::numeric /
            NULLIF(COUNT(*), 0),
            4
          )::numeric`,
        })
        .from(agentTransformationEvents)
        .where(
          sql`${agentTransformationEvents.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`
        );

      const mostCommonResult = await getIntelligenceDb()
        .select({
          source: agentTransformationEvents.sourceAgent,
          target: agentTransformationEvents.targetAgent,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(agentTransformationEvents)
        .where(
          sql`${agentTransformationEvents.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`
        )
        .groupBy(agentTransformationEvents.sourceAgent, agentTransformationEvents.targetAgent)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(1);

      const transformationFlows = await getIntelligenceDb()
        .select({
          source: agentTransformationEvents.sourceAgent,
          target: agentTransformationEvents.targetAgent,
          value: sql<number>`COUNT(*)::int`,
          avgConfidence: sql<number>`ROUND(AVG(${agentTransformationEvents.confidenceScore}), 3)::numeric`,
          avgDurationMs: sql<number>`ROUND(AVG(${agentTransformationEvents.transformationDurationMs}), 0)::numeric`,
        })
        .from(agentTransformationEvents)
        .where(
          sql`${agentTransformationEvents.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`
        )
        .groupBy(agentTransformationEvents.sourceAgent, agentTransformationEvents.targetAgent)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(50);

      const nodeSet = new Set<string>();
      transformationFlows.forEach((flow) => {
        nodeSet.add(flow.source);
        nodeSet.add(flow.target);
      });

      const nodes: TransformationNode[] = Array.from(nodeSet).map((agentName) => ({
        id: agentName,
        label: agentName
          .replace('agent-', '')
          .split('-')
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' '),
      }));

      const links: TransformationLink[] = transformationFlows.map((flow) => ({
        source: flow.source,
        target: flow.target,
        value: flow.value,
        avgConfidence: parseFloat(flow.avgConfidence?.toString() || '0'),
        avgDurationMs: parseFloat(flow.avgDurationMs?.toString() || '0'),
      }));

      const summary: TransformationSummary = {
        totalTransformations: summaryResult?.totalTransformations || 0,
        uniqueSourceAgents: summaryResult?.uniqueSourceAgents || 0,
        uniqueTargetAgents: summaryResult?.uniqueTargetAgents || 0,
        avgTransformationTimeMs: parseFloat(
          summaryResult?.avgTransformationTimeMs?.toString() || '0'
        ),
        successRate: parseFloat(summaryResult?.successRate?.toString() || '1.0'),
        mostCommonTransformation:
          mostCommonResult.length > 0
            ? {
                source: mostCommonResult[0].source,
                target: mostCommonResult[0].target,
                count: mostCommonResult[0].count,
              }
            : null,
      };

      res.json({
        summary,
        sankey: {
          nodes,
          links,
        },
      });
    } catch (error) {
      console.error('Error fetching transformation summary:', error);
      res.status(500).json({
        error: 'Failed to fetch transformation summary',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /transformations/recent
  router.get('/transformations/recent', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);

      const transformations = await agentMetricsProjection.getRecentTransformations(limit);

      res.json({
        transformations,
        total: transformations.length,
      });
    } catch (error) {
      console.error('Error fetching recent transformations:', error);
      res.status(500).json({
        error: 'Failed to fetch recent transformations',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /agents/:agentName/details
  router.get('/agents/:agentName/details', async (req, res) => {
    try {
      const { agentName } = req.params;
      const timeWindow = (req.query.timeWindow as string) || '24h';

      const metrics = await agentMetricsProjection.getAgentSummary(timeWindow);
      const agentMetric = metrics.find((m) => m.agent === agentName);

      if (!agentMetric) {
        return res.status(404).json({
          error: 'Agent not found',
          message: `No data found for agent: ${agentName}`,
        });
      }

      const actions = await agentMetricsProjection.getActionsByAgent(agentName, timeWindow);

      const totalActions = actions.length;
      const successfulActions = actions.filter(
        (a) =>
          a.actionDetails &&
          typeof a.actionDetails === 'object' &&
          'success' in (a.actionDetails as Record<string, unknown>) &&
          (a.actionDetails as Record<string, unknown>).success === true
      ).length;
      const successRate = totalActions > 0 ? (successfulActions / totalActions) * 100 : 0;

      const actionDurations = actions.filter((a) => a.durationMs).map((a) => a.durationMs);
      const avgResponseTime =
        actionDurations.length > 0
          ? actionDurations.reduce((sum, d) => sum + d, 0) / actionDurations.length
          : 0;

      const recentActions = actions.slice(0, 5);
      const hasRecentErrors = recentActions.some(
        (a) =>
          a.actionDetails &&
          typeof a.actionDetails === 'object' &&
          'error' in (a.actionDetails as Record<string, unknown>)
      );
      const status = hasRecentErrors ? 'error' : totalActions > 0 ? 'active' : 'idle';

      const currentAction = actions[0];
      const currentTask = currentAction?.actionType || null;

      const recentActivity = recentActions.map((action) => ({
        id: action.id,
        timestamp: action.createdAt,
        description: `${action.actionType}: ${action.actionName || 'Unknown'}${action.actionDetails && typeof action.actionDetails === 'object' && 'error' in (action.actionDetails as Record<string, unknown>) ? ' (failed)' : ''}`,
      }));

      const response = {
        name: agentName,
        status,
        successRate: Math.round(successRate * 100) / 100,
        responseTime: Math.round(avgResponseTime),
        tasksCompleted: totalActions,
        currentTask,
        recentActivity,
        metrics: {
          totalRequests: agentMetric.totalRequests,
          avgConfidence: agentMetric.avgConfidence,
          avgRoutingTime: agentMetric.avgRoutingTime,
        },
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching agent details:', error);
      res.status(500).json({
        error: 'Failed to fetch agent details',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}
