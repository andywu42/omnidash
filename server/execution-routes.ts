/**
 * Execution Graph REST Routes (OMN-2302)
 *
 * Provides historical execution data for the /graph page.
 * Queries event_bus_events grouped by correlation_id to reconstruct
 * recent execution graphs from stored ONEX node events.
 */

import { Router } from 'express';
import { getEventBusDataSource } from './event-bus-data-source';
import {
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
} from '../shared/topics';

const router = Router();

/**
 * GET /api/executions/recent
 *
 * Returns the 10 most recent execution graphs, each grouped by correlation_id.
 * Each execution is a list of raw events that the client can normalise using
 * normalizeWsEvent() / applyEventsToGraph() from the shared normaliser.
 *
 * Gracefully returns { executions: [] } when the DB is not configured.
 */
router.get('/recent', async (_req, res) => {
  const dataSource = getEventBusDataSource();

  if (!dataSource) {
    res.json({ executions: [] });
    return;
  }

  try {
    // Fetch recent agent-action and routing-decision events.
    // We cast to any[] because EventBusEvent has a broad payload type and we
    // only need the envelope fields here; the client normalises the rest.
    const rawEvents = await dataSource.queryEvents({
      // Match both canonical onex.evt.omniclaude.* topics (new producers) and
      // legacy flat topic names (existing DB rows stored before OMN-2760).
      event_types: [
        // Canonical omniclaude agent topics
        TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
        TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
        // Legacy flat topic names (match pre-OMN-2760 DB rows)
        'agent-actions',
        'agent-routing-decisions',
        'agent-transformation-events',
        // Payload event_type field values (producer-set, not topic-derived)
        'AGENT_ACTION',
        'ROUTING_DECISION',
        'AGENT_TRANSFORMATION',
      ],
      limit: 500,
      order_by: 'timestamp',
      order_direction: 'desc',
    });

    // Group events by correlation_id, maintaining insertion order of first seen
    const correlationMap = new Map<string, typeof rawEvents>();

    for (const event of rawEvents) {
      const cid = event.correlation_id || event.event_id;
      if (!correlationMap.has(cid)) {
        correlationMap.set(cid, []);
      }
      correlationMap.get(cid)!.push(event);
    }

    // Take the 10 most recent correlation_id groups (map preserves insertion order)
    const recentCorrelationIds = [...correlationMap.keys()].slice(0, 10);

    const executions = recentCorrelationIds.map((correlationId) => {
      const events = correlationMap.get(correlationId) ?? [];

      // Determine the latest timestamp in this group for display
      const timestamps = events
        .map((e) => new Date(e.timestamp).getTime())
        .filter((t) => !isNaN(t));
      const latestTs =
        timestamps.length > 0
          ? new Date(Math.max(...timestamps)).toISOString()
          : new Date().toISOString();

      // Shape each event as the client normaliser expects:
      // { type, data, timestamp } — same envelope as WebSocket messages.
      const wsEvents = events.map((e) => {
        // Determine WS message type from topic or event_type
        let type = 'AGENT_ACTION';
        const topic = (e.topic || '').toLowerCase();
        const evType = (e.event_type || '').toLowerCase();

        if (
          topic.includes('routing') ||
          evType.includes('routing') ||
          evType === 'routing_decision'
        ) {
          type = 'ROUTING_DECISION';
        } else if (
          topic.includes('transformation') ||
          evType.includes('transformation') ||
          evType === 'agent_transformation'
        ) {
          type = 'AGENT_TRANSFORMATION';
        }

        return {
          type,
          data: {
            ...(typeof e.payload === 'object' && e.payload !== null ? e.payload : {}),
            correlationId: e.correlation_id,
          },
          timestamp: e.timestamp,
        };
      });

      return {
        correlationId,
        latestTimestamp: latestTs,
        eventCount: events.length,
        events: wsEvents,
      };
    });

    res.json({ executions });
  } catch (error) {
    console.error('[execution-routes] Error querying recent executions:', error);
    // Graceful degradation — never 500 the graph page
    res.json({ executions: [] });
  }
});

export default router;
