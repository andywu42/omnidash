/**
 * Omniclaude domain projection handlers (OMN-5192).
 *
 * Projects events from omniclaude topics into the omnidash_analytics read-model:
 * - Routing decisions -> agent_routing_decisions
 * - Agent actions -> agent_actions
 * - Transformations -> agent_transformation_events
 * - Pattern enforcement -> pattern_enforcement_events
 * - Context enrichment -> context_enrichment_events
 * - LLM routing decisions -> llm_routing_decisions
 * - Task delegation -> delegation_events
 * - Delegation shadow comparison -> delegation_shadow_comparisons
 * - Gate decisions -> gate_decisions
 * - Epic run updates -> epic_run_events / epic_run_lease
 * - PR watch updates -> pr_watch_state
 * - Budget cap hits -> pipeline_budget_state
 * - Circuit breaker trips -> debug_escalation_counts
 * - Correlation trace spans -> correlation_trace_spans
 * - Session outcomes -> session_outcomes
 * - Phase metrics -> phase_metrics_events
 */

import { sql, eq } from 'drizzle-orm';
import {
  agentRoutingDecisions,
  agentActions,
  agentTransformationEvents,
  delegationEvents,
  delegationShadowComparisons,
  correlationTraceSpans,
  sessionOutcomes,
  phaseMetricsEvents,
  skillInvocations,
} from '@shared/intelligence-schema';
import type {
  InsertAgentRoutingDecision,
  InsertAgentAction,
  InsertAgentTransformationEvent,
  InsertDelegationEvent,
  InsertDelegationShadowComparison,
} from '@shared/intelligence-schema';
import type { PatternEnforcementEvent } from '@shared/enforcement-types';
import { ENRICHMENT_OUTCOMES } from '@shared/enrichment-types';
import type { ContextEnrichmentEvent } from '@shared/enrichment-types';
import type { LlmRoutingDecisionEvent } from '@shared/llm-routing-types';
import type { TaskDelegatedEvent, DelegationShadowComparisonEvent } from '@shared/delegation-types';
import {
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
  SUFFIX_OMNICLAUDE_CONTEXT_ENRICHMENT,
  SUFFIX_OMNICLAUDE_LLM_ROUTING_DECISION,
  SUFFIX_OMNICLAUDE_TASK_DELEGATED,
  SUFFIX_OMNICLAUDE_DELEGATION_SHADOW_COMPARISON,
  SUFFIX_OMNICLAUDE_GATE_DECISION,
  SUFFIX_OMNICLAUDE_EPIC_RUN_UPDATED,
  SUFFIX_OMNICLAUDE_PR_WATCH_UPDATED,
  SUFFIX_OMNICLAUDE_BUDGET_CAP_HIT,
  SUFFIX_OMNICLAUDE_CIRCUIT_BREAKER_TRIPPED,
  SUFFIX_OMNICLAUDE_CORRELATION_TRACE,
  SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
  SUFFIX_OMNICLAUDE_PHASE_METRICS,
  SUFFIX_OMNICLAUDE_DEBUG_TRIGGER_RECORD,
  SUFFIX_OMNICLAUDE_SKILL_STARTED,
  SUFFIX_OMNICLAUDE_SKILL_COMPLETED,
  SUFFIX_OMNICLAUDE_HOSTILE_REVIEWER_COMPLETED,
  SUFFIX_OMNICLAUDE_CONTEXT_UTILIZATION,
  SUFFIX_OMNICLAUDE_AGENT_MATCH,
  SUFFIX_OMNICLAUDE_LATENCY_BREAKDOWN,
  SUFFIX_OMNICLAUDE_TASK_ASSIGNED,
  SUFFIX_OMNICLAUDE_TASK_PROGRESS,
  SUFFIX_OMNICLAUDE_TASK_COMPLETED,
  SUFFIX_OMNICLAUDE_EVIDENCE_WRITTEN,
} from '@shared/topics';
import { ExtractionMetricsAggregator } from '../../extraction-aggregator';
import type {
  ContextUtilizationEvent,
  AgentMatchEvent,
  LatencyBreakdownEvent,
} from '@shared/extraction-types';
import {
  isContextUtilizationEvent,
  isAgentMatchEvent,
  isLatencyBreakdownEvent,
} from '@shared/extraction-types';
import { llmRoutingProjection } from '../../projection-bootstrap';
import { emitLlmRoutingInvalidate } from '../../llm-routing-events';
import { emitDelegationInvalidate } from '../../delegation-events';
import { emitEnrichmentInvalidate } from '../../enrichment-events';
import { emitEnforcementInvalidate } from '../../enforcement-events';
import {
  emitGateDecisionInvalidate,
  emitEpicRunInvalidate,
  emitPrWatchInvalidate,
  emitPipelineBudgetInvalidate,
  emitCircuitBreakerInvalidate,
} from '../../omniclaude-state-events';

import type {
  ProjectionHandler,
  ProjectionContext,
  MessageMeta,
  ProjectionHandlerStats,
} from './types';
import {
  safeParseDate,
  sanitizeSessionId,
  isTableMissingError,
  UUID_RE,
  createHandlerStats,
  registerHandlerStats,
} from './types';

const OMNICLAUDE_TOPICS = new Set([
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
  'onex.evt.omniclaude.pattern-enforcement.v1',
  SUFFIX_OMNICLAUDE_CONTEXT_ENRICHMENT,
  SUFFIX_OMNICLAUDE_LLM_ROUTING_DECISION,
  SUFFIX_OMNICLAUDE_TASK_DELEGATED,
  SUFFIX_OMNICLAUDE_DELEGATION_SHADOW_COMPARISON,
  SUFFIX_OMNICLAUDE_GATE_DECISION,
  SUFFIX_OMNICLAUDE_EPIC_RUN_UPDATED,
  SUFFIX_OMNICLAUDE_PR_WATCH_UPDATED,
  SUFFIX_OMNICLAUDE_BUDGET_CAP_HIT,
  SUFFIX_OMNICLAUDE_CIRCUIT_BREAKER_TRIPPED,
  SUFFIX_OMNICLAUDE_CORRELATION_TRACE,
  SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
  SUFFIX_OMNICLAUDE_PHASE_METRICS,
  SUFFIX_OMNICLAUDE_DEBUG_TRIGGER_RECORD,
  SUFFIX_OMNICLAUDE_SKILL_STARTED,
  SUFFIX_OMNICLAUDE_SKILL_COMPLETED,
  SUFFIX_OMNICLAUDE_HOSTILE_REVIEWER_COMPLETED,
  SUFFIX_OMNICLAUDE_CONTEXT_UTILIZATION,
  SUFFIX_OMNICLAUDE_AGENT_MATCH,
  SUFFIX_OMNICLAUDE_LATENCY_BREAKDOWN,
  SUFFIX_OMNICLAUDE_TASK_ASSIGNED,
  SUFFIX_OMNICLAUDE_TASK_PROGRESS,
  SUFFIX_OMNICLAUDE_TASK_COMPLETED,
  SUFFIX_OMNICLAUDE_EVIDENCE_WRITTEN,
]);

/** Shared extraction aggregator instance for context-utilization, agent-match, latency-breakdown */
const extractionAggregator = new ExtractionMetricsAggregator();

export class OmniclaudeProjectionHandler implements ProjectionHandler {
  readonly stats: ProjectionHandlerStats = createHandlerStats();

  constructor() {
    registerHandlerStats('OmniclaudeProjectionHandler', this.stats);
  }

  canHandle(topic: string): boolean {
    return OMNICLAUDE_TOPICS.has(topic);
  }

  async projectEvent(
    topic: string,
    data: Record<string, unknown>,
    context: ProjectionContext,
    meta: MessageMeta
  ): Promise<boolean> {
    this.stats.received++;
    const result = await this._dispatch(topic, data, context, meta);
    if (result) {
      this.stats.projected++;
    } else {
      this.stats.dropped.db_unavailable++;
    }
    return result;
  }

  private async _dispatch(
    topic: string,
    data: Record<string, unknown>,
    context: ProjectionContext,
    meta: MessageMeta
  ): Promise<boolean> {
    const { fallbackId } = meta;

    switch (topic) {
      case TOPIC_OMNICLAUDE_ROUTING_DECISIONS:
        return this.projectRoutingDecision(data, fallbackId, context);
      case TOPIC_OMNICLAUDE_AGENT_ACTIONS:
        return this.projectAgentAction(data, fallbackId, context);
      case TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION:
        return this.projectTransformationEvent(data, context);
      case TOPIC_OMNICLAUDE_PERFORMANCE_METRICS:
        // Performance metrics: in-memory only (EventConsumer), no durable projection.
        return true;
      case 'onex.evt.omniclaude.pattern-enforcement.v1':
        return this.projectEnforcementEvent(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_CONTEXT_ENRICHMENT:
        return this.projectEnrichmentEvent(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_LLM_ROUTING_DECISION:
        return this.projectLlmRoutingDecisionEvent(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_TASK_DELEGATED:
        return this.projectTaskDelegatedEvent(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_DELEGATION_SHADOW_COMPARISON:
        return this.projectDelegationShadowComparisonEvent(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_GATE_DECISION:
        return this.projectGateDecisionEvent(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_EPIC_RUN_UPDATED:
        return this.projectEpicRunUpdatedEvent(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_PR_WATCH_UPDATED:
        return this.projectPrWatchUpdatedEvent(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_BUDGET_CAP_HIT:
        return this.projectBudgetCapHitEvent(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_CIRCUIT_BREAKER_TRIPPED:
        return this.projectCircuitBreakerTrippedEvent(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_CORRELATION_TRACE:
        return this.projectCorrelationTrace(data, context);
      case SUFFIX_OMNICLAUDE_SESSION_OUTCOME:
        return this.projectSessionOutcome(data, context);
      case SUFFIX_OMNICLAUDE_PHASE_METRICS:
        return this.projectPhaseMetrics(data, context);
      case SUFFIX_OMNICLAUDE_DEBUG_TRIGGER_RECORD:
        return this.projectDebugTriggerRecord(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_SKILL_STARTED:
        return this.projectSkillStarted(data, context);
      case SUFFIX_OMNICLAUDE_SKILL_COMPLETED:
        return this.projectSkillCompleted(data, context);
      case SUFFIX_OMNICLAUDE_HOSTILE_REVIEWER_COMPLETED:
        return this.projectHostileReviewerCompleted(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_CONTEXT_UTILIZATION:
        return this.projectContextUtilization(data, meta);
      case SUFFIX_OMNICLAUDE_AGENT_MATCH:
        return this.projectAgentMatch(data, meta);
      case SUFFIX_OMNICLAUDE_LATENCY_BREAKDOWN:
        return this.projectLatencyBreakdown(data, meta);
      case SUFFIX_OMNICLAUDE_TASK_ASSIGNED:
      case SUFFIX_OMNICLAUDE_TASK_PROGRESS:
      case SUFFIX_OMNICLAUDE_TASK_COMPLETED:
      case SUFFIX_OMNICLAUDE_EVIDENCE_WRITTEN:
        return this.projectTeamEvent(topic, data, fallbackId, context);
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Team events -> team_events (OMN-7036)
  // -------------------------------------------------------------------------

  private async projectTeamEvent(
    topic: string,
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    // Derive event_type from topic: e.g. "onex.evt.omniclaude.task-assigned.v1" -> "task-assigned"
    const topicParts = topic.split('.');
    const eventType = topicParts[topicParts.length - 2] || topic;

    const eventId = (data.event_id as string) || (data.eventId as string) || fallbackId;
    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;

    try {
      await db.execute(sql`
        INSERT INTO team_events (event_id, correlation_id, task_id, event_type, dispatch_surface, agent_model, status, payload, emitted_at)
        VALUES (
          ${eventId},
          ${correlationId},
          ${(data.task_id as string) || (data.taskId as string) || ''},
          ${eventType},
          ${(data.dispatch_surface as string) || (data.dispatchSurface as string) || 'unknown'},
          ${(data.agent_model as string) || (data.agentModel as string) || null},
          ${(data.status as string) || null},
          ${data.payload ? JSON.stringify(data.payload) : null},
          ${safeParseDate((data.emitted_at as string) || (data.emittedAt as string) || (data.timestamp as string))}
        )
        ON CONFLICT (event_id) DO NOTHING
      `);
      return true;
    } catch (err) {
      if (isTableMissingError(err, 'team_events')) return false;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Routing decisions -> agent_routing_decisions
  // -------------------------------------------------------------------------

  private async projectRoutingDecision(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const row: InsertAgentRoutingDecision = {
      correlationId:
        (data.correlation_id as string) || (data.correlationId as string) || fallbackId,
      sessionId: sanitizeSessionId(
        (data.session_id as string | null | undefined) ??
          (data.sessionId as string | null | undefined),
        { correlationId: (data.correlation_id as string) || (data.correlationId as string) }
      ),
      userRequest:
        (data.user_request as string) ||
        (data.userRequest as string) ||
        (data.prompt_preview as string) ||
        '',
      userRequestHash:
        (data.user_request_hash as string) || (data.userRequestHash as string) || undefined,
      contextSnapshot: data.context_snapshot || data.contextSnapshot || undefined,
      selectedAgent: (data.selected_agent as string) || (data.selectedAgent as string) || 'unknown',
      confidenceScore: String(
        data.confidence_score ?? data.confidenceScore ?? data.confidence ?? 0
      ),
      routingStrategy:
        (data.routing_strategy as string) || (data.routingStrategy as string) || 'unknown',
      triggerConfidence:
        data.trigger_confidence != null ? String(data.trigger_confidence) : undefined,
      contextConfidence:
        data.context_confidence != null ? String(data.context_confidence) : undefined,
      capabilityConfidence:
        data.capability_confidence != null ? String(data.capability_confidence) : undefined,
      historicalConfidence:
        data.historical_confidence != null ? String(data.historical_confidence) : undefined,
      alternatives: data.alternatives || undefined,
      reasoning: (data.reasoning as string) || undefined,
      routingTimeMs: Number(data.routing_time_ms ?? data.routingTimeMs ?? 0),
      cacheHit: Boolean(data.cache_hit ?? data.cacheHit ?? false),
      selectionValidated: Boolean(data.selection_validated ?? data.selectionValidated ?? false),
      actualSuccess: data.actual_success != null ? Boolean(data.actual_success) : undefined,
      executionSucceeded:
        data.execution_succeeded != null ? Boolean(data.execution_succeeded) : undefined,
      actualQualityScore:
        data.actual_quality_score != null ? String(data.actual_quality_score) : undefined,
      createdAt: safeParseDate(data.created_at),
    };

    await db
      .insert(agentRoutingDecisions)
      .values(row)
      .onConflictDoNothing({ target: agentRoutingDecisions.correlationId });

    return true;
  }

  // -------------------------------------------------------------------------
  // Agent actions -> agent_actions
  // -------------------------------------------------------------------------

  private async projectAgentAction(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const row: InsertAgentAction = {
      correlationId:
        (data.correlation_id as string) || (data.correlationId as string) || fallbackId,
      agentName: (data.agent_name as string) || (data.agentName as string) || 'unknown',
      actionType: (data.action_type as string) || (data.actionType as string) || 'unknown',
      actionName: (data.action_name as string) || (data.actionName as string) || 'unknown',
      actionDetails: data.action_details || data.actionDetails || {},
      debugMode: Boolean(data.debug_mode ?? data.debugMode ?? true),
      durationMs:
        data.duration_ms != null
          ? Number(data.duration_ms)
          : data.durationMs != null
            ? Number(data.durationMs)
            : undefined,
      createdAt: safeParseDate(data.created_at),
    };

    await db
      .insert(agentActions)
      .values(row)
      .onConflictDoNothing({ target: agentActions.correlationId });

    return true;
  }

  // -------------------------------------------------------------------------
  // Transformation events -> agent_transformation_events
  // -------------------------------------------------------------------------

  private async projectTransformationEvent(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const row: InsertAgentTransformationEvent = {
      sourceAgent: (data.source_agent as string) || (data.sourceAgent as string) || 'unknown',
      targetAgent: (data.target_agent as string) || (data.targetAgent as string) || 'unknown',
      transformationReason:
        (data.transformation_reason as string) ||
        (data.transformationReason as string) ||
        undefined,
      confidenceScore: data.confidence_score != null ? String(data.confidence_score) : undefined,
      transformationDurationMs:
        data.transformation_duration_ms != null
          ? Number(data.transformation_duration_ms)
          : undefined,
      success: Boolean(data.success ?? true),
      createdAt: safeParseDate(data.created_at),
      projectPath: (data.project_path as string) || (data.projectPath as string) || undefined,
      projectName: (data.project_name as string) || (data.projectName as string) || undefined,
      claudeSessionId:
        (data.claude_session_id as string) || (data.claudeSessionId as string) || undefined,
    };

    await db
      .insert(agentTransformationEvents)
      .values(row)
      .onConflictDoNothing({
        target: [
          agentTransformationEvents.sourceAgent,
          agentTransformationEvents.targetAgent,
          agentTransformationEvents.createdAt,
        ],
      });

    return true;
  }

  // -------------------------------------------------------------------------
  // Pattern enforcement -> pattern_enforcement_events
  // -------------------------------------------------------------------------

  private async projectEnforcementEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const evt = data as Partial<PatternEnforcementEvent>;
    const correlationId =
      (evt.correlation_id as string) || (data.correlationId as string) || fallbackId;

    if (evt.outcome == null) {
      console.warn(
        '[ReadModelConsumer] Enforcement event missing required "outcome" field ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true;
    }
    const outcome = evt.outcome;
    if (!['hit', 'violation', 'corrected', 'false_positive'].includes(outcome)) {
      console.warn('[ReadModelConsumer] Unknown enforcement outcome:', outcome, '-- skipping');
      return true;
    }

    const patternName = (evt.pattern_name as string) || (data.patternName as string);
    if (!patternName) {
      console.warn(
        '[ReadModelConsumer] Enforcement event missing required "pattern_name" field ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true;
    }

    let insertedRowCount = 0;
    try {
      const result = await db.execute(sql`
        INSERT INTO pattern_enforcement_events (
          correlation_id, session_id, repo, language, domain,
          pattern_name, pattern_lifecycle_state, outcome, confidence,
          agent_name, created_at
        ) VALUES (
          ${correlationId},
          ${(evt.session_id as string) ?? null},
          ${(evt.repo as string) ?? null},
          ${(evt.language as string) ?? 'unknown'},
          ${(evt.domain as string) ?? 'unknown'},
          ${patternName},
          ${(evt.pattern_lifecycle_state as string) ?? null},
          ${outcome},
          ${evt.confidence != null ? Number(evt.confidence) : null},
          ${(evt.agent_name as string) ?? null},
          ${safeParseDate(evt.timestamp)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
      const rawRowCount = (result as unknown as Record<string, unknown>).rowCount;
      if (typeof rawRowCount === 'number') {
        insertedRowCount = rawRowCount;
      } else {
        console.warn(
          `[ReadModelConsumer] enforcement INSERT: rowCount not found in result shape -- WebSocket invalidation suppressed. Actual type: ${typeof rawRowCount}`
        );
        insertedRowCount = 0;
      }
    } catch (err) {
      if (isTableMissingError(err, 'pattern_enforcement_events')) {
        console.warn(
          '[ReadModelConsumer] pattern_enforcement_events table not yet created -- ' +
            'run migrations to enable enforcement projection'
        );
        return true;
      }
      throw err;
    }

    if (insertedRowCount > 0) {
      try {
        emitEnforcementInvalidate(correlationId);
      } catch (e) {
        console.warn('[ReadModelConsumer] emitEnforcementInvalidate() failed post-commit:', e);
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Context enrichment -> context_enrichment_events
  // -------------------------------------------------------------------------

  private async projectEnrichmentEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const evt = data as Partial<ContextEnrichmentEvent>;
    const correlationId =
      (evt.correlation_id as string) || (data.correlationId as string) || fallbackId;

    const outcome = evt.outcome;
    if (outcome == null) {
      console.warn(
        '[ReadModelConsumer] Enrichment event missing required "outcome" field ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true;
    }
    if (!(ENRICHMENT_OUTCOMES as readonly string[]).includes(outcome)) {
      console.warn('[ReadModelConsumer] Unknown enrichment outcome:', outcome, '-- skipping');
      return true;
    }

    const channel = evt.channel as string | undefined;
    if (!channel) {
      console.warn(
        '[ReadModelConsumer] Enrichment event missing required "channel" field ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true;
    }

    let insertedRowCount = 0;
    try {
      const result = await db.execute(sql`
        INSERT INTO context_enrichment_events (
          correlation_id, session_id, channel, model_name, cache_hit,
          outcome, latency_ms, tokens_before, tokens_after,
          net_tokens_saved, similarity_score, quality_score,
          repo, agent_name, created_at
        ) VALUES (
          ${correlationId},
          ${(evt.session_id as string) ?? null},
          ${channel},
          ${(evt.model_name as string) ?? 'unknown'},
          ${Boolean(evt.cache_hit ?? false)},
          ${outcome},
          ${Number.isNaN(Number(evt.latency_ms)) ? 0 : Math.round(Number(evt.latency_ms ?? 0))},
          ${Number.isNaN(Number(evt.tokens_before)) ? 0 : Math.round(Number(evt.tokens_before ?? 0))},
          ${Number.isNaN(Number(evt.tokens_after)) ? 0 : Math.round(Number(evt.tokens_after ?? 0))},
          ${Number.isNaN(Number(evt.net_tokens_saved)) ? 0 : Math.round(Number(evt.net_tokens_saved ?? 0))},
          ${evt.similarity_score != null && !Number.isNaN(Number(evt.similarity_score)) ? Number(evt.similarity_score) : null},
          ${evt.quality_score != null && !Number.isNaN(Number(evt.quality_score)) ? Number(evt.quality_score) : null},
          ${(evt.repo as string) ?? null},
          ${(evt.agent_name as string) ?? null},
          ${safeParseDate(evt.timestamp)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
      const rawRowCount = (result as unknown as Record<string, unknown>).rowCount;
      if (typeof rawRowCount === 'number') {
        insertedRowCount = rawRowCount;
      } else {
        console.error(
          `[ReadModelConsumer] enrichment INSERT: rowCount not found in result shape -- WebSocket invalidation suppressed. Shape may have changed. Actual type of rawRowCount: ${typeof rawRowCount}`
        );
        insertedRowCount = 0;
      }
    } catch (err) {
      if (isTableMissingError(err, 'context_enrichment_events')) {
        console.warn(
          '[ReadModelConsumer] context_enrichment_events table not yet created -- ' +
            'run migrations to enable enrichment projection'
        );
        return true;
      }
      throw err;
    }

    if (insertedRowCount > 0) {
      try {
        emitEnrichmentInvalidate(correlationId);
      } catch (e) {
        console.warn('[ReadModelConsumer] emitEnrichmentInvalidate() failed post-commit:', e);
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // LLM routing decisions -> llm_routing_decisions
  // -------------------------------------------------------------------------

  private async projectLlmRoutingDecisionEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const evt = data as Partial<LlmRoutingDecisionEvent>;

    const rawCorrelationId =
      (evt.correlation_id as string) || (data.correlationId as string) || fallbackId;
    if (!UUID_RE.test(rawCorrelationId)) {
      console.warn(
        '[ReadModelConsumer] LLM routing decision event has non-UUID correlation_id ' +
          `(${rawCorrelationId}) -- skipping malformed event`
      );
      return true;
    }
    const correlationId = rawCorrelationId;

    const llmAgent =
      (data.selected_agent as string) ||
      (data.llm_selected_candidate as string) ||
      (evt.llm_agent as string) ||
      (data.llmAgent as string);
    const fuzzyAgent =
      (data.fuzzy_top_candidate as string | null) ??
      (evt.fuzzy_agent as string) ??
      (data.fuzzyAgent as string) ??
      null;

    if (!llmAgent) {
      console.warn(
        '[ReadModelConsumer] LLM routing decision event missing required llm_agent/selected_agent field ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true;
    }

    const routingPromptVersion =
      (evt.routing_prompt_version as string) || (data.routingPromptVersion as string) || 'unknown';

    const usedFallback = Boolean(
      (data.fallback_used as boolean | undefined) ??
      (evt.used_fallback as boolean | undefined) ??
      false
    );

    // OMN-2920: fallbacks are routing failures -- skip projection
    if (usedFallback) {
      return true;
    }

    const model = (data.model_used as string | null) ?? (evt.model as string | null) ?? null;
    const eventTimestamp =
      (data.emitted_at as string | null) ?? (evt.timestamp as string | null) ?? null;

    const agreement =
      evt.agreement != null
        ? Boolean(evt.agreement)
        : fuzzyAgent != null
          ? llmAgent === fuzzyAgent
          : usedFallback;

    const promptTokens = Number(evt.prompt_tokens ?? 0);
    const completionTokens = Number(evt.completion_tokens ?? 0);
    const rawTotalTokens = Number(evt.total_tokens ?? 0);
    const totalTokens =
      rawTotalTokens === 0 && (promptTokens > 0 || completionTokens > 0)
        ? promptTokens + completionTokens
        : rawTotalTokens;
    const omninodeEnabled = evt.omninode_enabled !== false;

    try {
      await db.execute(sql`
        INSERT INTO llm_routing_decisions (
          correlation_id, session_id, llm_agent, fuzzy_agent, agreement,
          llm_confidence, fuzzy_confidence, llm_latency_ms, fuzzy_latency_ms,
          used_fallback, routing_prompt_version, intent, model, cost_usd,
          prompt_tokens, completion_tokens, total_tokens, omninode_enabled,
          created_at
        ) VALUES (
          ${correlationId},
          ${(evt.session_id as string) ?? null},
          ${llmAgent},
          ${fuzzyAgent ?? null},
          ${agreement},
          ${evt.llm_confidence != null && !Number.isNaN(Number(evt.llm_confidence)) ? Number(evt.llm_confidence) : null},
          ${evt.fuzzy_confidence != null && !Number.isNaN(Number(evt.fuzzy_confidence)) ? Number(evt.fuzzy_confidence) : null},
          ${Number.isNaN(Number(evt.llm_latency_ms)) ? 0 : Math.round(Number(evt.llm_latency_ms ?? 0))},
          ${Number.isNaN(Number(evt.fuzzy_latency_ms)) ? 0 : Math.round(Number(evt.fuzzy_latency_ms ?? 0))},
          ${usedFallback},
          ${routingPromptVersion},
          ${(evt.intent as string) ?? null},
          ${model},
          ${evt.cost_usd != null && !Number.isNaN(Number(evt.cost_usd)) ? Number(evt.cost_usd) : null},
          ${promptTokens},
          ${completionTokens},
          ${totalTokens},
          ${omninodeEnabled},
          ${safeParseDate(eventTimestamp)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      if (isTableMissingError(err, 'llm_routing_decisions')) {
        console.warn(
          '[ReadModelConsumer] llm_routing_decisions table not yet created -- ' +
            'run migrations to enable LLM routing projection'
        );
        return true;
      }
      throw err;
    }

    try {
      llmRoutingProjection.invalidateCache();
    } catch (e) {
      console.warn(
        '[read-model-consumer] llmRoutingProjection.invalidateCache() failed post-commit:',
        e
      );
    }

    emitLlmRoutingInvalidate(correlationId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Task delegation -> delegation_events
  // -------------------------------------------------------------------------

  private async projectTaskDelegatedEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const evt = data as Partial<TaskDelegatedEvent>;
    const correlationId =
      (evt.correlation_id as string) || (data.correlationId as string) || fallbackId;

    const taskType = (evt.task_type as string) || (data.taskType as string);
    const delegatedTo = (evt.delegated_to as string) || (data.delegatedTo as string);
    if (!taskType || !delegatedTo) {
      console.warn(
        '[ReadModelConsumer] task-delegated event missing required fields ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true;
    }

    const row: InsertDelegationEvent = {
      correlationId,
      sessionId: (evt.session_id as string) || (data.sessionId as string) || null,
      timestamp: safeParseDate(evt.timestamp),
      taskType,
      delegatedTo,
      delegatedBy: (evt.delegated_by as string) || (data.delegatedBy as string) || null,
      qualityGatePassed: Boolean(evt.quality_gate_passed ?? data.qualityGatePassed ?? false),
      qualityGatesChecked:
        evt.quality_gates_checked ??
        (data.qualityGatesChecked as string[] | null | undefined) ??
        null,
      qualityGatesFailed:
        evt.quality_gates_failed ??
        (data.qualityGatesFailed as string[] | null | undefined) ??
        null,
      costUsd: (() => {
        const v = evt.cost_usd ?? data.costUsd;
        return v != null && !Number.isNaN(Number(v)) ? String(Number(v)) : null;
      })(),
      costSavingsUsd: (() => {
        const v = evt.cost_savings_usd ?? data.costSavingsUsd;
        return v != null && !Number.isNaN(Number(v)) ? String(Number(v)) : null;
      })(),
      delegationLatencyMs: (() => {
        const v = evt.delegation_latency_ms ?? data.delegationLatencyMs;
        return v != null && !Number.isNaN(Number(v)) ? Math.round(Number(v)) : null;
      })(),
      repo: (evt.repo as string) || (data.repo as string) || null,
      isShadow: Boolean(evt.is_shadow ?? data.isShadow ?? false),
    };

    try {
      await db
        .insert(delegationEvents)
        .values(row)
        .onConflictDoNothing({ target: delegationEvents.correlationId });
    } catch (err) {
      if (isTableMissingError(err, 'delegation_events')) {
        console.warn(
          '[ReadModelConsumer] delegation_events table not yet created -- ' +
            'run migrations to enable delegation projection'
        );
        return true;
      }
      throw err;
    }

    emitDelegationInvalidate(correlationId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Delegation shadow comparison -> delegation_shadow_comparisons
  // -------------------------------------------------------------------------

  private async projectDelegationShadowComparisonEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const evt = data as Partial<DelegationShadowComparisonEvent>;
    const correlationId =
      (evt.correlation_id as string) || (data.correlationId as string) || fallbackId;

    const taskType = (evt.task_type as string) || (data.taskType as string);
    const primaryAgent = (evt.primary_agent as string) || (data.primaryAgent as string);
    const shadowAgent = (evt.shadow_agent as string) || (data.shadowAgent as string);
    if (!taskType || !primaryAgent || !shadowAgent) {
      console.warn(
        '[ReadModelConsumer] delegation-shadow-comparison event missing required fields ' +
          `(correlation_id=${correlationId}) -- skipping malformed event`
      );
      return true;
    }

    const row: InsertDelegationShadowComparison = {
      correlationId,
      sessionId: (evt.session_id as string) || (data.sessionId as string) || null,
      timestamp: safeParseDate(evt.timestamp),
      taskType,
      primaryAgent,
      shadowAgent,
      divergenceDetected: Boolean(evt.divergence_detected ?? data.divergenceDetected ?? false),
      divergenceScore: (() => {
        const v = evt.divergence_score ?? data.divergenceScore;
        return v != null && !Number.isNaN(Number(v)) ? String(Number(v)) : null;
      })(),
      primaryLatencyMs: (() => {
        const v = evt.primary_latency_ms ?? data.primaryLatencyMs;
        return v != null && !Number.isNaN(Number(v)) ? Math.round(Number(v)) : null;
      })(),
      shadowLatencyMs: (() => {
        const v = evt.shadow_latency_ms ?? data.shadowLatencyMs;
        return v != null && !Number.isNaN(Number(v)) ? Math.round(Number(v)) : null;
      })(),
      primaryCostUsd: (() => {
        const v = evt.primary_cost_usd ?? data.primaryCostUsd;
        return v != null && !Number.isNaN(Number(v)) ? String(Number(v)) : null;
      })(),
      shadowCostUsd: (() => {
        const v = evt.shadow_cost_usd ?? data.shadowCostUsd;
        return v != null && !Number.isNaN(Number(v)) ? String(Number(v)) : null;
      })(),
      divergenceReason:
        (evt.divergence_reason as string) || (data.divergenceReason as string) || null,
    };

    try {
      await db
        .insert(delegationShadowComparisons)
        .values(row)
        .onConflictDoNothing({ target: delegationShadowComparisons.correlationId });
    } catch (err) {
      if (isTableMissingError(err, 'delegation_shadow_comparisons')) {
        console.warn(
          '[ReadModelConsumer] delegation_shadow_comparisons table not yet created -- ' +
            'run migrations to enable delegation shadow projection'
        );
        return true;
      }
      throw err;
    }

    emitDelegationInvalidate(correlationId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Gate decisions -> gate_decisions
  // -------------------------------------------------------------------------

  private async projectGateDecisionEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;

    try {
      await db.execute(sql`
        INSERT INTO gate_decisions (
          correlation_id, session_id, pr_number, repo, gate_name,
          outcome, blocking, details, created_at
        ) VALUES (
          ${correlationId},
          ${(data.session_id as string) ?? null},
          ${data.pr_number != null ? Number(data.pr_number) : null},
          ${(data.repo as string) ?? null},
          ${(data.gate_name as string) ?? 'unknown'},
          ${(data.outcome as string) ?? 'unknown'},
          ${Boolean(data.blocking ?? false)},
          ${data.details != null ? JSON.stringify(data.details) : null},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      if (isTableMissingError(err, 'gate_decisions')) {
        console.warn(
          '[ReadModelConsumer] gate_decisions table not yet created -- ' +
            'run migrations to enable gate decision projection'
        );
        return true;
      }
      throw err;
    }

    emitGateDecisionInvalidate(correlationId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Epic run updates -> epic_run_events / epic_run_lease
  // -------------------------------------------------------------------------

  private async projectEpicRunUpdatedEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;
    // Emitter sends run_id, DB column is epic_run_id
    const epicRunId =
      (data.run_id as string) ||
      (data.epic_run_id as string) ||
      (data.epicRunId as string) ||
      correlationId;
    // Emitter sends status, DB column is event_type — map status to event_type
    const eventType =
      (data.status as string) ??
      (data.event_type as string) ??
      (data.eventType as string) ??
      'unknown';
    // epic_id is available from emitter — store in ticket_id column as the
    // closest semantic match (the epic identifier being tracked)
    const ticketId =
      (data.epic_id as string) ?? (data.ticket_id as string) ?? (data.ticketId as string) ?? null;
    // Build a summary payload from emitter fields not mapped to columns
    const summaryPayload: Record<string, unknown> = {};
    if (data.tickets_total != null) summaryPayload.tickets_total = data.tickets_total;
    if (data.tickets_completed != null) summaryPayload.tickets_completed = data.tickets_completed;
    if (data.tickets_failed != null) summaryPayload.tickets_failed = data.tickets_failed;
    if (data.phase != null) summaryPayload.phase = data.phase;
    const payloadJson =
      data.payload != null
        ? JSON.stringify(data.payload)
        : Object.keys(summaryPayload).length > 0
          ? JSON.stringify(summaryPayload)
          : null;

    try {
      await db.execute(sql`
        INSERT INTO epic_run_events (
          correlation_id, epic_run_id, event_type, ticket_id,
          repo, payload, created_at
        ) VALUES (
          ${correlationId},
          ${epicRunId},
          ${eventType},
          ${ticketId},
          ${(data.repo as string) ?? null},
          ${payloadJson},
          ${safeParseDate(data.emitted_at ?? data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);

      if (data.lease_holder != null || data.leaseHolder != null) {
        const leaseHolder =
          (data.lease_holder as string) || (data.leaseHolder as string) || 'unknown';
        const leaseExpiresAt = data.lease_expires_at ?? data.leaseExpiresAt;
        await db.execute(sql`
          INSERT INTO epic_run_lease (
            epic_run_id, lease_holder, lease_expires_at, updated_at
          ) VALUES (
            ${epicRunId},
            ${leaseHolder},
            ${leaseExpiresAt != null ? safeParseDate(leaseExpiresAt) : null},
            ${safeParseDate(data.timestamp ?? data.created_at)}
          )
          ON CONFLICT (epic_run_id) DO UPDATE SET
            lease_holder = EXCLUDED.lease_holder,
            lease_expires_at = EXCLUDED.lease_expires_at,
            updated_at = EXCLUDED.updated_at
        `);
      }
    } catch (err) {
      if (
        isTableMissingError(err, 'epic_run_events') ||
        isTableMissingError(err, 'epic_run_lease')
      ) {
        console.warn(
          '[ReadModelConsumer] epic_run_events/epic_run_lease tables not yet created -- ' +
            'run migrations to enable epic run projection'
        );
        return true;
      }
      throw err;
    }

    emitEpicRunInvalidate(epicRunId);
    return true;
  }

  // -------------------------------------------------------------------------
  // PR watch updates -> pr_watch_state
  // -------------------------------------------------------------------------

  private async projectPrWatchUpdatedEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;

    // Build metadata from emitter fields not mapped to columns
    const metadata: Record<string, unknown> = {};
    if (data.run_id != null) metadata.run_id = data.run_id;
    if (data.ticket_id != null) metadata.ticket_id = data.ticket_id;
    if (data.review_cycles_used != null) metadata.review_cycles_used = data.review_cycles_used;
    if (data.watch_duration_hours != null)
      metadata.watch_duration_hours = data.watch_duration_hours;
    const existingMetadata = data.metadata != null ? data.metadata : null;
    const metadataJson = existingMetadata
      ? JSON.stringify(existingMetadata)
      : Object.keys(metadata).length > 0
        ? JSON.stringify(metadata)
        : null;

    try {
      await db.execute(sql`
        INSERT INTO pr_watch_state (
          correlation_id, pr_number, repo, state,
          checks_status, review_status, metadata, created_at
        ) VALUES (
          ${correlationId},
          ${data.pr_number != null ? Number(data.pr_number) : null},
          ${(data.repo as string) ?? null},
          ${(data.status as string) ?? (data.state as string) ?? 'unknown'},
          ${(data.checks_status as string) ?? (data.checksStatus as string) ?? null},
          ${(data.review_status as string) ?? (data.reviewStatus as string) ?? null},
          ${metadataJson},
          ${safeParseDate(data.emitted_at ?? data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      if (isTableMissingError(err, 'pr_watch_state')) {
        console.warn(
          '[ReadModelConsumer] pr_watch_state table not yet created -- ' +
            'run migrations to enable PR watch projection'
        );
        return true;
      }
      throw err;
    }

    emitPrWatchInvalidate(correlationId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Budget cap hits -> pipeline_budget_state
  // -------------------------------------------------------------------------

  private async projectBudgetCapHitEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;
    const pipelineId = (data.pipeline_id as string) || (data.pipelineId as string) || correlationId;

    try {
      await db.execute(sql`
        INSERT INTO pipeline_budget_state (
          correlation_id, pipeline_id, budget_type, cap_value,
          current_value, cap_hit, repo, created_at
        ) VALUES (
          ${correlationId},
          ${pipelineId},
          ${(data.budget_type as string) ?? (data.budgetType as string) ?? 'tokens'},
          ${data.cap_value != null ? Number(data.cap_value) : null},
          ${data.current_value != null ? Number(data.current_value) : null},
          ${Boolean(data.cap_hit ?? data.capHit ?? true)},
          ${(data.repo as string) ?? null},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      if (isTableMissingError(err, 'pipeline_budget_state')) {
        console.warn(
          '[ReadModelConsumer] pipeline_budget_state table not yet created -- ' +
            'run migrations to enable pipeline budget projection'
        );
        return true;
      }
      throw err;
    }

    emitPipelineBudgetInvalidate(correlationId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Circuit breaker trips -> debug_escalation_counts
  // -------------------------------------------------------------------------

  private async projectCircuitBreakerTrippedEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;

    try {
      await db.execute(sql`
        INSERT INTO debug_escalation_counts (
          correlation_id, session_id, agent_name, escalation_count,
          window_start, window_end, tripped, repo, created_at
        ) VALUES (
          ${correlationId},
          ${(data.session_id as string) ?? null},
          ${(data.agent_name as string) ?? (data.agentName as string) ?? 'unknown'},
          ${data.escalation_count != null ? Number(data.escalation_count) : 1},
          ${data.window_start != null ? safeParseDate(data.window_start) : null},
          ${data.window_end != null ? safeParseDate(data.window_end) : null},
          ${Boolean(data.tripped ?? true)},
          ${(data.repo as string) ?? null},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      if (isTableMissingError(err, 'debug_escalation_counts')) {
        console.warn(
          '[ReadModelConsumer] debug_escalation_counts table not yet created -- ' +
            'run migrations to enable circuit breaker projection'
        );
        return true;
      }
      throw err;
    }

    emitCircuitBreakerInvalidate(correlationId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Correlation trace spans -> correlation_trace_spans (OMN-5047)
  // -------------------------------------------------------------------------

  private async projectCorrelationTrace(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const traceId = (data.trace_id as string) || (data.traceId as string);
    const spanId = (data.span_id as string) || (data.spanId as string);
    if (!traceId || !spanId) {
      console.warn('[ReadModelConsumer] correlation-trace missing trace_id or span_id -- skipping');
      return true;
    }

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || traceId;

    const startedAt = safeParseDate(data.started_at ?? data.startedAt);
    const endedAtRaw = data.ended_at ?? data.endedAt;
    const endedAt = endedAtRaw ? safeParseDate(endedAtRaw) : null;
    const durationMs =
      typeof (data.duration_ms ?? data.durationMs) === 'number'
        ? ((data.duration_ms ?? data.durationMs) as number)
        : endedAt
          ? endedAt.getTime() - startedAt.getTime()
          : null;

    try {
      await db
        .insert(correlationTraceSpans)
        .values({
          traceId,
          spanId,
          parentSpanId: (data.parent_span_id as string) || (data.parentSpanId as string) || null,
          correlationId,
          sessionId: sanitizeSessionId(
            (data.session_id as string | null | undefined) ??
              (data.sessionId as string | null | undefined),
            { correlationId }
          ),
          spanKind: (data.span_kind as string) || (data.spanKind as string) || 'internal',
          spanName: (data.span_name as string) || (data.spanName as string) || 'unknown',
          status: (data.status as string) || 'ok',
          startedAt,
          endedAt,
          durationMs,
          metadata: data.metadata || {},
        })
        .onConflictDoNothing();

      return true;
    } catch (err) {
      if (isTableMissingError(err, 'correlation_trace_spans')) {
        console.warn(
          '[ReadModelConsumer] correlation_trace_spans table not yet created -- ' +
            'run migrations to enable trace span projection'
        );
        return true;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Session outcomes -> session_outcomes (OMN-5184)
  // -------------------------------------------------------------------------

  private async projectSessionOutcome(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    // Try multiple field name patterns for session identifier.
    // Producers may use snake_case (session_id), camelCase (sessionId),
    // or the event may carry only a correlation_id at the envelope level.
    const sessionId =
      (data.session_id as string) ||
      (data.sessionId as string) ||
      (data.correlation_id as string) ||
      (data.correlationId as string) ||
      (data._correlation_id as string) || // from envelope unwrap
      '';

    if (!sessionId) {
      // Log actual keys to help diagnose future mismatches
      const keys = Object.keys(data)
        .filter((k) => !k.startsWith('_'))
        .sort()
        .join(', ');
      console.warn(
        `[ReadModelConsumer] session-outcome event missing session_id -- skipping. ` +
          `Available keys: [${keys}]`
      );
      return true;
    }

    const outcome = (data.outcome as string) || 'unknown';
    const emittedAt = safeParseDate(
      data.emitted_at ?? data.emittedAt ?? data.timestamp ?? data.created_at
    );

    try {
      await db
        .insert(sessionOutcomes)
        .values({
          sessionId,
          outcome,
          emittedAt,
        })
        .onConflictDoUpdate({
          target: sessionOutcomes.sessionId,
          set: {
            outcome: sql`EXCLUDED.outcome`,
            emittedAt: sql`EXCLUDED.emitted_at`,
            ingestedAt: sql`NOW()`,
          },
        });

      return true;
    } catch (err) {
      if (isTableMissingError(err, 'session_outcomes')) {
        console.warn(
          '[ReadModelConsumer] session_outcomes table not yet created -- ' +
            'run migrations to enable session outcome projection'
        );
        return true;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Phase metrics -> phase_metrics_events (OMN-5184)
  // -------------------------------------------------------------------------

  private async projectPhaseMetrics(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const sessionId = (data.session_id as string) || (data.sessionId as string);
    if (!sessionId) {
      console.warn('[ReadModelConsumer] phase-metrics event missing session_id -- skipping');
      return true;
    }

    const phase = (data.phase as string) || 'unknown';
    const status = (data.status as string) || 'unknown';
    const durationMs = Number(data.duration_ms ?? data.durationMs ?? 0);
    const ticketId = (data.ticket_id as string | null) || (data.ticketId as string | null) || null;
    const emittedAt = safeParseDate(
      data.emitted_at ?? data.emittedAt ?? data.timestamp ?? data.created_at
    );

    try {
      await db
        .insert(phaseMetricsEvents)
        .values({
          sessionId,
          ticketId,
          phase,
          status,
          durationMs,
          emittedAt,
        })
        .onConflictDoNothing();

      return true;
    } catch (err) {
      if (isTableMissingError(err, 'phase_metrics_events')) {
        console.warn(
          '[ReadModelConsumer] phase_metrics_events table not yet created -- ' +
            'run migrations to enable phase metrics projection'
        );
        return true;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Debug trigger records -> debug_trigger_records (OMN-5282)
  // -------------------------------------------------------------------------

  private async projectDebugTriggerRecord(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;

    try {
      await db.execute(sql`
        INSERT INTO debug_trigger_records (
          correlation_id, session_id, agent_name, trigger_reason,
          workflow, repo, created_at
        ) VALUES (
          ${correlationId},
          ${(data.session_id as string) ?? null},
          ${(data.agent_name as string) ?? (data.agentName as string) ?? 'unknown'},
          ${(data.trigger_reason as string) ?? (data.triggerReason as string) ?? null},
          ${(data.workflow as string) ?? null},
          ${(data.repo as string) ?? null},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      if (isTableMissingError(err, 'debug_trigger_records')) {
        console.warn(
          '[ReadModelConsumer] debug_trigger_records table not yet created -- ' +
            'run migrations to enable debug trigger record projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Skill invocations -> skill_invocations
  // Consumes both skill-started.v1 (INSERT) and skill-completed.v1 (UPDATE)
  // -------------------------------------------------------------------------

  private async projectSkillStarted(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const db = context.db;
    if (!db) return false;

    const skillName = String(data.skill_name ?? data.skillName ?? '');
    const sessionId =
      (data.session_id as string | null) ?? (data.sessionId as string | null) ?? null;
    const emittedAt = safeParseDate(
      data.emitted_at ?? data.emittedAt ?? data.started_at ?? data.timestamp ?? data.created_at
    );

    try {
      await db.insert(skillInvocations).values({
        skillName,
        sessionId,
        durationMs: null,
        success: true,
        status: 'running',
        error: null,
        emittedAt,
      });
    } catch (err: unknown) {
      if (isTableMissingError(err, 'skill_invocations')) return true;
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') return true;
      throw err;
    }
    return true;
  }

  private async projectSkillCompleted(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const db = context.db;
    if (!db) return false;

    const skillName = String(data.skill_name ?? data.skillName ?? '');
    const sessionId =
      (data.session_id as string | null) ?? (data.sessionId as string | null) ?? null;
    const durationMs =
      data.duration_ms != null
        ? Number(data.duration_ms)
        : data.durationMs != null
          ? Number(data.durationMs)
          : null;
    const isSuccess = data.success !== false;

    const rawStatus = (data.status as string | null) ?? (isSuccess ? 'success' : 'failed');
    const status = ['success', 'failed', 'partial'].includes(rawStatus)
      ? rawStatus
      : isSuccess
        ? 'success'
        : 'failed';

    const emittedAt = safeParseDate(
      data.emitted_at ?? data.emittedAt ?? data.completed_at ?? data.timestamp ?? data.created_at
    );
    const errorText = (data.error as string | null) ?? (data.errorMessage as string | null) ?? null;

    try {
      // Try to update matching started row first
      if (sessionId && skillName) {
        const updated = await db
          .update(skillInvocations)
          .set({ durationMs, success: isSuccess, status, error: errorText })
          .where(
            sql`${skillInvocations.sessionId} = ${sessionId} AND ${skillInvocations.skillName} = ${skillName} AND ${skillInvocations.status} = 'running'`
          );
        const rowCount = (updated as unknown as { rowCount?: number }).rowCount ?? 0;
        if (rowCount > 0) return true;
      }

      // No matching started row — insert directly (handles out-of-order or replay)
      await db.insert(skillInvocations).values({
        skillName,
        sessionId,
        durationMs,
        success: isSuccess,
        status,
        error: errorText,
        emittedAt,
      });
    } catch (err: unknown) {
      if (isTableMissingError(err, 'skill_invocations')) return true;
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') return true;
      throw err;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Hostile reviewer completed -> hostile_reviewer_runs (OMN-5864)
  // -------------------------------------------------------------------------

  private async projectHostileReviewerCompleted(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const eventId = (data.event_id as string) || (data.eventId as string) || fallbackId;
    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || eventId;

    // Serialize arrays as JSON for safe parameterized insertion (no sql.raw needed).
    // PostgreSQL casts json text[] via ::text[] on the jsonb_array_elements_text result.
    const modelsAttemptedJson = JSON.stringify(
      ((data.models_attempted as string[]) || []).map(String)
    );
    const modelsSucceededJson = JSON.stringify(
      ((data.models_succeeded as string[]) || []).map(String)
    );

    try {
      await db.execute(sql`
        INSERT INTO hostile_reviewer_runs (
          event_id, correlation_id, mode, target,
          models_attempted, models_succeeded, verdict,
          total_findings, critical_count, major_count, created_at
        ) VALUES (
          ${eventId},
          ${correlationId},
          ${(data.mode as string) ?? 'unknown'},
          ${(data.target as string) ?? 'unknown'},
          (SELECT COALESCE(array_agg(elem), ARRAY[]::text[]) FROM jsonb_array_elements_text(${modelsAttemptedJson}::jsonb) AS elem),
          (SELECT COALESCE(array_agg(elem), ARRAY[]::text[]) FROM jsonb_array_elements_text(${modelsSucceededJson}::jsonb) AS elem),
          ${(data.verdict as string) ?? 'unknown'},
          ${Number(data.total_findings ?? 0)},
          ${Number(data.critical_count ?? data.criticalCount ?? 0)},
          ${Number(data.major_count ?? data.majorCount ?? 0)},
          ${safeParseDate(data.emitted_at ?? data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (event_id) DO NOTHING
      `);
    } catch (err) {
      if (isTableMissingError(err, 'hostile_reviewer_runs')) {
        console.warn(
          '[ReadModelConsumer] hostile_reviewer_runs table not yet created -- ' +
            'run migrations to enable hostile reviewer projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Extraction pipeline events -> injection_effectiveness / latency_breakdowns
  // Delegates to ExtractionMetricsAggregator (OMN-6154)
  // -------------------------------------------------------------------------

  private async projectContextUtilization(
    data: Record<string, unknown>,
    _meta: MessageMeta
  ): Promise<boolean> {
    if (!isContextUtilizationEvent(data)) {
      console.warn(
        '[ReadModelConsumer] context-utilization event missing required fields -- skipping malformed event'
      );
      return true;
    }
    try {
      await extractionAggregator.handleContextUtilization(data);
    } catch (err) {
      if (isTableMissingError(err, 'injection_effectiveness')) {
        console.warn(
          '[ReadModelConsumer] injection_effectiveness table not yet created -- ' +
            'run migrations to enable extraction projection'
        );
        return true;
      }
      throw err;
    }
    return true;
  }

  private async projectAgentMatch(
    data: Record<string, unknown>,
    _meta: MessageMeta
  ): Promise<boolean> {
    if (!isAgentMatchEvent(data)) {
      console.warn(
        '[ReadModelConsumer] agent-match event missing required fields -- skipping malformed event'
      );
      return true;
    }
    try {
      await extractionAggregator.handleAgentMatch(data);
    } catch (err) {
      if (isTableMissingError(err, 'injection_effectiveness')) {
        console.warn(
          '[ReadModelConsumer] injection_effectiveness table not yet created -- ' +
            'run migrations to enable extraction projection'
        );
        return true;
      }
      throw err;
    }
    return true;
  }

  private async projectLatencyBreakdown(
    data: Record<string, unknown>,
    _meta: MessageMeta
  ): Promise<boolean> {
    if (!isLatencyBreakdownEvent(data)) {
      // Log actual keys to help diagnose future mismatches (OMN-6392)
      const keys = Object.keys(data)
        .filter((k) => !k.startsWith('_'))
        .sort()
        .join(', ');
      console.warn(
        `[ReadModelConsumer] latency-breakdown event failed guard -- skipping. ` +
          `Available keys: [${keys}]`
      );
      return true;
    }

    // Normalize camelCase fields to snake_case for the aggregator (OMN-6392).
    // The type guard now accepts both forms, but the DB column names are snake_case.
    const normalized: Record<string, unknown> = { ...data };
    if (!normalized.session_id && normalized.sessionId) {
      normalized.session_id = normalized.sessionId;
    }
    if (!normalized.prompt_id && normalized.promptId) {
      normalized.prompt_id = normalized.promptId;
    }
    if (!normalized.cohort) {
      normalized.cohort = 'unknown';
    }

    try {
      await extractionAggregator.handleLatencyBreakdown(
        normalized as unknown as import('@shared/extraction-types').LatencyBreakdownEvent
      );
    } catch (err) {
      if (isTableMissingError(err, 'latency_breakdowns')) {
        console.warn(
          '[ReadModelConsumer] latency_breakdowns table not yet created -- ' +
            'run migrations to enable extraction projection'
        );
        return true;
      }
      throw err;
    }
    return true;
  }
}
