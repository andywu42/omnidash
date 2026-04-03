/**
 * Golden chain sweep results routes (OMN-7358).
 * Provides historical sweep data for trend analysis.
 *
 * Data access: Direct DB (getIntelligenceDb)
 */
import type { Router } from 'express';
import { desc, eq, gte, and } from 'drizzle-orm';
import { getIntelligenceDb } from '../../storage';
import { goldenChainSweepResults } from '@shared/intelligence-schema';

export function registerGoldenChainRoutes(router: Router): void {
  // GET /golden-chain/history
  // Returns sweep history with optional filtering by days and chain_name.
  router.get('/golden-chain/history', async (req, res) => {
    try {
      const db = getIntelligenceDb();
      if (!db) {
        return res.status(503).json({ error: 'Intelligence DB not available' });
      }

      const days = parseInt(req.query.days as string) || 7;
      const chainName = req.query.chain_name as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const offset = parseInt(req.query.offset as string) || 0;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);

      const conditions = [gte(goldenChainSweepResults.createdAt, cutoff)];
      if (chainName) {
        conditions.push(eq(goldenChainSweepResults.chainName, chainName));
      }

      const results = await db
        .select()
        .from(goldenChainSweepResults)
        .where(and(...conditions))
        .orderBy(desc(goldenChainSweepResults.createdAt))
        .limit(limit)
        .offset(offset);

      // Compute pass rate trend grouped by sweep_id
      const sweepIds = [...new Set(results.map((r) => r.sweepId))];
      const sweepSummaries = sweepIds.map((sweepId) => {
        const sweepResults = results.filter((r) => r.sweepId === sweepId);
        const passCount = sweepResults.filter((r) => r.status === 'pass').length;
        const totalCount = sweepResults.length;
        return {
          sweepId,
          createdAt: sweepResults[0]?.createdAt,
          passRate: totalCount > 0 ? passCount / totalCount : 0,
          totalChains: totalCount,
          passCount,
          failCount: sweepResults.filter((r) => r.status === 'fail').length,
          timeoutCount: sweepResults.filter((r) => r.status === 'timeout').length,
          errorCount: sweepResults.filter((r) => r.status === 'error').length,
        };
      });

      res.json({
        results,
        sweepSummaries,
        pagination: { limit, offset, total: results.length },
      });
    } catch (error) {
      console.error('Golden chain history query failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /golden-chain/latest
  // Returns the most recent sweep result.
  router.get('/golden-chain/latest', async (req, res) => {
    try {
      const db = getIntelligenceDb();
      if (!db) {
        return res.status(503).json({ error: 'Intelligence DB not available' });
      }

      // Get the most recent sweep_id
      const latest = await db
        .select({ sweepId: goldenChainSweepResults.sweepId })
        .from(goldenChainSweepResults)
        .orderBy(desc(goldenChainSweepResults.createdAt))
        .limit(1);

      if (latest.length === 0) {
        return res.json({ sweep: null, chains: [] });
      }

      const sweepId = latest[0].sweepId;
      const chains = await db
        .select()
        .from(goldenChainSweepResults)
        .where(eq(goldenChainSweepResults.sweepId, sweepId));

      const passCount = chains.filter((r) => r.status === 'pass').length;
      const totalCount = chains.length;

      res.json({
        sweep: {
          sweepId,
          createdAt: chains[0]?.createdAt,
          overallStatus: passCount === totalCount ? 'pass' : passCount === 0 ? 'fail' : 'partial',
          passRate: totalCount > 0 ? passCount / totalCount : 0,
          passCount,
          totalCount,
        },
        chains,
      });
    } catch (error) {
      console.error('Golden chain latest query failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}
