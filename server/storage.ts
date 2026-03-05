// Load environment variables FIRST before any other imports
import { config } from 'dotenv';
config();

import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;

// ============================================================================
// Analytics Database Connection (omnidash_analytics read-model)
// ============================================================================
//
// omnidash owns its own read-model database: omnidash_analytics.
// All data arrives via Kafka event-sourced projections -- no cross-repo queries.
//
// Connection priority:
//   1. OMNIDASH_ANALYTICS_DB_URL  (canonical)
//   2. DATABASE_URL               (backward compatibility)
//   3. POSTGRES_* individual vars (backward compatibility)
//
// When not configured, dashboard runs in demo-only mode (graceful degradation).

// Track database configuration state for graceful degradation
let databaseConfigured = false;
let databaseConnectionError: string | null = null;

/**
 * Check if database is configured (env vars present).
 * Does NOT verify connectivity - just configuration.
 */
export function isDatabaseConfigured(): boolean {
  return databaseConfigured;
}

/**
 * Get the database configuration error message, if any.
 * Returns null if database is properly configured.
 */
export function getDatabaseError(): string | null {
  return databaseConnectionError;
}

function getAnalyticsConnectionString(): string | null {
  // Priority 1: OMNIDASH_ANALYTICS_DB_URL (canonical for read-model DB)
  if (process.env.OMNIDASH_ANALYTICS_DB_URL) {
    databaseConfigured = true;
    return process.env.OMNIDASH_ANALYTICS_DB_URL;
  }

  // Priority 2: DATABASE_URL (backward compatibility)
  if (process.env.DATABASE_URL) {
    databaseConfigured = true;
    return process.env.DATABASE_URL;
  }

  // Priority 3: Individual POSTGRES_* variables (backward compatibility)
  const password = process.env.POSTGRES_PASSWORD;
  const host = process.env.POSTGRES_HOST;
  const port = process.env.POSTGRES_PORT;
  const database = process.env.POSTGRES_DATABASE;
  const user = process.env.POSTGRES_USER;

  // Graceful degradation: if not configured, return null instead of throwing
  if (!password || !host || !port || !database || !user) {
    const missing: string[] = [];
    if (!host) missing.push('POSTGRES_HOST');
    if (!port) missing.push('POSTGRES_PORT');
    if (!database) missing.push('POSTGRES_DATABASE');
    if (!user) missing.push('POSTGRES_USER');
    if (!password) missing.push('POSTGRES_PASSWORD');

    databaseConnectionError = `Database not configured. Missing: ${missing.join(', ')}. Set OMNIDASH_ANALYTICS_DB_URL or individual POSTGRES_* vars. Dashboard running in demo-only mode.`;
    console.warn(`[Database] ${databaseConnectionError}`);
    databaseConfigured = false;
    return null;
  }

  databaseConfigured = true;
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

// Lazy initialization to avoid requiring env vars at module load time
let poolInstance: InstanceType<typeof Pool> | null = null;
let intelligenceDbInstance: ReturnType<typeof drizzle> | null = null;
let connectionAttempted = false;

function getPool(): InstanceType<typeof Pool> | null {
  if (!poolInstance && !connectionAttempted) {
    connectionAttempted = true;
    const connectionString = getAnalyticsConnectionString();
    if (!connectionString) {
      // Database not configured - graceful degradation
      return null;
    }
    poolInstance = new Pool({
      connectionString,
    });
  }
  return poolInstance;
}

/**
 * Get the analytics database connection (omnidash_analytics read-model).
 * Throws if database is not configured.
 * Use isDatabaseConfigured() first to check availability for graceful degradation.
 */
export function getIntelligenceDb(): ReturnType<typeof drizzle> {
  if (!intelligenceDbInstance) {
    const pool = getPool();
    if (!pool) {
      // Database not configured - throw with helpful message
      throw new Error(
        databaseConnectionError ||
          'Database not configured. Set OMNIDASH_ANALYTICS_DB_URL or POSTGRES_* environment variables.'
      );
    }
    intelligenceDbInstance = drizzle(pool);
  }
  return intelligenceDbInstance;
}

/**
 * Try to get database connection, returns null if not configured.
 * Use this for routes that want graceful degradation.
 *
 * Delegates directly to getIntelligenceDb() and catches any error
 * (including "not configured") so that the very first call can still
 * succeed when OMNIDASH_ANALYTICS_DB_URL / POSTGRES_* vars are present.
 * Repeated failures are cheap because getPool() caches via connectionAttempted.
 */
export function tryGetIntelligenceDb(): ReturnType<typeof drizzle> | null {
  try {
    return getIntelligenceDb();
  } catch {
    return null;
  }
}

/**
 * Close the analytics database pool and reset lazy-init state.
 *
 * Intended for test teardown so integration tests that override
 * OMNIDASH_ANALYTICS_DB_URL can cleanly shut down the pool they caused
 * to be created. A subsequent call to getIntelligenceDb() / tryGetIntelligenceDb()
 * will re-initialize a fresh pool from the current environment.
 */
export async function resetIntelligenceDb(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    console.warn('resetIntelligenceDb() called outside test environment -- ignoring');
    return;
  }
  try {
    if (poolInstance) {
      await poolInstance.end();
    }
  } finally {
    poolInstance = null;
    intelligenceDbInstance = null;
    connectionAttempted = false;
    databaseConfigured = false;
    databaseConnectionError = null;
  }
}
