/**
 * Registry Discovery Types
 *
 * TypeScript types for the ONEX Node Registry Discovery API (v1.2 spec).
 * These types define the BFF layer for contract-driven dashboards.
 */

// ============================================================================
// Core Enums
// ============================================================================

/**
 * ONEX node type classification (4-node architecture + SERVICE for long-running services)
 */
export type NodeType = 'EFFECT' | 'COMPUTE' | 'REDUCER' | 'ORCHESTRATOR' | 'SERVICE';

/**
 * Node registration state machine states
 */
export type RegistrationState =
  | 'PENDING_REGISTRATION'
  | 'ACCEPTED'
  | 'AWAITING_ACK'
  | 'ACK_RECEIVED'
  | 'ACTIVE'
  | 'ACK_TIMED_OUT'
  | 'LIVENESS_EXPIRED'
  | 'REJECTED';

/**
 * Consul health check status
 */
export type HealthStatus = 'passing' | 'warning' | 'critical' | 'unknown';

/**
 * Aggregated service health status
 */
export type ServiceHealth = 'healthy' | 'degraded' | 'unhealthy';

// ============================================================================
// Node Views
// ============================================================================

/**
 * Registry node view - core node metadata from PostgreSQL
 */
export interface RegistryNodeView {
  node_id: string;
  name: string;
  service_name: string;
  namespace: string | null;
  display_name: string | null;
  node_type: NodeType;
  version: string;
  state: RegistrationState;
  capabilities: string[];
  registered_at: string;
  last_heartbeat_at: string | null;
}

/**
 * Registry instance view - live Consul service instance
 */
export interface RegistryInstanceView {
  node_id: string;
  service_name: string;
  service_id: string;
  instance_id: string;
  address: string;
  port: number;
  health_status: HealthStatus;
  health_output: string | null;
  last_check_at: string | null;
  tags: string[];
  meta: Record<string, string>;
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Warning/error entry in API responses
 */
export interface RegistryWarning {
  error: string;
  message: string;
  timestamp: string;
}

/**
 * Pagination metadata
 */
export interface RegistryPagination {
  total: number;
  filtered: number;
  limit: number;
  offset: number;
}

/**
 * Summary statistics for the discovery response
 */
export interface RegistrySummary {
  total_nodes: number;
  active_nodes: number;
  pending_nodes: number;
  failed_nodes: number;
  unhealthy_instances: number;
  by_type: Record<NodeType, number>;
  by_health: Record<HealthStatus, number>;
}

/**
 * Full discovery response - GET /api/registry/discovery
 */
export interface RegistryDiscoveryResponse {
  timestamp: string;
  warnings: RegistryWarning[];
  summary: RegistrySummary;
  nodes: RegistryNodeView[];
  live_instances: RegistryInstanceView[];
  pagination: RegistryPagination;
}

/**
 * Node list response - GET /api/registry/nodes
 */
export interface RegistryNodesResponse {
  timestamp: string;
  nodes: RegistryNodeView[];
  pagination: RegistryPagination;
}

/**
 * Node detail response - GET /api/registry/nodes/:id
 */
export interface RegistryNodeDetailResponse {
  timestamp: string;
  node: RegistryNodeView;
  instances: RegistryInstanceView[];
}

/**
 * Instances response - GET /api/registry/instances
 */
export interface RegistryInstancesResponse {
  timestamp: string;
  instances: RegistryInstanceView[];
  pagination: RegistryPagination;
}

/**
 * Widget capability mapping - GET /api/registry/widgets/mapping
 */
export interface RegistryWidgetMapping {
  capability: string;
  widget_type: string;
  description: string;
  default_config: Record<string, unknown>;
}

export interface RegistryWidgetMappingResponse {
  timestamp: string;
  mappings: RegistryWidgetMapping[];
  version: string;
}

/**
 * Health check response - GET /api/registry/health
 */
export interface RegistryHealthResponse {
  timestamp: string;
  status: ServiceHealth;
  services: {
    postgres: ServiceHealth;
  };
  latency_ms: {
    postgres: number | null;
  };
}

// ============================================================================
// Query Parameters
// ============================================================================

/**
 * Query parameters for node filtering
 */
export interface RegistryNodeQueryParams {
  state?: RegistrationState;
  type?: NodeType;
  capability?: string;
  namespace?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Query parameters for instance filtering
 */
export interface RegistryInstanceQueryParams {
  node_id?: string;
  service_name?: string;
  health_status?: HealthStatus;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Error Response
// ============================================================================

/**
 * Standard error response format
 */
export interface RegistryErrorResponse {
  error: string;
  message: string;
  timestamp: string;
  details?: Record<string, unknown>;
}
