/**
 * DLQ Monitor API Routes (OMN-5287)
 *
 * Serves dead-letter queue message data for the DLQ Monitor Dashboard.
 * Reads from the dlq_messages table projected by ReadModelConsumer.
 */

import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { tryGetIntelligenceDb } from './storage';

export const dlqRoutes = Router();

// GET /api/dlq — recent failures + error type breakdown
dlqRoutes.get('/', async (req, res) => {
  const db = tryGetIntelligenceDb();
  if (!db) {
    return res.json({
      messages: [],
      errorBreakdown: [],
      total: 0,
      since: null,
    });
  }

  const limitRaw = parseInt(String(req.query.limit ?? '100'), 10);
  const limit = isNaN(limitRaw) || limitRaw < 1 || limitRaw > 500 ? 100 : limitRaw;

  try {
    const [messagesResult, breakdownResult, countResult] = await Promise.all([
      db.execute(sql`
        SELECT
          id,
          original_topic,
          error_message,
          error_type,
          retry_count,
          consumer_group,
          message_key,
          created_at
        FROM dlq_messages
        ORDER BY created_at DESC
        LIMIT ${limit}
      `) as unknown as Promise<{
        rows: Array<{
          id: string;
          original_topic: string;
          error_message: string;
          error_type: string;
          retry_count: number;
          consumer_group: string;
          message_key: string | null;
          created_at: string;
        }>;
      }>,

      db.execute(sql`
        SELECT
          error_type,
          COUNT(*)::int AS count
        FROM dlq_messages
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY error_type
        ORDER BY count DESC
      `) as unknown as Promise<{
        rows: Array<{ error_type: string; count: number }>;
      }>,

      db.execute(sql`
        SELECT COUNT(*)::int AS total FROM dlq_messages
      `) as unknown as Promise<{
        rows: Array<{ total: number }>;
      }>,
    ]);

    return res.json({
      messages: messagesResult.rows,
      errorBreakdown: breakdownResult.rows,
      total: countResult.rows[0]?.total ?? 0,
      since: null,
    });
  } catch (err) {
    console.error('[dlq-routes] query failed:', err);
    return res.status(500).json({
      error: 'Failed to fetch DLQ data',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /api/dlq/timeline — message rate bucketed by hour over 24h
dlqRoutes.get('/timeline', async (req, res) => {
  const db = tryGetIntelligenceDb();
  if (!db) {
    return res.json({ buckets: [] });
  }

  try {
    const result = await (db.execute(sql`
      SELECT
        date_trunc('hour', created_at) AS bucket,
        COUNT(*)::int AS count
      FROM dlq_messages
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY bucket
      ORDER BY bucket ASC
    `) as unknown as Promise<{
      rows: Array<{ bucket: string; count: number }>;
    }>);

    return res.json({ buckets: result.rows });
  } catch (err) {
    console.error('[dlq-routes] timeline query failed:', err);
    return res.status(500).json({
      error: 'Failed to fetch DLQ timeline',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});
