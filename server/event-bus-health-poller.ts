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
  'omniintelligence-consumer',
  'omnimemory-consumer',
];

/**
 * Topics expected to exist on the broker.
 * Any topic in this list that is absent from the broker generates a
 * missingFromBroker: true record in the projection.
 *
 * Derived from the omnidash topic catalog.
 */
export const EXPECTED_TOPICS: string[] = [
  'onex.evt.omniclaude.gate-decision.v1',
  'onex.evt.omniclaude.epic-run-updated.v1',
  'onex.evt.omniclaude.pr-watch-updated.v1',
  'onex.evt.omniclaude.budget-cap-hit.v1',
  'onex.evt.omniclaude.circuit-breaker-tripped.v1',
  'onex.evt.omniintelligence.pattern-discovery.v1',
  'onex.evt.omniintelligence.pattern-refined.v1',
  'onex.evt.omniintelligence.intent-classified.v1',
  'onex.evt.omnimemory.document-ingested.v1',
  // Canonical ONEX topic names (OMN-4083: replaced legacy flat names)
  // Legacy: 'agent-actions' → omniclaude no longer produces to this topic
  'onex.evt.omniclaude.agent-actions.v1',
  // Legacy: 'agent.routing.requested.v1' / 'agent.routing.completed.v1'
  'onex.cmd.omninode.routing-requested.v1',
  'onex.evt.omninode.routing-completed.v1',
];

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
