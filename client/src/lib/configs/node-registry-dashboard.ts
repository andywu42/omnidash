/**
 * Node Registry Dashboard Configuration
 *
 * Real-time visualization of 2-way node registration events from omnibase_infra.
 * Displays node introspection, heartbeat, and registration state transitions.
 *
 * Data flows: Kafka → EventConsumer → ProjectionService → REST → Dashboard
 */

import type { DashboardConfig } from '@/lib/dashboard-schema';
import { DashboardTheme } from '@/lib/dashboard-schema';

// Event Schemas (from omnibase_infra)
export type NodeType = 'EFFECT' | 'COMPUTE' | 'REDUCER' | 'ORCHESTRATOR' | 'SERVICE';

export type RegistrationState =
  | 'pending_registration'
  | 'accepted'
  | 'awaiting_ack'
  | 'ack_received'
  | 'active'
  | 'rejected'
  | 'ack_timed_out'
  | 'liveness_expired';

export type IntrospectionReason = 'STARTUP' | 'HEARTBEAT' | 'REQUESTED';

export interface NodeIntrospection {
  node_id: string;
  node_type: NodeType;
  node_version: string;
  endpoints: Record<string, string>;
  current_state: string;
  reason: IntrospectionReason;
  correlation_id: string;
  timestamp: string;
}

export interface NodeHeartbeat {
  node_id: string;
  uptime_seconds: number;
  active_operations_count: number;
  memory_usage_mb: number;
  cpu_usage_percent: number;
  timestamp: string;
}

export interface RegisteredNode {
  node_id: string;
  node_type: NodeType;
  state: RegistrationState;
  version: string;
  uptime_seconds: number;
  last_seen: string;
  memory_usage_mb?: number;
  cpu_usage_percent?: number;
}

export interface RegistrationEvent {
  type: 'registration' | 'state_change' | 'heartbeat' | 'introspection';
  node_id: string;
  message: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  timestamp: string;
}

export const nodeRegistryDashboardConfig: DashboardConfig = {
  dashboard_id: 'node-registry',
  name: 'Node Registry',
  description: 'Real-time node registration and health monitoring',
  theme: DashboardTheme.SYSTEM,
  layout: {
    columns: 12,
    row_height: 100,
    gap: 16,
  },
  data_source: 'websocket:node-registry',
  refresh_interval_seconds: 5,
  widgets: [
    // Row 0: Metric Cards (4 across)
    {
      widget_id: 'metric-total-nodes',
      title: 'Total Nodes Registered',
      description: 'Total number of nodes registered in the system',
      row: 0,
      col: 0,
      width: 3,
      height: 1,
      config: {
        config_kind: 'metric_card',
        metric_key: 'totalNodes',
        label: 'Total Nodes',
        value_format: 'number',
        precision: 0,
        icon: 'server',
      },
    },
    {
      widget_id: 'metric-active-nodes',
      title: 'Active Nodes',
      description: 'Nodes currently in active state',
      row: 0,
      col: 3,
      width: 3,
      height: 1,
      config: {
        config_kind: 'metric_card',
        metric_key: 'activeNodes',
        label: 'Active Nodes',
        value_format: 'number',
        precision: 0,
        icon: 'check-circle',
      },
    },
    {
      widget_id: 'metric-pending-nodes',
      title: 'Pending Registrations',
      description: 'Nodes awaiting registration completion',
      row: 0,
      col: 6,
      width: 3,
      height: 1,
      config: {
        config_kind: 'metric_card',
        metric_key: 'pendingNodes',
        label: 'Pending',
        value_format: 'number',
        precision: 0,
        icon: 'clock',
        thresholds: [
          { value: 5, severity: 'warning', label: 'Many pending' },
          { value: 10, severity: 'error', label: 'Too many pending' },
        ],
      },
    },
    {
      widget_id: 'metric-failed-nodes',
      title: 'Failed Registrations',
      description: 'Nodes with rejected or expired registrations',
      row: 0,
      col: 9,
      width: 3,
      height: 1,
      config: {
        config_kind: 'metric_card',
        metric_key: 'failedNodes',
        label: 'Failed',
        value_format: 'number',
        precision: 0,
        icon: 'alert-circle',
        thresholds: [
          { value: 1, severity: 'warning', label: 'Has failures' },
          { value: 3, severity: 'error', label: 'Multiple failures' },
        ],
      },
    },

    // Row 1-3: NodeDetailPanel (rendered directly by NodeRegistry.tsx, col 0-6)
    //          Pie Chart (right, col 7-11)
    {
      widget_id: 'chart-node-types',
      title: 'Node Distribution by Type',
      description: 'Breakdown of nodes by their functional type',
      row: 1,
      col: 8,
      width: 4,
      height: 3,
      config: {
        config_kind: 'chart',
        chart_type: 'pie',
        series: [{ name: 'Node Types', data_key: 'nodeTypeDistribution' }],
        show_legend: true,
      },
    },

    // Row 4-7: Table (left) and Event Feed (right)
    {
      widget_id: 'table-node-details',
      title: 'Node Details',
      description: 'Detailed view of all registered nodes',
      row: 1,
      col: 0,
      width: 8,
      height: 4,
      config: {
        config_kind: 'table',
        rows_key: 'registeredNodes',
        columns: [
          { key: 'node_name', header: 'Name', sortable: true, width: 180 },
          { key: 'node_description', header: 'Description', width: 200 },
          { key: 'node_type', header: 'Type', sortable: true, width: 100 },
          { key: 'state', header: 'State', format: 'badge', sortable: true, width: 120 },
          { key: 'version', header: 'Version', width: 80 },
          {
            key: 'uptime_seconds',
            header: 'Uptime',
            format: 'duration',
            sortable: true,
            align: 'right',
            width: 100,
          },
          { key: 'last_seen', header: 'Last Seen', format: 'datetime', sortable: true, width: 140 },
        ],
        page_size: 6,
        show_pagination: true,
        default_sort_key: 'last_seen',
        default_sort_direction: 'desc',
        striped: true,
        hover_highlight: true,
      },
    },
    {
      widget_id: 'event-feed-registrations',
      title: 'Registration Events',
      description: 'Live stream of registration events and state changes',
      row: 4,
      col: 8,
      width: 4,
      height: 4,
      config: {
        config_kind: 'event_feed',
        events_key: 'registrationEvents',
        max_items: 25,
        show_timestamp: true,
        show_severity: true,
        show_source: false,
        group_by_type: false,
        auto_scroll: true,
      },
    },
  ],
};
