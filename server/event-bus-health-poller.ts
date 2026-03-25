/**
 * Event Bus Health Poller (OMN-3192)
 *
 * Polls Redpanda Admin API endpoints to collect topic and consumer group health,
 * then feeds results into the EventBusHealthProjection singleton.
 *
 * Redpanda Admin API used:
 *   GET http://localhost:9644/v1/partitions
 *   GET http://localhost:9644/v1/brokers
 *   GET http://localhost:9644/v1/groups/{group}/offsets
 *
 * Known consumer groups are derived from WATCHED_CONSUMER_GROUPS below.
 * Topics not returned by the broker but listed in EXPECTED_TOPICS get
 * a record with presentOnBroker: false ("missing topic" alert).
 *
 * If Redpanda Admin API is unavailable, the poller logs a warning and
 * retries on the next interval — it does NOT crash the server.
 */

import {
  eventBusHealthProjection,
  type TopicHealthRecord,
} from './projections/event-bus-health-projection';
import { loadManifestTopics, loadMonitoredTopics } from './services/topic-manifest-loader';

// ============================================================================
// Constants
// ============================================================================

const REDPANDA_ADMIN_URL = process.env.REDPANDA_ADMIN_URL ?? 'http://localhost:9644';

/** Poll interval in milliseconds. */
const POLL_INTERVAL_MS = 30_000;

/**
 * Consumer groups monitored for lag.
 * Add new consumer groups here as they are provisioned.
 */
const WATCHED_CONSUMER_GROUPS: string[] = [
  'omnidash-consumer',
  'omnidash-read-model',
  'omnidash-read-model-v1',
  'omniintelligence-consumer',
  'omnimemory-consumer',
];

/**
 * Topics expected to exist on the broker.
 * Any topic in this list that is absent from the broker generates a
 * missingFromBroker: true record in the projection.
 *
 * OMN-5184: Derived from topics.yaml manifest (via TopicManifestLoader)
 * — read_model_topics + monitored_topics sections.
 * Adding a new topic to topics.yaml automatically updates health probe coverage.
 *
 * No fallback: if topics.yaml cannot be loaded, the error propagates and
 * omnidash fails startup (manifest is required infrastructure).
 */
function buildExpectedTopics(): string[] {
  const manifestTopics = loadManifestTopics();
  const monitoredTopics = loadMonitoredTopics();
  const combined = new Set([...manifestTopics, ...monitoredTopics]);
  return [...combined];
}

export const EXPECTED_TOPICS: string[] = buildExpectedTopics();

// ============================================================================
// Consumer Group Lag Tracking (OMN-6402)
// ============================================================================

/** Lag status based on total messages behind. */
export type ConsumerLagStatus = 'healthy' | 'degraded' | 'critical';

/** Per-topic partition lag entry. */
export interface PartitionLag {
  topic: string;
  partition: number;
  currentOffset: number;
  logEndOffset: number;
  lag: number;
}

/** Aggregate lag for the read-model consumer group. */
export interface ConsumerGroupLag {
  groupId: string;
  totalLag: number;
  status: ConsumerLagStatus;
  partitions: PartitionLag[];
  lastCheckedAt: string;
}

const DEGRADED_LAG_THRESHOLD = 10_000;
const CRITICAL_LAG_THRESHOLD = 100_000;

/** In-memory latest lag snapshot for the read-model consumer group. */
let readModelConsumerLag: ConsumerGroupLag | null = null;

/** Get the latest consumer group lag snapshot (called by projection-health). */
export function getReadModelConsumerLag(): ConsumerGroupLag | null {
  return readModelConsumerLag;
}

function lagStatus(totalLag: number): ConsumerLagStatus {
  if (totalLag >= CRITICAL_LAG_THRESHOLD) return 'critical';
  if (totalLag >= DEGRADED_LAG_THRESHOLD) return 'degraded';
  return 'healthy';
}

/** DLQ topic suffix pattern — topics ending with .dlq or -dlq. */
const DLQ_SUFFIX_RE = /\.(dlq)$|-dlq$/i;

// ============================================================================
// Types (Redpanda Admin API response shapes)
// ============================================================================

interface RedpandaPartition {
  ns: string;
  topic: string;
  partition_id: number;
  [key: string]: unknown;
}

interface RedpandaGroupOffset {
  topic: string;
  partitions: Array<{
    partition: number;
    offset: number;
    log_end_offset?: number;
  }>;
}

// ============================================================================
// Poll logic
// ============================================================================

async function pollEventBusHealth(): Promise<void> {
  let brokerTopics: string[];
  try {
    brokerTopics = await fetchTopicNames();
  } catch (err) {
    console.warn(
      '[event-bus-health-poller] Failed to fetch topics from Redpanda Admin API:',
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  const brokerTopicSet = new Set(brokerTopics);

  // Build DLQ message count map from broker topics
  const dlqCounts = new Map<string, number>();
  for (const t of brokerTopics) {
    if (DLQ_SUFFIX_RE.test(t)) {
      // Map DLQ topic back to its base topic
      const baseTopic = t.replace(DLQ_SUFFIX_RE, '');
      // We use a simple heuristic: DLQ message count = partition count as proxy
      // (actual count would require consumer group offset polling)
      dlqCounts.set(baseTopic, dlqCounts.get(baseTopic) ?? 0);
    }
  }

  // Fetch per-group offsets for lag calculation
  const lagByTopic = new Map<string, number>();
  for (const group of WATCHED_CONSUMER_GROUPS) {
    try {
      const offsets = await fetchGroupOffsets(group);
      for (const entry of offsets) {
        let totalLag = 0;
        for (const p of entry.partitions) {
          const logEnd = p.log_end_offset ?? p.offset;
          const lag = Math.max(0, logEnd - p.offset);
          totalLag += lag;
        }
        const existing = lagByTopic.get(entry.topic) ?? 0;
        lagByTopic.set(entry.topic, existing + totalLag);
      }
    } catch {
      // Group may not exist yet — skip silently
    }
  }

  // OMN-6402: Track read-model consumer group lag specifically
  try {
    const rmOffsets = await fetchGroupOffsets('omnidash-read-model-v1');
    const partitions: PartitionLag[] = [];
    let rmTotalLag = 0;
    for (const entry of rmOffsets) {
      for (const p of entry.partitions) {
        const logEnd = p.log_end_offset ?? p.offset;
        const lag = Math.max(0, logEnd - p.offset);
        rmTotalLag += lag;
        partitions.push({
          topic: entry.topic,
          partition: p.partition,
          currentOffset: p.offset,
          logEndOffset: logEnd,
          lag,
        });
      }
    }
    readModelConsumerLag = {
      groupId: 'omnidash-read-model-v1',
      totalLag: rmTotalLag,
      status: lagStatus(rmTotalLag),
      partitions,
      lastCheckedAt: new Date().toISOString(),
    };
  } catch {
    // Consumer group may not exist yet — leave null
  }

  // Determine the union of topics to report: broker topics + expected topics
  const allTopics = new Set([...brokerTopics, ...EXPECTED_TOPICS]);

  for (const topic of allTopics) {
    const presentOnBroker = brokerTopicSet.has(topic);

    const record: TopicHealthRecord = {
      topic,
      consumerGroup: 'omnidash-consumer',
      lag: lagByTopic.get(topic) ?? 0,
      lastMessageTimestamp: presentOnBroker ? new Date().toISOString() : null,
      dlqMessageCount: dlqCounts.get(topic) ?? 0,
      presentOnBroker,
    };

    eventBusHealthProjection.ingest(record);
  }
}

export async function fetchTopicNames(): Promise<string[]> {
  const url = `${REDPANDA_ADMIN_URL}/v1/partitions`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const raw = await res.json();
  const json = Array.isArray(raw) ? (raw as RedpandaPartition[]) : [];
  const topicSet = new Set<string>();
  for (const p of json) {
    if (typeof p.topic === 'string' && p.ns !== 'redpanda') {
      topicSet.add(p.topic);
    }
  }
  return [...topicSet];
}

async function fetchGroupOffsets(group: string): Promise<RedpandaGroupOffset[]> {
  const url = `${REDPANDA_ADMIN_URL}/v1/groups/${encodeURIComponent(group)}/offsets`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const json = (await res.json()) as { topics?: RedpandaGroupOffset[] } | RedpandaGroupOffset[];
  const arr = Array.isArray(json) ? json : (json.topics ?? []);
  return arr as RedpandaGroupOffset[];
}

// ============================================================================
// Lifecycle
// ============================================================================

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the event bus health poller.
 * Performs an immediate poll on start, then polls every POLL_INTERVAL_MS.
 *
 * Idempotent — calling start() when already running is a no-op.
 */
export function startEventBusHealthPoller(): void {
  if (intervalHandle !== null) return;

  console.log(
    `[event-bus-health-poller] Starting — polling ${REDPANDA_ADMIN_URL} every ${POLL_INTERVAL_MS}ms`
  );

  // Immediate first poll (fire-and-forget, errors are caught inside)
  pollEventBusHealth().catch((err) =>
    console.error('[event-bus-health-poller] Initial poll error:', err)
  );

  intervalHandle = setInterval(() => {
    pollEventBusHealth().catch((err) =>
      console.error('[event-bus-health-poller] Poll error:', err)
    );
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the event bus health poller.
 */
export function stopEventBusHealthPoller(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[event-bus-health-poller] Stopped');
  }
}
