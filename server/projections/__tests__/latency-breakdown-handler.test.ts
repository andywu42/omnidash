/**
 * Latency Breakdown Handler Regression Tests (OMN-6392)
 *
 * Tests the isLatencyBreakdownEvent type guard and the
 * projectLatencyBreakdown handler with various event shapes.
 *
 * Root cause of 98% drop: isExtractionBaseEvent required both
 * session_id (snake_case only) and cohort, and isLatencyBreakdownEvent
 * required prompt_id (snake_case only). Most producers use camelCase
 * and/or omit cohort.
 */

import { describe, it, expect } from 'vitest';
import { isLatencyBreakdownEvent, isContextUtilizationEvent } from '@shared/extraction-types';

// Re-export for testing (the function is not exported, so we test via the public guards)

describe('isLatencyBreakdownEvent (OMN-6392)', () => {
  it('accepts snake_case fields with cohort', () => {
    const event = {
      session_id: 'sess-001',
      prompt_id: 'prompt-001',
      cohort: 'test-cohort',
      routing_time_ms: 50,
    };
    expect(isLatencyBreakdownEvent(event)).toBe(true);
  });

  it('accepts snake_case fields without cohort', () => {
    // cohort is now optional (OMN-6392)
    const event = {
      session_id: 'sess-002',
      prompt_id: 'prompt-002',
    };
    expect(isLatencyBreakdownEvent(event)).toBe(true);
  });

  it('accepts camelCase sessionId', () => {
    const event = {
      sessionId: 'sess-003',
      prompt_id: 'prompt-003',
      cohort: 'test-cohort',
    };
    expect(isLatencyBreakdownEvent(event)).toBe(true);
  });

  it('accepts camelCase promptId', () => {
    const event = {
      session_id: 'sess-004',
      promptId: 'prompt-004',
    };
    expect(isLatencyBreakdownEvent(event)).toBe(true);
  });

  it('accepts fully camelCase event', () => {
    const event = {
      sessionId: 'sess-005',
      promptId: 'prompt-005',
    };
    expect(isLatencyBreakdownEvent(event)).toBe(true);
  });

  it('rejects event missing both session_id and sessionId', () => {
    const event = {
      prompt_id: 'prompt-006',
      cohort: 'test-cohort',
    };
    expect(isLatencyBreakdownEvent(event)).toBe(false);
  });

  it('accepts event missing prompt_id — emitter has no prompt_id concept (OMN-7919)', () => {
    // The Python emitter sends correlation_id but no prompt_id.
    // Events without prompt_id must pass this guard so they are not silently dropped.
    const event = {
      session_id: 'sess-007',
      cohort: 'test-cohort',
    };
    expect(isLatencyBreakdownEvent(event)).toBe(true);
  });

  it('rejects null', () => {
    expect(isLatencyBreakdownEvent(null)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isLatencyBreakdownEvent('string')).toBe(false);
    expect(isLatencyBreakdownEvent(42)).toBe(false);
  });

  it('rejects empty session_id string', () => {
    const event = {
      session_id: '',
      prompt_id: 'prompt-008',
    };
    expect(isLatencyBreakdownEvent(event)).toBe(false);
  });
});

describe('isContextUtilizationEvent (base guard test)', () => {
  it('accepts event with sessionId (camelCase) and correlation_id', () => {
    const event = {
      sessionId: 'sess-001',
      correlation_id: 'corr-001',
    };
    expect(isContextUtilizationEvent(event)).toBe(true);
  });

  it('accepts event without cohort', () => {
    const event = {
      session_id: 'sess-002',
      correlation_id: 'corr-002',
    };
    expect(isContextUtilizationEvent(event)).toBe(true);
  });
});
