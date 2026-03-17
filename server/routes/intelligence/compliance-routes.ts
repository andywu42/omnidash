/**
 * Code compliance and document access routes.
 * Extracted from intelligence-routes.ts (OMN-5193).
 *
 * Data access: Direct DB (getIntelligenceDb)
 * // TODO: migrate to ProjectionService
 */
import type { Router } from 'express';
import { sql, desc, eq, and } from 'drizzle-orm';
import { getIntelligenceDb } from '../../storage';
import { onexComplianceStamps, documentMetadata } from '@shared/intelligence-schema';
import { safeInterval, safeTruncUnit, timeWindowToInterval } from '../../sql-safety';

export function registerComplianceRoutes(router: Router): void {
  // GET /code/compliance
  // TODO: migrate to ProjectionService
  router.get('/code/compliance', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '24h';
      const interval = timeWindowToInterval(timeWindow);
      const truncation = timeWindow === '24h' ? 'hour' : 'day';

      // Check if table exists first
      try {
        await getIntelligenceDb().execute(sql`SELECT 1 FROM onex_compliance_stamps LIMIT 1`);
      } catch (tableError: any) {
        const errorCode = tableError?.code || tableError?.errno || '';
        if (
          errorCode === '42P01' ||
          errorCode === '42P01' ||
          tableError?.message?.includes('does not exist')
        ) {
          return res.json({
            summary: {
              totalFiles: 0,
              compliantFiles: 0,
              nonCompliantFiles: 0,
              pendingFiles: 0,
              compliancePercentage: 0,
              avgComplianceScore: 0,
            },
            statusBreakdown: [],
            nodeTypeBreakdown: [],
            trend: [],
          });
        }
        throw tableError;
      }

      const [summaryResult] = await getIntelligenceDb()
        .select({
          totalFiles: sql<number>`COUNT(DISTINCT ${onexComplianceStamps.filePath})::int`,
          compliantFiles: sql<number>`
            COUNT(DISTINCT ${onexComplianceStamps.filePath}) FILTER (
              WHERE ${onexComplianceStamps.complianceStatus} = 'compliant'
            )::int
          `,
          nonCompliantFiles: sql<number>`
            COUNT(DISTINCT ${onexComplianceStamps.filePath}) FILTER (
              WHERE ${onexComplianceStamps.complianceStatus} = 'non_compliant'
            )::int
          `,
          pendingFiles: sql<number>`
            COUNT(DISTINCT ${onexComplianceStamps.filePath}) FILTER (
              WHERE ${onexComplianceStamps.complianceStatus} = 'pending'
            )::int
          `,
          avgComplianceScore: sql<number>`
            ROUND(AVG(${onexComplianceStamps.complianceScore}), 4)::numeric
          `,
        })
        .from(onexComplianceStamps)
        .where(sql`${onexComplianceStamps.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`);

      const totalFiles = summaryResult?.totalFiles || 0;
      const compliantFiles = summaryResult?.compliantFiles || 0;
      const nonCompliantFiles = summaryResult?.nonCompliantFiles || 0;
      const pendingFiles = summaryResult?.pendingFiles || 0;
      const compliancePercentage =
        totalFiles > 0 ? parseFloat(((compliantFiles / totalFiles) * 100).toFixed(1)) : 0;

      const summary = {
        totalFiles,
        compliantFiles,
        nonCompliantFiles,
        pendingFiles,
        compliancePercentage,
        avgComplianceScore: parseFloat(summaryResult?.avgComplianceScore?.toString() || '0'),
      };

      const statusBreakdownQuery = await getIntelligenceDb()
        .select({
          status: onexComplianceStamps.complianceStatus,
          count: sql<number>`COUNT(DISTINCT ${onexComplianceStamps.filePath})::int`,
        })
        .from(onexComplianceStamps)
        .where(sql`${onexComplianceStamps.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`)
        .groupBy(onexComplianceStamps.complianceStatus);

      const statusBreakdown = statusBreakdownQuery.map((s) => ({
        status: s.status,
        count: s.count,
        percentage: totalFiles > 0 ? parseFloat(((s.count / totalFiles) * 100).toFixed(1)) : 0,
      }));

      const nodeTypeBreakdownQuery = await getIntelligenceDb()
        .select({
          nodeType: onexComplianceStamps.nodeType,
          totalCount: sql<number>`COUNT(DISTINCT ${onexComplianceStamps.filePath})::int`,
          compliantCount: sql<number>`
            COUNT(DISTINCT ${onexComplianceStamps.filePath}) FILTER (
              WHERE ${onexComplianceStamps.complianceStatus} = 'compliant'
            )::int
          `,
        })
        .from(onexComplianceStamps)
        .where(
          and(
            sql`${onexComplianceStamps.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`,
            sql`${onexComplianceStamps.nodeType} IS NOT NULL`
          )
        )
        .groupBy(onexComplianceStamps.nodeType);

      const nodeTypeBreakdown = nodeTypeBreakdownQuery.map((n) => ({
        nodeType: n.nodeType || 'unknown',
        compliantCount: n.compliantCount,
        totalCount: n.totalCount,
        percentage:
          n.totalCount > 0 ? parseFloat(((n.compliantCount / n.totalCount) * 100).toFixed(1)) : 0,
      }));

      const trendQuery = await getIntelligenceDb()
        .select({
          period: sql<string>`DATE_TRUNC(${safeTruncUnit(truncation)}, ${onexComplianceStamps.createdAt})::text`,
          totalFiles: sql<number>`COUNT(DISTINCT ${onexComplianceStamps.filePath})::int`,
          compliantFiles: sql<number>`
            COUNT(DISTINCT ${onexComplianceStamps.filePath}) FILTER (
              WHERE ${onexComplianceStamps.complianceStatus} = 'compliant'
            )::int
          `,
        })
        .from(onexComplianceStamps)
        .where(sql`${onexComplianceStamps.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`)
        .groupBy(sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${onexComplianceStamps.createdAt})`)
        .orderBy(
          sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${onexComplianceStamps.createdAt}) ASC`
        );

      const trend = trendQuery.map((t) => ({
        period: t.period,
        compliancePercentage:
          t.totalFiles > 0 ? parseFloat(((t.compliantFiles / t.totalFiles) * 100).toFixed(1)) : 0,
        totalFiles: t.totalFiles,
      }));

      res.json({
        summary,
        statusBreakdown,
        nodeTypeBreakdown,
        trend,
      });
    } catch (error: any) {
      const errorCode = error?.code || error?.errno || '';
      const errorMessage = error?.message || error?.toString() || '';

      if (
        errorCode === '42P01' ||
        errorMessage.includes('does not exist') ||
        errorMessage.includes('relation')
      ) {
        return res.json({
          summary: {
            totalFiles: 0,
            compliantFiles: 0,
            nonCompliantFiles: 0,
            pendingFiles: 0,
            compliancePercentage: 0,
            avgComplianceScore: 0,
          },
          statusBreakdown: [],
          nodeTypeBreakdown: [],
          trend: [],
        });
      }

      console.error('Error fetching ONEX compliance data:', error);
      res.status(500).json({
        error: 'Failed to fetch ONEX compliance data',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /documents/top-accessed
  // TODO: migrate to ProjectionService
  router.get('/documents/top-accessed', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '7d';
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const interval = timeWindowToInterval(timeWindow);

      const topDocuments = await getIntelligenceDb()
        .select({
          id: documentMetadata.id,
          repository: documentMetadata.repository,
          filePath: documentMetadata.filePath,
          accessCount: documentMetadata.accessCount,
          lastAccessedAt: documentMetadata.lastAccessedAt,
          createdAt: documentMetadata.createdAt,
        })
        .from(documentMetadata)
        .where(
          and(
            eq(documentMetadata.status, 'active'),
            timeWindow === '24h' || timeWindow === '7d' || timeWindow === '30d'
              ? sql`${documentMetadata.lastAccessedAt} > NOW() - INTERVAL ${safeInterval(interval)} OR ${documentMetadata.lastAccessedAt} IS NULL`
              : sql`1=1`
          )
        )
        .orderBy(desc(documentMetadata.accessCount), desc(documentMetadata.createdAt))
        .limit(limit);

      const documentsWithTrends = topDocuments.map((doc) => {
        let trend: 'up' | 'down' | 'stable' = 'stable';
        let trendPercentage = 0;

        if (doc.accessCount > 0) {
          const lastAccessedTime = doc.lastAccessedAt ? new Date(doc.lastAccessedAt).getTime() : 0;
          const now = Date.now();
          const hoursSinceAccess = (now - lastAccessedTime) / (1000 * 60 * 60);

          if (hoursSinceAccess < 24) {
            trend = 'up';
            trendPercentage = Math.floor(10 + doc.accessCount * 2);
          } else if (hoursSinceAccess < 168) {
            trend = 'stable';
            trendPercentage = Math.floor(-2 + Math.random() * 4);
          } else {
            trend = 'down';
            trendPercentage = -Math.floor(5 + Math.random() * 10);
          }
        } else {
          trend = 'stable';
          trendPercentage = 0;
        }

        return {
          id: doc.id,
          repository: doc.repository,
          filePath: doc.filePath,
          accessCount: doc.accessCount,
          lastAccessedAt: doc.lastAccessedAt?.toISOString() || null,
          trend,
          trendPercentage,
        };
      });

      res.json(documentsWithTrends);
    } catch (error) {
      console.error('Error fetching top accessed documents:', error);
      res.status(500).json({
        error: 'Failed to fetch top accessed documents',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}
