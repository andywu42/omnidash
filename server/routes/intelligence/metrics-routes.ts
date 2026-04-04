/**
 * Operations metrics, quality impact, developer experience, and performance routes.
 * Extracted from intelligence-routes.ts (OMN-5193).
 *
 * Data access: Mixed (eventConsumer in-memory + direct DB)
 * // TODO(OMN-6111): migrate direct DB queries to ProjectionService
 */
import type { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getIntelligenceDb } from '../../storage';
import { agentMetricsProjection } from '../../projection-bootstrap';
import {
  agentActions,
  agentManifestInjections,
  taskCompletionMetrics,
} from '@shared/intelligence-schema';
import { safeInterval, safeTruncUnit, timeWindowToInterval } from '../../sql-safety';

export function registerMetricsRoutes(router: Router): void {
  // GET /metrics/operations-per-minute
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/metrics/operations-per-minute', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '24h';
      const interval = timeWindowToInterval(timeWindow);
      const truncation = timeWindow === '24h' ? 'hour' : 'day';

      const operationsData = await getIntelligenceDb()
        .select({
          period: sql<string>`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentActions.createdAt})::text`,
          actionType: agentActions.actionType,
          totalOperations: sql<number>`COUNT(*)::int`,
          operationsPerMinute: sql<number>`
            CASE
              WHEN ${safeTruncUnit(truncation)} = 'hour' THEN ROUND(COUNT(*)::numeric / 60.0, 2)
              WHEN ${safeTruncUnit(truncation)} = 'day' THEN ROUND(COUNT(*)::numeric / 1440.0, 2)
              ELSE ROUND(COUNT(*)::numeric / 60.0, 2)
            END
          `,
        })
        .from(agentActions)
        .where(sql`${agentActions.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`)
        .groupBy(
          sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentActions.createdAt})`,
          agentActions.actionType
        )
        .orderBy(sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentActions.createdAt}) DESC`);

      const formattedData = operationsData.map((d) => ({
        period: d.period,
        operationsPerMinute: parseFloat(d.operationsPerMinute?.toString() || '0'),
        actionType: d.actionType,
      }));

      res.json(formattedData);
    } catch (error) {
      console.error('Error fetching operations per minute:', error);
      res.status(500).json({
        error: 'Failed to fetch operations per minute',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /metrics/quality-impact
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/metrics/quality-impact', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '24h';
      const interval = timeWindowToInterval(timeWindow);
      const truncation = timeWindow === '24h' ? 'hour' : 'day';

      const qualityImpactData = await getIntelligenceDb()
        .select({
          period: sql<string>`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentManifestInjections.createdAt})::text`,
          avgQualityImprovement: sql<number>`
            ROUND(AVG(
              CASE
                WHEN ${agentManifestInjections.agentQualityScore} IS NOT NULL
                  AND ${agentManifestInjections.agentExecutionSuccess} = TRUE
                THEN ${agentManifestInjections.agentQualityScore}
                ELSE 0
              END
            ), 4)::numeric
          `,
          manifestsImproved: sql<number>`
            COUNT(*) FILTER (
              WHERE ${agentManifestInjections.agentQualityScore} IS NOT NULL
                AND ${agentManifestInjections.agentExecutionSuccess} = TRUE
                AND ${agentManifestInjections.agentQualityScore} > 0
            )::int
          `,
        })
        .from(agentManifestInjections)
        .where(
          sql`${agentManifestInjections.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`
        )
        .groupBy(
          sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentManifestInjections.createdAt})`
        )
        .orderBy(
          sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentManifestInjections.createdAt}) DESC`
        );

      const formattedImpacts = qualityImpactData.map((d) => ({
        period: d.period,
        avgQualityImprovement: parseFloat(d.avgQualityImprovement?.toString() || '0'),
        manifestsImproved: d.manifestsImproved,
      }));

      res.json(formattedImpacts);
    } catch (error) {
      console.error('Error fetching quality impact:', error);
      res.status(500).json({
        error: 'Failed to fetch quality impact',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /developer/workflows
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/developer/workflows', async (req, res) => {
    try {
      const workflows = await getIntelligenceDb()
        .select({
          actionType: agentActions.actionType,
          completions: sql<number>`COUNT(*)::int`,
          avgDurationMs: sql<number>`ROUND(AVG(${agentActions.durationMs}), 1)::numeric`,
        })
        .from(agentActions)
        .where(sql`${agentActions.createdAt} > NOW() - INTERVAL '7 days'`)
        .groupBy(agentActions.actionType)
        .orderBy(sql`COUNT(*) DESC`);

      const previousWorkflows = await getIntelligenceDb()
        .select({
          actionType: agentActions.actionType,
          completions: sql<number>`COUNT(*)::int`,
        })
        .from(agentActions)
        .where(
          sql`
          ${agentActions.createdAt} > NOW() - INTERVAL '14 days' AND
          ${agentActions.createdAt} <= NOW() - INTERVAL '7 days'
        `
        )
        .groupBy(agentActions.actionType);

      const previousLookup = new Map(previousWorkflows.map((w) => [w.actionType, w.completions]));

      const actionTypeNames: Record<string, string> = {
        tool_call: 'Code Generation',
        decision: 'Decision Making',
        error: 'Error Handling',
        success: 'Task Completion',
        validation: 'Code Validation',
        analysis: 'Code Analysis',
      };

      const formattedWorkflows = workflows.map((w) => {
        const currentCompletions = w.completions;
        const previousCompletions = previousLookup.get(w.actionType) || 0;

        let improvement = 0;
        if (previousCompletions > 0) {
          improvement = Math.round(
            ((currentCompletions - previousCompletions) / previousCompletions) * 100
          );
        } else if (currentCompletions > 0) {
          improvement = 100;
        }

        const avgMs = parseFloat(w.avgDurationMs?.toString() || '0');
        const avgTime = avgMs >= 1000 ? `${(avgMs / 1000).toFixed(1)}s` : `${Math.round(avgMs)}ms`;

        return {
          id: w.actionType,
          name: actionTypeNames[w.actionType] || w.actionType,
          completions: currentCompletions,
          avgTime,
          improvement,
        };
      });

      res.json(formattedWorkflows);
    } catch (error) {
      console.error('Error fetching developer workflows:', error);
      res.status(500).json({
        error: 'Failed to fetch developer workflows',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /developer/velocity
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/developer/velocity', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '24h';
      const interval = timeWindowToInterval(timeWindow);
      const truncation = timeWindow === '24h' ? 'hour' : 'day';

      const velocityData = await getIntelligenceDb()
        .select({
          period: sql<string>`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentActions.createdAt})::text`,
          actionCount: sql<number>`COUNT(*)::int`,
        })
        .from(agentActions)
        .where(sql`${agentActions.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`)
        .groupBy(sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentActions.createdAt})`)
        .orderBy(sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentActions.createdAt}) ASC`);

      const formattedVelocity = velocityData.map((v) => {
        const timestamp = new Date(v.period);
        let timeLabel: string;

        if (timeWindow === '24h') {
          timeLabel = `${timestamp.getHours()}:00`;
        } else {
          timeLabel = timestamp.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          });
        }

        return {
          time: timeLabel,
          value: v.actionCount,
        };
      });

      res.json(formattedVelocity);
    } catch (error) {
      console.error('Error fetching developer velocity:', error);
      res.status(500).json({
        error: 'Failed to fetch developer velocity',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /developer/productivity
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/developer/productivity', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '24h';
      const interval = timeWindowToInterval(timeWindow);
      const truncation = timeWindow === '24h' ? 'hour' : 'day';

      const productivityData = await getIntelligenceDb()
        .select({
          period: sql<string>`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentActions.createdAt})::text`,
          successRate: sql<number>`
            COUNT(*) FILTER (WHERE ${agentActions.actionType} IN ('success', 'tool_call'))::numeric /
            NULLIF(COUNT(*), 0)
          `,
          avgConfidence: sql<number>`
            AVG(CASE
              WHEN ${agentActions.actionType} IN ('success', 'tool_call') THEN 1.0
              WHEN ${agentActions.actionType} = 'error' THEN 0.0
              ELSE 0.5
            END)::numeric
          `,
        })
        .from(agentActions)
        .where(sql`${agentActions.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`)
        .groupBy(sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentActions.createdAt})`)
        .orderBy(sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${agentActions.createdAt}) ASC`);

      const formattedProductivity = productivityData.map((p) => {
        const timestamp = new Date(p.period);
        let timeLabel: string;

        if (timeWindow === '24h') {
          timeLabel = `${timestamp.getHours()}:00`;
        } else {
          timeLabel = timestamp.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          });
        }

        const successRate = parseFloat(p.successRate?.toString() || '0');
        const avgConfidence = parseFloat(p.avgConfidence?.toString() || '0');
        const productivityScore = Math.round(successRate * avgConfidence * 100);

        return {
          time: timeLabel,
          value: productivityScore,
        };
      });

      res.json(formattedProductivity);
    } catch (error) {
      console.error('Error fetching developer productivity:', error);
      res.status(500).json({
        error: 'Failed to fetch developer productivity',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /developer/task-velocity
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/developer/task-velocity', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '7d';
      const interval = timeWindowToInterval(timeWindow);
      const truncation = timeWindow === '24h' ? 'hour' : 'day';

      const velocityData = await getIntelligenceDb()
        .select({
          period: sql<string>`DATE_TRUNC(${safeTruncUnit(truncation)}, ${taskCompletionMetrics.createdAt})::text`,
          tasksCompleted: sql<number>`COUNT(*) FILTER (WHERE ${taskCompletionMetrics.success} = TRUE)::int`,
          avgDurationMs: sql<number>`ROUND(AVG(${taskCompletionMetrics.completionTimeMs}) FILTER (WHERE ${taskCompletionMetrics.success} = TRUE), 1)::numeric`,
          totalTasks: sql<number>`COUNT(*)::int`,
        })
        .from(taskCompletionMetrics)
        .where(sql`${taskCompletionMetrics.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`)
        .groupBy(sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${taskCompletionMetrics.createdAt})`)
        .orderBy(
          sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${taskCompletionMetrics.createdAt}) ASC`
        );

      const formattedVelocity = velocityData.map((v) => {
        const timestamp = new Date(v.period);
        const dateLabel =
          timeWindow === '24h'
            ? timestamp.toISOString().split('T')[0] +
              ' ' +
              timestamp.getHours().toString().padStart(2, '0') +
              ':00'
            : timestamp.toISOString().split('T')[0];

        const tasksPerDay =
          timeWindow === '24h' ? parseFloat((v.tasksCompleted * 24).toFixed(1)) : v.tasksCompleted;

        return {
          date: dateLabel,
          tasksCompleted: v.tasksCompleted,
          avgDurationMs: parseFloat(v.avgDurationMs?.toString() || '0'),
          tasksPerDay: tasksPerDay,
        };
      });

      res.json(formattedVelocity);
    } catch (error) {
      console.error('Error fetching task velocity:', error);
      res.status(500).json({
        error: 'Failed to fetch task velocity',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /developer/metrics
  // Proxy to OmniIntelligence API with graceful fallback [OMN-6150, OMN-6758]
  // Previously the frontend fetched directly from the external service, causing
  // "Failed to load developer metrics" when the service was offline.
  router.get('/developer/metrics', async (req, res) => {
    const timeWindow = (req.query.timeWindow as string) || '24h';
    const intelligenceBaseUrl = process.env.INTELLIGENCE_SERVICE_URL;
    if (!intelligenceBaseUrl) {
      res.status(503).json({ error: 'INTELLIGENCE_SERVICE_URL is not configured' });
      return;
    }
    const upstreamUrl = `${intelligenceBaseUrl}/api/intelligence/developer/metrics?timeWindow=${timeWindow}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const upstream = await fetch(upstreamUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!upstream.ok) {
        throw new Error(`Upstream returned ${upstream.status}`);
      }

      const data = await upstream.json();
      res.json(data);
    } catch (error) {
      // Graceful fallback: return empty metrics shape so the page renders without crashing
      console.warn(
        '[metrics-routes] OmniIntelligence API unreachable, returning empty metrics:',
        error instanceof Error ? error.message : error
      );
      res.json({
        workflows: {
          workflows: [],
          total_developers: 0,
          total_code_generated: 0,
        },
        velocity: {
          time_window: timeWindow,
          data: [],
        },
        productivity: {
          time_window: timeWindow,
          data: [],
          avg_productivity_gain: 0,
          pattern_reuse_rate: 0,
        },
      });
    }
  });

  // GET /performance/metrics
  router.get('/performance/metrics', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);

      const metrics = await agentMetricsProjection.getPerformanceMetrics(limit);
      const stats = await agentMetricsProjection.getPerformanceStatsPublic();

      res.json({
        metrics,
        stats,
        total: metrics.length,
      });
    } catch (error) {
      console.error('Error fetching performance metrics:', error);
      res.status(500).json({
        error: 'Failed to fetch performance metrics',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /performance/summary
  router.get('/performance/summary', async (req, res) => {
    try {
      const stats = await agentMetricsProjection.getPerformanceStatsPublic();

      res.json(stats);
    } catch (error) {
      console.error('Error fetching performance summary:', error);
      res.status(500).json({
        error: 'Failed to fetch performance summary',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}
