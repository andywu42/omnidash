/**
 * OmniClaude domain handler [OMN-5191]
 *
 * Handles topics with the omniclaude prefix:
 * - Routing decisions
 * - Agent actions
 * - Agent transformations
 * - Performance metrics
 * - Claude hook events (prompt submissions)
 * - Lifecycle events (session-started, session-ended, tool-executed)
 * - Tool-content events
 */

import crypto from 'node:crypto';
import type { KafkaMessage } from 'kafkajs';
import {
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
  SUFFIX_OMNICLAUDE_ROUTING_DECISION,
  SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
  SUFFIX_OMNICLAUDE_MANIFEST_INJECTED,
  SUFFIX_OMNICLAUDE_PHASE_METRICS,
  SUFFIX_OMNICLAUDE_NOTIFICATION_BLOCKED,
  SUFFIX_OMNICLAUDE_NOTIFICATION_COMPLETED,
  SUFFIX_OMNICLAUDE_TRANSFORMATION_COMPLETED,
  SUFFIX_OMNICLAUDE_CONTEXT_UTILIZATION,
  SUFFIX_OMNICLAUDE_AGENT_MATCH,
  SUFFIX_OMNICLAUDE_LATENCY_BREAKDOWN,
  SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
  SUFFIX_OMNICLAUDE_SESSION_STARTED,
  SUFFIX_OMNICLAUDE_SESSION_ENDED,
  SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
  SUFFIX_INTELLIGENCE_CLAUDE_HOOK,
  SUFFIX_INTELLIGENCE_TOOL_CONTENT,
} from '@shared/topics';
import {
  isContextUtilizationEvent,
  isAgentMatchEvent,
  isLatencyBreakdownEvent,
} from '@shared/extraction-types';
import { emitEffectivenessUpdate } from '../../effectiveness-events';
import { effectivenessMetricsProjection } from '../../projection-bootstrap';
import { addDecisionRecord } from '../../decision-records-routes';
import type {
  DomainHandler,
  ConsumerContext,
  AgentAction,
  RoutingDecision,
  TransformationEvent,
  RawRoutingDecisionEvent,
  RawAgentActionEvent,
  RawTransformationEvent,
  RawPerformanceMetricEvent,
} from './types';
import { intentLogger, normalizeActionFields } from './consumer-utils';

/** All topic suffixes this handler responds to */
const HANDLED_TOPICS = new Set([
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
  SUFFIX_INTELLIGENCE_CLAUDE_HOOK,
  SUFFIX_INTELLIGENCE_TOOL_CONTENT,
  SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
  SUFFIX_OMNICLAUDE_SESSION_STARTED,
  SUFFIX_OMNICLAUDE_SESSION_ENDED,
  SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
  SUFFIX_OMNICLAUDE_CONTEXT_UTILIZATION,
  SUFFIX_OMNICLAUDE_AGENT_MATCH,
  SUFFIX_OMNICLAUDE_LATENCY_BREAKDOWN,
  SUFFIX_OMNICLAUDE_ROUTING_DECISION,
  SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
  SUFFIX_OMNICLAUDE_MANIFEST_INJECTED,
  SUFFIX_OMNICLAUDE_PHASE_METRICS,
  SUFFIX_OMNICLAUDE_NOTIFICATION_BLOCKED,
  SUFFIX_OMNICLAUDE_NOTIFICATION_COMPLETED,
  SUFFIX_OMNICLAUDE_TRANSFORMATION_COMPLETED,
]);

// ============================================================================
// Handler Functions
// ============================================================================

function handleRoutingDecision(event: RawRoutingDecisionEvent, ctx: ConsumerContext): void {
  const agent = event.selected_agent || event.selectedAgent;
  if (!agent) {
    console.warn('[EventConsumer] Routing decision missing agent name, skipping');
    return;
  }

  const existing = ctx.agentMetrics.get(agent) || {
    count: 0,
    totalRoutingTime: 0,
    totalConfidence: 0,
    successCount: 0,
    errorCount: 0,
    lastSeen: new Date(),
  };

  existing.count++;
  existing.totalRoutingTime += event.routing_time_ms || event.routingTimeMs || 0;
  existing.totalConfidence += event.confidence_score || event.confidenceScore || 0;
  existing.lastSeen = new Date();

  ctx.agentMetrics.set(agent, existing);
  intentLogger.debug(
    `Updated metrics for ${agent}: ${existing.count} requests, avg confidence ${(existing.totalConfidence / existing.count).toFixed(2)}`
  );

  ctx.cleanupOldMetrics();
  ctx.emit('metricUpdate', ctx.getAgentMetrics());

  const decision: RoutingDecision = {
    id: event.id || crypto.randomUUID(),
    correlationId: event.correlation_id || event.correlationId || '',
    userRequest: event.user_request || event.userRequest || '',
    selectedAgent: agent,
    confidenceScore: event.confidence_score || event.confidenceScore || 0,
    routingStrategy: event.routing_strategy || event.routingStrategy || '',
    alternatives: event.alternatives,
    reasoning: event.reasoning,
    routingTimeMs: event.routing_time_ms || event.routingTimeMs || 0,
    createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
  };

  ctx.routingDecisions.unshift(decision);
  if (ctx.routingDecisions.length > ctx.maxDecisions) {
    ctx.routingDecisions = ctx.routingDecisions.slice(0, ctx.maxDecisions);
  }

  addDecisionRecord({
    decision_id: decision.id,
    session_id: decision.correlationId,
    decided_at: decision.createdAt.toISOString(),
    decision_type: 'route_select',
    selected_candidate: decision.selectedAgent,
    candidates_considered: Array.isArray(event.alternatives)
      ? (event.alternatives as Array<{ id?: string; name?: string }>).map((alt) => {
          const altId = String(alt?.id ?? alt?.name ?? '');
          return {
            id: altId,
            eliminated: false,
            selected: altId === decision.selectedAgent,
          };
        })
      : [],
    constraints_applied: [],
    tie_breaker: null,
    agent_rationale: decision.reasoning ?? null,
  });

  ctx.emit('routingUpdate', decision);
}

function handleAgentAction(event: RawAgentActionEvent, ctx: ConsumerContext): void {
  const rawActionType = event.action_type || event.actionType || '';
  const rawAgentName = event.agent_name || event.agentName || '';
  const actionName = event.action_name || event.actionName || '';
  const { actionType, agentName } = normalizeActionFields(rawActionType, rawAgentName, actionName);

  const action: AgentAction = {
    id: event.id || crypto.randomUUID(),
    correlationId: event.correlation_id || event.correlationId || '',
    agentName,
    actionType,
    actionName,
    actionDetails: event.action_details || event.actionDetails,
    debugMode: event.debug_mode || event.debugMode,
    durationMs: event.duration_ms || event.durationMs || 0,
    createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
  };

  ctx.recentActions.unshift(action);
  intentLogger.debug(
    `Added action to queue: ${action.actionName} (${action.agentName}), queue size: ${ctx.recentActions.length}`
  );

  if (action.agentName && (action.actionType === 'success' || action.actionType === 'error')) {
    const existing = ctx.agentMetrics.get(action.agentName) || {
      count: 0,
      totalRoutingTime: 0,
      totalConfidence: 0,
      successCount: 0,
      errorCount: 0,
      lastSeen: new Date(),
    };

    if (action.actionType === 'success') {
      existing.successCount++;
    } else if (action.actionType === 'error') {
      existing.errorCount++;
    }

    existing.lastSeen = new Date();
    ctx.agentMetrics.set(action.agentName, existing);

    intentLogger.debug(
      `Updated ${action.agentName} success/error: ${existing.successCount}/${existing.errorCount}`
    );
    ctx.emit('metricUpdate', ctx.getAgentMetrics());
  }

  if (ctx.recentActions.length > ctx.maxActions) {
    ctx.recentActions = ctx.recentActions.slice(0, ctx.maxActions);
  }

  ctx.emit('actionUpdate', action);
}

function handleClaudeHookEvent(
  event: {
    event_type?: string;
    eventType?: string;
    session_id?: string;
    sessionId?: string;
    correlation_id?: string;
    correlationId?: string;
    timestamp_utc?: string;
    timestampUtc?: string;
    payload?: { prompt?: string; [key: string]: unknown };
  },
  ctx: ConsumerContext
): void {
  const eventType = event.event_type || event.eventType || 'unknown';
  const prompt = event.payload?.prompt || '';
  const truncatedPrompt = prompt.length > 100 ? prompt.slice(0, 100) + '...' : prompt;

  const action: AgentAction = {
    id: crypto.randomUUID(),
    correlationId: event.correlation_id || event.correlationId || '',
    agentName: 'omniclaude',
    actionType: 'prompt',
    actionName: eventType,
    actionDetails: {
      prompt: truncatedPrompt,
      sessionId: event.session_id || event.sessionId,
      eventType,
    },
    debugMode: false,
    durationMs: 0,
    createdAt: new Date(event.timestamp_utc || event.timestampUtc || Date.now()),
  };

  ctx.recentActions.unshift(action);
  intentLogger.debug(
    `Added claude hook event: ${eventType} - "${truncatedPrompt.slice(0, 30)}...", queue size: ${ctx.recentActions.length}`
  );

  if (ctx.recentActions.length > ctx.maxActions) {
    ctx.recentActions = ctx.recentActions.slice(0, ctx.maxActions);
  }

  ctx.emit('actionUpdate', action);
}

function handlePromptSubmittedEvent(event: Record<string, unknown>, ctx: ConsumerContext): void {
  const payload = (event.payload || {}) as Record<string, unknown>;
  const promptPreview =
    (payload.prompt_preview as string) ||
    (payload.promptPreview as string) ||
    (event.prompt_preview as string) ||
    (event.promptPreview as string) ||
    (event.prompt as string) ||
    '';

  const correlationId =
    (payload.correlation_id as string) ||
    (payload.correlationId as string) ||
    (event.correlation_id as string) ||
    (event.correlationId as string) ||
    '';
  const sessionId =
    (payload.session_id as string) ||
    (payload.sessionId as string) ||
    (event.session_id as string) ||
    (event.sessionId as string) ||
    '';
  const explicitPromptLength =
    (payload.prompt_length as number | undefined) ??
    (payload.promptLength as number | undefined) ??
    (event.prompt_length as number | undefined) ??
    (event.promptLength as number | undefined);
  const promptLength = explicitPromptLength ?? promptPreview.length;
  const emittedAt =
    (payload.emitted_at as string) ||
    (payload.emittedAt as string) ||
    (event.emitted_at as string) ||
    (event.emittedAt as string);

  const action: AgentAction = {
    id: crypto.randomUUID(),
    correlationId,
    agentName: 'omniclaude',
    actionType: 'prompt',
    actionName: 'UserPromptSubmit',
    actionDetails: {
      prompt: promptPreview,
      promptLength,
      sessionId,
    },
    debugMode: false,
    durationMs: 0,
    createdAt: new Date(emittedAt || Date.now()),
  };

  ctx.recentActions.unshift(action);
  intentLogger.debug(
    `Added prompt-submitted: "${promptPreview.slice(0, 30)}...", queue size: ${ctx.recentActions.length}`
  );

  if (ctx.recentActions.length > ctx.maxActions) {
    ctx.recentActions = ctx.recentActions.slice(0, ctx.maxActions);
  }

  ctx.emit('actionUpdate', action);
}

function handleOmniclaudeLifecycleEvent(
  event: {
    event_type?: string;
    eventType?: string;
    payload?: Record<string, unknown>;
  },
  topic: string,
  ctx: ConsumerContext
): void {
  const rawEventType = event.event_type || event.eventType;
  const segmentFallback = topic.split('.').slice(-2, -1)[0];
  const eventType = rawEventType || segmentFallback || topic;
  const payload = event.payload || {};

  const toolName =
    (typeof payload.toolName === 'string' ? payload.toolName : undefined) ||
    (typeof payload.tool_name === 'string' ? payload.tool_name : undefined) ||
    (typeof payload.functionName === 'string' ? payload.functionName : undefined) ||
    (typeof payload.function_name === 'string' ? payload.function_name : undefined) ||
    (typeof payload.tool === 'string' ? payload.tool : undefined);

  const action: AgentAction = {
    id: crypto.randomUUID(),
    correlationId: (payload.correlation_id || payload.correlationId || '') as string,
    agentName: 'omniclaude',
    actionType: eventType.includes('tool') ? 'tool_call' : 'lifecycle',
    actionName: eventType,
    actionDetails: {
      sessionId: payload.session_id || payload.sessionId,
      ...payload,
    },
    debugMode: false,
    durationMs: (payload.duration_ms || payload.durationMs || 0) as number,
    createdAt: new Date((payload.emitted_at || payload.emittedAt || Date.now()) as string | number),
    topic,
    toolName: toolName || undefined,
  };

  ctx.recentActions.unshift(action);
  intentLogger.debug(
    `Added omniclaude lifecycle: ${eventType}${toolName ? ` (tool: ${toolName})` : ''}, queue size: ${ctx.recentActions.length}`
  );

  if (ctx.recentActions.length > ctx.maxActions) {
    ctx.recentActions = ctx.recentActions.slice(0, ctx.maxActions);
  }

  ctx.emit('actionUpdate', action);
}

function handleTransformationEvent(event: RawTransformationEvent, ctx: ConsumerContext): void {
  const transformation: TransformationEvent = {
    id: event.id || crypto.randomUUID(),
    correlationId: event.correlation_id || event.correlationId || '',
    sourceAgent: event.source_agent || event.sourceAgent || '',
    targetAgent: event.target_agent || event.targetAgent || '',
    transformationDurationMs:
      event.transformation_duration_ms || event.transformationDurationMs || 0,
    success: event.success ?? true,
    confidenceScore: event.confidence_score || event.confidenceScore || 0,
    createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
  };

  ctx.recentTransformations.unshift(transformation);
  intentLogger.debug(
    `Added transformation to queue: ${transformation.sourceAgent} -> ${transformation.targetAgent}, queue size: ${ctx.recentTransformations.length}`
  );

  if (ctx.recentTransformations.length > ctx.maxTransformations) {
    ctx.recentTransformations = ctx.recentTransformations.slice(0, ctx.maxTransformations);
  }

  ctx.emit('transformationUpdate', transformation);
}

function handlePerformanceMetric(event: RawPerformanceMetricEvent, ctx: ConsumerContext): void {
  try {
    const metric = {
      id: event.id || crypto.randomUUID(),
      correlationId: event.correlation_id || event.correlationId || '',
      queryText: event.query_text || event.queryText || '',
      routingDurationMs: event.routing_duration_ms || event.routingDurationMs || 0,
      cacheHit: event.cache_hit ?? event.cacheHit ?? false,
      candidatesEvaluated: event.candidates_evaluated || event.candidatesEvaluated || 0,
      triggerMatchStrategy: event.trigger_match_strategy || event.triggerMatchStrategy || 'unknown',
      createdAt: new Date(event.timestamp || event.createdAt || Date.now()),
    };

    ctx.performanceMetrics.unshift(metric);
    if (ctx.performanceMetrics.length > ctx.PERFORMANCE_METRICS_BUFFER_SIZE) {
      ctx.performanceMetrics = ctx.performanceMetrics.slice(0, ctx.PERFORMANCE_METRICS_BUFFER_SIZE);
    }

    ctx.performanceStats.totalQueries++;
    if (metric.cacheHit) {
      ctx.performanceStats.cacheHitCount++;
    }
    ctx.performanceStats.totalRoutingDuration += metric.routingDurationMs;
    ctx.performanceStats.avgRoutingDuration =
      ctx.performanceStats.totalRoutingDuration / ctx.performanceStats.totalQueries;

    ctx.emit('performanceUpdate', {
      metric,
      stats: { ...ctx.performanceStats },
    });

    intentLogger.debug(
      `Processed performance metric: ${metric.routingDurationMs}ms, cache hit: ${metric.cacheHit}, strategy: ${metric.triggerMatchStrategy}`
    );
  } catch (error) {
    console.error('[EventConsumer] Error processing performance metric:', error);
  }
}

// ============================================================================
// Extraction Pipeline Handlers
// ============================================================================

function handleExtractionEvent(
  topic: string,
  event: Record<string, unknown>,
  ctx: ConsumerContext
): void {
  switch (topic) {
    case SUFFIX_OMNICLAUDE_CONTEXT_UTILIZATION:
      if (isContextUtilizationEvent(event)) {
        // Note: aggregator methods are sync despite extraction-aggregator using async signatures
        void ctx.extractionAggregator.handleContextUtilization(event);
        if (ctx.extractionAggregator.shouldBroadcast()) {
          effectivenessMetricsProjection.reset();
          emitEffectivenessUpdate();
          ctx.emit('extraction-event', { type: 'context-utilization' });
        }
      } else {
        console.warn('[extraction] Dropped malformed context-utilization event');
      }
      break;
    case SUFFIX_OMNICLAUDE_AGENT_MATCH:
      if (isAgentMatchEvent(event)) {
        void ctx.extractionAggregator.handleAgentMatch(event);
        if (ctx.extractionAggregator.shouldBroadcast()) {
          effectivenessMetricsProjection.reset();
          emitEffectivenessUpdate();
          ctx.emit('extraction-event', { type: 'agent-match' });
        }
      } else {
        console.warn('[extraction] Dropped malformed agent-match event');
      }
      break;
    case SUFFIX_OMNICLAUDE_LATENCY_BREAKDOWN:
      if (isLatencyBreakdownEvent(event)) {
        void ctx.extractionAggregator.handleLatencyBreakdown(event);
        if (ctx.extractionAggregator.shouldBroadcast()) {
          effectivenessMetricsProjection.reset();
          emitEffectivenessUpdate();
          ctx.emit('extraction-event', { type: 'latency-breakdown' });
        }
      } else {
        console.warn('[extraction] Dropped malformed latency-breakdown event');
      }
      break;
  }
}

// ============================================================================
// DomainHandler Implementation
// ============================================================================

export class OmniclaudeHandler implements DomainHandler {
  readonly name = 'omniclaude';

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
      case TOPIC_OMNICLAUDE_ROUTING_DECISIONS:
        if (ctx.isDebug) {
          intentLogger.debug(
            `Processing routing decision for agent: ${event.selected_agent || event.selectedAgent}`
          );
        }
        handleRoutingDecision(event as RawRoutingDecisionEvent, ctx);
        break;

      case TOPIC_OMNICLAUDE_AGENT_ACTIONS:
        if (ctx.isDebug) {
          intentLogger.debug(
            `Processing action: ${event.action_type || event.actionType} from ${event.agent_name || event.agentName}`
          );
        }
        handleAgentAction(event as RawAgentActionEvent, ctx);
        break;

      case TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION:
        if (ctx.isDebug) {
          intentLogger.debug(
            `Processing transformation: ${event.source_agent || event.sourceAgent} → ${event.target_agent || event.targetAgent}`
          );
        }
        handleTransformationEvent(event as RawTransformationEvent, ctx);
        break;

      case TOPIC_OMNICLAUDE_PERFORMANCE_METRICS:
        if (ctx.isDebug) {
          intentLogger.debug(
            `Processing performance metric: ${event.routing_duration_ms || event.routingDurationMs}ms`
          );
        }
        handlePerformanceMetric(event as RawPerformanceMetricEvent, ctx);
        break;

      case SUFFIX_INTELLIGENCE_CLAUDE_HOOK:
        if (ctx.isDebug) {
          intentLogger.debug(
            `Processing claude hook event: ${event.event_type || event.eventType}`
          );
        }
        handleClaudeHookEvent(event as Parameters<typeof handleClaudeHookEvent>[0], ctx);
        break;

      case SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED:
        if (ctx.isDebug) {
          intentLogger.debug(
            `Processing prompt-submitted: ${((event.payload as Record<string, unknown>)?.prompt_preview || '').toString().slice(0, 50)}...`
          );
        }
        handlePromptSubmittedEvent(event, ctx);
        break;

      case SUFFIX_OMNICLAUDE_SESSION_STARTED:
      case SUFFIX_OMNICLAUDE_SESSION_ENDED:
      case SUFFIX_OMNICLAUDE_TOOL_EXECUTED:
        if (ctx.isDebug) {
          intentLogger.debug(`Processing omniclaude event: ${event.event_type || event.eventType}`);
        }
        handleOmniclaudeLifecycleEvent(
          event as Parameters<typeof handleOmniclaudeLifecycleEvent>[0],
          topic,
          ctx
        );
        break;

      case SUFFIX_INTELLIGENCE_TOOL_CONTENT:
        if (ctx.isDebug) {
          intentLogger.debug(
            `Processing tool-content: ${(event as Record<string, string>).tool_name || 'unknown'}`
          );
        }
        handleAgentAction(
          {
            action_type: 'tool',
            agent_name: 'omniclaude',
            action_name: (event as Record<string, string>).tool_name || 'unknown',
            correlation_id: (event as Record<string, string>).correlation_id,
            duration_ms: Number((event as Record<string, unknown>).duration_ms || 0),
            timestamp: (event as Record<string, string>).timestamp,
          } as RawAgentActionEvent,
          ctx
        );
        break;

      // Extraction pipeline topics (OMN-1804)
      case SUFFIX_OMNICLAUDE_CONTEXT_UTILIZATION:
      case SUFFIX_OMNICLAUDE_AGENT_MATCH:
      case SUFFIX_OMNICLAUDE_LATENCY_BREAKDOWN:
        handleExtractionEvent(topic, event, ctx);
        break;

      // Session outcome events — projected to session_outcomes by read-model consumer (OMN-5557)
      case SUFFIX_OMNICLAUDE_SESSION_OUTCOME:
        if (ctx.isDebug) {
          intentLogger.debug(
            `Processing session-outcome: session=${event.session_id || event.sessionId}, outcome=${event.outcome}`
          );
        }
        ctx.emit('session-outcome', {
          sessionId: (event.session_id as string) || (event.sessionId as string) || null,
          outcome: (event.outcome as string) || 'unknown',
          timestamp: (event.timestamp as string) || new Date().toISOString(),
        });
        break;

      // Phase metrics events — projected to phase_metrics_events by read-model consumer (OMN-5557)
      case SUFFIX_OMNICLAUDE_PHASE_METRICS:
        if (ctx.isDebug) {
          intentLogger.debug(
            `Processing phase-metrics: session=${event.session_id || event.sessionId}, phase=${event.phase}, status=${event.status}`
          );
        }
        ctx.emit('phase-metrics', {
          sessionId: (event.session_id as string) || (event.sessionId as string) || null,
          phase: (event.phase as string) || 'unknown',
          status: (event.status as string) || 'unknown',
          durationMs: Number(event.duration_ms ?? event.durationMs ?? 0),
          timestamp: (event.timestamp as string) || new Date().toISOString(),
        });
        break;

      // Routing decision suffix — duplicate of TOPIC_OMNICLAUDE_ROUTING_DECISIONS (same topic string).
      // Handled by handleRoutingDecision() above; this case is unreachable but kept for clarity.
      case SUFFIX_OMNICLAUDE_ROUTING_DECISION:
        handleRoutingDecision(event as RawRoutingDecisionEvent, ctx);
        break;

      // OmniClaude extended events — offset advancement only (no domain-handler logic needed)
      case SUFFIX_OMNICLAUDE_MANIFEST_INJECTED:
      case SUFFIX_OMNICLAUDE_NOTIFICATION_BLOCKED:
      case SUFFIX_OMNICLAUDE_NOTIFICATION_COMPLETED:
      case SUFFIX_OMNICLAUDE_TRANSFORMATION_COMPLETED:
        if (ctx.isDebug) {
          intentLogger.debug(`Processing omniclaude extended event from topic: ${topic}`);
        }
        break;
    }
  }
}
