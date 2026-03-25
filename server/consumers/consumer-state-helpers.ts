// no-migration: OMN-6405 type-only change (added | null to optional heartbeat fields)
/**
 * Consumer state helpers — pure functions for state management [OMN-5191]
 *
 * Extracted from event-consumer.ts to reduce orchestrator size.
 * These functions operate on the in-memory state maps/arrays
 * owned by EventConsumer.
 */

import type {
  RegisteredNode,
  NodeType,
  RegistrationState,
  OnexNodeState,
  CanonicalOnexNode,
  AgentMetrics,
  AgentAction,
  RoutingDecision,
  TransformationEvent,
  InternalIntentClassifiedEvent,
  NodeIntrospectionEvent,
  NodeHeartbeatEvent,
  NodeStateChangeEvent,
} from './domain/types';
import type { EventBusEvent } from '../event-bus-data-source';
import { intentLogger } from './domain/consumer-utils';

// ============================================================================
// Canonical Node Helpers
// ============================================================================

export function mapCanonicalState(state: OnexNodeState): RegistrationState {
  const stateMap: Record<string, RegistrationState> = {
    ACTIVE: 'active',
    PENDING: 'pending_registration',
    OFFLINE: 'liveness_expired',
  };
  return stateMap[state] || 'pending_registration';
}

export function syncCanonicalToRegistered(
  registeredNodes: Map<string, RegisteredNode>,
  canonicalNode: CanonicalOnexNode
): void {
  const existing = registeredNodes.get(canonicalNode.node_id);
  const rawType = canonicalNode.node_type ?? existing?.nodeType;
  const validTypes: NodeType[] = ['EFFECT', 'COMPUTE', 'REDUCER', 'ORCHESTRATOR'];
  let nodeType: NodeType = 'COMPUTE';
  if (typeof rawType === 'string') {
    const upper = rawType.toUpperCase() as NodeType;
    if (validTypes.includes(upper)) nodeType = upper;
  }
  registeredNodes.set(canonicalNode.node_id, {
    nodeId: canonicalNode.node_id,
    nodeType,
    state: mapCanonicalState(canonicalNode.state),
    version: canonicalNode.node_version ?? existing?.version ?? '1.0.0',
    uptimeSeconds: existing?.uptimeSeconds ?? 0,
    lastSeen: new Date(canonicalNode.last_event_at || Date.now()),
    memoryUsageMb: existing?.memoryUsageMb,
    cpuUsagePercent: existing?.cpuUsagePercent,
    endpoints: existing?.endpoints ?? {},
  });
}

export function propagateHeartbeatMetrics(
  registeredNodes: Map<string, RegisteredNode>,
  payload: {
    node_id: string;
    uptime_seconds?: number | null;
    memory_usage_mb?: number | null;
    cpu_usage_percent?: number | null;
    active_operations_count?: number | null;
  }
): void {
  const regNode = registeredNodes.get(payload.node_id);
  if (!regNode) return;
  registeredNodes.set(payload.node_id, {
    ...regNode,
    uptimeSeconds: payload.uptime_seconds ?? regNode.uptimeSeconds,
    memoryUsageMb: payload.memory_usage_mb ?? regNode.memoryUsageMb,
    cpuUsagePercent: payload.cpu_usage_percent ?? regNode.cpuUsagePercent,
  });
}

export function cleanupOldMetrics(
  agentMetrics: Map<
    string,
    {
      count: number;
      totalRoutingTime: number;
      totalConfidence: number;
      successCount: number;
      errorCount: number;
      lastSeen: Date;
    }
  >
): void {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (const [agent, metrics] of Array.from(agentMetrics.entries())) {
    if (metrics.lastSeen < cutoff) agentMetrics.delete(agent);
  }
}

// ============================================================================
// Computed Getters
// ============================================================================

export function computeAgentMetrics(
  agentMetrics: Map<
    string,
    {
      count: number;
      totalRoutingTime: number;
      totalConfidence: number;
      successCount: number;
      errorCount: number;
      lastSeen: Date;
    }
  >
): AgentMetrics[] {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return Array.from(agentMetrics.entries())
    .filter(([_, data]) => data.lastSeen >= twentyFourHoursAgo)
    .map(([agent, data]) => {
      const totalOutcomes = data.successCount + data.errorCount;
      const successRate =
        totalOutcomes > 0 ? data.successCount / totalOutcomes : data.totalConfidence / data.count;
      return {
        agent,
        totalRequests: data.count,
        successRate,
        avgRoutingTime: data.totalRoutingTime / data.count,
        avgConfidence: data.totalConfidence / data.count,
        lastSeen: data.lastSeen,
      };
    });
}

export function computeNodeRegistryStats(nodes: RegisteredNode[]): {
  totalNodes: number;
  activeNodes: number;
  pendingNodes: number;
  failedNodes: number;
  typeDistribution: Record<NodeType, number>;
} {
  return {
    totalNodes: nodes.length,
    activeNodes: nodes.filter((n) => n.state === 'active').length,
    pendingNodes: nodes.filter((n) =>
      ['pending_registration', 'awaiting_ack', 'ack_received', 'accepted'].includes(n.state)
    ).length,
    failedNodes: nodes.filter((n) =>
      ['rejected', 'liveness_expired', 'ack_timed_out'].includes(n.state)
    ).length,
    typeDistribution: nodes.reduce(
      (acc, n) => {
        acc[n.nodeType] = (acc[n.nodeType] || 0) + 1;
        return acc;
      },
      {} as Record<NodeType, number>
    ),
  };
}

export function computeIntentStats(
  recentIntents: InternalIntentClassifiedEvent[],
  intentDistribution: Map<string, { count: number; timestamps: number[] }>
): {
  totalIntents: number;
  recentIntentsCount: number;
  typeDistribution: Record<string, number>;
  topIntentTypes: [string, number][];
} {
  const d: Record<string, number> = {};
  for (const [t, data] of intentDistribution.entries()) d[t] = data.count;
  return {
    totalIntents: Object.values(d).reduce((s, c) => s + c, 0),
    recentIntentsCount: recentIntents.length,
    typeDistribution: d,
    topIntentTypes: Object.entries(d)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10),
  };
}

export function computeCanonicalNodeStats(nodes: CanonicalOnexNode[]): {
  totalNodes: number;
  activeNodes: number;
  pendingNodes: number;
  offlineNodes: number;
} {
  return {
    totalNodes: nodes.length,
    activeNodes: nodes.filter((x) => x.state === 'ACTIVE').length,
    pendingNodes: nodes.filter((x) => x.state === 'PENDING').length,
    offlineNodes: nodes.filter((x) => x.state === 'OFFLINE').length,
  };
}

// ============================================================================
// Data Pruning
// ============================================================================

export interface PrunableState {
  recentActions: AgentAction[];
  routingDecisions: RoutingDecision[];
  recentTransformations: TransformationEvent[];
  performanceMetrics: Array<{ createdAt: Date }>;
  nodeIntrospectionEvents: NodeIntrospectionEvent[];
  nodeHeartbeatEvents: NodeHeartbeatEvent[];
  nodeStateChangeEvents: NodeStateChangeEvent[];
  registeredNodes: Map<string, RegisteredNode>;
  liveEventBusEvents: EventBusEvent[];
  preloadedEventBusEvents: EventBusEvent[];
  recentIntents: InternalIntentClassifiedEvent[];
  intentDistributionWithTimestamps: Map<string, { count: number; timestamps: number[] }>;
  agentMetrics: Map<
    string,
    {
      count: number;
      totalRoutingTime: number;
      totalConfidence: number;
      successCount: number;
      errorCount: number;
      lastSeen: Date;
    }
  >;
}

export function pruneOldData(state: PrunableState, retentionMs: number): void {
  const cutoff = Date.now() - retentionMs;
  const before = {
    a: state.recentActions.length,
    d: state.routingDecisions.length,
    t: state.recentTransformations.length,
    p: state.performanceMetrics.length,
    ni: state.nodeIntrospectionEvents.length,
    nh: state.nodeHeartbeatEvents.length,
    ns: state.nodeStateChangeEvents.length,
    n: state.registeredNodes.size,
    le: state.liveEventBusEvents.length,
    pe: state.preloadedEventBusEvents.length,
    i: state.recentIntents.length,
  };

  state.recentActions = state.recentActions.filter((a) => new Date(a.createdAt).getTime() > cutoff);
  state.routingDecisions = state.routingDecisions.filter(
    (d) => new Date(d.createdAt).getTime() > cutoff
  );
  state.recentTransformations = state.recentTransformations.filter(
    (t) => new Date(t.createdAt).getTime() > cutoff
  );
  state.performanceMetrics = state.performanceMetrics.filter(
    (m) => new Date(m.createdAt).getTime() > cutoff
  );
  state.nodeIntrospectionEvents = state.nodeIntrospectionEvents.filter(
    (e) => new Date(e.createdAt).getTime() > cutoff
  );
  state.nodeHeartbeatEvents = state.nodeHeartbeatEvents.filter(
    (e) => new Date(e.createdAt).getTime() > cutoff
  );
  state.nodeStateChangeEvents = state.nodeStateChangeEvents.filter(
    (e) => new Date(e.createdAt).getTime() > cutoff
  );
  for (const [nodeId, node] of Array.from(state.registeredNodes.entries())) {
    if (new Date(node.lastSeen).getTime() < cutoff) state.registeredNodes.delete(nodeId);
  }
  state.liveEventBusEvents = state.liveEventBusEvents.filter(
    (e) => new Date(e.timestamp).getTime() > cutoff
  );
  state.preloadedEventBusEvents = state.preloadedEventBusEvents.filter(
    (e) => new Date(e.timestamp).getTime() > cutoff
  );
  state.recentIntents = state.recentIntents.filter((i) => new Date(i.createdAt).getTime() > cutoff);

  let distributionEntriesPruned = 0;
  for (const [intentType, data] of Array.from(state.intentDistributionWithTimestamps.entries())) {
    const validTimestamps = data.timestamps.filter((ts: number) => ts > cutoff);
    if (validTimestamps.length === 0) {
      state.intentDistributionWithTimestamps.delete(intentType);
      distributionEntriesPruned++;
    } else if (validTimestamps.length < data.timestamps.length) {
      state.intentDistributionWithTimestamps.set(intentType, {
        count: data.count - (data.timestamps.length - validTimestamps.length),
        timestamps: validTimestamps,
      });
    }
  }

  const totalRemoved =
    before.a -
    state.recentActions.length +
    (before.d - state.routingDecisions.length) +
    (before.t - state.recentTransformations.length) +
    (before.p - state.performanceMetrics.length) +
    (before.ni - state.nodeIntrospectionEvents.length) +
    (before.nh - state.nodeHeartbeatEvents.length) +
    (before.ns - state.nodeStateChangeEvents.length) +
    (before.n - state.registeredNodes.size) +
    (before.le - state.liveEventBusEvents.length) +
    (before.pe - state.preloadedEventBusEvents.length) +
    (before.i - state.recentIntents.length) +
    distributionEntriesPruned;
  if (totalRemoved > 0) intentLogger.info(`Pruned ${totalRemoved} old entries`);
}
