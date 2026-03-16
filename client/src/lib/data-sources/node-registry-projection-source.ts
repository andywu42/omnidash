/**
 * Node Registry Projection Data Source (OMN-2097 / OMN-2320)
 *
 * Transforms the server-side NodeRegistryPayload into the DashboardData
 * shape expected by the NodeRegistry page and DashboardRenderer.
 *
 * This replaces the raw WebSocket event handling that was previously
 * done inline in NodeRegistry.tsx.
 */

// no-migration: OMN-5132 display-only field addition, no projection schema change
import type { DashboardData } from '@/lib/dashboard-schema';
import { deriveNodeName } from '@/lib/node-display-utils';
import type {
  NodeType,
  RegistrationState,
  NodeState,
  NodeRegistryStats,
  NodeRegistryPayload,
  NodeCapabilities,
  NodeMetadata,
  IntrospectionReason,
} from '@shared/projection-types';

// Re-export for consumers that import from this module
export type {
  NodeType,
  RegistrationState,
  NodeState,
  NodeRegistryStats,
  NodeRegistryPayload,
  NodeCapabilities,
  NodeMetadata,
  IntrospectionReason,
};

// ============================================================================
// Transform helpers
// ============================================================================

function stateToStatus(state: RegistrationState): 'healthy' | 'warning' | 'error' {
  switch (state) {
    case 'active':
      return 'healthy';
    case 'pending_registration':
    case 'accepted':
    case 'awaiting_ack':
    case 'ack_received':
      return 'warning';
    case 'rejected':
    case 'ack_timed_out':
    case 'liveness_expired':
      return 'error';
    default:
      return 'warning';
  }
}

function stateToSeverity(state: RegistrationState): 'info' | 'success' | 'warning' | 'error' {
  switch (state) {
    case 'active':
      return 'success';
    case 'pending_registration':
    case 'accepted':
    case 'awaiting_ack':
    case 'ack_received':
      return 'info';
    case 'rejected':
    case 'ack_timed_out':
    case 'liveness_expired':
      return 'error';
    default:
      return 'warning';
  }
}

/**
 * Flatten structured capabilities into a single string array for display.
 */
function flattenCapabilities(caps: NodeCapabilities | undefined): string[] {
  if (!caps) return [];
  const result: string[] = [];
  if (caps.declared) result.push(...caps.declared);
  if (caps.discovered) {
    for (const c of caps.discovered) {
      if (!result.includes(c)) result.push(c);
    }
  }
  if (caps.contract) {
    for (const c of caps.contract) {
      if (!result.includes(c)) result.push(c);
    }
  }
  return result;
}

// ============================================================================
// Main transform
// ============================================================================

/**
 * Transform a NodeRegistryPayload into the DashboardData shape expected
 * by the DashboardRenderer and existing widget configurations.
 */
export function transformNodeRegistryPayload(payload: NodeRegistryPayload): DashboardData {
  const { nodes, recentStateChanges, stats } = payload;

  const pendingNodes =
    (stats.byState['pending_registration'] ?? 0) +
    (stats.byState['accepted'] ?? 0) +
    (stats.byState['awaiting_ack'] ?? 0) +
    (stats.byState['ack_received'] ?? 0);

  const failedNodes =
    (stats.byState['rejected'] ?? 0) +
    (stats.byState['liveness_expired'] ?? 0) +
    (stats.byState['ack_timed_out'] ?? 0);

  // Node statuses for status grid
  const nodeStatuses = nodes.map((n) => ({
    node_id: n.nodeId,
    status: stateToStatus(n.state),
  }));

  // Node type distribution for pie chart
  const typeCounts: Record<string, number> = {};
  for (const node of nodes) {
    typeCounts[node.nodeType] = (typeCounts[node.nodeType] ?? 0) + 1;
  }
  const nodeTypeDistribution = Object.entries(typeCounts).map(([name, value]) => ({
    name,
    value,
  }));

  // Transform nodes to client-expected snake_case format with extended fields
  const registeredNodes = nodes.map((n) => {
    const capsList = flattenCapabilities(n.capabilities);
    const description =
      n.metadata?.description ?? (capsList.length > 0 ? capsList.join(', ') : null);
    return {
      node_id: n.nodeId,
      node_name: deriveNodeName(n.nodeId),
      node_description: description,
      node_type: n.nodeType,
      state: n.state,
      version: n.version,
      uptime_seconds: n.uptimeSeconds,
      last_seen: n.lastSeen,
      memory_usage_mb: n.memoryUsageMb,
      cpu_usage_percent: n.cpuUsagePercent,
      endpoints: n.endpoints,
      capabilities: capsList,
      structured_capabilities: n.capabilities,
      metadata: n.metadata,
      reason: n.reason,
    };
  });

  // Transform recent state changes into RegistrationEvent format
  const registrationEvents = recentStateChanges.map((change) => {
    const nodeId = (change.payload.nodeId ?? change.payload.node_id ?? 'unknown') as string;
    const previousState = change.payload.previousState ?? change.payload.previous_state ?? '';
    const newState = change.payload.newState ?? change.payload.new_state ?? '';

    return {
      type: 'state_change' as const,
      node_id: nodeId,
      message: `${nodeId}: ${previousState} -> ${newState}`,
      severity: stateToSeverity(newState as RegistrationState),
      // || intentional: eventTimeMs of 0 is the monotonic-merge sentinel meaning "no real
      // timestamp". For display we fall back to now rather than showing epoch-0 (1970-01-01).
      timestamp: new Date(change.eventTimeMs || Date.now()).toISOString(),
    };
  });

  return {
    totalNodes: stats.totalNodes,
    activeNodes: stats.activeNodes,
    pendingNodes,
    failedNodes,
    nodeStatuses,
    nodeTypeDistribution,
    registeredNodes,
    registrationEvents,
  };
}
