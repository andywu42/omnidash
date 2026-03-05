/**
 * Schema Health Endpoint (OMN-3751)
 *
 * GET /api/health/schema
 *
 * Runtime health check that verifies migration parity between the SQL files
 * on disk and the schema_migrations tracking table in the database.
 *
 * Returns HTTP 200 when schema is in parity, HTTP 503 when drift is detected.
 *
 * Response shape:
 * {
 *   applied_migrations_count: number,
 *   disk_migrations_count: number,
 *   schema_ok: boolean,
 *   missing_in_db: string[],
 *   missing_on_disk: string[],
 *   checked_at: string
 * }
 */

import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { tryGetIntelligenceDb } from './storage';
import { sql } from 'drizzle-orm';

export interface SchemaHealthResponse {
  applied_migrations_count: number;
  disk_migrations_count: number;
  schema_ok: boolean;
  missing_in_db: string[];
  missing_on_disk: string[];
  checked_at: string;
}

// Cache to avoid hammering the DB on every health check (30s TTL)
let cache: { response: SchemaHealthResponse; expiresAt: number } | null = null;

/**
 * Clear the schema health cache (exported for tests).
 */
export function clearSchemaHealthCache(): void {
  cache = null;
}

/**
 * Read migration filenames from disk.
 * Returns a sorted array of .sql filenames from the migrations/ directory.
 */
function getMigrationsOnDisk(): string[] {
  // Resolve relative to this file's location -> server/ -> ../migrations/
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Query applied migrations from the schema_migrations table.
 * Returns null if the DB is unavailable or the table does not exist.
 */
async function getMigrationsInDb(): Promise<string[] | null> {
  const db = tryGetIntelligenceDb();
  if (!db) return null;

  try {
    const result = await db.execute(sql`SELECT filename FROM schema_migrations ORDER BY filename`);
    // drizzle returns rows in different shapes depending on driver
    const rows = Array.isArray(result) ? result : ((result as any).rows ?? []);
    return rows.map((r: any) => r.filename as string);
  } catch (err) {
    const pgCode = (err as { code?: string }).code;
    const msg = err instanceof Error ? err.message : String(err);
    // Table might not exist yet — treat as empty
    if (pgCode === '42P01' || msg.includes('does not exist')) {
      return [];
    }
    throw err;
  }
}

/**
 * Perform the schema parity check.
 */
async function checkSchemaParity(): Promise<SchemaHealthResponse> {
  const filesOnDisk = getMigrationsOnDisk();
  const filesInDb = await getMigrationsInDb();

  // If DB is unavailable, report drift with a clear signal
  if (filesInDb === null) {
    return {
      applied_migrations_count: 0,
      disk_migrations_count: filesOnDisk.length,
      schema_ok: false,
      missing_in_db: ['(database unavailable)'],
      missing_on_disk: [],
      checked_at: new Date().toISOString(),
    };
  }

  const diskSet = new Set(filesOnDisk);
  const dbSet = new Set(filesInDb);

  const missingInDb = filesOnDisk.filter((f) => !dbSet.has(f));
  const missingOnDisk = filesInDb.filter((f) => !diskSet.has(f));

  return {
    applied_migrations_count: filesInDb.length,
    disk_migrations_count: filesOnDisk.length,
    schema_ok: missingInDb.length === 0 && missingOnDisk.length === 0,
    missing_in_db: missingInDb,
    missing_on_disk: missingOnDisk,
    checked_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

/**
 * GET /api/health/schema
 *
 * Returns migration parity status.
 * HTTP 200 = schema_ok: true
 * HTTP 503 = schema_ok: false (drift detected)
 */
router.get('/schema', async (_req, res) => {
  try {
    // Serve from cache if fresh
    if (cache && Date.now() < cache.expiresAt) {
      res.set('Cache-Control', 'no-store');
      const status = cache.response.schema_ok ? 200 : 503;
      res.status(status).json(cache.response);
      return;
    }

    const response = await checkSchemaParity();

    // Cache for 30 seconds
    cache = { response, expiresAt: Date.now() + 30_000 };

    res.set('Cache-Control', 'no-store');
    const status = response.schema_ok ? 200 : 503;
    res.status(status).json(response);
  } catch (err) {
    console.error('[schema-health] Probe failed:', err);
    res.set('Cache-Control', 'no-store');
    res.status(503).json({
      applied_migrations_count: 0,
      disk_migrations_count: 0,
      schema_ok: false,
      missing_in_db: [],
      missing_on_disk: [],
      error: err instanceof Error ? err.message : 'Unknown error',
      checked_at: new Date().toISOString(),
    });
  }
});

export default router;
