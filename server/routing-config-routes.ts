/**
 * Routing Config API Routes (OMN-3445)
 *
 * Generic key-value store for LLM routing configuration.
 * Handles model switcher (active_routing_model) and
 * prompt version tracking (routing_prompt_version).
 *
 * Endpoints:
 *   GET /api/routing-config/:key  — fetch single config value
 *   PUT /api/routing-config/:key  — upsert config value (body: { value: string })
 *
 * Data is persisted in the routing_config table
 * (migrations/0012_routing_config.sql).
 *
 * OMN-2325 exemption: routing config CRUD requires direct DB writes.
 * Once routing config is event-sourced, migrate to a ProjectionService view.
 * TODO(OMN-3445-followup): migrate to event-sourced projection.
 */

import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { tryGetIntelligenceDb } from './storage';

const router = Router();

// ============================================================================
// GET /api/routing-config/:key
// ============================================================================

router.get('/:key', async (req: Request, res: Response) => {
  const { key } = req.params;

  const db = tryGetIntelligenceDb();
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }

  try {
    const rows = await db.execute(sql`SELECT key, value FROM routing_config WHERE key = ${key}`);
    if (rows.rows.length === 0) {
      return res.json({ key, value: null });
    }
    const row = rows.rows[0] as { key: string; value: string };
    return res.json({ key: row.key, value: row.value });
  } catch (error) {
    console.error('[routing-config] Error fetching config:', error);
    return res.status(500).json({ error: 'Failed to fetch routing config' });
  }
});

// ============================================================================
// PUT /api/routing-config/:key
// ============================================================================

const PutBodySchema = z.object({ value: z.string().min(1) });

router.put('/:key', async (req: Request, res: Response) => {
  const { key } = req.params;

  const parseResult = PutBodySchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'value must be a non-empty string' });
  }
  const { value } = parseResult.data;

  const db = tryGetIntelligenceDb();
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }

  try {
    await db.execute(
      sql`INSERT INTO routing_config (key, value, updated_at)
          VALUES (${key}, ${value}, NOW())
          ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()`
    );
    return res.json({ key, value });
  } catch (error) {
    console.error('[routing-config] Error upserting config:', error);
    return res.status(500).json({ error: 'Failed to update routing config' });
  }
});

export default router;
