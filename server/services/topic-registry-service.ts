/**
 * TopicRegistryService (OMN-5024)
 *
 * EventEmitter-based in-memory store for topics discovered from node
 * introspection events. This is the single source of truth for dynamically
 * discovered event topics in the omnidash runtime.
 *
 * Responsibilities:
 *   - Track per-node publish_topics from introspection event_bus data
 *   - Compute the global set of all known `onex.evt.*` topics
 *   - Emit 'topicsChanged' only when the global set actually changes
 *   - Provide snapshot() for diagnostics and health probes
 *
 * This service is intentionally decoupled from Kafka — it is a pure
 * data structure fed by NodeRegistryProjection (OMN-5025).
 */

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopicEntry {
  /** Canonical ONEX topic name */
  topic: string;
  /** Direction: 'publish' or 'subscribe' */
  direction?: string;
  /** Optional schema reference */
  schema_ref?: string;
}

export interface NodeTopicUpdate {
  node_id: string;
  publish_topics: TopicEntry[];
  subscribe_topics?: TopicEntry[];
}

export interface TopicRegistrySnapshot {
  /** All unique onex.evt.* topics currently known */
  evt_topics: string[];
  /** Number of nodes contributing topic data */
  node_count: number;
  /** Per-node topic breakdown */
  nodes: Record<string, { publish_topics: string[]; subscribe_topics: string[] }>;
  /** Timestamp of last update */
  last_update_utc: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TopicRegistryService extends EventEmitter {
  /**
   * Per-node topic data. Key = node_id, value = set of publish topic strings.
   * Subscribe topics are tracked for diagnostics but not used for consumer subscriptions.
   */
  private nodePublishTopics = new Map<string, Set<string>>();
  private nodeSubscribeTopics = new Map<string, Set<string>>();

  /** Cached global set of all onex.evt.* publish topics */
  private cachedEvtTopics = new Set<string>();

  private lastUpdateUtc = '';

  /**
   * Update the topic data for a node. Called when an introspection event
   * with an event_bus block is received.
   *
   * Only `onex.evt.*` topics are tracked for consumer subscription purposes.
   * Non-evt topics (cmd, intent, snapshot, dlq) are ignored — consumers
   * subscribe to those via static bootstrap lists.
   *
   * Emits 'topicsChanged' if the global evt topic set changes.
   */
  updateNode(update: NodeTopicUpdate): void {
    const { node_id, publish_topics, subscribe_topics } = update;

    // Extract topic strings, filter to onex.evt.* only
    const pubSet = new Set(
      publish_topics.map((t) => t.topic).filter((t) => t.startsWith('onex.evt.'))
    );

    const subSet = new Set((subscribe_topics ?? []).map((t) => t.topic));

    this.nodePublishTopics.set(node_id, pubSet);
    this.nodeSubscribeTopics.set(node_id, subSet);
    this.lastUpdateUtc = new Date().toISOString();

    this.recomputeAndEmit();
  }

  /**
   * Remove a node from the registry. Called when a node deregisters or
   * its liveness expires.
   *
   * Emits 'topicsChanged' if the global evt topic set changes.
   */
  removeNode(nodeId: string): void {
    const hadPublish = this.nodePublishTopics.delete(nodeId);
    this.nodeSubscribeTopics.delete(nodeId);

    if (hadPublish) {
      this.lastUpdateUtc = new Date().toISOString();
      this.recomputeAndEmit();
    }
  }

  /**
   * Get all unique onex.evt.* topics currently known across all nodes.
   * This is the topic set that EventConsumer should subscribe to (merged
   * with BOOTSTRAP_TOPICS).
   */
  getAllEvtTopics(): string[] {
    return [...this.cachedEvtTopics].sort();
  }

  /**
   * Get the number of nodes that have reported event_bus data.
   */
  getNodeCount(): number {
    return this.nodePublishTopics.size;
  }

  /**
   * Get the number of nodes that are missing event_bus data (i.e., nodes
   * that have been seen via introspection but did not include event_bus).
   * This is tracked externally by the caller — the registry only knows
   * about nodes that DID report event_bus.
   */

  /**
   * Full diagnostic snapshot for health probes and debugging.
   */
  snapshot(): TopicRegistrySnapshot {
    const nodes: TopicRegistrySnapshot['nodes'] = {};

    for (const [nodeId, pubTopics] of this.nodePublishTopics) {
      const subTopics = this.nodeSubscribeTopics.get(nodeId) ?? new Set<string>();
      nodes[nodeId] = {
        publish_topics: [...pubTopics].sort(),
        subscribe_topics: [...subTopics].sort(),
      };
    }

    return {
      evt_topics: this.getAllEvtTopics(),
      node_count: this.nodePublishTopics.size,
      nodes,
      last_update_utc: this.lastUpdateUtc || new Date().toISOString(),
    };
  }

  /**
   * Clear all data. Primarily for testing.
   */
  clear(): void {
    this.nodePublishTopics.clear();
    this.nodeSubscribeTopics.clear();
    this.cachedEvtTopics.clear();
    this.lastUpdateUtc = '';
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private recomputeAndEmit(): void {
    const newSet = new Set<string>();
    for (const topics of this.nodePublishTopics.values()) {
      for (const t of topics) {
        newSet.add(t);
      }
    }

    // Only emit if the global set actually changed
    if (!setsEqual(this.cachedEvtTopics, newSet)) {
      const added = [...newSet].filter((t) => !this.cachedEvtTopics.has(t));
      const removed = [...this.cachedEvtTopics].filter((t) => !newSet.has(t));

      this.cachedEvtTopics = newSet;
      this.emit('topicsChanged', {
        topics: [...newSet].sort(),
        added,
        removed,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: TopicRegistryService | null = null;

/**
 * Get the singleton TopicRegistryService instance.
 * Creates the instance on first call.
 */
export function getTopicRegistryService(): TopicRegistryService {
  if (!_instance) {
    _instance = new TopicRegistryService();
  }
  return _instance;
}

/**
 * Reset the singleton (for testing only).
 */
export function resetTopicRegistryService(): void {
  if (_instance) {
    _instance.clear();
    _instance.removeAllListeners();
  }
  _instance = null;
}
