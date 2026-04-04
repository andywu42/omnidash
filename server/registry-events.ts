/**
 * Registry Event Emitter
 *
 * Manages registry discovery events for real-time WebSocket updates.
 * In production, this would connect to the actual ONEX registry service.
 * In development mode, it generates mock events for testing.
 *
 * Part of OMN-1278: Contract-Driven Dashboard - Registry Discovery (Phase 4)
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { log } from './vite';

/**
 * Debug logging that only outputs in development mode or when DEBUG is set.
 * Uses the standard log() utility for consistent formatting.
 */
const DEBUG_ENABLED = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debugLog(message: string): void {
  if (DEBUG_ENABLED) {
    log(message, 'registry-events');
  }
}

/**
 * Registry event types as defined in the WebSocket Event Spec v1.2
 */
export type RegistryEventType =
  | 'NODE_REGISTERED'
  | 'NODE_STATE_CHANGED'
  | 'NODE_HEARTBEAT'
  | 'NODE_DEREGISTERED'
  | 'INSTANCE_HEALTH_CHANGED'
  | 'INSTANCE_ADDED'
  | 'INSTANCE_REMOVED';

/**
 * Registry event payload structure
 */
export interface RegistryEvent {
  type: RegistryEventType;
  timestamp: string;
  correlation_id: string;
  payload: RegistryEventPayload;
}

/**
 * Union type for all possible event payloads
 */
export type RegistryEventPayload =
  | NodeRegisteredPayload
  | NodeStateChangedPayload
  | NodeHeartbeatPayload
  | NodeDeregisteredPayload
  | InstanceHealthChangedPayload
  | InstanceAddedPayload
  | InstanceRemovedPayload;

// Payload types for each event
export interface NodeRegisteredPayload {
  node_id: string;
  node_type: 'EFFECT' | 'COMPUTE' | 'REDUCER' | 'ORCHESTRATOR';
  name: string;
  version: string;
  capabilities: string[];
}

export interface NodeStateChangedPayload {
  node_id: string;
  previous_state: string;
  new_state: string;
  reason?: string;
}

export interface NodeHeartbeatPayload {
  node_id: string;
  timestamp: string;
  health_status: 'healthy' | 'degraded' | 'unhealthy';
}

export interface NodeDeregisteredPayload {
  node_id: string;
  reason?: string;
}

export interface InstanceHealthChangedPayload {
  instance_id: string;
  node_id: string;
  previous_health: string;
  new_health: string;
  checks: Array<{
    name: string;
    status: 'passing' | 'warning' | 'critical';
  }>;
}

export interface InstanceAddedPayload {
  instance_id: string;
  node_id: string;
  address: string;
  port: number;
}

export interface InstanceRemovedPayload {
  instance_id: string;
  node_id: string;
  reason?: string;
}

// Mock data for development testing
const MOCK_NODES = [
  {
    node_id: 'node_effect_http_client',
    node_type: 'EFFECT' as const,
    name: 'NodeHTTPClientEffect',
    version: '1.2.0',
    capabilities: ['http-requests', 'retry-logic', 'circuit-breaker'],
  },
  {
    node_id: 'node_compute_json_transform',
    node_type: 'COMPUTE' as const,
    name: 'NodeJSONTransformCompute',
    version: '2.0.1',
    capabilities: ['json-parsing', 'schema-validation', 'data-mapping'],
  },
  {
    node_id: 'node_reducer_aggregate',
    node_type: 'REDUCER' as const,
    name: 'NodeAggregateReducer',
    version: '1.0.0',
    capabilities: ['sum', 'count', 'average', 'group-by'],
  },
  {
    node_id: 'node_orchestrator_workflow',
    node_type: 'ORCHESTRATOR' as const,
    name: 'NodeWorkflowOrchestrator',
    version: '3.1.0',
    capabilities: ['sequential', 'parallel', 'conditional', 'loop'],
  },
  {
    node_id: 'node_effect_database',
    node_type: 'EFFECT' as const,
    name: 'NodeDatabaseEffect',
    version: '1.5.2',
    capabilities: ['postgresql', 'transactions', 'connection-pool'],
  },
  {
    node_id: 'node_compute_validation',
    node_type: 'COMPUTE' as const,
    name: 'NodeValidationCompute',
    version: '1.1.0',
    capabilities: ['schema-validation', 'type-checking', 'constraint-validation'],
  },
];

const NODE_STATES = ['registered', 'active', 'inactive', 'pending', 'deprecated', 'failed'];
const HEALTH_STATUSES = ['healthy', 'degraded', 'unhealthy'] as const;
const HEALTH_CHECK_STATUSES = ['passing', 'warning', 'critical'] as const;

/**
 * Registry Event Emitter class
 */
class RegistryEventEmitterClass extends EventEmitter {
  private mockIntervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor() {
    super();
    // Set max listeners to avoid memory leak warnings during development
    this.setMaxListeners(20);
  }

  /**
   * Emit a registry event
   */
  emitRegistryEvent(event: RegistryEvent): void {
    this.emit('registry', event);

    // Also emit to specific topic based on event type
    if (event.type.startsWith('NODE_')) {
      this.emit('registry-nodes', event);
    } else if (event.type.startsWith('INSTANCE_')) {
      this.emit('registry-instances', event);
    }
  }

  /**
   * Start mock event generation for development/testing
   * @param interval - Interval in milliseconds between events (default: 5000)
   */
  startMockEvents(interval = 5000): void {
    if (process.env.DEMO_MODE !== 'true') {
      debugLog('Mock events skipped — DEMO_MODE is not enabled');
      return;
    }

    if (this.isRunning) {
      debugLog('Mock events already running');
      return;
    }

    debugLog(`Starting mock event generation (interval: ${interval}ms)`);
    this.isRunning = true;

    this.mockIntervalId = setInterval(() => {
      const event = this.generateRandomEvent();
      this.emitRegistryEvent(event);
    }, interval);
  }

  /**
   * Stop mock event generation
   */
  stopMockEvents(): void {
    if (this.mockIntervalId) {
      clearInterval(this.mockIntervalId);
      this.mockIntervalId = null;
    }
    this.isRunning = false;
    debugLog('Mock event generation stopped');
  }

  /**
   * Check if mock events are running
   */
  isMockEventsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Generate a random registry event for testing
   */
  private generateRandomEvent(): RegistryEvent {
    const eventTypes: RegistryEventType[] = [
      'NODE_HEARTBEAT',
      'NODE_HEARTBEAT',
      'NODE_HEARTBEAT', // Weight heartbeats more heavily (most common in real systems)
      'NODE_STATE_CHANGED',
      'INSTANCE_HEALTH_CHANGED',
      'INSTANCE_HEALTH_CHANGED',
      'NODE_REGISTERED',
      'NODE_DEREGISTERED',
      'INSTANCE_ADDED',
      'INSTANCE_REMOVED',
    ];

    const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
    const node = MOCK_NODES[Math.floor(Math.random() * MOCK_NODES.length)];
    const timestamp = new Date().toISOString();
    const correlationId = crypto.randomUUID();

    let payload: RegistryEventPayload;

    switch (eventType) {
      case 'NODE_REGISTERED':
        payload = {
          node_id: node.node_id,
          node_type: node.node_type,
          name: node.name,
          version: node.version,
          capabilities: node.capabilities,
        };
        break;

      case 'NODE_STATE_CHANGED':
        const previousState = NODE_STATES[Math.floor(Math.random() * NODE_STATES.length)];
        let newState = NODE_STATES[Math.floor(Math.random() * NODE_STATES.length)];
        // Ensure state actually changes
        while (newState === previousState) {
          newState = NODE_STATES[Math.floor(Math.random() * NODE_STATES.length)];
        }
        payload = {
          node_id: node.node_id,
          previous_state: previousState,
          new_state: newState,
          reason: Math.random() > 0.5 ? 'Scheduled maintenance' : undefined,
        };
        break;

      case 'NODE_HEARTBEAT':
        payload = {
          node_id: node.node_id,
          timestamp,
          health_status: HEALTH_STATUSES[Math.floor(Math.random() * HEALTH_STATUSES.length)],
        };
        break;

      case 'NODE_DEREGISTERED':
        payload = {
          node_id: node.node_id,
          reason: Math.random() > 0.5 ? 'Node shutdown' : 'Health check failed',
        };
        break;

      case 'INSTANCE_HEALTH_CHANGED':
        const previousHealth =
          HEALTH_CHECK_STATUSES[Math.floor(Math.random() * HEALTH_CHECK_STATUSES.length)];
        let newHealth =
          HEALTH_CHECK_STATUSES[Math.floor(Math.random() * HEALTH_CHECK_STATUSES.length)];
        // Ensure health actually changes
        while (newHealth === previousHealth) {
          newHealth =
            HEALTH_CHECK_STATUSES[Math.floor(Math.random() * HEALTH_CHECK_STATUSES.length)];
        }
        payload = {
          instance_id: `${node.node_id}-instance-${Math.floor(Math.random() * 3) + 1}`,
          node_id: node.node_id,
          previous_health: previousHealth,
          new_health: newHealth,
          checks: [
            {
              name: 'memory',
              status:
                HEALTH_CHECK_STATUSES[Math.floor(Math.random() * HEALTH_CHECK_STATUSES.length)],
            },
            {
              name: 'cpu',
              status:
                HEALTH_CHECK_STATUSES[Math.floor(Math.random() * HEALTH_CHECK_STATUSES.length)],
            },
            {
              name: 'disk',
              status:
                HEALTH_CHECK_STATUSES[Math.floor(Math.random() * HEALTH_CHECK_STATUSES.length)],
            },
          ],
        };
        break;

      case 'INSTANCE_ADDED':
        payload = {
          instance_id: `${node.node_id}-instance-${Date.now()}`,
          node_id: node.node_id,
          address: `192.168.1.${Math.floor(Math.random() * 254) + 1}`,
          port: 8000 + Math.floor(Math.random() * 100),
        };
        break;

      case 'INSTANCE_REMOVED':
        payload = {
          instance_id: `${node.node_id}-instance-${Math.floor(Math.random() * 3) + 1}`,
          node_id: node.node_id,
          reason: Math.random() > 0.5 ? 'Scale down' : 'Instance unhealthy',
        };
        break;

      default:
        // Fallback to heartbeat
        payload = {
          node_id: node.node_id,
          timestamp,
          health_status: 'healthy',
        };
    }

    return {
      type: eventType,
      timestamp,
      correlation_id: correlationId,
      payload,
    };
  }
}

// Export singleton instance
export const registryEventEmitter = new RegistryEventEmitterClass();

// Export helper function for emitting events
export function emitRegistryEvent(event: RegistryEvent): void {
  registryEventEmitter.emitRegistryEvent(event);
}

// Export function to start mock events
export function startMockRegistryEvents(interval = 5000): void {
  registryEventEmitter.startMockEvents(interval);
}

// Export function to stop mock events
export function stopMockRegistryEvents(): void {
  registryEventEmitter.stopMockEvents();
}
