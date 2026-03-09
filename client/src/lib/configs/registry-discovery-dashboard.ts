/**
 * Registry Discovery Dashboard Configuration
 *
 * Contract-driven dashboard showing registered nodes and live service instances
 * from the service registry. Displays node metadata, health status, and
 * real-time instance information.
 *
 * Data source: /api/registry/discovery
 */

import type { DashboardConfig, DashboardData } from '@/lib/dashboard-schema';
import { DashboardTheme } from '@/lib/dashboard-schema';
import type { NodeType, RegistrationState, HealthStatus } from '@shared/registry-types';

// Re-export types for use in other components
export type { NodeType, RegistrationState as NodeState, HealthStatus };

export interface RegisteredNodeInfo {
  node_id: string; // From API response (RegistryNodeView.node_id)
  name: string;
  node_type: NodeType;
  state: RegistrationState;
  version: string;
  capabilities: string[];
  description?: string;
  registered_at?: string;
}

export interface LiveInstanceInfo {
  node_id: string;
  service_name: string;
  address: string;
  port: number;
  health_status: HealthStatus;
  last_check_at: string;
  tags?: string[];
}

export interface RegistryDiscoverySummary {
  total_nodes: number;
  active_nodes: number;
  pending_nodes: number;
  failed_nodes: number;
  by_type: { name: string; value: number }[];
  by_health: {
    passing: number;
    warning: number;
    critical: number;
    unknown: number;
  };
}

export interface RegistryDiscoveryData extends DashboardData {
  summary: RegistryDiscoverySummary;
  nodes: RegisteredNodeInfo[];
  live_instances: LiveInstanceInfo[];
  warnings?: string[];
}

export const registryDiscoveryDashboardConfig: DashboardConfig = {
  dashboard_id: 'registry-discovery',
  name: 'Registry Discovery',
  description: 'Contract-driven dashboard showing registered nodes and live service instances',
  theme: DashboardTheme.SYSTEM,
  layout: {
    columns: 12,
    row_height: 80,
    gap: 16,
    responsive: true,
  },
  data_source: 'api:/api/registry/discovery',
  refresh_interval_seconds: 30,
  widgets: [
    // Row 0: Summary metrics (4 cards) - using flattened keys from transformRegistryData
    // Visual hierarchy: Total (neutral), Active (green), Pending (amber), Failed (red when > 0)
    {
      widget_id: 'total-nodes',
      title: 'Total Nodes',
      description: 'Total registered nodes in the system',
      row: 0,
      col: 0,
      width: 3,
      height: 1,
      config: {
        config_kind: 'metric_card',
        metric_key: 'total_nodes',
        label: 'Total Nodes',
        value_format: 'number',
        precision: 0,
        icon: 'server',
        // No semantic_status - neutral/informational card
      },
    },
    {
      widget_id: 'active-nodes',
      title: 'Active Nodes',
      description: 'Currently active and running nodes',
      row: 0,
      col: 3,
      width: 3,
      height: 1,
      config: {
        config_kind: 'metric_card',
        metric_key: 'active_nodes',
        label: 'Active',
        value_format: 'number',
        precision: 0,
        icon: 'check-circle',
        // Always green - active nodes represent success/healthy state
        semantic_status: 'healthy',
      },
    },
    {
      widget_id: 'pending-nodes',
      title: 'Pending Nodes',
      description: 'Nodes awaiting activation or acknowledgment',
      row: 0,
      col: 6,
      width: 3,
      height: 1,
      config: {
        config_kind: 'metric_card',
        metric_key: 'pending_nodes',
        label: 'Pending',
        value_format: 'number',
        precision: 0,
        icon: 'clock',
        // Always amber - pending nodes need attention
        semantic_status: 'warning',
      },
    },
    {
      widget_id: 'failed-nodes',
      title: 'Failed Nodes',
      description: 'Nodes in error or expired state',
      row: 0,
      col: 9,
      width: 3,
      height: 1,
      config: {
        config_kind: 'metric_card',
        metric_key: 'failed_nodes',
        label: 'Failed',
        value_format: 'number',
        precision: 0,
        icon: 'alert-circle',
        // Threshold-based: muted when 0, red/error when >= 1
        thresholds: [{ value: 1, severity: 'error', label: 'Has failures' }],
      },
    },

    // Row 1: Two pie charts side-by-side (Node Types, Instance Health)
    {
      widget_id: 'node-type-distribution',
      title: 'Node Types',
      description:
        'Distribution of registered nodes by type (Effect, Compute, Reducer, Orchestrator)',
      row: 1,
      col: 0,
      width: 6,
      height: 3,
      config: {
        config_kind: 'chart',
        chart_type: 'pie',
        series: [{ name: 'Node Types', data_key: 'nodeTypeDistribution' }],
        show_legend: true,
      },
    },
    {
      widget_id: 'instance-health-chart',
      title: 'Instance Health',
      description: 'Health status distribution of running instances',
      row: 1,
      col: 6,
      width: 6,
      height: 3,
      config: {
        config_kind: 'chart',
        chart_type: 'pie',
        series: [{ name: 'Instance Health', data_key: 'instanceHealthDistribution' }],
        show_legend: true,
      },
    },
    // NOTE: Tables removed - using custom interactive table in RegistryDiscovery.tsx instead
    // NOTE: Events widget rendered separately via EventFeedSidebar component in RegistryDiscovery.tsx
    // This preserves rich registry-specific event payload handling (node_id, state changes, health changes)
    // that the generic EventFeedWidget doesn't support
  ],
};

/**
 * Transform API response to dashboard-friendly format.
 * Flattens summary fields for widget consumption.
 */
export function transformRegistryData(data: RegistryDiscoveryData): DashboardData {
  // Convert by_health object to array format for pie chart
  const instanceHealthDistribution = Object.entries(data.summary.by_health).map(
    ([name, value]) => ({ name, value })
  );

  return {
    ...data,
    // Flatten summary fields for MetricCard widgets (they use data[key] directly, not nested paths)
    total_nodes: data.summary.total_nodes,
    active_nodes: data.summary.active_nodes,
    pending_nodes: data.summary.pending_nodes,
    failed_nodes: data.summary.failed_nodes,
    // Flatten by_type for chart widget
    nodeTypeDistribution: data.summary.by_type,
    // Flatten by_health for instance health pie chart
    instanceHealthDistribution,
  };
}

/**
 * Generate mock data for development and testing
 */
export function generateMockRegistryDiscoveryData(): RegistryDiscoveryData {
  const now = new Date();

  const nodes: RegisteredNodeInfo[] = [
    {
      node_id: 'node-001-auth-effect',
      name: 'NodeAuthEffect',
      node_type: 'EFFECT',
      state: 'ACTIVE',
      version: '1.4.2',
      capabilities: ['authenticate', 'authorize', 'token-refresh'],
    },
    {
      node_id: 'node-002-transform-compute',
      name: 'NodeTransformCompute',
      node_type: 'COMPUTE',
      state: 'ACTIVE',
      version: '1.4.2',
      capabilities: ['json-transform', 'xml-parse', 'csv-convert'],
    },
    {
      node_id: 'node-003-aggregate-reducer',
      name: 'NodeAggregateReducer',
      node_type: 'REDUCER',
      state: 'ACTIVE',
      version: '1.4.1',
      capabilities: ['sum', 'avg', 'count', 'group-by'],
    },
    {
      node_id: 'node-004-workflow-orchestrator',
      name: 'NodeWorkflowOrchestrator',
      node_type: 'ORCHESTRATOR',
      state: 'ACTIVE',
      version: '1.4.2',
      capabilities: ['parallel-execute', 'conditional-branch', 'retry'],
    },
    {
      node_id: 'node-005-database-effect',
      name: 'NodeDatabaseEffect',
      node_type: 'EFFECT',
      state: 'PENDING_REGISTRATION',
      version: '1.4.2',
      capabilities: ['query', 'insert', 'update', 'delete'],
    },
    {
      node_id: 'node-006-ml-compute',
      name: 'NodeMLCompute',
      node_type: 'COMPUTE',
      state: 'AWAITING_ACK',
      version: '1.4.2',
      capabilities: ['inference', 'embedding', 'classification'],
    },
    {
      node_id: 'node-007-cache-reducer',
      name: 'NodeCacheReducer',
      node_type: 'REDUCER',
      state: 'LIVENESS_EXPIRED',
      version: '1.3.9',
      capabilities: ['lru-cache', 'distributed-cache'],
    },
    {
      node_id: 'node-008-queue-effect',
      name: 'NodeQueueEffect',
      node_type: 'EFFECT',
      state: 'ACTIVE',
      version: '1.4.2',
      capabilities: ['enqueue', 'dequeue', 'peek'],
    },
  ];

  const live_instances: LiveInstanceInfo[] = [
    {
      node_id: 'node-001-auth-effect',
      service_name: 'node-auth-effect',
      address: '192.168.86.201',
      port: 8001,
      health_status: 'passing',
      last_check_at: new Date(now.getTime() - 5000).toISOString(),
    },
    {
      node_id: 'node-002-transform-compute',
      service_name: 'node-transform-compute',
      address: '192.168.86.201',
      port: 8002,
      health_status: 'passing',
      last_check_at: new Date(now.getTime() - 8000).toISOString(),
    },
    {
      node_id: 'node-003-aggregate-reducer',
      service_name: 'node-aggregate-reducer',
      address: '192.168.86.200',
      port: 8003,
      health_status: 'warning',
      last_check_at: new Date(now.getTime() - 30000).toISOString(),
    },
    {
      node_id: 'node-004-workflow-orchestrator',
      service_name: 'node-workflow-orchestrator',
      address: '192.168.86.200',
      port: 8004,
      health_status: 'passing',
      last_check_at: new Date(now.getTime() - 3000).toISOString(),
    },
    {
      node_id: 'node-008-queue-effect',
      service_name: 'node-queue-effect',
      address: '192.168.86.100',
      port: 8005,
      health_status: 'passing',
      last_check_at: new Date(now.getTime() - 12000).toISOString(),
    },
  ];

  // Note: States are UPPERCASE to match RegistrationState enum
  const activeNodes = nodes.filter((n) => n.state === 'ACTIVE').length;
  const pendingNodes = nodes.filter((n) =>
    ['PENDING_REGISTRATION', 'AWAITING_ACK', 'ACCEPTED', 'ACK_RECEIVED'].includes(n.state)
  ).length;
  const failedNodes = nodes.filter((n) =>
    ['REJECTED', 'LIVENESS_EXPIRED', 'ACK_TIMED_OUT'].includes(n.state)
  ).length;

  const typeCounts = nodes.reduce(
    (acc, n) => {
      acc[n.node_type] = (acc[n.node_type] || 0) + 1;
      return acc;
    },
    {} as Record<NodeType, number>
  );

  const by_type = Object.entries(typeCounts).map(([name, value]) => ({
    name,
    value,
  }));

  const healthCounts = live_instances.reduce(
    (acc, i) => {
      acc[i.health_status] = (acc[i.health_status] || 0) + 1;
      return acc;
    },
    { passing: 0, warning: 0, critical: 0, unknown: 0 } as Record<HealthStatus, number>
  );

  return {
    summary: {
      total_nodes: nodes.length,
      active_nodes: activeNodes,
      pending_nodes: pendingNodes,
      failed_nodes: failedNodes,
      by_type,
      by_health: healthCounts,
    },
    nodes,
    live_instances,
  };
}
