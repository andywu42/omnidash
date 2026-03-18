/**
 * Shared types for the Wiring Health Dashboard (OMN-5292).
 *
 * These interfaces describe the shape of wiring health snapshot events
 * emitted by WiringHealthChecker and projected into the in-memory
 * WiringHealthProjection. Shared here so both client and server can
 * import from @shared rather than crossing the client/server boundary.
 */

/** Per-topic health record within a wiring health snapshot. */
export interface TopicWiringRecord {
  topic: string;
  emitCount: number;
  consumeCount: number;
  mismatchRatio: number;
  isHealthy: boolean;
}

/** A single wiring health snapshot. */
export interface WiringHealthSnapshot {
  timestamp: string;
  overallHealthy: boolean;
  unhealthyCount: number;
  threshold: number;
  topics: TopicWiringRecord[];
  correlationId: string;
  receivedAt: string;
}

/** Summary counts for the dashboard header. */
export interface WiringHealthSummary {
  overallHealthy: boolean;
  unhealthyCount: number;
  totalTopics: number;
  threshold: number;
  lastSnapshotAt: string | null;
  snapshotCount: number;
}
