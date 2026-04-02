/**
 * Secondary DB connection for the omnibase_infra database (read-only).
 *
 * The event_ledger table lives in the infra database, not the omnidash_analytics
 * read-model. This module provides a lazy, optional connection gated on
 * OMNIBASE_INFRA_DB_URL. When not configured, callers degrade gracefully.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;

let infraPool: InstanceType<typeof Pool> | null = null;
let infraDbInstance: ReturnType<typeof drizzle> | null = null;
let connectionAttempted = false;

/**
 * Check if the infra database is configured.
 */
export function isInfraDbConfigured(): boolean {
  return !!process.env.OMNIBASE_INFRA_DB_URL;
}

/**
 * Get a Drizzle connection to the infra database.
 * Returns null if OMNIBASE_INFRA_DB_URL is not set.
 */
export function tryGetInfraDb(): ReturnType<typeof drizzle> | null {
  if (infraDbInstance) return infraDbInstance;
  if (connectionAttempted) return null;

  connectionAttempted = true;
  const url = process.env.OMNIBASE_INFRA_DB_URL;
  if (!url) {
    console.warn('[infra-db] OMNIBASE_INFRA_DB_URL not set — ledger queries unavailable');
    return null;
  }

  infraPool = new Pool({ connectionString: url, max: 3 });
  infraDbInstance = drizzle(infraPool);
  return infraDbInstance;
}
