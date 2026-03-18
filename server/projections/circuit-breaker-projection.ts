/**
 * CircuitBreakerProjection — DB-backed projection for circuit breaker state (OMN-5293)
 *
 * Queries the circuit_breaker_events table to produce:
 *  - Per-service current state summary
 *  - Recent transition event log
 *  - State distribution counts within a time window
 *
 * Source table: circuit_breaker_events (migration 0024)
 * Source topic: onex.evt.omnibase-infra.circuit-breaker.v1
 */

import { sql, desc, gte } from 'drizzle-orm';
import { circuitBreakerEvents } from '@shared/intelligence-schema';
import { DbBackedProjectionView } from './db-backed-projection-view';
import { tryGetIntelligenceDb } from '../storage';

// ============================================================================
// Public types
// ============================================================================

export type CircuitBreakerWindow = '1h' | '24h' | '7d';

export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerServiceSummary {
  serviceName: string;
  currentState: CircuitBreakerState;
  failureCount: number;
  threshold: number;
  lastTransitionAt: string;
}

export interface CircuitBreakerRecentEvent {
  id: string;
  serviceName: string;
  state: CircuitBreakerState;
  previousState: CircuitBreakerState;
  failureCount: number;
  threshold: number;
  emittedAt: string;
}

export interface CircuitBreakerStateCounts {
  closed: number;
  open: number;
  half_open: number;
}

export interface CircuitBreakerPayload {
  services: CircuitBreakerServiceSummary[];
  recentEvents: CircuitBreakerRecentEvent[];
  stateCounts: CircuitBreakerStateCounts;
  window: CircuitBreakerWindow;
  totalEvents: number;
}

type Db = NonNullable<ReturnType<typeof tryGetIntelligenceDb>>;

// ============================================================================
// Window helpers
// ============================================================================

function windowCutoff(window: CircuitBreakerWindow): Date {
  const now = Date.now();
  if (window === '1h') return new Date(now - 60 * 60 * 1000);
  if (window === '7d') return new Date(now - 7 * 24 * 60 * 60 * 1000);
  return new Date(now - 24 * 60 * 60 * 1000);
}

// ============================================================================
// Projection class
// ============================================================================

export class CircuitBreakerProjection extends DbBackedProjectionView<CircuitBreakerPayload> {
  readonly viewId = 'circuit-breaker';

  private windowCache = new Map<
    CircuitBreakerWindow,
    { payload: CircuitBreakerPayload; ts: number }
  >();

  emptyPayload(): CircuitBreakerPayload {
    return {
      services: [],
      recentEvents: [],
      stateCounts: { closed: 0, open: 0, half_open: 0 },
      window: '24h',
      totalEvents: 0,
    };
  }

  /** Required by DbBackedProjectionView — delegates to 24h window. */
  protected async querySnapshot(db: Db): Promise<CircuitBreakerPayload> {
    return this._computeForWindow(db, '24h');
  }

  /** Return cached result if < 10 s old, else recompute. */
  async ensureFreshForWindow(window: CircuitBreakerWindow): Promise<CircuitBreakerPayload> {
    const cached = this.windowCache.get(window);
    if (cached && Date.now() - cached.ts < 10_000) return cached.payload;

    const db = tryGetIntelligenceDb();
    if (!db) return { ...this.emptyPayload(), window };

    const payload = await this._computeForWindow(db, window);
    this.windowCache.set(window, { payload, ts: Date.now() });
    return payload;
  }

  private async _computeForWindow(
    db: Db,
    window: CircuitBreakerWindow
  ): Promise<CircuitBreakerPayload> {
    const cutoff = windowCutoff(window);

    // Recent events (50 most recent)
    const rows = await db
      .select()
      .from(circuitBreakerEvents)
      .where(gte(circuitBreakerEvents.emittedAt, cutoff))
      .orderBy(desc(circuitBreakerEvents.emittedAt))
      .limit(50);

    const recentEvents: CircuitBreakerRecentEvent[] = rows.map((r) => ({
      id: r.id,
      serviceName: r.serviceName,
      state: r.state as CircuitBreakerState,
      previousState: r.previousState as CircuitBreakerState,
      failureCount: r.failureCount,
      threshold: r.threshold,
      emittedAt: r.emittedAt.toISOString(),
    }));

    // Latest state per service (most-recent-wins)
    const serviceMap = new Map<string, CircuitBreakerServiceSummary>();
    for (const ev of [...recentEvents].reverse()) {
      serviceMap.set(ev.serviceName, {
        serviceName: ev.serviceName,
        currentState: ev.state,
        failureCount: ev.failureCount,
        threshold: ev.threshold,
        lastTransitionAt: ev.emittedAt,
      });
    }
    const services = Array.from(serviceMap.values()).sort((a, b) =>
      a.serviceName.localeCompare(b.serviceName)
    );

    // State distribution
    const stateCounts: CircuitBreakerStateCounts = { closed: 0, open: 0, half_open: 0 };
    for (const ev of recentEvents) {
      if (ev.state === 'open') stateCounts.open++;
      else if (ev.state === 'half_open') stateCounts.half_open++;
      else stateCounts.closed++;
    }

    // Total in window
    const countResult = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(circuitBreakerEvents)
      .where(gte(circuitBreakerEvents.emittedAt, cutoff));
    const totalEvents = countResult[0]?.n ?? 0;

    return {
      services,
      recentEvents,
      stateCounts,
      window,
      totalEvents,
    };
  }
}
