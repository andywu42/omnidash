/**
 * Wiring Status Service (OMN-6975)
 *
 * Computes wiring status for all dashboard routes by querying the
 * omnidash_analytics database for row counts and last-event timestamps.
 *
 * Separated from wiring-status-routes.ts to comply with the OMN-2325
 * constraint that route files must not import DB accessors directly.
 */

import { tryGetIntelligenceDb } from '../storage';
import wiringStatusData from '../../shared/wiring-status.json';
import type { WiringStatus } from '../../shared/wiring-status';
import { safeCountAndMaxTimestampQuery } from '../sql-safety';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WiringStatusRouteInfo {
  route: string;
  status: WiringStatus;
  table: string | null;
  description: string;
  rowCount: number | null;
  lastEventAt: string | null;
}

export interface WiringStatusApiResponse {
  routes: WiringStatusRouteInfo[];
  summary: Record<WiringStatus, number>;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Table allowlist for safe SQL queries
// ---------------------------------------------------------------------------

const ALLOWED_TABLES = new Set<string>(
  Object.values(wiringStatusData.routes)
    .map((entry) => (entry as { table: string | null }).table)
    .filter((t): t is string => t !== null)
);

function assertAllowedTable(table: string): void {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Table "${table}" not in wiring-status allowlist`);
  }
}

// ---------------------------------------------------------------------------
// Cache (30s TTL)
// ---------------------------------------------------------------------------

let cache: { response: WiringStatusApiResponse; expiresAt: number } | null = null;

/** Clear cache (exported for tests). */
export function clearWiringStatusCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function getTableStats(
  db: ReturnType<typeof tryGetIntelligenceDb>,
  table: string
): Promise<{ rowCount: number; lastEventAt: string | null }> {
  if (!db) return { rowCount: 0, lastEventAt: null };
  assertAllowedTable(table);

  const tsCol = table === 'pr_watch_state' ? 'updated_at' : 'created_at';

  try {
    const result = await db.execute(safeCountAndMaxTimestampQuery(table, tsCol));
    const rows = Array.isArray(result) ? result : ((result as any).rows ?? []);
    const row = rows[0] as { cnt?: number; last_event?: string } | undefined;
    return {
      rowCount: row?.cnt ?? 0,
      lastEventAt: row?.last_event ? new Date(row.last_event).toISOString() : null,
    };
  } catch {
    return { rowCount: 0, lastEventAt: null };
  }
}

export async function getWiringStatus(): Promise<WiringStatusApiResponse> {
  // Return cached response if fresh
  if (cache && Date.now() < cache.expiresAt) {
    return cache.response;
  }

  const db = tryGetIntelligenceDb();
  const routes: WiringStatusRouteInfo[] = [];
  const summary: Record<WiringStatus, number> = {
    working: 0,
    partial: 0,
    preview: 0,
    stub: 0,
    missing: 0,
  };

  const entries = Object.entries(wiringStatusData.routes) as [
    string,
    { status: WiringStatus; table: string | null; description: string },
  ][];

  const statsPromises = entries.map(async ([route, entry]) => {
    let rowCount: number | null = null;
    let lastEventAt: string | null = null;

    if (entry.table) {
      const stats = await getTableStats(db, entry.table);
      rowCount = stats.rowCount;
      lastEventAt = stats.lastEventAt;
    }

    return {
      route,
      status: entry.status,
      table: entry.table,
      description: entry.description,
      rowCount,
      lastEventAt,
    };
  });

  const results = await Promise.all(statsPromises);

  for (const info of results) {
    routes.push(info);
    summary[info.status] = (summary[info.status] ?? 0) + 1;
  }

  const statusOrder: Record<WiringStatus, number> = {
    working: 0,
    partial: 1,
    preview: 2,
    stub: 3,
    missing: 4,
  };
  routes.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  const response: WiringStatusApiResponse = {
    routes,
    summary,
    checkedAt: new Date().toISOString(),
  };

  cache = { response, expiresAt: Date.now() + 30_000 };
  return response;
}
