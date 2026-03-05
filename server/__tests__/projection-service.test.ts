/**
 * ProjectionService Tests (OMN-2094)
 *
 * Covers:
 * - Sequence assignment (monotonic, unique)
 * - Event wrapping (ProjectionEvent shape)
 * - View registration/unregistration
 * - Event routing to views
 * - Invalidation emission on state changes
 * - Batch ingestion
 * - Reset behavior
 * - Edge cases (no views, view rejects event, duplicate viewId)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TOPIC_OMNICLAUDE_AGENT_ACTIONS } from '@shared/topics';
import { ProjectionService, type ProjectionView, type RawEventInput } from '../projection-service';
import type {
  ProjectionEvent,
  ProjectionResponse,
  ProjectionEventsResponse,
} from '@shared/projection-types';

// ============================================================================
// Test Helpers
// ============================================================================

/** Minimal ProjectionView for testing. Stores all applied events. */
class TestView implements ProjectionView<ProjectionEvent[]> {
  readonly viewId: string;
  private events: ProjectionEvent[] = [];
  private acceptAll: boolean;

  constructor(viewId: string, acceptAll = true) {
    this.viewId = viewId;
    this.acceptAll = acceptAll;
  }

  getSnapshot(options?: { limit?: number }): ProjectionResponse<ProjectionEvent[]> {
    const limit = options?.limit ?? this.events.length;
    return {
      viewId: this.viewId,
      cursor: this.events.length > 0 ? this.events[this.events.length - 1].ingestSeq : 0,
      snapshotTimeMs: Date.now(),
      payload: this.events.slice(-limit),
    };
  }

  getEventsSince(cursor: number, limit?: number): ProjectionEventsResponse {
    const filtered = this.events.filter((e) => e.ingestSeq > cursor);
    const result = limit ? filtered.slice(0, limit) : filtered;
    return {
      viewId: this.viewId,
      cursor: result.length > 0 ? result[result.length - 1].ingestSeq : cursor,
      snapshotTimeMs: Date.now(),
      events: result,
    };
  }

  applyEvent(event: ProjectionEvent): boolean {
    if (!this.acceptAll) return false;
    this.events.push(event);
    return true;
  }

  reset(): void {
    this.events = [];
  }

  /** Test helper: how many events were applied */
  get appliedCount(): number {
    return this.events.length;
  }
}

/** Create a minimal raw event for testing */
let rawEventCounter: number; // initialized in beforeEach
function rawEvent(overrides: Partial<RawEventInput> = {}): RawEventInput {
  return {
    id: `test-${++rawEventCounter}`,
    eventTimeMs: Date.now(),
    topic: 'test-topic',
    type: 'test-event',
    source: 'test-source',
    payload: { data: 'test' },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ProjectionService', () => {
  let service: ProjectionService;

  beforeEach(() => {
    service = new ProjectionService();
    rawEventCounter = 0;
  });

  // --------------------------------------------------------------------------
  // Sequence Assignment
  // --------------------------------------------------------------------------

  describe('sequence assignment', () => {
    it('should start at 1 by default', () => {
      expect(service.currentSeq).toBe(1);
    });

    it('should start at custom initialSeq when provided', () => {
      const custom = new ProjectionService({ initialSeq: 500 });
      expect(custom.currentSeq).toBe(500);
      const event = custom.ingest(rawEvent());
      expect(event.ingestSeq).toBe(500);
      expect(custom.currentSeq).toBe(501);
    });

    it('should assign monotonically increasing sequences', () => {
      const events: ReturnType<typeof service.ingest>[] = [];
      for (let i = 0; i < 100; i++) {
        events.push(service.ingest(rawEvent()));
      }

      const seqs = events.map((e) => e.ingestSeq);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBe(seqs[i - 1] + 1);
      }
    });

    it('should assign unique sequences across ingest calls', () => {
      const events = [
        service.ingest(rawEvent()),
        service.ingest(rawEvent()),
        service.ingest(rawEvent()),
      ];

      const seqs = new Set(events.map((e) => e.ingestSeq));
      expect(seqs.size).toBe(3);
    });

    it('should assign sequences in order even for batch ingestion', () => {
      const events = service.ingestBatch([rawEvent(), rawEvent(), rawEvent()]);

      expect(events[0].ingestSeq).toBe(1);
      expect(events[1].ingestSeq).toBe(2);
      expect(events[2].ingestSeq).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // Event Wrapping
  // --------------------------------------------------------------------------

  describe('event wrapping', () => {
    it('should wrap raw input into a ProjectionEvent', () => {
      const now = Date.now();
      const event = service.ingest({
        id: 'evt-123',
        eventTimeMs: now,
        topic: 'onex.evt.platform.node-heartbeat.v1',
        type: 'node-heartbeat',
        source: 'platform',
        severity: 'info',
        payload: { node_id: 'n1', uptime_seconds: 300 },
      });

      expect(event).toMatchObject({
        id: 'evt-123',
        eventTimeMs: now,
        ingestSeq: 1,
        topic: 'onex.evt.platform.node-heartbeat.v1',
        type: 'node-heartbeat',
        source: 'platform',
        severity: 'info',
        payload: { node_id: 'n1', uptime_seconds: 300 },
      });
      expect(event.error).toBeUndefined();
    });

    it('should fill in defaults for missing fields', () => {
      const event = service.ingest({});

      expect(event.id).toMatch(/^proj-1$/);
      expect(event.topic).toBe('');
      expect(event.type).toBe('unknown');
      expect(event.source).toBe('');
      expect(event.severity).toBe('info');
      expect(event.payload).toEqual({});
      expect(event.error).toBeUndefined();
    });

    it('should use topic as type fallback when type is not provided', () => {
      const event = service.ingest({ topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS });
      expect(event.type).toBe(TOPIC_OMNICLAUDE_AGENT_ACTIONS);
    });

    it('should preserve error details when provided', () => {
      const event = service.ingest({
        severity: 'error',
        error: { message: 'Connection refused', stack: 'Error: ...' },
      });

      expect(event.severity).toBe('error');
      expect(event.error).toEqual({
        message: 'Connection refused',
        stack: 'Error: ...',
      });
    });

    it('should extract eventTimeMs from payload when not provided directly', () => {
      const timestamp = 1700000000000;
      const event = service.ingest({
        payload: { emitted_at: timestamp },
      });

      expect(event.eventTimeMs).toBe(timestamp);
    });
  });

  // --------------------------------------------------------------------------
  // View Registration
  // --------------------------------------------------------------------------

  describe('view registration', () => {
    it('should register a view', () => {
      const view = new TestView('test-view');
      service.registerView(view);

      expect(service.viewCount).toBe(1);
      expect(service.viewIds).toEqual(['test-view']);
    });

    it('should register multiple views', () => {
      service.registerView(new TestView('view-a'));
      service.registerView(new TestView('view-b'));
      service.registerView(new TestView('view-c'));

      expect(service.viewCount).toBe(3);
      expect(service.viewIds).toContain('view-a');
      expect(service.viewIds).toContain('view-b');
      expect(service.viewIds).toContain('view-c');
    });

    it('should reject duplicate viewIds', () => {
      service.registerView(new TestView('dupe'));
      expect(() => service.registerView(new TestView('dupe'))).toThrow(
        'ProjectionView "dupe" is already registered'
      );
    });

    it('should unregister a view', () => {
      service.registerView(new TestView('temp'));
      expect(service.unregisterView('temp')).toBe(true);
      expect(service.viewCount).toBe(0);
    });

    it('should return false when unregistering non-existent view', () => {
      expect(service.unregisterView('nope')).toBe(false);
    });

    it('should retrieve a registered view by ID', () => {
      const view = new TestView('my-view');
      service.registerView(view);

      const retrieved = service.getView('my-view');
      expect(retrieved).toBe(view);
    });

    it('should return undefined for non-existent view', () => {
      expect(service.getView('ghost')).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Event Routing
  // --------------------------------------------------------------------------

  describe('event routing', () => {
    it('should route events to all registered views', () => {
      const viewA = new TestView('view-a');
      const viewB = new TestView('view-b');
      service.registerView(viewA);
      service.registerView(viewB);

      service.ingest(rawEvent());

      expect(viewA.appliedCount).toBe(1);
      expect(viewB.appliedCount).toBe(1);
    });

    it('should route each event in a batch to all views', () => {
      const view = new TestView('batch-view');
      service.registerView(view);

      service.ingestBatch([rawEvent(), rawEvent(), rawEvent()]);

      expect(view.appliedCount).toBe(3);
    });

    it('should work with no registered views (no-op)', () => {
      // Should not throw
      const event = service.ingest(rawEvent());
      expect(event.ingestSeq).toBe(1);
    });

    it('should pass the same ProjectionEvent to all views', () => {
      const viewA = new TestView('view-a');
      const viewB = new TestView('view-b');
      service.registerView(viewA);
      service.registerView(viewB);

      service.ingest(rawEvent({ id: 'shared-event' }));

      const snapshotA = viewA.getSnapshot();
      const snapshotB = viewB.getSnapshot();
      expect(snapshotA.payload[0].id).toBe('shared-event');
      expect(snapshotB.payload[0].id).toBe('shared-event');
      expect(snapshotA.payload[0].ingestSeq).toBe(snapshotB.payload[0].ingestSeq);
    });
  });

  // --------------------------------------------------------------------------
  // Invalidation Emission
  // --------------------------------------------------------------------------

  describe('invalidation emission', () => {
    it('should emit projection-invalidate when a view applies an event', async () => {
      const view = new TestView('my-view');
      service.registerView(view);

      const handler = vi.fn();
      service.on('projection-invalidate', handler);

      service.ingest(rawEvent());
      await Promise.resolve(); // flush microtask-coalesced invalidation

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({
        viewId: 'my-view',
        cursor: 1,
      });
    });

    it('should NOT emit when view rejects the event', () => {
      const rejectingView = new TestView('rejecter', false);
      service.registerView(rejectingView);

      const handler = vi.fn();
      service.on('projection-invalidate', handler);

      service.ingest(rawEvent());

      expect(handler).not.toHaveBeenCalled();
    });

    it('should emit once per view that accepts the event', async () => {
      const acceptor = new TestView('acceptor');
      const rejecter = new TestView('rejecter', false);
      service.registerView(acceptor);
      service.registerView(rejecter);

      const handler = vi.fn();
      service.on('projection-invalidate', handler);

      service.ingest(rawEvent());
      await Promise.resolve(); // flush microtask-coalesced invalidation

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({
        viewId: 'acceptor',
        cursor: 1,
      });
    });

    it('should emit with correct cursor for each event in a batch', async () => {
      const view = new TestView('batch-view');
      service.registerView(view);

      const invalidations: Array<{ viewId: string; cursor: number }> = [];
      service.on('projection-invalidate', (data) => invalidations.push(data));

      service.ingestBatch([rawEvent(), rawEvent(), rawEvent()]);
      await Promise.resolve(); // flush microtask-coalesced invalidation

      // Coalescing: a synchronous batch emits ONE invalidation per view
      // with the max cursor (last event's ingestSeq)
      expect(invalidations).toHaveLength(1);
      expect(invalidations[0]).toEqual({ viewId: 'batch-view', cursor: 3 });
    });

    it('should emit for multiple views independently', async () => {
      service.registerView(new TestView('view-a'));
      service.registerView(new TestView('view-b'));

      const invalidations: Array<{ viewId: string; cursor: number }> = [];
      service.on('projection-invalidate', (data) => invalidations.push(data));

      service.ingest(rawEvent());
      await Promise.resolve(); // flush microtask-coalesced invalidation

      expect(invalidations).toHaveLength(2);
      const viewIds = invalidations.map((i) => i.viewId);
      expect(viewIds).toContain('view-a');
      expect(viewIds).toContain('view-b');
    });
  });

  // --------------------------------------------------------------------------
  // View Snapshot & Events-Since (TestView integration)
  // --------------------------------------------------------------------------

  describe('view queries', () => {
    it('should return snapshot with cursor from last applied event', () => {
      const view = new TestView('snapshot-view');
      service.registerView(view);

      service.ingestBatch([rawEvent(), rawEvent(), rawEvent()]);

      const snapshot = view.getSnapshot();
      expect(snapshot.viewId).toBe('snapshot-view');
      expect(snapshot.cursor).toBe(3);
      expect(snapshot.payload).toHaveLength(3);
    });

    it('should respect snapshot limit', () => {
      const view = new TestView('limited-view');
      service.registerView(view);

      service.ingestBatch([rawEvent(), rawEvent(), rawEvent(), rawEvent(), rawEvent()]);

      const snapshot = view.getSnapshot({ limit: 2 });
      expect(snapshot.payload).toHaveLength(2);
      // Should return the last 2 events
      expect(snapshot.payload[0].ingestSeq).toBe(4);
      expect(snapshot.payload[1].ingestSeq).toBe(5);
    });

    it('should return events since cursor', () => {
      const view = new TestView('since-view');
      service.registerView(view);

      service.ingestBatch([rawEvent(), rawEvent(), rawEvent(), rawEvent()]);

      const response = view.getEventsSince(2);
      expect(response.viewId).toBe('since-view');
      expect(response.events).toHaveLength(2);
      expect(response.events[0].ingestSeq).toBe(3);
      expect(response.events[1].ingestSeq).toBe(4);
      expect(response.cursor).toBe(4);
    });

    it('should return empty events when cursor is at head', () => {
      const view = new TestView('caught-up');
      service.registerView(view);

      service.ingestBatch([rawEvent(), rawEvent()]);

      const response = view.getEventsSince(2);
      expect(response.events).toHaveLength(0);
      expect(response.cursor).toBe(2); // stays at provided cursor
    });

    it('should respect events-since limit', () => {
      const view = new TestView('limit-view');
      service.registerView(view);

      service.ingestBatch([rawEvent(), rawEvent(), rawEvent(), rawEvent()]);

      const response = view.getEventsSince(0, 2);
      expect(response.events).toHaveLength(2);
      expect(response.events[0].ingestSeq).toBe(1);
      expect(response.events[1].ingestSeq).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Reset
  // --------------------------------------------------------------------------

  describe('reset', () => {
    it('should reset all views', () => {
      const viewA = new TestView('view-a');
      const viewB = new TestView('view-b');
      service.registerView(viewA);
      service.registerView(viewB);

      service.ingestBatch([rawEvent(), rawEvent()]);
      expect(viewA.appliedCount).toBe(2);
      expect(viewB.appliedCount).toBe(2);

      service.reset();

      expect(viewA.appliedCount).toBe(0);
      expect(viewB.appliedCount).toBe(0);
    });

    it('should reset sequence counter to 1 by default', () => {
      service.ingestBatch([rawEvent(), rawEvent()]);
      expect(service.currentSeq).toBe(3);

      service.reset();
      expect(service.currentSeq).toBe(1);
    });

    it('should reset sequence counter to custom value', () => {
      service.ingest(rawEvent());
      service.reset(100);
      expect(service.currentSeq).toBe(100);

      const event = service.ingest(rawEvent());
      expect(event.ingestSeq).toBe(100);
    });

    it('should emit projection-reset event with new sequence', () => {
      service.ingestBatch([rawEvent(), rawEvent()]);
      const handler = vi.fn();
      service.on('projection-reset', handler);

      service.reset(100);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ newSeq: 100 });
    });

    it('should emit projection-reset with default seq of 1', () => {
      service.ingest(rawEvent());
      const handler = vi.fn();
      service.on('projection-reset', handler);

      service.reset();

      expect(handler).toHaveBeenCalledWith({ newSeq: 1 });
    });

    it('should allow re-ingestion after reset', () => {
      const view = new TestView('reset-view');
      service.registerView(view);

      service.ingest(rawEvent());
      service.reset();
      service.ingest(rawEvent());

      expect(view.appliedCount).toBe(1);
      expect(view.getSnapshot().cursor).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Edge Cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty batch gracefully', () => {
      const events = service.ingestBatch([]);
      expect(events).toEqual([]);
      expect(service.currentSeq).toBe(1); // no sequences assigned
    });

    it('should not throw if a view applyEvent throws and should emit projection-error', () => {
      const badView: ProjectionView<unknown> = {
        viewId: 'bad-view',
        getSnapshot: () => ({ viewId: 'bad-view', cursor: 0, snapshotTimeMs: 0, payload: null }),
        getEventsSince: () => ({ viewId: 'bad-view', cursor: 0, snapshotTimeMs: 0, events: [] }),
        applyEvent: () => {
          throw new Error('boom');
        },
        reset: () => {},
      };

      service.registerView(badView);

      const errorHandler = vi.fn();
      service.on('projection-error', errorHandler);

      // The service should catch the error and continue (fault isolation)
      expect(() => service.ingest(rawEvent())).not.toThrow();

      // Should also emit projection-error for observability
      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith({
        viewId: 'bad-view',
        ingestSeq: 1,
        error: 'boom',
      });
    });

    it('should continue routing to remaining views after one throws', () => {
      const badView: ProjectionView<unknown> = {
        viewId: 'bad-view',
        getSnapshot: () => ({ viewId: 'bad-view', cursor: 0, snapshotTimeMs: 0, payload: null }),
        getEventsSince: () => ({ viewId: 'bad-view', cursor: 0, snapshotTimeMs: 0, events: [] }),
        applyEvent: () => {
          throw new Error('boom');
        },
        reset: () => {},
      };
      const goodView = new TestView('good-view');

      service.registerView(badView);
      service.registerView(goodView);

      service.ingest(rawEvent());

      // The good view should still receive the event despite bad view throwing
      expect(goodView.appliedCount).toBe(1);
    });

    it('should still route to remaining views after one rejects', () => {
      const rejecter = new TestView('rejecter', false);
      const acceptor = new TestView('acceptor');
      service.registerView(rejecter);
      service.registerView(acceptor);

      service.ingest(rawEvent());

      expect(acceptor.appliedCount).toBe(1);
    });

    it('should continue resetting remaining views if one throws during reset', () => {
      const badView: ProjectionView<unknown> = {
        viewId: 'reset-boom',
        getSnapshot: () => ({ viewId: 'reset-boom', cursor: 0, snapshotTimeMs: 0, payload: null }),
        getEventsSince: () => ({ viewId: 'reset-boom', cursor: 0, snapshotTimeMs: 0, events: [] }),
        applyEvent: () => true,
        reset: () => {
          throw new Error('reset-failure');
        },
      };
      const goodView = new TestView('reset-ok');

      service.registerView(badView);
      service.registerView(goodView);

      service.ingest(rawEvent());
      expect(goodView.appliedCount).toBe(1);

      // reset should not throw even when one view fails
      expect(() => service.reset()).not.toThrow();
      expect(goodView.appliedCount).toBe(0);
      expect(service.currentSeq).toBe(1);
    });

    it('should maintain view registry across resets', () => {
      service.registerView(new TestView('persistent'));
      service.reset();

      expect(service.viewCount).toBe(1);
      expect(service.viewIds).toEqual(['persistent']);
    });

    it('should set eventTimeMissing when no timestamp is available', () => {
      const event = service.ingest({ payload: { data: 'no-time' } });
      expect(event.eventTimeMissing).toBe(true);
      expect(event.eventTimeMs).toBe(0);
    });

    it('should not set eventTimeMissing when eventTimeMs is provided', () => {
      const event = service.ingest({ eventTimeMs: 1700000000000 });
      expect(event.eventTimeMissing).toBeUndefined();
    });

    it('should not set eventTimeMissing when eventTimeMs is explicitly 0', () => {
      // eventTimeMs: 0 is a valid caller-provided timestamp (epoch)
      // Should NOT be treated as missing — caller explicitly set it
      const event = service.ingest({ eventTimeMs: 0 });
      expect(event.eventTimeMissing).toBeUndefined();
      expect(event.eventTimeMs).toBe(0);
    });

    it('should not set eventTimeMissing when payload contains a timestamp', () => {
      const event = service.ingest({ payload: { emitted_at: 1700000000000 } });
      expect(event.eventTimeMissing).toBeUndefined();
    });

    it('should handle non-Error throwables in applyEvent', () => {
      const badView: ProjectionView<unknown> = {
        viewId: 'string-thrower',
        getSnapshot: () => ({
          viewId: 'string-thrower',
          cursor: 0,
          snapshotTimeMs: 0,
          payload: null,
        }),
        getEventsSince: () => ({
          viewId: 'string-thrower',
          cursor: 0,
          snapshotTimeMs: 0,
          events: [],
        }),
        applyEvent: () => {
          throw 'not an Error object';
        },
        reset: () => {},
      };
      service.registerView(badView);
      const handler = vi.fn();
      service.on('projection-error', handler);
      expect(() => service.ingest(rawEvent())).not.toThrow();
      expect(handler).toHaveBeenCalledWith({
        viewId: 'string-thrower',
        ingestSeq: 1,
        error: 'not an Error object',
      });
    });

    it('should set maxListeners to 50 to support many downstream consumers', () => {
      expect(service.getMaxListeners()).toBe(50);
    });

    it('should return the correct view from getView', () => {
      const view = new TestView('typed-view');
      service.registerView(view);

      const retrieved = service.getView<ProjectionEvent[]>('typed-view');
      expect(retrieved).toBe(view);
      expect(retrieved?.viewId).toBe('typed-view');
    });

    it('should return undefined from getView for non-existent ID', () => {
      const retrieved = service.getView<unknown>('missing');
      expect(retrieved).toBeUndefined();
    });
  });
});
