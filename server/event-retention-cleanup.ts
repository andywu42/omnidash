/**
 * Periodic retention cleanup for event_bus_events.
 *
 * Default policy:
 * - General events: 14-day retention
 * - High-volume operational topics: 3-day retention
 * - Pattern/heartbeat topics: should never be stored (filtered at ingestion),
 *   but clean up any that slip through
 *
 * Runs every CLEANUP_INTERVAL_MS (default: 1 hour).
 *
 * OMN-7011: Prevents unbounded event_bus_events growth.
 */

import { sql } from 'drizzle-orm';
import { tryGetIntelligenceDb } from './storage.js';
import {
  SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
  SUFFIX_INTELLIGENCE_TOOL_CONTENT,
  TOPIC_OMNIBASE_INFRA_WIRING_HEALTH_SNAPSHOT,
  SUFFIX_INTELLIGENCE_PROMOTION_CHECK_REQUESTED,
  SUFFIX_NODE_INTROSPECTION,
  SUFFIX_NODE_HEARTBEAT,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNED,
  SUFFIX_INTELLIGENCE_PATTERN_STORED,
  SUFFIX_INTELLIGENCE_PATTERN_PROJECTION,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
} from '@shared/topics';

const CLEANUP_INTERVAL_MS = parseInt(
  process.env.EVENT_RETENTION_CLEANUP_INTERVAL_MS ?? '3600000',
  10
);

const GENERAL_RETENTION_DAYS = parseInt(process.env.EVENT_RETENTION_GENERAL_DAYS ?? '14', 10);

const HIGH_VOLUME_RETENTION_DAYS = parseInt(
  process.env.EVENT_RETENTION_HIGH_VOLUME_DAYS ?? '3',
  10
);

const HIGH_VOLUME_TOPICS = [
  SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
  SUFFIX_INTELLIGENCE_TOOL_CONTENT,
  TOPIC_OMNIBASE_INFRA_WIRING_HEALTH_SNAPSHOT,
  SUFFIX_INTELLIGENCE_PROMOTION_CHECK_REQUESTED,
  SUFFIX_NODE_INTROSPECTION,
];

const NEVER_STORE_TOPICS = [
  SUFFIX_NODE_HEARTBEAT,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNED,
  SUFFIX_INTELLIGENCE_PATTERN_STORED,
  SUFFIX_INTELLIGENCE_PATTERN_PROJECTION,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
];

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export async function runRetentionCleanup(): Promise<{
  deletedGeneral: number;
  deletedHighVolume: number;
  deletedNeverStore: number;
}> {
  const db = tryGetIntelligenceDb();
  if (!db) return { deletedGeneral: 0, deletedHighVolume: 0, deletedNeverStore: 0 };

  // 1. Delete never-store topics (safety net for anything that slipped past ingestion filter)
  // Cast JS array to PostgreSQL text[] so ANY() receives the correct type.
  const neverStoreResult = await db.execute(sql`
    DELETE FROM event_bus_events
    WHERE topic = ANY(${NEVER_STORE_TOPICS}::text[])
  `);

  // 2. Delete high-volume topics beyond retention
  const highVolResult = await db.execute(sql`
    DELETE FROM event_bus_events
    WHERE topic = ANY(${HIGH_VOLUME_TOPICS}::text[])
      AND created_at < NOW() - MAKE_INTERVAL(days => ${HIGH_VOLUME_RETENTION_DAYS})
  `);

  // 3. Delete general events beyond retention
  const generalResult = await db.execute(sql`
    DELETE FROM event_bus_events
    WHERE created_at < NOW() - MAKE_INTERVAL(days => ${GENERAL_RETENTION_DAYS})
  `);

  const counts = {
    deletedNeverStore: Number((neverStoreResult as { rowCount?: number }).rowCount ?? 0),
    deletedHighVolume: Number((highVolResult as { rowCount?: number }).rowCount ?? 0),
    deletedGeneral: Number((generalResult as { rowCount?: number }).rowCount ?? 0),
  };

  const total = counts.deletedNeverStore + counts.deletedHighVolume + counts.deletedGeneral;
  if (total > 0) {
    console.log(
      `[retention-cleanup] Deleted ${total} rows: ` +
        `${counts.deletedNeverStore} never-store, ` +
        `${counts.deletedHighVolume} high-volume (>${HIGH_VOLUME_RETENTION_DAYS}d), ` +
        `${counts.deletedGeneral} general (>${GENERAL_RETENTION_DAYS}d)`
    );
  }

  return counts;
}

export function startRetentionCleanup(): void {
  if (cleanupTimer) return;
  console.log(
    `[retention-cleanup] Starting with interval=${CLEANUP_INTERVAL_MS}ms, ` +
      `general=${GENERAL_RETENTION_DAYS}d, high-volume=${HIGH_VOLUME_RETENTION_DAYS}d`
  );
  // Run once immediately on startup
  runRetentionCleanup().catch((err: unknown) =>
    console.error('[retention-cleanup] Initial run failed:', err)
  );
  cleanupTimer = setInterval(() => {
    runRetentionCleanup().catch((err: unknown) =>
      console.error('[retention-cleanup] Scheduled run failed:', err)
    );
  }, CLEANUP_INTERVAL_MS);
}

export function stopRetentionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
