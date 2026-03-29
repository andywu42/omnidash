/**
 * sql-safety.ts — Centralized safe SQL fragment helpers [OMN-5196]
 *
 * Replaces all ad-hoc `sql.raw()` calls with allowlist-validated helpers
 * that return safe `SQL` fragments. Every function throws on invalid input
 * so callers get an explicit error rather than a potential injection vector.
 *
 * Usage:
 *   import { safeInterval, safeTruncUnit, safeIntervalFromTimeWindow } from './sql-safety';
 *
 *   // Instead of: sql`... INTERVAL '${sql.raw(interval)}'`
 *   // Use:        sql`... INTERVAL ${safeInterval(interval)}`
 *
 *   // Instead of: sql`DATE_TRUNC('${sql.raw(unit)}', col)`
 *   // Use:        sql`DATE_TRUNC(${safeTruncUnit(unit)}, col)`
 */

import { sql, type SQL } from 'drizzle-orm';

// ============================================================================
// Interval allowlists
// ============================================================================

/**
 * Allowlisted PostgreSQL INTERVAL literals. Keys are the raw interval strings
 * produced by windowToInterval / getIntervalFromTimeWindow; values are the
 * identical string wrapped in a safe SQL fragment.
 *
 * Only these exact strings may appear in `INTERVAL '...'` clauses.
 */
const SAFE_INTERVALS: ReadonlySet<string> = new Set([
  '10 minutes',
  '1 hour',
  '24 hours',
  '7 days',
  '30 days',
]);

/**
 * Allowlisted PostgreSQL DATE_TRUNC unit strings.
 * Only these may appear in `DATE_TRUNC('...', col)` clauses.
 */
const SAFE_TRUNC_UNITS: ReadonlySet<string> = new Set(['minute', 'hour', 'day', 'week', 'month']);

/**
 * Accepted time window parameters from query strings.
 * Exported for route-layer guards that validate before calling projections.
 */
export const ACCEPTED_WINDOWS: ReadonlySet<string> = new Set(['24h', '7d', '30d']);

// ============================================================================
// Safe SQL fragment builders
// ============================================================================

/**
 * Return a safe SQL fragment for a PostgreSQL INTERVAL literal.
 *
 * @example
 *   sql`WHERE created_at >= NOW() - INTERVAL ${safeInterval('24 hours')}`
 *   // Produces: WHERE created_at >= NOW() - INTERVAL '24 hours'
 *
 * @throws {Error} if `interval` is not in the allowlist
 */
export function safeInterval(interval: string): SQL {
  if (!SAFE_INTERVALS.has(interval)) {
    throw new Error(
      `safeInterval: rejected "${interval}". ` +
        `Allowed values: ${[...SAFE_INTERVALS].join(', ')}.`
    );
  }
  return sql.raw(`'${interval}'`);
}

/**
 * Return a safe SQL fragment for a DATE_TRUNC unit string.
 *
 * @example
 *   sql`DATE_TRUNC(${safeTruncUnit('hour')}, created_at)`
 *   // Produces: DATE_TRUNC('hour', created_at)
 *
 * @throws {Error} if `unit` is not in the allowlist
 */
export function safeTruncUnit(unit: string): SQL {
  if (!SAFE_TRUNC_UNITS.has(unit)) {
    throw new Error(
      `safeTruncUnit: rejected "${unit}". ` + `Allowed values: ${[...SAFE_TRUNC_UNITS].join(', ')}.`
    );
  }
  return sql.raw(`'${unit}'`);
}

/**
 * Convert a time window query parameter to a safe INTERVAL SQL fragment.
 * Combines windowToInterval mapping + allowlist validation in one call.
 *
 * @example
 *   sql`WHERE created_at >= NOW() - INTERVAL ${safeIntervalFromTimeWindow('24h')}`
 *
 * @throws {Error} if `timeWindow` is not recognized
 */
export function safeIntervalFromTimeWindow(timeWindow: string): SQL {
  const interval = timeWindowToInterval(timeWindow);
  return safeInterval(interval);
}

/**
 * Convert a time window label to a PostgreSQL INTERVAL string.
 * This is the single canonical mapping — all files should use this
 * instead of maintaining local switch statements.
 *
 * @throws {Error} if `timeWindow` is not recognized
 */
export function timeWindowToInterval(timeWindow: string): string {
  switch (timeWindow) {
    case '24h':
      return '24 hours';
    case '7d':
      return '7 days';
    case '30d':
      return '30 days';
    default:
      throw new Error(
        `timeWindowToInterval: unrecognised window "${timeWindow}". ` +
          `Accepted values: '24h', '7d', '30d'.`
      );
  }
}

/**
 * Determine the DATE_TRUNC unit for a given time window.
 * 24h uses 'hour' granularity; 7d and 30d use 'day'.
 */
export function truncUnitForWindow(window: string): string {
  return window === '24h' ? 'hour' : 'day';
}

/**
 * Convert an alert-helpers-style time window to a safe INTERVAL SQL fragment.
 * Alert helpers use literal interval strings like '1 hour', '10 minutes', '24 hours'.
 *
 * @throws {Error} if `interval` is not in the allowlist
 */
export function safeAlertInterval(timeWindow: string): SQL {
  // Alert helpers pass raw interval strings directly
  return safeInterval(timeWindow);
}

// ============================================================================
// Safe identifier helpers (for internal allowlisted table/column names)
// ============================================================================

/**
 * PostgreSQL identifier validation regex.
 * Only allows alphanumeric characters and underscores — no quotes, spaces,
 * semicolons, or other injection vectors.
 */
const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Return a safe SQL fragment for `SELECT COUNT(*) AS count FROM "<table>"`.
 *
 * @throws {Error} if `tableName` contains unsafe characters
 */
export function safeCountQuery(tableName: string): SQL {
  if (!SAFE_IDENTIFIER_RE.test(tableName)) {
    throw new Error(
      `safeCountQuery: rejected table name "${tableName}" — must match ${SAFE_IDENTIFIER_RE}`
    );
  }
  return sql.raw(`SELECT COUNT(*) AS count FROM "${tableName}"`);
}

/**
 * Return a safe SQL fragment for `SELECT MAX("<tsCol>") AS last_updated FROM "<table>"`.
 *
 * @throws {Error} if `tableName` or `tsCol` contain unsafe characters
 */
export function safeMaxTimestampQuery(tableName: string, tsCol: string): SQL {
  if (!SAFE_IDENTIFIER_RE.test(tableName)) {
    throw new Error(
      `safeMaxTimestampQuery: rejected table name "${tableName}" — must match ${SAFE_IDENTIFIER_RE}`
    );
  }
  if (!SAFE_IDENTIFIER_RE.test(tsCol)) {
    throw new Error(
      `safeMaxTimestampQuery: rejected column name "${tsCol}" — must match ${SAFE_IDENTIFIER_RE}`
    );
  }
  return sql.raw(`SELECT MAX("${tsCol}") AS last_updated FROM "${tableName}"`);
}

/**
 * Return a safe SQL fragment for `SELECT COUNT(*)::int AS cnt, MAX("<tsCol>") AS last_event FROM "<table>"`.
 *
 * @throws {Error} if `tableName` or `tsCol` contain unsafe characters
 */
export function safeCountAndMaxTimestampQuery(tableName: string, tsCol: string): SQL {
  if (!SAFE_IDENTIFIER_RE.test(tableName)) {
    throw new Error(
      `safeCountAndMaxTimestampQuery: rejected table name "${tableName}" — must match ${SAFE_IDENTIFIER_RE}`
    );
  }
  if (!SAFE_IDENTIFIER_RE.test(tsCol)) {
    throw new Error(
      `safeCountAndMaxTimestampQuery: rejected column name "${tsCol}" — must match ${SAFE_IDENTIFIER_RE}`
    );
  }
  return sql.raw(`SELECT COUNT(*)::int AS cnt, MAX("${tsCol}") AS last_event FROM "${tableName}"`);
}
