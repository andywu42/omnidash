/**
 * Event Schema Validation Tests (OMN-3751)
 *
 * Verifies that Zod schemas for the 3 critical pattern topics correctly
 * accept well-formed events and reject malformed ones.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PatternProjectionEventSchema,
  PatternLifecycleTransitionedEventSchema,
  PatternLearningRequestedEventSchema,
  validateEvent,
  getEventValidationStats,
  resetEventValidationStats,
} from '../event-schemas';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makePatternProjectionEvent(overrides?: Record<string, unknown>) {
  return {
    patterns: [
      {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        pattern_name: 'retry-on-timeout',
        pattern_type: 'error_handling',
        status: 'validated',
        quality_score: 0.85,
        scoring_evidence: { accuracy: 0.9 },
        signature: { hash: 'abc123' },
        metrics: {},
        metadata: {},
      },
    ],
    snapshot_at: '2026-03-05T10:00:00Z',
    correlation_id: 'c1d2e3f4-a5b6-7890-cdef-123456789abc',
    ...overrides,
  };
}

function makeLifecycleEvent(overrides?: Record<string, unknown>) {
  return {
    pattern_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    to_status: 'validated',
    from_status: 'candidate',
    transitioned_at: '2026-03-05T10:00:00Z',
    correlation_id: 'c1d2e3f4-a5b6-7890-cdef-123456789abc',
    ...overrides,
  };
}

function makeLearningEvent(overrides?: Record<string, unknown>) {
  return {
    correlation_id: 'c1d2e3f4-a5b6-7890-cdef-123456789abc',
    session_id: 'sess-001',
    trigger: 'extraction_pipeline',
    timestamp: '2026-03-05T10:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pattern Projection Event
// ---------------------------------------------------------------------------

describe('PatternProjectionEventSchema', () => {
  it('accepts a well-formed event', () => {
    const result = PatternProjectionEventSchema.safeParse(makePatternProjectionEvent());
    expect(result.success).toBe(true);
  });

  it('accepts event with camelCase field aliases', () => {
    const result = PatternProjectionEventSchema.safeParse({
      patterns: [
        {
          patternId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          patternName: 'retry-on-timeout',
          patternType: 'error_handling',
          lifecycleState: 'validated',
          compositeScore: 0.85,
        },
      ],
      snapshotAt: '2026-03-05T10:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts event with empty patterns array', () => {
    const result = PatternProjectionEventSchema.safeParse({
      patterns: [],
      snapshot_at: '2026-03-05T10:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects event without patterns array', () => {
    const result = PatternProjectionEventSchema.safeParse({
      snapshot_at: '2026-03-05T10:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects patterns where none of id/pattern_id/patternId is present', () => {
    const result = PatternProjectionEventSchema.safeParse({
      patterns: [
        {
          pattern_name: 'orphan',
          pattern_type: 'unknown',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-object payload', () => {
    const result = PatternProjectionEventSchema.safeParse('not-an-object');
    expect(result.success).toBe(false);
  });

  it('rejects null payload', () => {
    const result = PatternProjectionEventSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pattern Lifecycle Transitioned Event
// ---------------------------------------------------------------------------

describe('PatternLifecycleTransitionedEventSchema', () => {
  it('accepts a well-formed event', () => {
    const result = PatternLifecycleTransitionedEventSchema.safeParse(makeLifecycleEvent());
    expect(result.success).toBe(true);
  });

  it('accepts event with camelCase aliases', () => {
    const result = PatternLifecycleTransitionedEventSchema.safeParse({
      patternId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      toStatus: 'validated',
    });
    expect(result.success).toBe(true);
  });

  it('rejects event missing pattern_id', () => {
    const result = PatternLifecycleTransitionedEventSchema.safeParse({
      to_status: 'validated',
    });
    expect(result.success).toBe(false);
  });

  it('rejects event missing to_status', () => {
    const result = PatternLifecycleTransitionedEventSchema.safeParse({
      pattern_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-object payload', () => {
    const result = PatternLifecycleTransitionedEventSchema.safeParse(42);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pattern Learning Requested Event
// ---------------------------------------------------------------------------

describe('PatternLearningRequestedEventSchema', () => {
  it('accepts a well-formed event', () => {
    const result = PatternLearningRequestedEventSchema.safeParse(makeLearningEvent());
    expect(result.success).toBe(true);
  });

  it('accepts event with correlationId alias', () => {
    const result = PatternLearningRequestedEventSchema.safeParse({
      correlationId: 'c1d2e3f4-a5b6-7890-cdef-123456789abc',
    });
    expect(result.success).toBe(true);
  });

  it('rejects event missing both correlation_id and correlationId', () => {
    const result = PatternLearningRequestedEventSchema.safeParse({
      session_id: 'sess-001',
      trigger: 'manual',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-object payload', () => {
    const result = PatternLearningRequestedEventSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateEvent() helper
// ---------------------------------------------------------------------------

describe('validateEvent()', () => {
  beforeEach(() => {
    resetEventValidationStats();
  });

  it('returns validated data on success', () => {
    const data = makePatternProjectionEvent();
    const result = validateEvent(PatternProjectionEventSchema, data, 'test-topic');
    expect(result).not.toBeNull();
    expect(result!.patterns).toHaveLength(1);
  });

  it('returns null on validation failure', () => {
    const result = validateEvent(
      PatternLifecycleTransitionedEventSchema,
      { pattern_id: 'abc' },
      'test-topic'
    );
    expect(result).toBeNull();
  });

  it('increments dead-letter counter on failure', () => {
    validateEvent(PatternLearningRequestedEventSchema, {}, 'topic-a');
    validateEvent(PatternLearningRequestedEventSchema, {}, 'topic-a');
    validateEvent(PatternLifecycleTransitionedEventSchema, {}, 'topic-b');

    const stats = getEventValidationStats();
    expect(stats.totalValidated).toBe(3);
    expect(stats.totalRejected).toBe(3);
    expect(stats.rejectionsByTopic['topic-a']).toBe(2);
    expect(stats.rejectionsByTopic['topic-b']).toBe(1);
  });

  it('tracks successful validations without incrementing rejected', () => {
    validateEvent(PatternProjectionEventSchema, makePatternProjectionEvent(), 'ok-topic');
    const stats = getEventValidationStats();
    expect(stats.totalValidated).toBe(1);
    expect(stats.totalRejected).toBe(0);
  });
});
