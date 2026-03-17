/**
 * Health check, system status, service health, and runtime identity routes.
 * Extracted from intelligence-routes.ts (OMN-5193).
 *
 * Data access: Mixed (eventConsumer + direct DB)
 * // TODO: migrate direct DB queries to ProjectionService
 */
import type { Router } from 'express';
import { sql, eq, gte, and } from 'drizzle-orm';
import { getIntelligenceDb } from '../../storage';
import { eventConsumer } from '../../event-consumer';
import { readModelConsumer } from '../../read-model-consumer';
import { getRuntimeIdentityForApi, runtimeIdentity } from '../../runtime-identity';
import { checkAllServices } from '../../service-health';
import { agentManifestInjections, nodeServiceRegistry } from '@shared/intelligence-schema';
import type { ManifestInjectionHealth } from './types';

export function registerHealthRoutes(router: Router): void {
  // GET /health
  router.get('/health', async (req, res) => {
    try {
      const health = eventConsumer.getHealthStatus();
      res.json({
        ...health,
        runtime: {
          supervised: runtimeIdentity.supervised,
          mode: runtimeIdentity.runtimeMode,
        },
      });
    } catch (error) {
      console.error('Health check failed:', error);
      res.status(503).json({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // GET /read-model/status
  router.get('/read-model/status', async (req, res) => {
    try {
      const stats = readModelConsumer.getStats();
      res.json({
        status: stats.isRunning ? 'running' : 'stopped',
        eventsProjected: stats.eventsProjected,
        errorsCount: stats.errorsCount,
        lastProjectedAt: stats.lastProjectedAt,
        topicStats: stats.topicStats,
        database: 'omnidash_analytics',
        catalog_source: stats.catalogSource,
        unsupported_catalog_topics: stats.unsupportedCatalogTopics,
      });
    } catch (error) {
      console.error('Error fetching read-model status:', error);
      res.status(500).json({
        error: 'Failed to fetch read-model status',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /runtime/identity
  router.get('/runtime/identity', (req, res) => {
    res.json(getRuntimeIdentityForApi());
  });

  // GET /health/manifest-injection
  // TODO: migrate to ProjectionService
  router.get('/health/manifest-injection', async (req, res) => {
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [metricsResult] = await getIntelligenceDb()
        .select({
          totalInjections: sql<number>`COUNT(*)::int`,
          successfulInjections: sql<number>`
            COUNT(*) FILTER (WHERE ${agentManifestInjections.agentExecutionSuccess} = TRUE)::int
          `,
          failedInjections: sql<number>`
            COUNT(*) FILTER (WHERE ${agentManifestInjections.agentExecutionSuccess} = FALSE)::int
          `,
          avgLatencyMs: sql<number>`
            ROUND(AVG(${agentManifestInjections.totalQueryTimeMs}), 2)::numeric
          `,
        })
        .from(agentManifestInjections)
        .where(gte(agentManifestInjections.createdAt, twentyFourHoursAgo));

      const totalInjections = metricsResult?.totalInjections || 0;
      const successfulInjections = metricsResult?.successfulInjections || 0;
      const successRate =
        totalInjections > 0 ? parseFloat((successfulInjections / totalInjections).toFixed(4)) : 1.0;
      const avgLatencyMs = parseFloat(metricsResult?.avgLatencyMs?.toString() || '0');

      const failedInjectionsQuery = await getIntelligenceDb()
        .select({
          errorType: sql<string>`
            CASE
              WHEN ${agentManifestInjections.isFallback} = TRUE THEN 'fallback_used'
              WHEN ${agentManifestInjections.debugIntelligenceFailures} > 0 THEN 'intelligence_failure'
              ELSE 'execution_failure'
            END
          `,
          count: sql<number>`COUNT(*)::int`,
          lastOccurrence: sql<string>`MAX(${agentManifestInjections.createdAt})::text`,
        })
        .from(agentManifestInjections)
        .where(
          and(
            gte(agentManifestInjections.createdAt, twentyFourHoursAgo),
            eq(agentManifestInjections.agentExecutionSuccess, false)
          )
        ).groupBy(sql`
          CASE
            WHEN ${agentManifestInjections.isFallback} = TRUE THEN 'fallback_used'
            WHEN ${agentManifestInjections.debugIntelligenceFailures} > 0 THEN 'intelligence_failure'
            ELSE 'execution_failure'
          END
        `);

      const failedInjections = failedInjectionsQuery.map((f) => ({
        errorType: f.errorType,
        count: f.count,
        lastOccurrence: f.lastOccurrence,
      }));

      const [sizeStatsResult] = await getIntelligenceDb()
        .select({
          avgSizeBytes: sql<number>`
            AVG(LENGTH(${agentManifestInjections.fullManifestSnapshot}::text))::numeric
          `,
          minSizeBytes: sql<number>`
            MIN(LENGTH(${agentManifestInjections.fullManifestSnapshot}::text))::numeric
          `,
          maxSizeBytes: sql<number>`
            MAX(LENGTH(${agentManifestInjections.fullManifestSnapshot}::text))::numeric
          `,
        })
        .from(agentManifestInjections)
        .where(gte(agentManifestInjections.createdAt, twentyFourHoursAgo));

      const manifestSizeStats = {
        avgSizeKb: parseFloat(
          (parseFloat(sizeStatsResult?.avgSizeBytes?.toString() || '0') / 1024).toFixed(2)
        ),
        minSizeKb: parseFloat(
          (parseFloat(sizeStatsResult?.minSizeBytes?.toString() || '0') / 1024).toFixed(2)
        ),
        maxSizeKb: parseFloat(
          (parseFloat(sizeStatsResult?.maxSizeBytes?.toString() || '0') / 1024).toFixed(2)
        ),
      };

      const latencyTrendQuery = await getIntelligenceDb()
        .select({
          period: sql<string>`DATE_TRUNC('hour', ${agentManifestInjections.createdAt})::text`,
          avgLatencyMs: sql<number>`ROUND(AVG(${agentManifestInjections.totalQueryTimeMs}), 2)::numeric`,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(agentManifestInjections)
        .where(gte(agentManifestInjections.createdAt, twentyFourHoursAgo))
        .groupBy(sql`DATE_TRUNC('hour', ${agentManifestInjections.createdAt})`)
        .orderBy(sql`DATE_TRUNC('hour', ${agentManifestInjections.createdAt}) DESC`);

      const latencyTrend = latencyTrendQuery.map((t) => ({
        period: t.period,
        avgLatencyMs: parseFloat(t.avgLatencyMs?.toString() || '0'),
        count: t.count,
      }));

      const serviceHealth: ManifestInjectionHealth['serviceHealth'] = {
        postgresql: { status: 'up', latencyMs: 0 },
        qdrant: { status: 'down' },
      };

      const pgStartTime = Date.now();
      try {
        await getIntelligenceDb().execute(sql`SELECT 1`);
        serviceHealth.postgresql = {
          status: 'up',
          latencyMs: Date.now() - pgStartTime,
        };
      } catch (pgError) {
        serviceHealth.postgresql = { status: 'down' };
        console.error('PostgreSQL health check failed:', pgError);
      }

      serviceHealth.qdrant = { status: 'up', latencyMs: 0 };

      const healthResponse: ManifestInjectionHealth = {
        successRate,
        avgLatencyMs,
        failedInjections,
        manifestSizeStats,
        latencyTrend,
        serviceHealth,
      };

      res.json(healthResponse);
    } catch (error) {
      console.error('Error fetching manifest injection health:', error);
      res.status(500).json({
        error: 'Failed to fetch manifest injection health',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /platform/services
  // TODO: migrate to ProjectionService
  router.get('/platform/services', async (req, res) => {
    try {
      const services = await getIntelligenceDb()
        .select({
          id: nodeServiceRegistry.id,
          serviceName: nodeServiceRegistry.serviceName,
          serviceUrl: nodeServiceRegistry.serviceUrl,
          serviceType: nodeServiceRegistry.serviceType,
          healthStatus: nodeServiceRegistry.healthStatus,
          lastHealthCheck: nodeServiceRegistry.lastHealthCheck,
        })
        .from(nodeServiceRegistry)
        .where(eq(nodeServiceRegistry.isActive, true))
        .orderBy(nodeServiceRegistry.serviceName);

      const formattedServices = services.map((s) => ({
        id: s.id,
        serviceName: s.serviceName,
        serviceUrl: s.serviceUrl,
        serviceType: s.serviceType || 'unknown',
        healthStatus: s.healthStatus,
        lastHealthCheck: s.lastHealthCheck?.toISOString() || null,
      }));

      res.json(formattedServices);
    } catch (error) {
      console.error('Error fetching platform services:', error);
      res.status(500).json({
        error: 'Failed to fetch platform services',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /services/health
  router.get('/services/health', async (req, res) => {
    try {
      const healthChecks = await checkAllServices();
      const allUp = healthChecks.every((check) => check.status === 'up');
      const statusCode = allUp ? 200 : 503;

      res.status(statusCode).json({
        timestamp: new Date().toISOString(),
        overallStatus: allUp ? 'healthy' : 'unhealthy',
        services: healthChecks,
        summary: {
          total: healthChecks.length,
          up: healthChecks.filter((c) => c.status === 'up').length,
          down: healthChecks.filter((c) => c.status === 'down').length,
          warning: healthChecks.filter((c) => c.status === 'warning').length,
        },
      });
    } catch (error) {
      console.error('Service health check failed:', error);
      res.status(500).json({
        timestamp: new Date().toISOString(),
        overallStatus: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        services: [],
      });
    }
  });

  // GET /services/:serviceName/details
  router.get('/services/:serviceName/details', async (req, res) => {
    try {
      const { serviceName } = req.params;

      const healthChecks = await checkAllServices();
      const serviceHealth = healthChecks.find(
        (check) => check.service.toLowerCase() === serviceName.toLowerCase()
      );

      if (!serviceHealth) {
        return res.status(404).json({
          error: 'Service not found',
          message: `No service found with name: ${serviceName}`,
        });
      }

      const statusMap = {
        up: 'healthy',
        down: 'down',
        warning: 'degraded',
      };

      const response = {
        name: serviceHealth.service,
        status: statusMap[serviceHealth.status as keyof typeof statusMap] || 'down',
        uptime: serviceHealth.status === 'up' ? 99.9 : 0,
        responseTime: (serviceHealth as any).responseTime || 0,
        lastCheck: new Date().toISOString(),
        details: serviceHealth.details,
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching service details:', error);
      res.status(500).json({
        error: 'Failed to fetch service details',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}
