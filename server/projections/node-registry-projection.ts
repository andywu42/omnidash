/**
 * NodeRegistryProjection — Server-side projection for node registry state (OMN-2097)
 *
 * Materializes incremental node state from EventConsumer emissions into a
 * queryable snapshot. Uses MonotonicMergeTracker per node ID to enforce
 * event-time-wins ordering and reject stale updates.
 *
 * Maintained state:
 * - nodes: Map<string, NodeState>         — current state per node
 * - recentStateChanges: ProjectionEvent[] — bounded buffer (100 max)
 * - stats: { totalNodes, activeNodes, byState } — incremental counters
 * - cursor: number                        — max(ingestSeq) applied
 *
 * Listens to event types:
 * - 'node-introspection'  → upsert node from introspection data
 * - 'node-heartbeat'      → update node health metrics
 * - 'node-state-change'   → update node state, track in recentStateChanges
 * - 'node-registry-seed'  → bulk seed from EventConsumer.getRegisteredNodes()
 */

import type { ProjectionView } from '../projection-service';
import type {
  ProjectionEvent,
  ProjectionResponse,
  ProjectionEventsResponse,
  NodeType,
  RegistrationState,
  NodeState,
  NodeRegistryStats,
  NodeRegistryPayload,
  NodeCapabilities,
  NodeMetadata,
  IntrospectionReason,
} from '@shared/projection-types';
import { MonotonicMergeTracker, MISSING_TIMESTAMP_SENTINEL_MS } from '../monotonic-merge';
import type { TopicRegistryService } from '../services/topic-registry-service';

// Re-export shared types for consumers that import from this module
export type {
  NodeType,
  RegistrationState,
  NodeState,
  NodeRegistryStats,
  NodeRegistryPayload,
  NodeCapabilities,
  NodeMetadata,
  IntrospectionReason,
} from '@shared/projection-types';

// ============================================================================
// Constants
// ============================================================================

const VIEW_ID = 'node-registry';
const MAX_RECENT_STATE_CHANGES = 100;
const MAX_APPLIED_EVENTS = 500;
/** Trim appliedEvents when it exceeds MAX by this many, amortizing the O(n) slice cost. */
const APPLIED_EVENTS_TRIM_MARGIN = 100;

/**
 * Convert an event timestamp to an ISO display string. Uses `||` (not `??`)
 * intentionally: eventTimeMs of 0 is the MISSING_TIMESTAMP_SENTINEL_MS sentinel
 * meaning "no real timestamp". For display purposes we fall back to the current
 * wall-clock time rather than showing epoch-0 (1970-01-01) in the UI.
 */
function displayTimestamp(eventTimeMs: number): string {
  return new Date(eventTimeMs || Date.now()).toISOString();
}

// ============================================================================
// Normalization helpers for cloud-sourced introspection payloads (OMN-4098)
// ============================================================================

/**
 * Convert a node_version value to a semver string.
 * Python ModelSemVer serializes as { major, minor, patch }; plain strings are
 * passed through unchanged.
 */
function toVersionString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v != null && typeof v === 'object') {
    const sv = v as { major?: number; minor?: number; patch?: number };
    if (sv.major !== undefined) {
      return `${sv.major}.${sv.minor ?? 0}.${sv.patch ?? 0}`;
    }
  }
  return '1.0.0';
}

/**
 * Normalize a node_type value to the uppercase NodeType union.
 * Python EnumNodeKind serializes as lowercase ("effect", "compute", etc.).
 */
function normalizeNodeType(value: unknown): NodeType {
  if (typeof value !== 'string') return 'COMPUTE';
  const upper = value.toUpperCase() as NodeType;
  const valid: NodeType[] = ['EFFECT', 'COMPUTE', 'REDUCER', 'ORCHESTRATOR'];
  return valid.includes(upper) ? upper : 'COMPUTE';
}

/** Event types this view handles */
const HANDLED_EVENT_TYPES = new Set([
  'node-introspection',
  'node-heartbeat',
  'node-state-change',
  'node-registry-seed',
  // Canonical active-node event (onex.evt.platform.node-became-active.v1).
  // Payload: { node_id, capabilities } (NodeBecameActivePayloadSchema).
  'node-became-active',
]);

// ============================================================================
// Extraction helpers for rich introspection fields
// ============================================================================

/**
 * Extract structured capabilities from an event payload.
 * Handles multiple shapes:
 * - `{ capabilities: { declared: [...], discovered: [...], contract: [...] } }` (structured)
 * - `{ capabilities: { key: value, ... } }` (canonical Record from infra)
 * - `{ capabilities: [...] }` (legacy flat array → treated as declared)
 * - `{ declared_capabilities: [...] }` (alternative field name)
 */
function extractCapabilities(
  payload: Record<string, unknown>,
  existing: NodeCapabilities | undefined
): NodeCapabilities | undefined {
  const raw = payload.capabilities ?? payload.declared_capabilities;
  if (raw == null && existing == null) return undefined;

  // Already structured { declared, discovered, contract }
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    // Check if it looks like NodeCapabilities (has declared/discovered/contract keys)
    if (obj.declared || obj.discovered || obj.contract) {
      return {
        declared: Array.isArray(obj.declared) ? (obj.declared as string[]) : existing?.declared,
        discovered: Array.isArray(obj.discovered)
          ? (obj.discovered as string[])
          : existing?.discovered,
        contract: Array.isArray(obj.contract) ? (obj.contract as string[]) : existing?.contract,
      };
    }
    // Canonical Record<string, unknown> from infra — extract keys as declared capabilities
    const keys = Object.keys(obj);
    if (keys.length > 0) {
      return {
        declared: keys,
        discovered: existing?.discovered,
        contract: existing?.contract,
      };
    }
  }

  // Flat string array → treat as declared
  if (Array.isArray(raw)) {
    return {
      declared: raw as string[],
      discovered: existing?.discovered,
      contract: existing?.contract,
    };
  }

  return existing;
}

/**
 * Extract node metadata from an event payload.
 */
function extractMetadata(
  payload: Record<string, unknown>,
  existing: NodeMetadata | undefined
): NodeMetadata | undefined {
  const raw = payload.metadata as Record<string, unknown> | undefined;
  if (raw == null && existing == null) return undefined;

  if (raw != null && typeof raw === 'object') {
    return {
      environment: (raw.environment as string) ?? existing?.environment,
      region: (raw.region as string) ?? existing?.region,
      cluster: (raw.cluster as string) ?? existing?.cluster,
      description: (raw.description as string) ?? existing?.description,
      priority: (raw.priority as number) ?? existing?.priority,
    };
  }

  return existing;
}

// ============================================================================
// NodeRegistryProjection
// ============================================================================

export class NodeRegistryProjection implements ProjectionView<NodeRegistryPayload> {
  readonly viewId = VIEW_ID;

  private nodes = new Map<string, NodeState>();
  private recentStateChanges: ProjectionEvent[] = [];
  private appliedEvents: ProjectionEvent[] = [];
  private cursor = 0;
  private mergeTracker = new MonotonicMergeTracker();

  /**
   * Optional TopicRegistryService — when set, handleIntrospection() feeds
   * event_bus.publish_topics into the registry for dynamic topic discovery.
   * Set via setTopicRegistry() after construction (OMN-5025).
   */
  private topicRegistry: TopicRegistryService | null = null;

  /**
   * Wire the TopicRegistryService so that introspection events feed topic
   * discovery. This is the SOLE canonical site where introspection data
   * flows into the topic registry (OMN-5025).
   */
  setTopicRegistry(registry: TopicRegistryService): void {
    this.topicRegistry = registry;
  }

  // Incremental stats — maintained on every node mutation to avoid O(n) recalc
  private stats: NodeRegistryStats = {
    totalNodes: 0,
    activeNodes: 0,
    byState: {},
  };

  // --------------------------------------------------------------------------
  // ProjectionView interface
  // --------------------------------------------------------------------------

  /** Returns a defensive shallow copy of the current node registry state, stats, and recent state changes. */
  getSnapshot(options?: { limit?: number }): ProjectionResponse<NodeRegistryPayload> {
    const allNodes = Array.from(this.nodes.values()).map((n) => ({
      ...n,
      endpoints: n.endpoints ? { ...n.endpoints } : undefined,
    }));
    const nodes = options?.limit ? allNodes.slice(0, options.limit) : allNodes;

    return {
      viewId: this.viewId,
      cursor: this.cursor,
      snapshotTimeMs: Date.now(),
      payload: {
        nodes,
        // Shallow-copy events and payloads to isolate from internal state.
        // Sufficient because current payloads are flat key-value pairs.
        recentStateChanges: this.recentStateChanges.map((e) => ({
          ...e,
          payload: { ...e.payload },
        })),
        stats: { ...this.stats, byState: { ...this.stats.byState } },
      },
    };
  }

  /** Returns applied events with ingestSeq > cursor (exclusive). Uses binary search for O(log n) lookup. */
  getEventsSince(cursor: number, limit?: number): ProjectionEventsResponse {
    // Detect whether the buffer was trimmed past the client's cursor.
    // If the oldest available event has a seq more than 1 ahead of the
    // requested cursor, earlier events were discarded and the client
    // should fall back to a full snapshot refresh.
    const oldestAvailableSeq = this.appliedEvents.length > 0 ? this.appliedEvents[0].ingestSeq : 0;
    const truncated = cursor > 0 && oldestAvailableSeq > cursor + 1;

    // Binary search for the first event with ingestSeq > cursor.
    // appliedEvents are appended in ingestSeq order, so binary search is valid.
    let lo = 0;
    let hi = this.appliedEvents.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.appliedEvents[mid].ingestSeq <= cursor) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // Default to full buffer — safe because appliedEvents is bounded:
    // applyEvent() trims synchronously when length exceeds 600, slicing to 500.
    // Since JS is single-threaded, no external caller can observe > 600 entries.
    const effectiveLimit = limit ?? MAX_APPLIED_EVENTS + APPLIED_EVENTS_TRIM_MARGIN;
    const sliced = this.appliedEvents.slice(lo, lo + effectiveLimit);
    return {
      viewId: this.viewId,
      cursor:
        sliced.length > 0 ? sliced[sliced.length - 1].ingestSeq : Math.max(cursor, this.cursor),
      snapshotTimeMs: Date.now(),
      // Shallow-copy events consistent with getSnapshot() to isolate from internal state
      events: sliced.map((e) => ({ ...e, payload: { ...e.payload } })),
      ...(truncated && { truncated }),
    };
  }

  /** Routes an event to the appropriate handler and advances the cursor on success. */
  applyEvent(event: ProjectionEvent): boolean {
    if (!HANDLED_EVENT_TYPES.has(event.type)) {
      return false;
    }

    let applied = false;

    switch (event.type) {
      case 'node-introspection':
        applied = this.handleIntrospection(event);
        break;
      case 'node-heartbeat':
        applied = this.handleHeartbeat(event);
        break;
      case 'node-state-change':
        applied = this.handleStateChange(event);
        break;
      case 'node-registry-seed':
        applied = this.handleSeed(event);
        break;
      case 'node-became-active':
        applied = this.handleNodeBecameActive(event);
        break;
    }

    if (applied) {
      this.cursor = Math.max(this.cursor, event.ingestSeq);
      // Defensive clone: routeToViews() passes the same event reference to all
      // views, so a sibling view mutating payload would corrupt our buffer.
      this.appliedEvents.push({ ...event, payload: { ...event.payload } });
      if (this.appliedEvents.length > MAX_APPLIED_EVENTS + APPLIED_EVENTS_TRIM_MARGIN) {
        this.appliedEvents = this.appliedEvents.slice(-MAX_APPLIED_EVENTS);
      }
    }

    return applied;
  }

  /** Clears all nodes, stats, applied events, recent state changes, and resets the merge tracker and cursor. */
  reset(): void {
    this.nodes.clear();
    this.recentStateChanges = [];
    this.appliedEvents = [];
    this.cursor = 0;
    this.mergeTracker.reset();
    this.stats = { totalNodes: 0, activeNodes: 0, byState: {} };
  }

  // --------------------------------------------------------------------------
  // Event handlers
  // --------------------------------------------------------------------------

  private handleIntrospection(event: ProjectionEvent): boolean {
    const payload = event.payload;
    const nodeId = (payload.nodeId ?? payload.node_id) as string | undefined;
    if (!nodeId) return false;

    if (
      !this.mergeTracker.checkAndUpdate(nodeId, {
        eventTime: event.eventTimeMs,
        seq: event.ingestSeq,
      })
    ) {
      return false;
    }

    const existing = this.nodes.get(nodeId);
    const oldState = existing?.state;

    // Extract structured capabilities from the introspection payload.
    // Infrastructure may send capabilities as a Record<string, unknown> (canonical)
    // or as a flat string[] (legacy). Normalize both into NodeCapabilities.
    const capabilities = extractCapabilities(payload, existing?.capabilities);

    // Extract metadata if present in the payload
    const metadata = extractMetadata(payload, existing?.metadata);

    // Extract introspection reason
    const reason = (payload.reason ?? existing?.reason) as IntrospectionReason | undefined;

    // Nodes emitting introspection events are by definition running. When the
    // runtime emits node-introspection with current_state: null (no explicit FSM
    // state set), treat the node as 'active' rather than 'pending_registration'.
    // 'pending_registration' is only appropriate when the node is in the initial
    // handshake phase — a null current_state from an introspection event means the
    // runtime hasn't wired the FSM, not that the node is waiting to be registered.
    const resolvedState =
      payload.currentState ??
      (payload.current_state !== null ? payload.current_state : undefined) ??
      existing?.state ??
      'active';

    const node: NodeState = {
      nodeId,
      nodeType: normalizeNodeType(payload.nodeType ?? payload.node_type ?? existing?.nodeType),
      state: resolvedState as RegistrationState,
      version: toVersionString(payload.nodeVersion ?? payload.node_version ?? existing?.version),
      uptimeSeconds: existing?.uptimeSeconds ?? 0,
      lastSeen: displayTimestamp(event.eventTimeMs),
      memoryUsageMb: existing?.memoryUsageMb,
      cpuUsagePercent: existing?.cpuUsagePercent,
      endpoints: (payload.endpoints ?? existing?.endpoints) as Record<string, string> | undefined,
      capabilities,
      metadata,
      reason,
    };

    this.nodes.set(nodeId, node);
    this.updateStats(oldState, node.state, !existing);

    // Feed topic registry from introspection event_bus data (OMN-5025).
    // This is the SOLE canonical site for introspection → registry flow.
    if (this.topicRegistry) {
      const eventBus = payload.event_bus as
        | {
            publish_topics?: Array<{ topic: string; direction?: string; schema_ref?: string }>;
            subscribe_topics?: Array<{ topic: string; direction?: string }>;
          }
        | undefined;

      // Always call updateNode — nodes without event_bus get an empty topic set,
      // which correctly tracks them as "present but missing event_bus data".
      this.topicRegistry.updateNode({
        node_id: nodeId,
        publish_topics: eventBus?.publish_topics ?? [],
        subscribe_topics: eventBus?.subscribe_topics,
      });
    }

    return true;
  }

  private handleHeartbeat(event: ProjectionEvent): boolean {
    const payload = event.payload;
    const nodeId = (payload.nodeId ?? payload.node_id) as string | undefined;
    if (!nodeId) return false;

    if (
      !this.mergeTracker.checkAndUpdate(nodeId, {
        eventTime: event.eventTimeMs,
        seq: event.ingestSeq,
      })
    ) {
      return false;
    }

    const existing = this.nodes.get(nodeId);
    if (!existing) {
      // Heartbeat for unknown node — create a minimal entry
      const node: NodeState = {
        nodeId,
        nodeType: 'COMPUTE',
        state: 'active',
        version: '1.0.0',
        uptimeSeconds: (payload.uptimeSeconds ?? payload.uptime_seconds ?? 0) as number,
        lastSeen: displayTimestamp(event.eventTimeMs),
        memoryUsageMb: (payload.memoryUsageMb ?? payload.memory_usage_mb) as number | undefined,
        cpuUsagePercent: (payload.cpuUsagePercent ?? payload.cpu_usage_percent) as
          | number
          | undefined,
      };
      this.nodes.set(nodeId, node);
      this.updateStats(undefined, node.state, true);
      return true;
    }

    this.nodes.set(nodeId, {
      ...existing,
      uptimeSeconds: (payload.uptimeSeconds ??
        payload.uptime_seconds ??
        existing.uptimeSeconds) as number,
      lastSeen: displayTimestamp(event.eventTimeMs),
      memoryUsageMb: (payload.memoryUsageMb ??
        payload.memory_usage_mb ??
        existing.memoryUsageMb) as number | undefined,
      cpuUsagePercent: (payload.cpuUsagePercent ??
        payload.cpu_usage_percent ??
        existing.cpuUsagePercent) as number | undefined,
    });

    return true;
  }

  private handleStateChange(event: ProjectionEvent): boolean {
    const payload = event.payload;
    const nodeId = (payload.nodeId ?? payload.node_id) as string | undefined;
    if (!nodeId) return false;

    const newState = (payload.newState ?? payload.new_state) as RegistrationState | undefined;
    if (!newState) return false;

    if (
      !this.mergeTracker.checkAndUpdate(nodeId, {
        eventTime: event.eventTimeMs,
        seq: event.ingestSeq,
      })
    ) {
      return false;
    }

    const existing = this.nodes.get(nodeId);
    const oldState = existing?.state;

    if (existing) {
      this.nodes.set(nodeId, {
        ...existing,
        state: newState,
        lastSeen: displayTimestamp(event.eventTimeMs),
      });
    } else {
      // State change for unknown node — create a minimal entry so the
      // transition is actually tracked (mirrors handleHeartbeat behavior)
      this.nodes.set(nodeId, {
        nodeId,
        nodeType: 'COMPUTE',
        state: newState,
        version: '1.0.0',
        uptimeSeconds: 0,
        lastSeen: displayTimestamp(event.eventTimeMs),
      });
    }

    this.updateStats(oldState, newState, !existing);

    // Track in recentStateChanges (clone to isolate from appliedEvents references)
    this.recentStateChanges.unshift({ ...event, payload: { ...event.payload } });
    if (this.recentStateChanges.length > MAX_RECENT_STATE_CHANGES) {
      this.recentStateChanges.splice(MAX_RECENT_STATE_CHANGES);
    }

    return true;
  }

  /**
   * Bulk seed handler — used to populate initial state from
   * EventConsumer.getRegisteredNodes() on startup.
   */
  private handleSeed(event: ProjectionEvent): boolean {
    const payload = event.payload;
    const rawNodes = payload.nodes as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(rawNodes) || rawNodes.length === 0) return false;

    // Deduplicate by nodeId — if upstream data contains duplicate nodeIds in a
    // single seed batch, keep the last occurrence for deterministic last-write-wins
    // behavior (Map insertion order is stable per spec).
    const deduped = new Map<string, Record<string, unknown>>();
    for (const raw of rawNodes) {
      const nid = (raw.nodeId ?? raw.node_id) as string;
      if (nid) deduped.set(nid, raw);
    }

    let seeded = 0;

    for (const raw of deduped.values()) {
      const nodeId = (raw.nodeId ?? raw.node_id) as string;

      // Seed events have no real timestamp — use sentinel epoch 0 so that
      // any node already tracked with a real-timestamped event is not overwritten.
      if (
        !this.mergeTracker.checkAndUpdate(nodeId, {
          eventTime: MISSING_TIMESTAMP_SENTINEL_MS,
          seq: event.ingestSeq,
        })
      ) {
        continue; // Node already has fresher data — skip seed entry
      }

      const node: NodeState = {
        nodeId,
        nodeType: normalizeNodeType(raw.nodeType ?? raw.node_type),
        state: (raw.state ?? 'pending_registration') as RegistrationState,
        version: toVersionString(raw.version),
        uptimeSeconds: (raw.uptimeSeconds ?? raw.uptime_seconds ?? 0) as number,
        lastSeen: raw.lastSeen
          ? raw.lastSeen instanceof Date
            ? (raw.lastSeen as Date).toISOString()
            : String(raw.lastSeen)
          : new Date().toISOString(),
        memoryUsageMb: (raw.memoryUsageMb ?? raw.memory_usage_mb) as number | undefined,
        cpuUsagePercent: (raw.cpuUsagePercent ?? raw.cpu_usage_percent) as number | undefined,
        endpoints: raw.endpoints as Record<string, string> | undefined,
        capabilities: extractCapabilities(raw, undefined),
        metadata: extractMetadata(raw, undefined),
        reason: raw.reason as IntrospectionReason | undefined,
      };

      this.nodes.set(nodeId, node);
      seeded++;
    }

    if (seeded === 0) return false;

    this.rebuildStats();
    return true;
  }

  /**
   * Handle canonical node-became-active events (onex.evt.platform.node-became-active.v1).
   *
   * The payload carries { node_id, capabilities } (NodeBecameActivePayloadSchema).
   * Capabilities arrive as Record<string, unknown> (canonical infra format);
   * extractCapabilities() normalises them into NodeCapabilities.declared keys.
   *
   * Uses the same MonotonicMergeTracker gate as other handlers to reject stale
   * or out-of-order events.
   */
  private handleNodeBecameActive(event: ProjectionEvent): boolean {
    const payload = event.payload;
    const nodeId = (payload.node_id ?? payload.nodeId) as string | undefined;
    if (!nodeId) return false;

    if (
      !this.mergeTracker.checkAndUpdate(nodeId, {
        eventTime: event.eventTimeMs,
        seq: event.ingestSeq,
      })
    ) {
      return false;
    }

    const existing = this.nodes.get(nodeId);
    const oldState = existing?.state;
    const newState: RegistrationState = 'active';

    const capabilities = extractCapabilities(payload, existing?.capabilities);
    const metadata = extractMetadata(payload, existing?.metadata);

    const node: NodeState = {
      nodeId,
      nodeType: normalizeNodeType(payload.nodeType ?? payload.node_type ?? existing?.nodeType),
      state: newState,
      version: (existing?.version ?? '1.0.0') as string,
      uptimeSeconds: existing?.uptimeSeconds ?? 0,
      lastSeen: displayTimestamp(event.eventTimeMs),
      memoryUsageMb: existing?.memoryUsageMb,
      cpuUsagePercent: existing?.cpuUsagePercent,
      endpoints: existing?.endpoints,
      capabilities,
      metadata,
      reason: existing?.reason,
    };

    this.nodes.set(nodeId, node);
    this.updateStats(oldState, newState, !existing);

    return true;
  }

  // --------------------------------------------------------------------------
  // Stats maintenance
  // --------------------------------------------------------------------------

  /**
   * Incrementally update stats when a single node's state changes.
   * Avoids O(n) full recalculation on every event.
   */
  private updateStats(
    oldState: RegistrationState | undefined,
    newState: RegistrationState,
    isNew: boolean
  ): void {
    if (isNew) {
      this.stats.totalNodes++;
    }

    // Decrement old state counter (guarded against negative from out-of-order events)
    if (oldState) {
      this.stats.byState[oldState] = Math.max(0, (this.stats.byState[oldState] ?? 0) - 1);
      if (this.stats.byState[oldState] <= 0) {
        delete this.stats.byState[oldState];
      }
      if (oldState === 'active') {
        this.stats.activeNodes = Math.max(0, this.stats.activeNodes - 1);
      }
    }

    // Increment new state counter
    this.stats.byState[newState] = (this.stats.byState[newState] ?? 0) + 1;
    if (newState === 'active') {
      this.stats.activeNodes++;
    }
  }

  /** Full stats rebuild — used after bulk seed operations. */
  private rebuildStats(): void {
    const byState: Record<string, number> = {};
    let activeNodes = 0;

    for (const node of this.nodes.values()) {
      byState[node.state] = (byState[node.state] ?? 0) + 1;
      if (node.state === 'active') {
        activeNodes++;
      }
    }

    this.stats = {
      totalNodes: this.nodes.size,
      activeNodes,
      byState,
    };
  }
}
