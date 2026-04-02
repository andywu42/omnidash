/**
 * Event Ledger API Routes
 *
 * REST endpoints for browsing the immutable event ledger:
 *   GET /api/ledger/recent    — latest ledger entries (paginated)
 *   GET /api/ledger/query     — search by correlation_id, event_type, topic, time range
 *   GET /api/ledger/stats     — summary statistics (total entries, topics, time range)
 *
 * Data is read directly from the event_ledger table in the omnibase_infra
 * database via the secondary infra-db pool (OMNIBASE_INFRA_DB_URL).
 */

import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { tryGetInfraDb, isInfraDbConfigured } from './infra-db';

const router = Router();

// ============================================================================
// Middleware: check infra DB availability
// ============================================================================

router.use((_req, res, next) => {
  if (!isInfraDbConfigured()) {
    return res.status(503).json({
      error: 'Event ledger unavailable — OMNIBASE_INFRA_DB_URL not configured',
    });
  }
  next();
});

// ============================================================================
// GET /api/ledger/stats
// ============================================================================

router.get('/stats', async (_req, res) => {
  const db = tryGetInfraDb();
  if (!db) return res.status(503).json({ error: 'Infra database unavailable' });

  try {
    const [countResult, topicResult, rangeResult] = await Promise.all([
      db.execute(sql`SELECT COUNT(*)::int AS total FROM event_ledger`),
      db.execute(sql`SELECT COUNT(DISTINCT topic)::int AS topic_count FROM event_ledger`),
      db.execute(sql`
        SELECT
          MIN(COALESCE(event_timestamp, ledger_written_at))::text AS earliest,
          MAX(COALESCE(event_timestamp, ledger_written_at))::text AS latest
        FROM event_ledger
      `),
    ]);

    const total = Number((countResult.rows[0] as { total?: unknown })?.total ?? 0);
    const topicCount = Number((topicResult.rows[0] as { topic_count?: unknown })?.topic_count ?? 0);
    const range = rangeResult.rows[0] as { earliest?: string; latest?: string } | undefined;

    return res.json({
      total_entries: total,
      distinct_topics: topicCount,
      earliest: range?.earliest ?? null,
      latest: range?.latest ?? null,
    });
  } catch (err) {
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '42P01') {
      return res.json({
        total_entries: 0,
        distinct_topics: 0,
        earliest: null,
        latest: null,
      });
    }
    console.error('[ledger] stats query failed:', err);
    return res.status(500).json({ error: 'Failed to fetch ledger stats' });
  }
});

// ============================================================================
// GET /api/ledger/recent?limit=50&offset=0
// ============================================================================

router.get('/recent', async (req, res) => {
  const db = tryGetInfraDb();
  if (!db) return res.status(503).json({ error: 'Infra database unavailable' });

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const result = await db.execute(sql`
      SELECT
        ledger_entry_id::text,
        topic,
        partition,
        kafka_offset,
        event_type,
        source,
        correlation_id::text,
        event_timestamp::text,
        ledger_written_at::text
      FROM event_ledger
      ORDER BY COALESCE(event_timestamp, ledger_written_at) DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    return res.json({ entries: result.rows, limit, offset });
  } catch (err) {
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '42P01') {
      return res.json({ entries: [], limit, offset });
    }
    console.error('[ledger] recent query failed:', err);
    return res.status(500).json({ error: 'Failed to fetch recent ledger entries' });
  }
});

// ============================================================================
// GET /api/ledger/query?correlation_id=...&event_type=...&topic=...&start=...&end=...&limit=50&offset=0
// ============================================================================

router.get('/query', async (req, res) => {
  const db = tryGetInfraDb();
  if (!db) return res.status(503).json({ error: 'Infra database unavailable' });

  const correlationId =
    typeof req.query.correlation_id === 'string' ? req.query.correlation_id : null;
  const eventType = typeof req.query.event_type === 'string' ? req.query.event_type : null;
  const topic = typeof req.query.topic === 'string' ? req.query.topic : null;
  const start = typeof req.query.start === 'string' ? req.query.start : null;
  const end = typeof req.query.end === 'string' ? req.query.end : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  if (!correlationId && !eventType && !topic && !start) {
    return res.status(400).json({
      error: 'At least one filter required: correlation_id, event_type, topic, or start',
    });
  }

  try {
    // Build dynamic WHERE clauses
    const conditions: ReturnType<typeof sql>[] = [];

    if (correlationId) {
      conditions.push(sql`correlation_id = ${correlationId}::uuid`);
    }
    if (eventType) {
      conditions.push(sql`event_type = ${eventType}`);
    }
    if (topic) {
      conditions.push(sql`topic = ${topic}`);
    }
    if (start) {
      conditions.push(sql`COALESCE(event_timestamp, ledger_written_at) >= ${start}::timestamptz`);
    }
    if (end) {
      conditions.push(sql`COALESCE(event_timestamp, ledger_written_at) < ${end}::timestamptz`);
    }

    // Combine conditions with AND
    const whereClause = conditions.reduce((acc, cond, i) => {
      if (i === 0) return cond;
      return sql`${acc} AND ${cond}`;
    });

    const [dataResult, countResult] = await Promise.all([
      db.execute(sql`
        SELECT
          ledger_entry_id::text,
          topic,
          partition,
          kafka_offset,
          event_type,
          source,
          correlation_id::text,
          event_timestamp::text,
          ledger_written_at::text
        FROM event_ledger
        WHERE ${whereClause}
        ORDER BY COALESCE(event_timestamp, ledger_written_at) DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS total
        FROM event_ledger
        WHERE ${whereClause}
      `),
    ]);

    const total = Number((countResult.rows[0] as { total?: unknown })?.total ?? 0);

    return res.json({
      entries: dataResult.rows,
      total,
      has_more: offset + dataResult.rows.length < total,
      limit,
      offset,
    });
  } catch (err) {
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '42P01') {
      return res.json({ entries: [], total: 0, has_more: false, limit, offset });
    }
    console.error('[ledger] query failed:', err);
    return res.status(500).json({ error: 'Failed to query ledger' });
  }
});

export default router;
