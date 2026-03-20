/**
 * Platform domain handler [OMN-5191]
 *
 * Handles cross-cutting platform topics:
 * - Node introspection (legacy + canonical envelope)
 * - Node heartbeat (legacy + canonical envelope)
 * - Node registration and state changes
 * - Contract lifecycle (registered/deregistered)
 * - FSM state transitions, runtime ticks, registration snapshots
 * - Node became-active events
 * - Status dashboard topics (GitHub PR, Git hook, Linear snapshot)
 */

import crypto from 'node:crypto';
import type { KafkaMessage } from 'kafkajs';
import {
  SUFFIX_NODE_INTROSPECTION,
  SUFFIX_NODE_REGISTRATION,
  SUFFIX_REQUEST_INTROSPECTION,
  SUFFIX_NODE_HEARTBEAT,
  SUFFIX_CONTRACT_REGISTERED,
  SUFFIX_CONTRACT_DEREGISTERED,
  SUFFIX_NODE_REGISTRATION_INITIATED,
  SUFFIX_NODE_REGISTRATION_ACCEPTED,
  SUFFIX_NODE_REGISTRATION_REJECTED,
  SUFFIX_NODE_REGISTRATION_ACKED,
  SUFFIX_NODE_REGISTRATION_RESULT,
  SUFFIX_NODE_REGISTRATION_ACK_RECEIVED,
  SUFFIX_NODE_REGISTRATION_ACK_TIMED_OUT,
  SUFFIX_NODE_BECAME_ACTIVE,
  SUFFIX_NODE_LIVENESS_EXPIRED,
  SUFFIX_REGISTRY_REQUEST_INTROSPECTION,
  SUFFIX_FSM_STATE_TRANSITIONS,
  SUFFIX_RUNTIME_TICK,
  SUFFIX_REGISTRATION_SNAPSHOTS,
  SUFFIX_AGENT_STATUS,
  SUFFIX_GITHUB_PR_STATUS,
  SUFFIX_GIT_HOOK,
  SUFFIX_LINEAR_SNAPSHOT,
} from '@shared/topics';
import {
  NodeBecameActivePayloadSchema,
  NodeHeartbeatPayloadSchema,
  NodeIntrospectionPayloadSchema,
} from '@shared/schemas';
import {
  BridgeNodeIntrospectionSchema,
  BridgeNodeHeartbeatSchema,
  BridgeNodeStateChangeSchema,
  BridgeNodeBecameActiveSchema,
  validateBridgeEmit,
} from '@shared/schemas/bridge-events';
import { isGitHubPRStatusEvent, isGitHookEvent, isLinearSnapshotEvent } from '@shared/status-types';
import { statusProjection } from '../../projections/status-projection';
import { emitStatusInvalidate } from '../../status-events';
import type {
  DomainHandler,
  ConsumerContext,
  NodeIntrospectionEvent,
  NodeHeartbeatEvent,
  NodeStateChangeEvent,
  RegisteredNode,
  CanonicalOnexNode,
  OnexNodeState,
  NodeType,
  RawNodeIntrospectionEvent,
  RawNodeHeartbeatEvent,
  RawNodeStateChangeEvent,
} from './types';
import {
  intentLogger,
  parseNodeType,
  parseRegistrationState,
  parseIntrospectionReason,
} from './consumer-utils';

const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
const DEBUG_CANONICAL_EVENTS = process.env.DEBUG_CANONICAL_EVENTS === 'true' || isTestEnv;

/** All topic suffixes this handler responds to */
const HANDLED_TOPICS = new Set([
  SUFFIX_NODE_INTROSPECTION,
  SUFFIX_NODE_REGISTRATION,
  SUFFIX_REQUEST_INTROSPECTION,
  SUFFIX_NODE_HEARTBEAT,
  SUFFIX_CONTRACT_REGISTERED,
  SUFFIX_CONTRACT_DEREGISTERED,
  SUFFIX_NODE_REGISTRATION_INITIATED,
  SUFFIX_NODE_REGISTRATION_ACCEPTED,
  SUFFIX_NODE_REGISTRATION_REJECTED,
  SUFFIX_NODE_REGISTRATION_ACKED,
  SUFFIX_NODE_REGISTRATION_RESULT,
  SUFFIX_NODE_REGISTRATION_ACK_RECEIVED,
  SUFFIX_NODE_REGISTRATION_ACK_TIMED_OUT,
  SUFFIX_NODE_BECAME_ACTIVE,
  SUFFIX_NODE_LIVENESS_EXPIRED,
  SUFFIX_REGISTRY_REQUEST_INTROSPECTION,
  SUFFIX_FSM_STATE_TRANSITIONS,
  SUFFIX_RUNTIME_TICK,
  SUFFIX_REGISTRATION_SNAPSHOTS,
  SUFFIX_AGENT_STATUS,
  SUFFIX_GITHUB_PR_STATUS,
  SUFFIX_GIT_HOOK,
  SUFFIX_LINEAR_SNAPSHOT,
]);

// ============================================================================
// Legacy (flat) Node Event Handlers
// ============================================================================

function handleNodeIntrospection(event: RawNodeIntrospectionEvent, ctx: ConsumerContext): void {
  try {
    const nodeId = event.node_id || event.nodeId;
    if (!nodeId) {
      console.warn('[EventConsumer] Node introspection missing node_id, skipping');
      return;
    }

    const introspectionEvent: NodeIntrospectionEvent = {
      id: event.id || crypto.randomUUID(),
      nodeId,
      nodeType: parseNodeType(event.node_type || event.nodeType, 'COMPUTE'),
      nodeVersion: event.node_version || event.nodeVersion || '1.0.0',
      endpoints: event.endpoints || {},
      currentState: parseRegistrationState(
        event.current_state || event.currentState,
        'pending_registration'
      ),
      reason: parseIntrospectionReason(event.reason, 'STARTUP'),
      correlationId: event.correlation_id || event.correlationId || '',
      createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
    };

    ctx.nodeIntrospectionEvents.unshift(introspectionEvent);
    if (ctx.nodeIntrospectionEvents.length > ctx.maxNodeEvents) {
      ctx.nodeIntrospectionEvents = ctx.nodeIntrospectionEvents.slice(0, ctx.maxNodeEvents);
    }

    const existingNode = ctx.registeredNodes.get(nodeId);
    const node: RegisteredNode = {
      nodeId,
      nodeType: introspectionEvent.nodeType,
      state: introspectionEvent.currentState,
      version: introspectionEvent.nodeVersion,
      uptimeSeconds: existingNode?.uptimeSeconds || 0,
      lastSeen: introspectionEvent.createdAt,
      memoryUsageMb: existingNode?.memoryUsageMb,
      cpuUsagePercent: existingNode?.cpuUsagePercent,
      endpoints: introspectionEvent.endpoints,
    };

    // Evict oldest node if at capacity and this is a new node
    if (ctx.registeredNodes.size >= ctx.MAX_REGISTERED_NODES && !ctx.registeredNodes.has(nodeId)) {
      let oldestNodeId: string | null = null;
      let oldestTime = Infinity;
      const nodeEntries = Array.from(ctx.registeredNodes.entries());
      for (const [id, n] of nodeEntries) {
        const lastSeenTime = new Date(n.lastSeen).getTime();
        if (lastSeenTime < oldestTime) {
          oldestTime = lastSeenTime;
          oldestNodeId = id;
        }
      }
      if (oldestNodeId) {
        ctx.registeredNodes.delete(oldestNodeId);
        intentLogger.debug(`Evicted oldest node ${oldestNodeId} to make room for ${nodeId}`);
      }
    }

    ctx.registeredNodes.set(nodeId, node);

    ctx.emit('nodeIntrospectionUpdate', introspectionEvent);
    ctx.emit('nodeRegistryUpdate', ctx.getRegisteredNodes());

    intentLogger.debug(
      `Processed node introspection: ${nodeId} (${introspectionEvent.nodeType}, ${introspectionEvent.reason})`
    );
  } catch (error) {
    console.error('[EventConsumer] Error processing node introspection:', error);
  }
}

function handleNodeHeartbeat(event: RawNodeHeartbeatEvent, ctx: ConsumerContext): void {
  try {
    const nodeId = event.node_id || event.nodeId;
    if (!nodeId) {
      console.warn('[EventConsumer] Node heartbeat missing node_id, skipping');
      return;
    }

    const heartbeatEvent: NodeHeartbeatEvent = {
      id: event.id || crypto.randomUUID(),
      nodeId,
      uptimeSeconds: event.uptime_seconds || event.uptimeSeconds || 0,
      activeOperationsCount: event.active_operations_count || event.activeOperationsCount || 0,
      memoryUsageMb: event.memory_usage_mb || event.memoryUsageMb || 0,
      cpuUsagePercent: event.cpu_usage_percent || event.cpuUsagePercent || 0,
      createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
    };

    ctx.nodeHeartbeatEvents.unshift(heartbeatEvent);
    if (ctx.nodeHeartbeatEvents.length > ctx.maxNodeEvents) {
      ctx.nodeHeartbeatEvents = ctx.nodeHeartbeatEvents.slice(0, ctx.maxNodeEvents);
    }

    const existingNode = ctx.registeredNodes.get(nodeId);
    if (existingNode) {
      ctx.registeredNodes.set(nodeId, {
        ...existingNode,
        uptimeSeconds: heartbeatEvent.uptimeSeconds,
        lastSeen: heartbeatEvent.createdAt,
        memoryUsageMb: heartbeatEvent.memoryUsageMb,
        cpuUsagePercent: heartbeatEvent.cpuUsagePercent,
      });
    }

    ctx.emit('nodeHeartbeatUpdate', heartbeatEvent);
    ctx.emit('nodeRegistryUpdate', ctx.getRegisteredNodes());

    intentLogger.debug(
      `Processed node heartbeat: ${nodeId} (CPU: ${heartbeatEvent.cpuUsagePercent}%, Mem: ${heartbeatEvent.memoryUsageMb}MB)`
    );
  } catch (error) {
    console.error('[EventConsumer] Error processing node heartbeat:', error);
  }
}

function handleNodeStateChange(event: RawNodeStateChangeEvent, ctx: ConsumerContext): void {
  try {
    const nodeId = event.node_id || event.nodeId;
    if (!nodeId) {
      console.warn('[EventConsumer] Node state change missing node_id, skipping');
      return;
    }

    const stateChangeEvent: NodeStateChangeEvent = {
      id: event.id || crypto.randomUUID(),
      nodeId,
      previousState: parseRegistrationState(
        event.previous_state || event.previousState,
        'pending_registration'
      ),
      newState: parseRegistrationState(event.new_state || event.newState, 'active'),
      reason: event.reason,
      createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
    };

    ctx.nodeStateChangeEvents.unshift(stateChangeEvent);
    if (ctx.nodeStateChangeEvents.length > ctx.maxNodeEvents) {
      ctx.nodeStateChangeEvents = ctx.nodeStateChangeEvents.slice(0, ctx.maxNodeEvents);
    }

    const existingNode = ctx.registeredNodes.get(nodeId);
    if (existingNode) {
      ctx.registeredNodes.set(nodeId, {
        ...existingNode,
        state: stateChangeEvent.newState,
        lastSeen: stateChangeEvent.createdAt,
      });
    }

    ctx.emit('nodeStateChangeUpdate', stateChangeEvent);
    ctx.emit('nodeRegistryUpdate', ctx.getRegisteredNodes());

    intentLogger.debug(
      `Processed node state change: ${nodeId} (${stateChangeEvent.previousState} -> ${stateChangeEvent.newState})`
    );
  } catch (error) {
    console.error('[EventConsumer] Error processing node state change:', error);
  }
}

// ============================================================================
// Canonical ONEX Event Handlers
// ============================================================================

function handleCanonicalNodeIntrospection(message: KafkaMessage, ctx: ConsumerContext): void {
  const envelope = ctx.parseEnvelope(message, NodeIntrospectionPayloadSchema);
  if (!envelope) return;
  if (ctx.isDuplicate(envelope.correlation_id)) {
    if (DEBUG_CANONICAL_EVENTS) {
      intentLogger.debug(
        `Duplicate node-introspection event, skipping: ${envelope.correlation_id}`
      );
    }
    return;
  }

  const { payload, envelope_timestamp } = envelope;
  const emittedAtMs = new Date(envelope_timestamp).getTime();

  const existing = ctx.canonicalNodes.get(payload.node_id);
  if (existing && emittedAtMs <= (existing.last_introspection_at ?? 0)) {
    if (DEBUG_CANONICAL_EVENTS) {
      intentLogger.debug(`Stale node-introspection event, skipping: ${payload.node_id}`);
    }
    return;
  }

  // Normalize node_version: Python may send a { major, minor, patch } object (OMN-4098)
  const rawVersion = payload.node_version;
  let nodeVersion: string | undefined;
  if (typeof rawVersion === 'string') {
    nodeVersion = rawVersion;
  } else if (rawVersion != null && typeof rawVersion === 'object') {
    const sv = rawVersion as { major?: number; minor?: number; patch?: number };
    nodeVersion = `${sv.major ?? 0}.${sv.minor ?? 0}.${sv.patch ?? 0}`;
  }

  const resolvedState: OnexNodeState =
    payload.current_state != null
      ? (payload.current_state as OnexNodeState)
      : (existing?.state ?? 'PENDING');

  const node: CanonicalOnexNode = existing
    ? {
        ...existing,
        state: resolvedState,
        node_type: payload.node_type ?? existing.node_type,
        node_version: nodeVersion ?? existing.node_version,
        capabilities: payload.capabilities || existing.capabilities,
        last_introspection_at: emittedAtMs,
        last_event_at: emittedAtMs,
      }
    : {
        node_id: payload.node_id,
        state: resolvedState,
        node_type: payload.node_type,
        node_version: nodeVersion,
        capabilities: payload.capabilities,
        last_introspection_at: emittedAtMs,
        last_event_at: emittedAtMs,
      };

  ctx.canonicalNodes.set(payload.node_id, node);

  // Emit state change so Registration Events feed gets populated (OMN-5132)
  const previousState = existing?.state;
  if (previousState && previousState !== resolvedState) {
    ctx.emit(
      'nodeStateChangeUpdate',
      validateBridgeEmit(
        BridgeNodeStateChangeSchema,
        {
          node_id: payload.node_id,
          previous_state: previousState,
          new_state: resolvedState,
          emitted_at: envelope_timestamp,
        },
        'nodeStateChangeUpdate'
      )
    );
  }

  ctx.syncCanonicalToRegistered(ctx.canonicalNodes.get(payload.node_id)!);

  ctx.emit(
    'nodeIntrospectionUpdate',
    validateBridgeEmit(
      BridgeNodeIntrospectionSchema,
      {
        node_id: payload.node_id,
        node_type: payload.node_type ?? 'COMPUTE',
        version: nodeVersion ?? '1.0.0',
        current_state: resolvedState,
        capabilities: payload.capabilities ?? [],
        metadata: {},
        endpoints: {},
        reason: null,
        event_bus: {},
        emitted_at: envelope_timestamp,
      },
      'nodeIntrospectionUpdate'
    )
  );

  ctx.emit('nodeRegistryUpdate', ctx.getRegisteredNodes());

  if (DEBUG_CANONICAL_EVENTS) {
    intentLogger.debug(`Canonical node-introspection processed: ${payload.node_id}`);
  }
}

function handleCanonicalNodeHeartbeat(message: KafkaMessage, ctx: ConsumerContext): void {
  const envelope = ctx.parseEnvelope(message, NodeHeartbeatPayloadSchema);
  if (!envelope) return;
  if (ctx.isDuplicate(envelope.correlation_id)) {
    return;
  }

  const { payload, envelope_timestamp } = envelope;
  const emittedAtMs = new Date(envelope_timestamp).getTime();

  const node = ctx.canonicalNodes.get(payload.node_id);
  if (!node) {
    ctx.canonicalNodes.set(payload.node_id, {
      node_id: payload.node_id,
      state: 'PENDING',
      node_type: payload.node_type,
      last_heartbeat_at: emittedAtMs,
      last_event_at: emittedAtMs,
    });

    ctx.syncCanonicalToRegistered(ctx.canonicalNodes.get(payload.node_id)!);
    ctx.propagateHeartbeatMetrics(payload);

    const newNodeHeartbeatEvent: NodeHeartbeatEvent = {
      id: envelope.correlation_id ?? crypto.randomUUID(),
      nodeId: payload.node_id,
      uptimeSeconds: payload.uptime_seconds ?? 0,
      activeOperationsCount: payload.active_operations_count ?? 0,
      memoryUsageMb: payload.memory_usage_mb ?? 0,
      cpuUsagePercent: payload.cpu_usage_percent ?? 0,
      createdAt: new Date(emittedAtMs),
    };
    ctx.emit(
      'nodeHeartbeatUpdate',
      validateBridgeEmit(BridgeNodeHeartbeatSchema, newNodeHeartbeatEvent, 'nodeHeartbeatUpdate')
    );

    ctx.emit('nodeRegistryUpdate', ctx.getRegisteredNodes());
    return;
  }

  if (!ctx.shouldProcess(node, emittedAtMs)) {
    return;
  }

  ctx.canonicalNodes.set(payload.node_id, {
    ...node,
    node_type: payload.node_type ?? node.node_type,
    last_heartbeat_at: emittedAtMs,
    last_event_at: emittedAtMs,
  });

  ctx.syncCanonicalToRegistered(ctx.canonicalNodes.get(payload.node_id)!);
  ctx.propagateHeartbeatMetrics(payload);

  const heartbeatEvent: NodeHeartbeatEvent = {
    id: envelope.correlation_id ?? crypto.randomUUID(),
    nodeId: payload.node_id,
    uptimeSeconds: payload.uptime_seconds ?? 0,
    activeOperationsCount: payload.active_operations_count ?? 0,
    memoryUsageMb: payload.memory_usage_mb ?? 0,
    cpuUsagePercent: payload.cpu_usage_percent ?? 0,
    createdAt: new Date(emittedAtMs),
  };
  ctx.emit(
    'nodeHeartbeatUpdate',
    validateBridgeEmit(BridgeNodeHeartbeatSchema, heartbeatEvent, 'nodeHeartbeatUpdate')
  );

  ctx.emit('nodeRegistryUpdate', ctx.getRegisteredNodes());
}

function handleCanonicalNodeBecameActive(message: KafkaMessage, ctx: ConsumerContext): void {
  const envelope = ctx.parseEnvelope(message, NodeBecameActivePayloadSchema);
  if (!envelope) return;
  if (ctx.isDuplicate(envelope.correlation_id)) return;

  const { payload, envelope_timestamp } = envelope;
  const emittedAtMs = new Date(envelope_timestamp).getTime();
  const nodeId = payload.node_id;

  const existing = ctx.canonicalNodes.get(nodeId);
  const node: CanonicalOnexNode = existing
    ? {
        ...existing,
        state: 'ACTIVE' as OnexNodeState,
        capabilities: payload.capabilities || existing.capabilities,
        last_event_at: emittedAtMs,
      }
    : {
        node_id: nodeId,
        state: 'ACTIVE' as OnexNodeState,
        node_type: undefined,
        node_version: undefined,
        capabilities: payload.capabilities,
        last_event_at: emittedAtMs,
      };

  ctx.canonicalNodes.set(nodeId, node);
  ctx.syncCanonicalToRegistered(node);

  ctx.emit(
    'nodeBecameActive',
    validateBridgeEmit(
      BridgeNodeBecameActiveSchema,
      {
        node_id: nodeId,
        capabilities: payload.capabilities,
        emitted_at: envelope_timestamp,
      },
      'nodeBecameActive'
    )
  );
  ctx.emit('nodeRegistryUpdate', ctx.getRegisteredNodes());

  if (DEBUG_CANONICAL_EVENTS) {
    intentLogger.debug(`Canonical node-became-active processed: ${nodeId}`);
  }
}

// ============================================================================
// DomainHandler Implementation
// ============================================================================

export class PlatformHandler implements DomainHandler {
  readonly name = 'platform';

  canHandle(topic: string): boolean {
    return HANDLED_TOPICS.has(topic);
  }

  handleEvent(
    topic: string,
    event: Record<string, unknown>,
    message: KafkaMessage,
    ctx: ConsumerContext
  ): void {
    switch (topic) {
      case SUFFIX_NODE_INTROSPECTION:
      case SUFFIX_REQUEST_INTROSPECTION: {
        const isIntrospectionEnvelope = Boolean(
          event.envelope_id && event.envelope_timestamp && event.payload
        );
        if (!isIntrospectionEnvelope) {
          if (ctx.isDebug) {
            intentLogger.debug(
              `Processing node introspection: ${event.node_id || event.nodeId} (${event.reason || 'unknown'})`
            );
          }
          handleNodeIntrospection(event as RawNodeIntrospectionEvent, ctx);
        } else {
          if (DEBUG_CANONICAL_EVENTS) {
            intentLogger.debug('Processing canonical node-introspection event');
          }
          handleCanonicalNodeIntrospection(message, ctx);
        }
        break;
      }

      case SUFFIX_NODE_HEARTBEAT: {
        const isHeartbeatEnvelope = Boolean(
          event.envelope_id && event.envelope_timestamp && event.payload
        );
        if (!isHeartbeatEnvelope) {
          if (ctx.isDebug) {
            intentLogger.debug(`Processing node heartbeat: ${event.node_id || event.nodeId}`);
          }
          handleNodeHeartbeat(event as RawNodeHeartbeatEvent, ctx);
        } else {
          if (DEBUG_CANONICAL_EVENTS) {
            intentLogger.debug('Processing canonical node-heartbeat event');
          }
          handleCanonicalNodeHeartbeat(message, ctx);
        }
        break;
      }

      case SUFFIX_NODE_REGISTRATION: {
        const isRegistrationEnvelope = Boolean(
          event.envelope_id && event.envelope_timestamp && event.payload
        );
        if (!isRegistrationEnvelope) {
          if (ctx.isDebug) {
            intentLogger.debug(
              `Processing node state change: ${event.node_id || event.nodeId} -> ${event.new_state || event.newState || 'active'}`
            );
          }
          handleNodeStateChange(event as RawNodeStateChangeEvent, ctx);
        } else {
          if (DEBUG_CANONICAL_EVENTS) {
            intentLogger.debug('Processing canonical node-registration event');
          }
          handleCanonicalNodeIntrospection(message, ctx);
        }
        break;
      }

      case SUFFIX_CONTRACT_REGISTERED:
      case SUFFIX_CONTRACT_DEREGISTERED:
        if (ctx.isDebug) {
          intentLogger.debug(`Processing contract lifecycle event from topic: ${topic}`);
        }
        handleCanonicalNodeIntrospection(message, ctx);
        break;

      case SUFFIX_NODE_REGISTRATION_INITIATED:
      case SUFFIX_NODE_REGISTRATION_ACCEPTED:
      case SUFFIX_NODE_REGISTRATION_REJECTED:
      case SUFFIX_NODE_REGISTRATION_ACKED:
      case SUFFIX_NODE_REGISTRATION_RESULT:
      case SUFFIX_NODE_REGISTRATION_ACK_RECEIVED:
      case SUFFIX_NODE_REGISTRATION_ACK_TIMED_OUT:
      case SUFFIX_NODE_LIVENESS_EXPIRED:
        if (ctx.isDebug) {
          intentLogger.debug(`Processing node registration lifecycle event from topic: ${topic}`);
        }
        handleCanonicalNodeIntrospection(message, ctx);
        break;

      case SUFFIX_NODE_BECAME_ACTIVE:
        if (ctx.isDebug) {
          intentLogger.debug(`Processing node-became-active event from topic: ${topic}`);
        }
        handleCanonicalNodeBecameActive(message, ctx);
        break;

      case SUFFIX_REGISTRY_REQUEST_INTROSPECTION:
        if (ctx.isDebug) {
          intentLogger.debug('Processing registry-request-introspection event');
        }
        handleCanonicalNodeIntrospection(message, ctx);
        break;

      case SUFFIX_FSM_STATE_TRANSITIONS:
        if (ctx.isDebug) {
          intentLogger.debug('Processing FSM state transition event');
        }
        handleCanonicalNodeIntrospection(message, ctx);
        break;

      case SUFFIX_RUNTIME_TICK:
        if (ctx.isDebug) {
          intentLogger.debug('Processing runtime tick event');
        }
        handleCanonicalNodeIntrospection(message, ctx);
        break;

      case SUFFIX_REGISTRATION_SNAPSHOTS:
        if (ctx.isDebug) {
          intentLogger.debug('Processing registration snapshot');
        }
        handleCanonicalNodeIntrospection(message, ctx);
        break;

      // Status dashboard topics (OMN-2658)
      case SUFFIX_GITHUB_PR_STATUS:
        if (isGitHubPRStatusEvent(event)) {
          statusProjection.upsertPR(event);
          emitStatusInvalidate('pr');
          if (ctx.isDebug) {
            intentLogger.debug(
              `[status] PR upserted: ${event.repo}#${event.pr_number} (${event.ci_status})`
            );
          }
        } else {
          console.warn('[status] Dropped malformed github.pr-status event');
        }
        break;

      case SUFFIX_GIT_HOOK:
        if (isGitHookEvent(event)) {
          statusProjection.appendHook(event);
          emitStatusInvalidate('hook');
          if (ctx.isDebug) {
            intentLogger.debug(
              `[status] Hook event appended: ${event.hook} on ${event.repo}:${event.branch} (success=${event.success})`
            );
          }
        } else {
          console.warn('[status] Dropped malformed git.hook event');
        }
        break;

      case SUFFIX_LINEAR_SNAPSHOT:
        if (isLinearSnapshotEvent(event)) {
          statusProjection.replaceWorkstreams(event);
          emitStatusInvalidate('linear');
          if (ctx.isDebug) {
            intentLogger.debug(
              `[status] Linear snapshot replaced: ${event.workstreams.length} workstreams`
            );
          }
        } else {
          console.warn('[status] Dropped malformed linear.snapshot event');
        }
        break;

      // Agent status events (OMN-5604)
      case SUFFIX_AGENT_STATUS:
        // intentional-skip: agent_status_events table + projection deferred to OMN-5604.
        // Domain handler advances offset; append-only projection pending table creation.
        if (ctx.isDebug) {
          intentLogger.debug(`Processing session/agent event from topic: ${topic}`);
        }
        break;
    }
  }
}
