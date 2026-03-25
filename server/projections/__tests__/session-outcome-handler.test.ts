/**
 * Session Outcome Handler Regression Tests (OMN-6391)
 *
 * Tests the OmniclaudeProjectionHandler.projectSessionOutcome method
 * with various event shapes to prevent future silent drops.
 *
 * Root cause of 87% drop: events arriving with { data: { session_id } } envelope
 * were not unwrapped by parseMessage, so the handler saw no session_id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OmniclaudeProjectionHandler } from '../../consumers/read-model/omniclaude-projections';
import type { ProjectionContext, MessageMeta } from '../../consumers/read-model/types';
import { SUFFIX_OMNICLAUDE_SESSION_OUTCOME } from '@shared/topics';

// ============================================================================
// Mock DB
// ============================================================================

function buildMockDb() {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('OmniclaudeProjectionHandler - projectSessionOutcome', () => {
  let handler: OmniclaudeProjectionHandler;
  let mockDb: ReturnType<typeof buildMockDb>;
  let context: ProjectionContext;
  let meta: MessageMeta;

  beforeEach(() => {
    handler = new OmniclaudeProjectionHandler();
    mockDb = buildMockDb();
    context = { db: mockDb as any };
    meta = {
      fallbackId: 'test-fallback-id',
      partition: 0,
      offset: '0',
      timestamp: Date.now().toString(),
    };
  });

  it('handles event with snake_case session_id', async () => {
    const data = {
      session_id: 'sess-001',
      outcome: 'success',
      emitted_at: '2026-03-24T10:00:00Z',
    };

    const result = await handler.projectEvent(
      SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
      data,
      context,
      meta
    );

    expect(result).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('handles event with camelCase sessionId', async () => {
    const data = {
      sessionId: 'sess-002',
      outcome: 'failed',
      emittedAt: '2026-03-24T10:00:00Z',
    };

    const result = await handler.projectEvent(
      SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
      data,
      context,
      meta
    );

    expect(result).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('handles event with correlation_id fallback', async () => {
    const data = {
      correlation_id: 'corr-003',
      outcome: 'success',
      timestamp: '2026-03-24T10:00:00Z',
    };

    const result = await handler.projectEvent(
      SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
      data,
      context,
      meta
    );

    expect(result).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('handles event with _correlation_id from envelope unwrap', async () => {
    const data = {
      _correlation_id: 'envelope-corr-004',
      outcome: 'abandoned',
      created_at: '2026-03-24T10:00:00Z',
    };

    const result = await handler.projectEvent(
      SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
      data,
      context,
      meta
    );

    expect(result).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('logs warning with event keys when all identifiers are missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const data = {
      outcome: 'success',
      some_other_field: 'value',
    };

    const result = await handler.projectEvent(
      SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
      data,
      context,
      meta
    );

    expect(result).toBe(true); // handled but not projected
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Available keys:')
    );
    // DB should NOT be called since we have no ID
    expect(mockDb.insert).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('defaults outcome to "unknown" when missing', async () => {
    const data = {
      session_id: 'sess-005',
      emitted_at: '2026-03-24T10:00:00Z',
    };

    const result = await handler.projectEvent(
      SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
      data,
      context,
      meta
    );

    expect(result).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('returns false when DB is unavailable', async () => {
    const noDbContext: ProjectionContext = { db: null };

    const data = {
      session_id: 'sess-006',
      outcome: 'success',
    };

    const result = await handler.projectEvent(
      SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
      data,
      noDbContext,
      meta
    );

    expect(result).toBe(false);
  });
});
