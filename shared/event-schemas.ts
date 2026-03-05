/**
 * Zod Event Schemas for Critical Kafka Topics (OMN-3751)
 *
 * Strict validation schemas for the 3 pattern topics that project into
 * pattern_learning_artifacts. These replace the silent-default fallback
 * chains in read-model-consumer.ts with explicit parse-or-reject validation.
 *
 * Each schema matches the Pydantic model in omniintelligence. On validation
 * failure the consumer logs a structured error and skips the message rather
 * than silently defaulting missing fields.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Loose UUID: accepts both lowercase and mixed-case hex UUIDs. */
const looseUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Must be a valid UUID');

// ---------------------------------------------------------------------------
// 1. Pattern Projection Event
//    Topic: onex.evt.omniintelligence.pattern-projection.v1
//    Producer: NodePatternProjectionEffect (omniintelligence)
//    Model: ModelPatternProjectionEvent -> patterns: ModelPatternSummary[]
// ---------------------------------------------------------------------------

/**
 * Individual pattern summary within a projection snapshot.
 * Matches ModelPatternSummary from omniintelligence.
 */
export const PatternSummarySchema = z
  .object({
    // Pattern identifier — one of id, pattern_id, or patternId must be present
    id: z.string().optional(),
    pattern_id: z.string().optional(),
    patternId: z.string().optional(),

    // Pattern name — accepts domain_id, pattern_name, or patternName
    domain_id: z.string().optional(),
    pattern_name: z.string().optional(),
    patternName: z.string().optional(),

    // Pattern type
    pattern_type: z.string().optional(),
    patternType: z.string().optional(),

    // Lifecycle state
    status: z.string().optional(),
    lifecycle_state: z.string().optional(),
    lifecycleState: z.string().optional(),

    // Quality score
    quality_score: z.number().optional(),
    composite_score: z.number().optional(),
    compositeScore: z.number().optional(),

    // JSONB payload fields (optional, flexible)
    scoring_evidence: z.unknown().optional(),
    scoringEvidence: z.unknown().optional(),
    signature: z.unknown().optional(),
    signature_hash: z.string().optional(),
    metrics: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .refine((data) => Boolean(data.id || data.pattern_id || data.patternId), {
    message: 'Pattern must have at least one of: id, pattern_id, patternId',
  });

export const PatternProjectionEventSchema = z.object({
  // The projection snapshot carries a patterns array
  patterns: z.array(PatternSummarySchema).min(0),

  // Snapshot timestamp (optional)
  snapshot_at: z.string().optional(),
  snapshotAt: z.string().optional(),

  // Envelope fields (passed through from Kafka)
  correlation_id: z.string().optional(),
  correlationId: z.string().optional(),
});

export type PatternProjectionEvent = z.infer<typeof PatternProjectionEventSchema>;

// ---------------------------------------------------------------------------
// 2. Pattern Lifecycle Transitioned Event
//    Topic: onex.evt.omniintelligence.pattern-lifecycle-transitioned.v1
//    Producer: NodePatternLifecycleEffect (omniintelligence)
//    Model: ModelPatternLifecycleEvent
// ---------------------------------------------------------------------------

export const PatternLifecycleTransitionedEventSchema = z
  .object({
    // Pattern identifier (required)
    pattern_id: z.string().optional(),
    patternId: z.string().optional(),

    // Target status (required — without this the event is meaningless)
    to_status: z.string().optional(),
    toStatus: z.string().optional(),

    // Source status (optional context)
    from_status: z.string().optional(),
    fromStatus: z.string().optional(),

    // Transition timestamp
    transitioned_at: z.string().optional(),
    transitionedAt: z.string().optional(),
    timestamp: z.string().optional(),
    created_at: z.string().optional(),

    // Envelope fields
    correlation_id: z.string().optional(),
    correlationId: z.string().optional(),
  })
  .refine((data) => Boolean(data.pattern_id || data.patternId), {
    message: 'pattern_id or patternId is required',
  })
  .refine((data) => Boolean(data.to_status || data.toStatus), {
    message: 'to_status or toStatus is required',
  });

export type PatternLifecycleTransitionedEvent = z.infer<
  typeof PatternLifecycleTransitionedEventSchema
>;

// ---------------------------------------------------------------------------
// 3. Pattern Learning Requested (Command)
//    Topic: onex.cmd.omniintelligence.pattern-learning.v1
//    Producer: various (omniintelligence pipeline entry point)
//    Model: (untyped command — this schema is our first enforcement)
// ---------------------------------------------------------------------------

export const PatternLearningRequestedEventSchema = z
  .object({
    // Correlation ID used as the pattern_id sentinel
    correlation_id: z.string().optional(),
    correlationId: z.string().optional(),

    // Session context
    session_id: z.string().optional(),
    sessionId: z.string().optional(),

    // Trigger source
    trigger: z.string().optional(),

    // Timestamp
    timestamp: z.string().optional(),
    created_at: z.string().optional(),
  })
  .refine((data) => Boolean(data.correlation_id || data.correlationId), {
    message: 'correlation_id or correlationId is required',
  });

export type PatternLearningRequestedEvent = z.infer<typeof PatternLearningRequestedEventSchema>;

// ---------------------------------------------------------------------------
// Dead-letter counter for Zod validation failures
// ---------------------------------------------------------------------------

export interface EventValidationStats {
  totalValidated: number;
  totalRejected: number;
  rejectionsByTopic: Record<string, number>;
}

const stats: EventValidationStats = {
  totalValidated: 0,
  totalRejected: 0,
  rejectionsByTopic: {},
};

/**
 * Get current validation statistics.
 */
export function getEventValidationStats(): EventValidationStats {
  return { ...stats, rejectionsByTopic: { ...stats.rejectionsByTopic } };
}

/**
 * Reset validation statistics (for testing).
 */
export function resetEventValidationStats(): void {
  stats.totalValidated = 0;
  stats.totalRejected = 0;
  stats.rejectionsByTopic = {};
}

/**
 * Validate an event payload against a Zod schema, logging structured errors
 * on failure. Returns the validated data on success, or null on failure.
 *
 * On failure:
 * - Logs a structured JSON error with topic, field-level details, and raw excerpt
 * - Increments the dead-letter counter for the topic
 * - Returns null (caller must skip the message)
 */
export function validateEvent<T>(schema: z.ZodType<T>, data: unknown, topic: string): T | null {
  stats.totalValidated++;

  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  // Validation failed — increment dead-letter counter and log structured error
  stats.totalRejected++;
  stats.rejectionsByTopic[topic] = (stats.rejectionsByTopic[topic] ?? 0) + 1;

  const errors = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
    expected: 'expected' in issue ? issue.expected : undefined,
    received: 'received' in issue ? issue.received : undefined,
  }));

  // Truncate data excerpt to avoid log explosion
  const dataExcerpt = JSON.stringify(data)?.slice(0, 500) ?? '<unparseable>';

  console.error(
    JSON.stringify({
      level: 'error',
      event: 'event_validation_failed',
      topic,
      errors,
      rejected_count: stats.rejectionsByTopic[topic],
      data_excerpt: dataExcerpt,
      ticket: 'OMN-3751',
    })
  );

  return null;
}
