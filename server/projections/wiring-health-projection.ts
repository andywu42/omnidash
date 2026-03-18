/**
 * WiringHealthProjection — In-memory projection for wiring health snapshots (OMN-5292)
 *
 * Data source: Kafka topic onex.evt.omnibase-infra.wiring-health-snapshot.v1
 * emitted by WiringHealthChecker in omnibase_infra after each health computation.
 *
 * Retains the latest snapshot plus a rolling history of recent snapshots for
 * the timeline view.
 */

// ============================================================================
// Types (sourced from shared; re-exported for server-side consumers)
// ============================================================================

import type {
  TopicWiringRecord,
  WiringHealthSnapshot,
  WiringHealthSummary,
} from '@shared/wiring-health-types';

export type { TopicWiringRecord, WiringHealthSnapshot, WiringHealthSummary };

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of historical snapshots to retain. */
const MAX_HISTORY = 100;

// ============================================================================
// Projection
// ============================================================================

/**
 * WiringHealthProjection — in-memory accumulator for wiring health snapshot events.
 *
 * Keyed by timestamp (latest always accessible). Rolling history preserved.
 */
export class WiringHealthProjection {
  private latest: WiringHealthSnapshot | null = null;
  private readonly history: WiringHealthSnapshot[] = [];

  /**
   * Ingest a fresh wiring health snapshot event.
   * Stores as latest and appends to rolling history.
   */
  ingest(snapshot: WiringHealthSnapshot): void {
    this.latest = snapshot;
    this.history.push(snapshot);
    // Cap history to MAX_HISTORY entries (oldest dropped first)
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
  }

  /**
   * Return the most recent wiring health snapshot, or null if none ingested.
   */
  getLatest(): WiringHealthSnapshot | null {
    return this.latest;
  }

  /**
   * Return all retained snapshots ordered oldest-first.
   */
  getHistory(): WiringHealthSnapshot[] {
    return [...this.history];
  }

  /**
   * Aggregate summary for the dashboard header.
   */
  getSummary(): WiringHealthSummary {
    if (!this.latest) {
      return {
        overallHealthy: true,
        unhealthyCount: 0,
        totalTopics: 0,
        threshold: 0.05,
        lastSnapshotAt: null,
        snapshotCount: 0,
      };
    }
    return {
      overallHealthy: this.latest.overallHealthy,
      unhealthyCount: this.latest.unhealthyCount,
      totalTopics: this.latest.topics.length,
      threshold: this.latest.threshold,
      lastSnapshotAt: this.latest.timestamp,
      snapshotCount: this.history.length,
    };
  }
}

/** Singleton projection instance used by the route and consumer. */
export const wiringHealthProjection = new WiringHealthProjection();
