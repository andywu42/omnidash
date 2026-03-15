/**
 * Trace Routes (OMN-5047)
 *
 * API endpoints for querying correlation trace spans from the
 * correlation_trace_spans table. These endpoints power the /trace page,
 * providing session-aware and trace-aware span queries.
 *
 * Endpoints:
 *   GET /api/traces/sessions/recent       - Recent sessions with trace counts
 *   GET /api/traces/session/:sessionId    - All traces for a session
 *   GET /api/traces/:traceId/spans        - All spans for a trace (timeline)
 *   GET /api/traces/span/:spanId          - Single span detail
 */

import { Router } from 'express';
import { desc, eq, sql, inArray } from 'drizzle-orm';
import { tryGetIntelligenceDb } from './storage';
import { correlationTraceSpans } from '@shared/intelligence-schema';

const router = Router();

// ============================================================================
// GET /sessions/recent — Recent sessions with trace summary
// ============================================================================

router.get('/sessions/recent', async (req, res) => {
  try {
    const db = tryGetIntelligenceDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const rawLimit = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;

    // Get recent sessions with aggregate stats
    const sessions = await db
      .select({
        sessionId: correlationTraceSpans.sessionId,
        traceCount: sql<number>`count(DISTINCT ${correlationTraceSpans.traceId})::int`.as(
          'trace_count'
        ),
        spanCount: sql<number>`count(*)::int`.as('span_count'),
        firstSeen: sql<string>`min(${correlationTraceSpans.startedAt})`.as('first_seen'),
        lastSeen: sql<string>`max(${correlationTraceSpans.startedAt})`.as('last_seen'),
        errorCount:
          sql<number>`count(*) FILTER (WHERE ${correlationTraceSpans.status} = 'error')::int`.as(
            'error_count'
          ),
      })
      .from(correlationTraceSpans)
      .where(sql`${correlationTraceSpans.sessionId} IS NOT NULL`)
      .groupBy(correlationTraceSpans.sessionId)
      .orderBy(sql`max(${correlationTraceSpans.startedAt}) DESC`)
      .limit(limit);

    res.json(sessions);
  } catch (error) {
    console.error('[trace-routes] Error fetching recent sessions:', error);
    res.status(500).json({
      error: 'Failed to fetch recent sessions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// GET /session/:sessionId — All traces for a session
// ============================================================================

router.get('/session/:sessionId', async (req, res) => {
  try {
    const db = tryGetIntelligenceDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const { sessionId } = req.params;

    // Get all distinct traces for this session, with summary per trace
    const traces = await db
      .select({
        traceId: correlationTraceSpans.traceId,
        correlationId: correlationTraceSpans.correlationId,
        spanCount: sql<number>`count(*)::int`.as('span_count'),
        rootSpanName:
          sql<string>`min(CASE WHEN ${correlationTraceSpans.parentSpanId} IS NULL THEN ${correlationTraceSpans.spanName} END)`.as(
            'root_span_name'
          ),
        startedAt: sql<string>`min(${correlationTraceSpans.startedAt})`.as('started_at'),
        endedAt: sql<string>`max(${correlationTraceSpans.endedAt})`.as('ended_at'),
        totalDurationMs: sql<number>`COALESCE(sum(${correlationTraceSpans.durationMs}), 0)::int`.as(
          'total_duration_ms'
        ),
        errorCount:
          sql<number>`count(*) FILTER (WHERE ${correlationTraceSpans.status} = 'error')::int`.as(
            'error_count'
          ),
      })
      .from(correlationTraceSpans)
      .where(eq(correlationTraceSpans.sessionId, sessionId))
      .groupBy(correlationTraceSpans.traceId, correlationTraceSpans.correlationId)
      .orderBy(sql`min(${correlationTraceSpans.startedAt}) DESC`);

    res.json({
      sessionId,
      traceCount: traces.length,
      traces,
    });
  } catch (error) {
    console.error('[trace-routes] Error fetching session traces:', error);
    res.status(500).json({
      error: 'Failed to fetch session traces',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// GET /:traceId/spans — All spans for a specific trace (timeline view)
// ============================================================================

router.get('/:traceId/spans', async (req, res) => {
  try {
    const db = tryGetIntelligenceDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const { traceId } = req.params;

    const spans = await db
      .select({
        id: correlationTraceSpans.id,
        traceId: correlationTraceSpans.traceId,
        spanId: correlationTraceSpans.spanId,
        parentSpanId: correlationTraceSpans.parentSpanId,
        correlationId: correlationTraceSpans.correlationId,
        sessionId: correlationTraceSpans.sessionId,
        spanKind: correlationTraceSpans.spanKind,
        spanName: correlationTraceSpans.spanName,
        status: correlationTraceSpans.status,
        startedAt: correlationTraceSpans.startedAt,
        endedAt: correlationTraceSpans.endedAt,
        durationMs: correlationTraceSpans.durationMs,
        metadata: correlationTraceSpans.metadata,
      })
      .from(correlationTraceSpans)
      .where(eq(correlationTraceSpans.traceId, traceId))
      .orderBy(correlationTraceSpans.startedAt);

    if (spans.length === 0) {
      res.json({ traceId, spans: [], summary: null });
      return;
    }

    // Compute summary
    const rootSpan = spans.find((s) => !s.parentSpanId);
    const errorSpans = spans.filter((s) => s.status === 'error');
    const kindCounts: Record<string, number> = {};
    for (const s of spans) {
      kindCounts[s.spanKind] = (kindCounts[s.spanKind] || 0) + 1;
    }

    const minStart = spans.reduce(
      (min, s) => (s.startedAt < min ? s.startedAt : min),
      spans[0].startedAt
    );
    const maxEnd = spans.reduce((max, s) => {
      const end = s.endedAt ?? s.startedAt;
      return end > max ? end : max;
    }, spans[0].endedAt ?? spans[0].startedAt);

    const summary = {
      totalSpans: spans.length,
      rootSpanName: rootSpan?.spanName ?? null,
      correlationId: spans[0].correlationId,
      sessionId: spans[0].sessionId,
      errors: errorSpans.length,
      totalDurationMs: maxEnd.getTime() - minStart.getTime(),
      kindBreakdown: kindCounts,
    };

    // Serialize dates for JSON response
    const serializedSpans = spans.map((s) => ({
      ...s,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
    }));

    res.json({ traceId, spans: serializedSpans, summary });
  } catch (error) {
    console.error('[trace-routes] Error fetching trace spans:', error);
    res.status(500).json({
      error: 'Failed to fetch trace spans',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// GET /recent — Recent traces (convenience for the trace page landing)
// ============================================================================

router.get('/recent', async (req, res) => {
  try {
    const db = tryGetIntelligenceDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const rawLimit = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;

    // Get recent distinct traces with summary
    const traces = await db
      .select({
        traceId: correlationTraceSpans.traceId,
        correlationId: correlationTraceSpans.correlationId,
        sessionId: correlationTraceSpans.sessionId,
        spanCount: sql<number>`count(*)::int`.as('span_count'),
        rootSpanName:
          sql<string>`min(CASE WHEN ${correlationTraceSpans.parentSpanId} IS NULL THEN ${correlationTraceSpans.spanName} END)`.as(
            'root_span_name'
          ),
        startedAt: sql<string>`min(${correlationTraceSpans.startedAt})`.as('started_at'),
        totalDurationMs: sql<number>`COALESCE(sum(${correlationTraceSpans.durationMs}), 0)::int`.as(
          'total_duration_ms'
        ),
        errorCount:
          sql<number>`count(*) FILTER (WHERE ${correlationTraceSpans.status} = 'error')::int`.as(
            'error_count'
          ),
      })
      .from(correlationTraceSpans)
      .groupBy(
        correlationTraceSpans.traceId,
        correlationTraceSpans.correlationId,
        correlationTraceSpans.sessionId
      )
      .orderBy(sql`min(${correlationTraceSpans.startedAt}) DESC`)
      .limit(limit);

    res.json(traces);
  } catch (error) {
    console.error('[trace-routes] Error fetching recent traces:', error);
    res.status(500).json({
      error: 'Failed to fetch recent traces',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
