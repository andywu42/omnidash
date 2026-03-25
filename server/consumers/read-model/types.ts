/**
 * Shared types and utilities for read-model projection handlers (OMN-5192).
 *
 * ProjectionHandler is the interface that all domain-specific projection
 * modules implement. ProjectionContext provides the DB handle and shared
 * utilities needed by every handler.
 */

import crypto from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';

// ---------------------------------------------------------------------------
// ProjectionContext — injected into every handler by the orchestrator
// ---------------------------------------------------------------------------

export interface ProjectionContext {
  /** Drizzle DB instance (omnidash_analytics). May be null if DB is unavailable. */
  db: ReturnType<typeof drizzle> | null;
}

// ---------------------------------------------------------------------------
// ProjectionHandler — interface for domain-specific projection modules
// ---------------------------------------------------------------------------

export interface ProjectionHandler {
  /** Return true if this handler can project events from the given topic. */
  canHandle(topic: string): boolean;

  /**
   * Project a single parsed event into the read-model.
   *
   * @param topic   Kafka topic the message arrived on
   * @param data    Parsed JSON payload (envelope unwrapped)
   * @param context DB handle and shared utilities
   * @param meta    Kafka message coordinates for deterministic dedup
   * @returns true if the projection succeeded (advance watermark),
   *          false if DB was unavailable (do NOT advance watermark)
   */
  projectEvent(
    topic: string,
    data: Record<string, unknown>,
    context: ProjectionContext,
    meta: MessageMeta
  ): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// MessageMeta — Kafka message coordinates passed to handlers
// ---------------------------------------------------------------------------

export interface MessageMeta {
  partition: number;
  offset: string;
  /** Deterministic fallback correlation ID derived from topic+partition+offset. */
  fallbackId: string;
}

// ---------------------------------------------------------------------------
// Shared utility functions (hoisted from read-model-consumer.ts)
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic UUID-shaped string from Kafka message coordinates.
 * Uses SHA-256 hash of topic + partition + offset, which uniquely identify
 * a message within a Kafka cluster. This ensures that redelivery of the
 * same message produces the same fallback correlation_id, preserving
 * ON CONFLICT DO NOTHING idempotency.
 */
export function deterministicCorrelationId(
  topic: string,
  partition: number,
  offset: string
): string {
  return crypto
    .createHash('sha256')
    .update(`${topic}:${partition}:${offset}`)
    .digest('hex')
    .slice(0, 32)
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

/**
 * Sanitize a session_id value before writing to the DB (OMN-4823).
 *
 * After OMN-4821, session_id is typed text so any string is valid at the DB
 * layer. This helper enforces application-level quality:
 * - Trims whitespace
 * - Returns undefined (null in DB) for empty, null, or whitespace-only values
 * - Logs a warning when the raw value was non-empty but malformed (not a UUID
 *   and not a plain printable string)
 *
 * All INSERT sites for agent_routing_decisions.session_id must route through
 * this helper -- do not inline session_id sanitization at call sites.
 */
export function sanitizeSessionId(
  raw: string | null | undefined,
  context: { correlationId?: string } = {}
): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    console.warn('[read-model-consumer] session_id contains control characters -- writing null', {
      rawLength: raw.length,
      correlationId: context.correlationId,
    });
    return undefined;
  }
  return trimmed;
}

/**
 * Parse a date string safely, returning the current wall-clock time (`new
 * Date()`) when the input is missing or produces an invalid Date.
 *
 * Wall-clock is used as the fallback so that rows with a missing/malformed
 * timestamp are stored with a "reasonable recent" time rather than 1970-01-01.
 */
export function safeParseDate(value: unknown): Date {
  if (!value) {
    return new Date();
  }
  const d = new Date(value as string);
  if (!Number.isFinite(d.getTime())) {
    console.warn(
      `[ReadModelConsumer] safeParseDate: malformed timestamp "${value}", falling back to wall-clock`
    );
    return new Date();
  }
  return d;
}

/**
 * Parse a date string safely, returning epoch-zero (`new Date(0)`) when the
 * input is missing or produces an invalid Date.
 *
 * Epoch-zero is used as a min-date sentinel so that rows with a
 * missing/malformed timestamp sort last (oldest) rather than first (newest).
 * Only use for fields where epoch-zero-as-oldest is intentional (e.g.
 * computedAtUtc in baselines snapshots).
 */
export function safeParseDateOrMin(value: unknown): Date {
  if (!value) {
    console.warn(
      '[ReadModelConsumer] safeParseDateOrMin: missing timestamp value, falling back to epoch-zero'
    );
    return new Date(0);
  }
  const d = new Date(value as string);
  if (!Number.isFinite(d.getTime())) {
    console.warn(
      `[ReadModelConsumer] safeParseDateOrMin: malformed timestamp "${value}", falling back to epoch-zero`
    );
    return new Date(0);
  }
  if (d.getFullYear() < 2020) {
    console.warn(
      `[ReadModelConsumer] safeParseDateOrMin: timestamp "${value}" parsed to year ${d.getFullYear()} (< 2020), treating as epoch-zero sentinel`
    );
    return new Date(0);
  }
  return d;
}

/**
 * Handle a "table does not exist" error gracefully.
 * Returns true if the error is a missing-table error (42P01 or string match),
 * false otherwise (caller should re-throw).
 */
export function isTableMissingError(err: unknown, tableName: string): boolean {
  const pgCode = (err as { code?: string }).code;
  const msg = err instanceof Error ? err.message : String(err);
  return pgCode === '42P01' || (msg.includes(tableName) && msg.includes('does not exist'));
}

// ---------------------------------------------------------------------------
// ProjectionHandlerStats — per-handler observability counters (OMN-6400)
// ---------------------------------------------------------------------------

/** Reasons an event may be dropped during projection. */
export type DropReason = 'missing_field' | 'guard_failed' | 'db_unavailable' | 'table_missing';

/**
 * In-memory counters for a single projection handler.
 * Exposed via GET /api/projection-health.
 */
export interface ProjectionHandlerStats {
  /** Total events received by this handler. */
  received: number;
  /** Events successfully projected into the read-model. */
  projected: number;
  /** Events dropped, broken down by reason. */
  dropped: Record<DropReason, number>;
}

/** Create a fresh zero-value stats object. */
export function createHandlerStats(): ProjectionHandlerStats {
  return {
    received: 0,
    projected: 0,
    dropped: {
      missing_field: 0,
      guard_failed: 0,
      db_unavailable: 0,
      table_missing: 0,
    },
  };
}

/**
 * Global registry of handler stats keyed by handler class name.
 * Each projection handler registers itself on construction.
 */
const handlerStatsRegistry = new Map<string, ProjectionHandlerStats>();

/** Register stats for a handler. Called once per handler instance. */
export function registerHandlerStats(name: string, stats: ProjectionHandlerStats): void {
  handlerStatsRegistry.set(name, stats);
}

/** Get a snapshot of all handler stats. */
export function getAllHandlerStats(): Record<string, ProjectionHandlerStats> {
  const result: Record<string, ProjectionHandlerStats> = {};
  for (const [name, stats] of handlerStatsRegistry) {
    result[name] = { ...stats, dropped: { ...stats.dropped } };
  }
  return result;
}

// UUID validation regex -- hoisted to module scope so it is compiled once.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PostgreSQL hard limit is 65535 parameters per query.
// The widest baselines child table (comparisons) has 14 explicit user params.
// floor(65535 / 14) = 4681 safe rows. Use 4000 as a conservative cap.
export const MAX_BATCH_ROWS = 4000;

// Hoisted to module scope -- shared by both comparison and breakdown writers.
export const VALID_PROMOTION_ACTIONS = new Set(['promote', 'shadow', 'suppress', 'fork']);
export const VALID_CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);
