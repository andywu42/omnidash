/**
 * Decision Records API Routes (OMN-2469)
 *
 * REST endpoints for the "Why This Happened" panel.
 * Provides session-scoped decision provenance data for the dashboard.
 *
 * Endpoints:
 *   GET /api/decisions/timeline?session_id=<id>        — Decision Timeline (View 2)
 *   GET /api/decisions/intent-vs-plan?session_id=<id>  — Intent vs Plan (View 1)
 *   GET /api/decisions/:decision_id                    — Single DecisionRecord
 *
 * Architecture note (OMN-2325): This route file uses an in-memory circular
 * buffer (same pattern as intent-routes.ts) to store DecisionRecords received
 * from the omniintelligence service via the event consumer. No direct DB
 * access is permitted from route files.
 *
 * Data flow:
 *   omniintelligence → Kafka → event-consumer.ts → addDecisionRecord()
 *   Dashboard client  → GET /api/decisions/*  → read from in-memory buffer
 *
 * When the OMN-2467 projection is fully wired, replace the circular buffer
 * reads with projectionService.getView('decision-records').getSnapshot().
 *
 * Dependencies: OMN-2467 (DecisionRecord storage + query API)
 */

import { Router, type Request, type Response } from 'express';
import type {
  DecisionRecord,
  DecisionTimelineRow,
  DecisionTimelineResponse,
  IntentVsPlanResponse,
  DecisionSessionSummary,
  DecisionSessionsResponse,
} from '@shared/decision-record-types';

// ============================================================================
// In-memory circular buffer (OMN-2325 compliant — no direct DB access)
// ============================================================================

/** Maximum number of DecisionRecords to retain in memory. */
const _parsedMaxDecisions = parseInt(process.env.MAX_STORED_DECISIONS ?? '5000', 10);
if (!Number.isFinite(_parsedMaxDecisions) || _parsedMaxDecisions <= 0) {
  console.warn(
    `[decision-records] Invalid MAX_STORED_DECISIONS value "${process.env.MAX_STORED_DECISIONS}" -- falling back to 5000`
  );
}
const MAX_STORED_DECISIONS =
  Number.isFinite(_parsedMaxDecisions) && _parsedMaxDecisions > 0 ? _parsedMaxDecisions : 5000;

/** Circular buffer for in-memory DecisionRecord storage. */
const decisionBuffer: (DecisionRecord | undefined)[] = new Array<DecisionRecord | undefined>(
  MAX_STORED_DECISIONS
).fill(undefined);

/** Pointer to the next write position in the circular buffer. */
let bufferHead = 0;

/** Total number of valid entries currently in the buffer (capped at MAX_STORED_DECISIONS). */
let bufferCount = 0;

/**
 * Add a DecisionRecord to the circular buffer.
 * Overwrites the oldest entry when the buffer is full.
 */
function addDecisionRecord(record: DecisionRecord): void {
  decisionBuffer[bufferHead] = record;
  bufferHead = (bufferHead + 1) % MAX_STORED_DECISIONS;
  if (bufferCount < MAX_STORED_DECISIONS) {
    bufferCount++;
  }
}

/**
 * Retrieve all DecisionRecords from the buffer, newest-first.
 */
function getAllDecisionRecords(): DecisionRecord[] {
  if (bufferCount === 0) return [];

  const results: DecisionRecord[] = [];

  if (bufferCount < MAX_STORED_DECISIONS) {
    // Buffer not yet full — read from index 0 to bufferHead - 1, reverse for newest-first
    for (let i = bufferHead - 1; i >= 0; i--) {
      const entry = decisionBuffer[i];
      if (entry !== undefined) results.push(entry);
    }
  } else {
    // Buffer is full — oldest entry is at bufferHead, newest is at bufferHead - 1 (mod MAX)
    for (let i = 0; i < MAX_STORED_DECISIONS; i++) {
      const idx = (bufferHead - 1 - i + MAX_STORED_DECISIONS) % MAX_STORED_DECISIONS;
      const entry = decisionBuffer[idx];
      if (entry !== undefined) results.push(entry);
    }
  }

  return results;
}

/**
 * Retrieve DecisionRecords for a specific session_id, newest-first.
 */
function getDecisionsBySession(sessionId: string): DecisionRecord[] {
  return getAllDecisionRecords().filter((r) => r.session_id === sessionId);
}

/**
 * Find a single DecisionRecord by its decision_id.
 */
function getDecisionById(decisionId: string): DecisionRecord | undefined {
  return getAllDecisionRecords().find((r) => r.decision_id === decisionId);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a full DecisionRecord to the lightweight DecisionTimelineRow
 * used by the timeline component (View 2).
 */
function toTimelineRow(record: DecisionRecord): DecisionTimelineRow {
  return {
    decision_id: record.decision_id,
    decided_at: record.decided_at,
    decision_type: record.decision_type,
    selected_candidate: record.selected_candidate,
    candidates_count: record.candidates_considered.length,
    full_record: record,
  };
}

/**
 * Validate that `session_id` query param is present and is a non-empty string.
 * Writes a 400 response and returns null if invalid.
 */
function validateSessionId(req: Request, res: Response): string | null {
  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
  if (!sessionId) {
    res.status(400).json({
      error: 'Missing required query parameter: session_id',
    });
    return null;
  }
  return sessionId;
}

/**
 * Retrieve distinct sessions that have at least one DecisionRecord.
 * Returns summaries sorted newest-first (by last decision timestamp).
 */
function getDistinctSessions(): DecisionSessionSummary[] {
  const allRecords = getAllDecisionRecords();
  const sessionMap = new Map<string, { count: number; firstAt: string; lastAt: string }>();

  for (const record of allRecords) {
    const existing = sessionMap.get(record.session_id);
    if (!existing) {
      sessionMap.set(record.session_id, {
        count: 1,
        firstAt: record.decided_at,
        lastAt: record.decided_at,
      });
    } else {
      existing.count++;
      if (record.decided_at < existing.firstAt) existing.firstAt = record.decided_at;
      if (record.decided_at > existing.lastAt) existing.lastAt = record.decided_at;
    }
  }

  const summaries: DecisionSessionSummary[] = [];
  for (const [sessionId, info] of sessionMap) {
    summaries.push({
      session_id: sessionId,
      decision_count: info.count,
      first_decided_at: info.firstAt,
      last_decided_at: info.lastAt,
    });
  }

  // Sort newest-first by last decision timestamp
  summaries.sort(
    (a, b) => new Date(b.last_decided_at).getTime() - new Date(a.last_decided_at).getTime()
  );

  return summaries;
}

// ============================================================================
// Router
// ============================================================================

const router = Router();

// ============================================================================
// GET /api/decisions/sessions
// ============================================================================
//
// Returns a list of all sessions that have at least one DecisionRecord.
// Used by the session picker in the Why This Happened page.
// Sessions are sorted newest-first (by last_decided_at).
//
// Response: DecisionSessionsResponse

router.get('/sessions', (_req: Request, res: Response) => {
  try {
    const sessions = getDistinctSessions();

    const response: DecisionSessionsResponse = {
      total: sessions.length,
      sessions,
    };

    return res.json(response);
  } catch (error) {
    console.error('[decision-records] Error fetching sessions:', error);
    return res.status(500).json({ error: 'Failed to fetch decision sessions' });
  }
});

// ============================================================================
// GET /api/decisions/timeline?session_id=<id>
// ============================================================================
//
// Returns all DecisionRecords for a session as timeline rows (View 2).
// Rows are sorted chronologically (oldest first — "how did we get here").
// If session has no records, returns empty rows array (not 404).
//
// Response: DecisionTimelineResponse

router.get('/timeline', (req: Request, res: Response) => {
  try {
    const sessionId = validateSessionId(req, res);
    if (sessionId === null) return;

    const records = getDecisionsBySession(sessionId);

    // Sort chronologically (oldest → newest) for the timeline mental model
    const sorted = [...records].sort(
      (a, b) => new Date(a.decided_at).getTime() - new Date(b.decided_at).getTime()
    );

    const rows = sorted.map(toTimelineRow);

    const response: DecisionTimelineResponse = {
      session_id: sessionId,
      total: rows.length,
      rows,
    };

    return res.json(response);
  } catch (error) {
    console.error('[decision-records] Error fetching timeline:', error);
    return res.status(500).json({ error: 'Failed to fetch decision timeline' });
  }
});

// ============================================================================
// GET /api/decisions/intent-vs-plan?session_id=<id>
// ============================================================================
//
// Returns the intent-vs-plan comparison for a session (View 1).
// Derives the comparison from the stored DecisionRecords.
// Returns 404 if no records exist for the session.
//
// TODO(OMN-2467-followup): When OMN-2467 ships intent-vs-plan storage,
// replace this derivation with a direct intent-vs-plan query.
//
// Response: IntentVsPlanResponse

router.get('/intent-vs-plan', (req: Request, res: Response) => {
  try {
    const sessionId = validateSessionId(req, res);
    if (sessionId === null) return;

    const records = getDecisionsBySession(sessionId);

    if (records.length === 0) {
      return res.status(404).json({
        error: `No decision records found for session: ${sessionId}`,
      });
    }

    // Derive intent-vs-plan from the stored DecisionRecords.
    // Each decision maps to one IntentPlanField showing what was resolved and how.
    const fields = records
      .sort((a, b) => new Date(a.decided_at).getTime() - new Date(b.decided_at).getTime())
      .map((record) => ({
        field_name: record.decision_type,
        intent_value: null, // User intent not yet stored in V1 — always null until OMN-2467 adds it
        resolved_value: record.selected_candidate,
        origin:
          record.decision_type === 'default_apply' ? ('default' as const) : ('inferred' as const),
        decision_id: record.decision_id,
      }));

    const earliestRecord = records.reduce((earliest, r) =>
      new Date(r.decided_at) < new Date(earliest.decided_at) ? r : earliest
    );

    const response: IntentVsPlanResponse = {
      session_id: sessionId,
      executed_at: earliestRecord.decided_at,
      fields,
    };

    return res.json(response);
  } catch (error) {
    console.error('[decision-records] Error fetching intent-vs-plan:', error);
    return res.status(500).json({ error: 'Failed to fetch intent-vs-plan data' });
  }
});

// ============================================================================
// GET /api/decisions/recent
// ============================================================================
//
// Returns the most recent DecisionRecords across all sessions.
// Accepts optional ?limit=N query param (default 50, max 500).
//
// Response: { total: number, decisions: DecisionRecord[] }

router.get('/recent', (_req: Request, res: Response) => {
  try {
    const limit = Math.min(
      Math.max(1, parseInt((_req.query.limit as string) || '50', 10) || 50),
      500
    );

    const allRecords = getAllDecisionRecords();
    const decisions = allRecords.slice(0, limit);

    return res.json({
      total: decisions.length,
      decisions,
    });
  } catch (error) {
    console.error('[decision-records] Error fetching recent decisions:', error);
    return res.status(500).json({ error: 'Failed to fetch recent decisions' });
  }
});

// ============================================================================
// GET /api/decisions/:decision_id
// ============================================================================
//
// Returns a single full DecisionRecord by its decision_id.
// Returns 404 if no record exists with that ID.
//
// Response: DecisionRecord

router.get('/:decision_id', (req: Request, res: Response) => {
  try {
    const { decision_id } = req.params;

    if (!decision_id || typeof decision_id !== 'string') {
      return res.status(400).json({ error: 'Missing decision_id path parameter' });
    }

    const record = getDecisionById(decision_id);

    if (!record) {
      return res.status(404).json({
        error: `Decision record not found: ${decision_id}`,
      });
    }

    return res.json(record satisfies DecisionRecord);
  } catch (error) {
    console.error('[decision-records] Error fetching decision record:', error);
    return res.status(500).json({ error: 'Failed to fetch decision record' });
  }
});

// ============================================================================
// Exports
// ============================================================================

export default router;

/**
 * Public mutation API for the event consumer to push incoming DecisionRecords.
 * Called by event-consumer.ts when it receives a routing decision event from Kafka.
 */
export { addDecisionRecord };

/**
 * Test helpers — exported only for unit tests.
 * NOT part of the public API. Do not use in production code.
 */
export const _testHelpers = {
  addToStore: addDecisionRecord,
  getAllRecords: getAllDecisionRecords,
  getBySession: getDecisionsBySession,
  getById: getDecisionById,
  getDistinctSessions,
  toTimelineRow,
  resetBuffer: () => {
    decisionBuffer.fill(undefined);
    bufferHead = 0;
    bufferCount = 0;
  },
  getBufferState: () => ({ head: bufferHead, count: bufferCount }),
  MAX_STORED_DECISIONS,
};
