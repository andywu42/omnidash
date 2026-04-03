/**
 * TeamEventsProjection — DB-backed projection for agent coordination events (OMN-7036)
 *
 * Projects from: team_events table (populated by read-model-consumer.ts)
 *
 * Subscribed Kafka topics:
 *   onex.evt.omniclaude.task-assigned.v1
 *   onex.evt.omniclaude.task-progress.v1
 *   onex.evt.omniclaude.task-completed.v1
 *   onex.evt.omniclaude.evidence-written.v1
 *
 * Canonical event identity: correlation_id + task_id + emitted_at
 * Ordering: by emitted_at DESC
 *
 * Snapshot payload shape:
 *   { recent: TeamEventRow[]; summary: TeamEventsSummary }
 *
 * Routes access this via teamEventsProjection.ensureFresh()
 * — no direct DB imports allowed in route files (OMN-2325).
 */

import { sql } from 'drizzle-orm';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';
import {
  teamEventRowSchema,
  teamEventsPayloadSchema,
  type TeamEventRow,
  type TeamEventsSummary,
  type TeamEventsPayload,
} from '@shared/omniclaude-state-schema';

// Re-exports for route files
export type { TeamEventRow, TeamEventsSummary, TeamEventsPayload };

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

export class TeamEventsProjection extends DbBackedProjectionView<TeamEventsPayload> {
  readonly viewId = 'team-events';

  protected emptyPayload(): TeamEventsPayload {
    return {
      recent: [],
      summary: { total_events: 0, surface_counts: {}, event_type_counts: {} },
    };
  }

  protected async querySnapshot(db: Db, limit = 100): Promise<TeamEventsPayload> {
    try {
      const [recentRows, surfaceRows, typeRows] = await Promise.all([
        db.execute(sql`
          SELECT
            event_id,
            correlation_id,
            task_id,
            event_type,
            dispatch_surface,
            agent_model,
            status,
            payload,
            emitted_at::text
          FROM team_events
          ORDER BY emitted_at DESC
          LIMIT ${limit}
        `),
        db.execute(sql`
          SELECT
            dispatch_surface,
            COUNT(*)::int AS count
          FROM team_events
          GROUP BY dispatch_surface
        `),
        db.execute(sql`
          SELECT
            event_type,
            COUNT(*)::int AS count
          FROM team_events
          GROUP BY event_type
        `),
      ]);

      const recent = (recentRows.rows ?? []).map((row) => teamEventRowSchema.parse(row));

      const surfaceCounts: Record<string, number> = {};
      let totalEvents = 0;
      for (const row of surfaceRows.rows ?? []) {
        const surface = String(row.dispatch_surface);
        const count = Number(row.count);
        surfaceCounts[surface] = count;
        totalEvents += count;
      }

      const eventTypeCounts: Record<string, number> = {};
      for (const row of typeRows.rows ?? []) {
        eventTypeCounts[String(row.event_type)] = Number(row.count);
      }

      const summary: TeamEventsSummary = {
        total_events: totalEvents,
        surface_counts: surfaceCounts,
        event_type_counts: eventTypeCounts,
      };

      return teamEventsPayloadSchema.parse({ recent, summary });
    } catch (err) {
      console.error('[team-events-projection] Query failed:', err);
      return this.emptyPayload();
    }
  }
}
