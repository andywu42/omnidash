/**
 * Smoke test / adapter test endpoints for development and demo.
 * Extracted from intelligence-routes.ts (OMN-5193).
 *
 * These are temporary endpoints for testing adapters. They should NOT
 * be relied upon in production.
 */
import type { Router } from 'express';
import { intelligenceEvents } from '../../intelligence-event-adapter';
import { dbAdapter } from '../../db-adapter';

export function registerMockRoutes(router: Router): void {
  // Test Intelligence Event Adapter (Kafka request/response)
  router.get('/events/test/patterns', async (req, res) => {
    try {
      const sourcePath = (req.query.path as string) || 'node_*_effect.py';
      const language = (req.query.lang as string) || 'python';
      const timeout = Number(req.query.timeout ?? 15000);
      if (intelligenceEvents.started !== true) {
        await intelligenceEvents.start();
      }
      const result = await intelligenceEvents.requestPatternDiscovery(
        { sourcePath, language },
        timeout
      );
      return res.json({ ok: true, result });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // Test DB Adapter (simple count)
  router.get('/db/test/count', async (req, res) => {
    try {
      const table = (req.query.table as string) || 'agent_actions';
      const count = await dbAdapter.count(table);
      return res.json({ ok: true, table, count });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // Discover patterns via intelligence service (generic wrapper)
  // GET /analysis/patterns?path=glob&lang=python&timeout=8000
  router.get('/analysis/patterns', async (req, res) => {
    try {
      const sourcePath = (req.query.path as string) || 'node_*_effect.py';
      const language = (req.query.lang as string) || 'python';
      const timeoutParam = req.query.timeout as string | undefined;
      const timeoutMs = timeoutParam
        ? Math.max(1000, Math.min(60000, parseInt(timeoutParam, 10) || 0))
        : 6000;

      if (intelligenceEvents.started !== true) {
        await intelligenceEvents.start();
      }

      const result = await intelligenceEvents.requestPatternDiscovery(
        { sourcePath, language },
        timeoutMs
      );
      return res.json({ patterns: result?.patterns || [], meta: { sourcePath, language } });
    } catch (err: any) {
      return res.status(502).json({ message: err?.message || 'Pattern discovery failed' });
    }
  });
}
