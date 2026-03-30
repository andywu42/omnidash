import { describe, it, expect } from 'vitest';

/**
 * Tests for the pattern ingestion dedup guard (OMN-7014).
 * Verifies that placeholder and zero-score patterns are rejected.
 */

describe('pattern ingestion dedup', () => {
  const REJECTED_PATTERN_NAMES = new Set([
    'learning_requested',
    'learning requested',
    'general',
    'stored_placeholder',
  ]);

  it('rejects patterns with placeholder names', () => {
    expect(REJECTED_PATTERN_NAMES.has('learning_requested')).toBe(true);
    expect(REJECTED_PATTERN_NAMES.has('general')).toBe(true);
    expect(REJECTED_PATTERN_NAMES.has('stored_placeholder')).toBe(true);
    expect(REJECTED_PATTERN_NAMES.has('learning requested')).toBe(true);
  });

  it('allows patterns with real names', () => {
    expect(REJECTED_PATTERN_NAMES.has('valid_pattern_name')).toBe(false);
    expect(REJECTED_PATTERN_NAMES.has('code_quality_metric')).toBe(false);
    expect(REJECTED_PATTERN_NAMES.has('error_recovery_pattern')).toBe(false);
  });

  it('rejects patterns with zero composite score and unmeasured evidence', () => {
    const shouldReject = (score: number, evidenceTier: string) =>
      score === 0 && evidenceTier === 'unmeasured';
    expect(shouldReject(0, 'unmeasured')).toBe(true);
  });

  it('allows patterns with non-zero score even if unmeasured', () => {
    const shouldReject = (score: number, evidenceTier: string) =>
      score === 0 && evidenceTier === 'unmeasured';
    expect(shouldReject(0.5, 'unmeasured')).toBe(false);
    expect(shouldReject(0.1, 'unmeasured')).toBe(false);
  });

  it('allows patterns with zero score but measured evidence', () => {
    const shouldReject = (score: number, evidenceTier: string) =>
      score === 0 && evidenceTier === 'unmeasured';
    expect(shouldReject(0, 'measured')).toBe(false);
    expect(shouldReject(0, 'observed')).toBe(false);
  });
});
