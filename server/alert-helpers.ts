import { sql } from 'drizzle-orm';
import { getIntelligenceDb } from './storage';
import {
  agentActions,
  agentManifestInjections,
  agentRoutingDecisions,
} from '@shared/intelligence-schema';
import { safeInterval } from './sql-safety';

/**
 * Alert Metrics Cache
 * Caches alert metrics for 30 seconds to reduce database load
 */
interface AlertMetricsCache {
  errorRate: number;
  injectionSuccessRate: number;
  avgResponseTime: number;
  successRate: number;
  timestamp: number;
}

let metricsCache: AlertMetricsCache | null = null;
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Check if cache is valid
 */
function isCacheValid(): boolean {
  if (!metricsCache) return false;
  return Date.now() - metricsCache.timestamp < CACHE_TTL_MS;
}

/**
 * Get all alert metrics in a single optimized query
 * Fetches all metrics in parallel and caches for 30 seconds
 */
export async function getAllAlertMetrics(): Promise<AlertMetricsCache> {
  // Return cached data if still valid
  if (isCacheValid() && metricsCache) {
    return metricsCache;
  }

  try {
    // Execute all queries in parallel for maximum performance
    const [errorRate, injectionSuccessRate, avgResponseTime, successRate] = await Promise.all([
      getErrorRateUncached('10 minutes'),
      getManifestInjectionSuccessRateUncached('1 hour'),
      getAvgResponseTimeUncached('10 minutes'),
      getSuccessRateUncached('1 hour'),
    ]);

    // Cache the results
    metricsCache = {
      errorRate,
      injectionSuccessRate,
      avgResponseTime,
      successRate,
      timestamp: Date.now(),
    };

    return metricsCache;
  } catch (error) {
    console.error('Error fetching alert metrics:', error);
    // Propagate null to signal data unavailability — callers must handle
    throw new Error(
      `Alert metrics unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Clear the metrics cache (useful for testing or forcing refresh)
 */
export function clearAlertMetricsCache(): void {
  metricsCache = null;
}

/**
 * Internal: Calculate error rate without caching
 */
async function getErrorRateUncached(timeWindow: string): Promise<number> {
  try {
    const interval =
      timeWindow === '1 hour'
        ? '1 hour'
        : timeWindow === '10 minutes'
          ? '10 minutes'
          : timeWindow === '24 hours'
            ? '24 hours'
            : '10 minutes';

    // Optimized query - only count, no full table scan
    const [result] = await getIntelligenceDb()
      .select({
        totalActions: sql<number>`COUNT(*)::int`,
        errorActions: sql<number>`
          COUNT(*) FILTER (
            WHERE ${agentActions.actionType} = 'error'
          )::int
        `,
      })
      .from(agentActions)
      .where(sql`${agentActions.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`);

    if (!result || result.totalActions === 0) {
      return 0;
    }

    return result.errorActions / result.totalActions;
  } catch (error) {
    console.error('Error calculating error rate:', error);
    return 0;
  }
}

/**
 * Internal: Calculate manifest injection success rate without caching
 */
async function getManifestInjectionSuccessRateUncached(timeWindow: string): Promise<number> {
  try {
    const interval =
      timeWindow === '1 hour' ? '1 hour' : timeWindow === '24 hours' ? '24 hours' : '1 hour';

    const [result] = await getIntelligenceDb()
      .select({
        totalInjections: sql<number>`COUNT(*)::int`,
        successfulInjections: sql<number>`
          COUNT(*) FILTER (
            WHERE ${agentManifestInjections.agentExecutionSuccess} = TRUE
          )::int
        `,
      })
      .from(agentManifestInjections)
      .where(
        sql`${agentManifestInjections.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`
      );

    if (!result || result.totalInjections === 0) {
      return 1.0;
    }

    return result.successfulInjections / result.totalInjections;
  } catch (error) {
    console.error('Error calculating manifest injection success rate:', error);
    return 1.0;
  }
}

/**
 * Internal: Calculate average response time without caching
 */
async function getAvgResponseTimeUncached(timeWindow: string): Promise<number> {
  try {
    const interval =
      timeWindow === '10 minutes'
        ? '10 minutes'
        : timeWindow === '1 hour'
          ? '1 hour'
          : timeWindow === '24 hours'
            ? '24 hours'
            : '10 minutes';

    const [result] = await getIntelligenceDb()
      .select({
        avgTimeMs: sql<number>`ROUND(AVG(${agentRoutingDecisions.routingTimeMs}))::int`,
      })
      .from(agentRoutingDecisions)
      .where(sql`${agentRoutingDecisions.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`);

    if (!result || !result.avgTimeMs) {
      return 0;
    }

    return result.avgTimeMs;
  } catch (error) {
    console.error('Error calculating average response time:', error);
    return 0;
  }
}

/**
 * Internal: Calculate overall success rate without caching
 */
async function getSuccessRateUncached(timeWindow: string): Promise<number> {
  try {
    const interval =
      timeWindow === '1 hour' ? '1 hour' : timeWindow === '24 hours' ? '24 hours' : '1 hour';

    const [result] = await getIntelligenceDb()
      .select({
        totalDecisions: sql<number>`COUNT(*)::int`,
        successfulDecisions: sql<number>`
          COUNT(*) FILTER (
            WHERE ${agentRoutingDecisions.executionSucceeded} = TRUE
          )::int
        `,
      })
      .from(agentRoutingDecisions)
      .where(sql`${agentRoutingDecisions.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`);

    if (!result || result.totalDecisions === 0) {
      return 1.0;
    }

    return result.successfulDecisions / result.totalDecisions;
  } catch (error) {
    console.error('Error calculating success rate:', error);
    return 1.0;
  }
}

/**
 * Legacy public functions for backward compatibility
 * Use getAllAlertMetrics() for best performance
 */
export async function getErrorRate(_timeWindow: string): Promise<number> {
  const metrics = await getAllAlertMetrics();
  return metrics.errorRate;
}

export async function getManifestInjectionSuccessRate(_timeWindow: string): Promise<number> {
  const metrics = await getAllAlertMetrics();
  return metrics.injectionSuccessRate;
}

export async function getAvgResponseTime(_timeWindow: string): Promise<number> {
  const metrics = await getAllAlertMetrics();
  return metrics.avgResponseTime;
}

export async function getSuccessRate(_timeWindow: string): Promise<number> {
  const metrics = await getAllAlertMetrics();
  return metrics.successRate;
}
