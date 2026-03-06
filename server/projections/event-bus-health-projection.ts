/**
 * EventBusHealthProjection — In-memory projection for Redpanda topic health (OMN-3192)
 *
 * Data source: Polled from Redpanda Admin API:
 *   GET http://localhost:9644/v1/partitions
 *   GET http://localhost:9644/v1/brokers
 *   GET http://localhost:9644/v1/groups/{group}/offsets
 *
 * The topic health poller (event-bus-health-poller.ts) calls ingest() for each topic.
 *
 * Payload shape served via /api/event-bus-health:
 *   EventBusHealthPayload { topics: TopicHealthSummary[], summary: EventBusSummary }
 *
 * Silent consumer detection: any topic with lastMessageTimestamp older than
 * SILENCE_THRESHOLD_MS (default 10 minutes) is marked silent: true.
 */

// ============================================================================
// Types
// ============================================================================

/** Raw topic health record from the Redpanda Admin API poller. */
export interface TopicHealthRecord {
  topic: string;
  consumerGroup: string;
  lag: number;
  lastMessageTimestamp: string | null;
  dlqMessageCount: number;
  /** True when the topic exists on the broker. False when expected but absent. */
  presentOnBroker: boolean;
}

/** Aggregated health summary for a single Kafka/Redpanda topic. */
export interface TopicHealthSummary {
  topic: string;
  consumerGroup: string;
  lag: number;
  lastMessageTimestamp: string | null;
  dlqMessageCount: number;
  /** True when dlqMessageCount > 0. */
  hasDlqMessages: boolean;
  /** True when topic is not present on broker (expected but missing). */
  missingFromBroker: boolean;
  /** True when no message has been received in > SILENCE_THRESHOLD_MS. */
  silent: boolean;
  /** ISO timestamp of when this record was last updated. */
  lastPolledAt: string;
}

/** Summary counts for the Event Bus Health dashboard header. */
export interface EventBusSummary {
  totalTopics: number;
  silentTopics: number;
  missingTopics: number;
  topicsWithDlqMessages: number;
  totalLag: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Milliseconds without a new message after which a topic is considered silent. */
const SILENCE_THRESHOLD_MS = 10 * 60_000;

// ============================================================================
// Projection
// ============================================================================

/**
 * EventBusHealthProjection — in-memory accumulator for Redpanda topic health.
 *
 * Keyed by topic name. Supports:
 *   - ingest(record): update topic health from a fresh poll
 *   - getTopicHealth(topic): retrieve summary for a specific topic
 *   - getAllTopics(): retrieve all topic summaries
 *   - getSummary(): aggregate counts for the dashboard header
 */
export class EventBusHealthProjection {
  /** Map from topic name to latest health record. */
  private readonly topics = new Map<string, TopicHealthRecord & { lastPolledAt: string }>();

  /**
   * Ingest a fresh poll result for a topic.
   * Replaces any existing record for the same topic.
   */
  ingest(record: TopicHealthRecord): void {
    this.topics.set(record.topic, {
      ...record,
      lastPolledAt: new Date().toISOString(),
    });
  }

  /**
   * Retrieve the health summary for a specific topic.
   * Returns null if no records have been ingested for this topic.
   */
  getTopicHealth(topic: string): TopicHealthSummary | null {
    const record = this.topics.get(topic);
    if (!record) return null;
    return this.toSummary(record);
  }

  /**
   * Retrieve all topic health summaries.
   * Missing topics (presentOnBroker: false) appear first (most urgent),
   * then sorted by lag descending within the remaining topics.
   */
  getAllTopics(): TopicHealthSummary[] {
    const summaries = [...this.topics.values()].map((r) => this.toSummary(r));
    return summaries.sort((a, b) => {
      // Missing topics float to top
      if (a.missingFromBroker && !b.missingFromBroker) return -1;
      if (!a.missingFromBroker && b.missingFromBroker) return 1;
      // Then sort by lag descending
      return b.lag - a.lag;
    });
  }

  /**
   * Aggregate summary counts for the dashboard header.
   */
  getSummary(): EventBusSummary {
    const summaries = this.getAllTopics();
    return {
      totalTopics: summaries.length,
      silentTopics: summaries.filter((t) => t.silent).length,
      missingTopics: summaries.filter((t) => t.missingFromBroker).length,
      topicsWithDlqMessages: summaries.filter((t) => t.hasDlqMessages).length,
      totalLag: summaries.reduce((acc, t) => acc + t.lag, 0),
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Convert a stored record to a TopicHealthSummary with computed fields.
   */
  private toSummary(record: TopicHealthRecord & { lastPolledAt: string }): TopicHealthSummary {
    const silent = this.isSilent(record.lastMessageTimestamp);
    return {
      topic: record.topic,
      consumerGroup: record.consumerGroup,
      lag: record.lag,
      lastMessageTimestamp: record.lastMessageTimestamp,
      dlqMessageCount: record.dlqMessageCount,
      hasDlqMessages: record.dlqMessageCount > 0,
      missingFromBroker: !record.presentOnBroker,
      silent,
      lastPolledAt: record.lastPolledAt,
    };
  }

  /**
   * Determine if a topic should be considered silent.
   * A topic is silent when:
   * - lastMessageTimestamp is null (no messages ever received), OR
   * - lastMessageTimestamp is older than SILENCE_THRESHOLD_MS
   */
  private isSilent(lastMessageTimestamp: string | null): boolean {
    if (lastMessageTimestamp === null) return true;
    const ts = new Date(lastMessageTimestamp).getTime();
    if (isNaN(ts)) return true;
    return Date.now() - ts > SILENCE_THRESHOLD_MS;
  }
}

/** Singleton projection instance used by the poller and API route. */
export const eventBusHealthProjection = new EventBusHealthProjection();
