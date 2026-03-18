/**
 * OmniIntelligence domain projection handlers (OMN-5192).
 *
 * Projects events from omniintelligence topics into the omnidash_analytics read-model:
 * - LLM call completed -> llm_cost_aggregates
 * - Pattern projection -> pattern_learning_artifacts (upsert)
 * - Pattern lifecycle transitioned -> pattern_learning_artifacts (update)
 * - Pattern learning requested -> pattern_learning_artifacts (insert pending)
 * - Plan review strategy run -> plan_review_runs
 * - Run evaluated -> objective_evaluations / objective_gate_failures
 */

import crypto from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import {
  llmCostAggregates,
  patternLearningArtifacts,
  planReviewRuns,
  intentDriftEvents,
  routingFeedbackEvents,
  complianceEvaluations,
} from '@shared/intelligence-schema';
import type {
  InsertLlmCostAggregate,
  InsertPatternLearningArtifact,
  InsertIntentDrift,
  InsertRoutingFeedbackEvent,
  InsertComplianceEvaluation,
} from '@shared/intelligence-schema';
import {
  TOPIC_OMNIINTELLIGENCE_LLM_CALL_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_PROJECTION,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
  TOPIC_INTELLIGENCE_PLAN_REVIEW_STRATEGY_RUN_COMPLETED,
  SUFFIX_INTELLIGENCE_RUN_EVALUATED,
  SUFFIX_INTELLIGENCE_INTENT_DRIFT_DETECTED,
  SUFFIX_INTELLIGENCE_CI_DEBUG_ESCALATION,
  SUFFIX_INTELLIGENCE_ROUTING_FEEDBACK_PROCESSED,
  SUFFIX_INTELLIGENCE_COMPLIANCE_EVALUATED,
  SUFFIX_INTELLIGENCE_CONTEXT_EFFECTIVENESS,
} from '@shared/topics';
import { emitEffectivenessUpdate } from '../../effectiveness-events';
import {
  PatternProjectionEventSchema,
  PatternLifecycleTransitionedEventSchema,
  PatternLearningRequestedEventSchema,
  validateEvent,
} from '@shared/event-schemas';

import type { ProjectionHandler, ProjectionContext, MessageMeta } from './types';
import { safeParseDate, isTableMissingError, UUID_RE } from './types';

const OMNIINTELLIGENCE_TOPICS = new Set([
  TOPIC_OMNIINTELLIGENCE_LLM_CALL_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_PROJECTION,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
  TOPIC_INTELLIGENCE_PLAN_REVIEW_STRATEGY_RUN_COMPLETED,
  SUFFIX_INTELLIGENCE_RUN_EVALUATED,
  SUFFIX_INTELLIGENCE_INTENT_DRIFT_DETECTED,
  SUFFIX_INTELLIGENCE_CI_DEBUG_ESCALATION,
  SUFFIX_INTELLIGENCE_ROUTING_FEEDBACK_PROCESSED,
  SUFFIX_INTELLIGENCE_COMPLIANCE_EVALUATED,
  SUFFIX_INTELLIGENCE_CONTEXT_EFFECTIVENESS,
]);

export class OmniintelligenceProjectionHandler implements ProjectionHandler {
  canHandle(topic: string): boolean {
    return OMNIINTELLIGENCE_TOPICS.has(topic);
  }

  async projectEvent(
    topic: string,
    data: Record<string, unknown>,
    context: ProjectionContext,
    meta: MessageMeta
  ): Promise<boolean> {
    const { fallbackId } = meta;

    switch (topic) {
      case TOPIC_OMNIINTELLIGENCE_LLM_CALL_COMPLETED:
        return this.projectLlmCostEvent(data, context);
      case SUFFIX_INTELLIGENCE_PATTERN_PROJECTION: {
        const validated = validateEvent(PatternProjectionEventSchema, data, topic);
        if (!validated) return true; // Malformed event -- skip (advance watermark, don't retry)
        return this.projectPatternProjectionEvent(data, fallbackId, context);
      }
      case SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED: {
        const validated = validateEvent(PatternLifecycleTransitionedEventSchema, data, topic);
        if (!validated) return true; // Malformed event -- skip
        return this.projectPatternLifecycleTransitionedEvent(data, fallbackId, context);
      }
      case SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD: {
        const validated = validateEvent(PatternLearningRequestedEventSchema, data, topic);
        if (!validated) return true; // Malformed event -- skip
        return this.projectPatternLearningRequestedEvent(data, fallbackId, context);
      }
      case TOPIC_INTELLIGENCE_PLAN_REVIEW_STRATEGY_RUN_COMPLETED:
        return this.projectPlanReviewStrategyRunEvent(data, fallbackId, context);
      case SUFFIX_INTELLIGENCE_RUN_EVALUATED:
        return this.projectRunEvaluated(data, fallbackId, context);
      case SUFFIX_INTELLIGENCE_INTENT_DRIFT_DETECTED:
        return this.projectIntentDriftDetected(data, context);
      case SUFFIX_INTELLIGENCE_CI_DEBUG_ESCALATION:
        return this.projectCiDebugEscalation(data, fallbackId, context);
      case SUFFIX_INTELLIGENCE_ROUTING_FEEDBACK_PROCESSED:
        return this.projectRoutingFeedbackProcessed(data, context);
      case SUFFIX_INTELLIGENCE_COMPLIANCE_EVALUATED:
        return this.projectComplianceEvaluated(data, context);
      case SUFFIX_INTELLIGENCE_CONTEXT_EFFECTIVENESS:
        return this.projectContextEffectiveness(context);
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // LLM call completed -> llm_cost_aggregates (OMN-2371)
  // -------------------------------------------------------------------------

  private async projectLlmCostEvent(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const bucketTime = safeParseDate(
      data.timestamp_iso ?? data.bucket_time ?? data.bucketTime ?? data.timestamp ?? data.created_at
    );

    const usageNormalized = data.usage_normalized as Record<string, unknown> | null | undefined;
    const usageSourceRaw =
      (usageNormalized?.source as string) ||
      (data.usage_source as string) ||
      (data.usageSource as string) ||
      (data.usage_is_estimated ? 'ESTIMATED' : 'API');
    const usageSourceUpper = usageSourceRaw.toUpperCase();
    const validUsageSources = ['API', 'ESTIMATED', 'MISSING'] as const;
    const usageSource = validUsageSources.includes(
      usageSourceUpper as (typeof validUsageSources)[number]
    )
      ? (usageSourceUpper as 'API' | 'ESTIMATED' | 'MISSING')
      : 'API';
    if (
      !validUsageSources.includes(usageSourceUpper as (typeof validUsageSources)[number]) &&
      usageSourceRaw
    ) {
      console.warn(
        `[ReadModelConsumer] LLM cost event has unrecognised usage_source "${usageSourceRaw}" -- defaulting to "API"`
      );
    }

    const granularityRaw = (data.granularity as string) || 'hour';
    const granularity = ['hour', 'day'].includes(granularityRaw) ? granularityRaw : 'hour';

    const promptTokens = Number(data.prompt_tokens ?? data.promptTokens ?? 0);
    const completionTokens = Number(data.completion_tokens ?? data.completionTokens ?? 0);
    const rawTotalTokens = Number(data.total_tokens ?? data.totalTokens ?? 0);
    const derivedTotal = promptTokens + completionTokens;

    let totalTokens: number;
    if (rawTotalTokens === 0 && derivedTotal > 0) {
      totalTokens = derivedTotal;
    } else {
      if (rawTotalTokens !== 0 && derivedTotal !== 0 && rawTotalTokens !== derivedTotal) {
        console.warn(
          `[ReadModelConsumer] LLM cost event token total mismatch: ` +
            `total_tokens=${rawTotalTokens} but prompt_tokens(${promptTokens}) + completion_tokens(${completionTokens}) = ${derivedTotal}. ` +
            `Storing event-supplied total.`
        );
      }
      totalTokens = rawTotalTokens;
    }

    const rawEstimatedCost = data.estimated_cost_usd ?? data.estimatedCostUsd;
    const nEstimatedCost = Number(rawEstimatedCost);
    const estimatedCostUsd = String(Number.isFinite(nEstimatedCost) ? nEstimatedCost : 0);

    const rawTotalCost = data.total_cost_usd ?? data.totalCostUsd ?? rawEstimatedCost;
    const nTotalCost = Number(rawTotalCost);
    const totalCostUsd = String(Number.isFinite(nTotalCost) ? nTotalCost : 0);

    const rawReportedCost = data.reported_cost_usd ?? data.reportedCostUsd;
    const nReportedCost = Number(rawReportedCost);
    const reportedCostUsd = String(Number.isFinite(nReportedCost) ? nReportedCost : 0);

    const modelName =
      (data.model_id as string) ||
      (data.model_name as string) ||
      (data.modelName as string) ||
      'unknown';

    const reportingSource = (data.reporting_source as string) || (data.reportingSource as string);
    const explicitRepo = (data.repo_name as string) || (data.repoName as string);
    const repoName =
      explicitRepo ||
      (reportingSource && reportingSource.length < 64 && !/\s/.test(reportingSource)
        ? reportingSource
        : undefined);

    const row: InsertLlmCostAggregate = {
      bucketTime,
      granularity,
      modelName,
      repoName,
      patternId: (data.pattern_id as string) || (data.patternId as string) || undefined,
      patternName: (data.pattern_name as string) || (data.patternName as string) || undefined,
      sessionId: (data.session_id as string) || (data.sessionId as string) || undefined,
      usageSource,
      requestCount: Number(data.request_count ?? data.requestCount ?? 1),
      promptTokens,
      completionTokens,
      totalTokens,
      totalCostUsd,
      reportedCostUsd,
      estimatedCostUsd,
    };

    if (row.modelName === 'unknown') {
      console.warn(
        '[ReadModelConsumer] LLM cost event missing model_id/model_name -- inserting as "unknown"'
      );
    }

    try {
      await db.insert(llmCostAggregates).values(row);
    } catch (err) {
      if (isTableMissingError(err, 'llm_cost_aggregates')) {
        console.warn(
          '[ReadModelConsumer] llm_cost_aggregates table not yet created -- ' +
            'run migrations to enable LLM cost projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Pattern projection -> pattern_learning_artifacts (OMN-2924)
  // -------------------------------------------------------------------------

  private async projectPatternProjectionEvent(
    data: Record<string, unknown>,
    _fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const rawPatterns = data.patterns;
    if (!Array.isArray(rawPatterns) || rawPatterns.length === 0) {
      return true;
    }

    try {
      for (const pattern of rawPatterns as Record<string, unknown>[]) {
        const patternId =
          (pattern.id as string) || (pattern.pattern_id as string) || (pattern.patternId as string);
        if (!patternId) {
          console.warn('[ReadModelConsumer] Pattern projection item missing id -- skipping item');
          continue;
        }

        const patternName =
          (pattern.domain_id as string) ||
          (pattern.pattern_name as string) ||
          (pattern.patternName as string) ||
          'unknown';

        const patternType =
          (pattern.pattern_type as string) || (pattern.patternType as string) || 'unknown';

        const lifecycleState =
          (pattern.status as string) ||
          (pattern.lifecycle_state as string) ||
          (pattern.lifecycleState as string) ||
          'candidate';

        const compositeScore = String(
          pattern.quality_score ?? pattern.composite_score ?? pattern.compositeScore ?? 0
        );

        const scoringEvidence = pattern.scoring_evidence ?? pattern.scoringEvidence ?? {};
        const signature = pattern.signature ?? { hash: pattern.signature_hash ?? '' };
        const metrics = pattern.metrics ?? {};
        const metadata = pattern.metadata ?? {};

        const row: InsertPatternLearningArtifact = {
          patternId,
          patternName,
          patternType,
          lifecycleState,
          compositeScore,
          scoringEvidence,
          signature,
          metrics,
          metadata,
          updatedAt: safeParseDate(data.snapshot_at ?? data.snapshotAt),
          projectedAt: new Date(),
        };

        await db
          .insert(patternLearningArtifacts)
          .values(row)
          .onConflictDoUpdate({
            target: patternLearningArtifacts.patternId,
            set: {
              patternName: row.patternName,
              patternType: row.patternType,
              lifecycleState: row.lifecycleState,
              compositeScore: row.compositeScore,
              scoringEvidence: row.scoringEvidence,
              signature: row.signature,
              metrics: row.metrics,
              metadata: row.metadata,
              updatedAt: row.updatedAt,
              projectedAt: row.projectedAt,
            },
          });
      }
    } catch (err) {
      if (isTableMissingError(err, 'pattern_learning_artifacts')) {
        console.warn(
          '[ReadModelConsumer] pattern_learning_artifacts table not yet created -- ' +
            'run migrations to enable pattern projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Pattern lifecycle transitioned -> pattern_learning_artifacts (OMN-2924)
  // -------------------------------------------------------------------------

  private async projectPatternLifecycleTransitionedEvent(
    data: Record<string, unknown>,
    _fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const patternId = (data.pattern_id as string) || (data.patternId as string);
    if (!patternId) {
      console.warn(
        '[ReadModelConsumer] Pattern lifecycle transitioned event missing pattern_id -- skipping'
      );
      return true;
    }

    const toStatus = (data.to_status as string) || (data.toStatus as string);
    if (!toStatus) {
      console.warn(
        `[ReadModelConsumer] Pattern lifecycle transitioned event for ${patternId} ` +
          'missing to_status -- skipping'
      );
      return true;
    }

    const transitionedAt = safeParseDate(
      data.transitioned_at ?? data.transitionedAt ?? data.timestamp ?? data.created_at
    );

    try {
      const result = await db
        .update(patternLearningArtifacts)
        .set({
          lifecycleState: toStatus,
          stateChangedAt: transitionedAt,
          updatedAt: new Date(),
        })
        .where(eq(patternLearningArtifacts.patternId, patternId))
        .returning({ id: patternLearningArtifacts.id });

      if (result.length === 0) {
        console.debug(
          `[ReadModelConsumer] pattern-lifecycle-transitioned: no row found for pattern_id=${patternId} ` +
            '-- skipping (projection snapshot may not have arrived yet)'
        );
      }
    } catch (err) {
      if (isTableMissingError(err, 'pattern_learning_artifacts')) {
        console.warn(
          '[ReadModelConsumer] pattern_learning_artifacts table not yet created -- ' +
            'run migrations to enable pattern lifecycle projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Pattern learning requested -> pattern_learning_artifacts (OMN-2920)
  // -------------------------------------------------------------------------

  private async projectPatternLearningRequestedEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;
    if (!UUID_RE.test(correlationId)) {
      console.warn(
        `[ReadModelConsumer] PatternLearningRequested: correlation_id "${correlationId}" is not a ` +
          'valid UUID -- skipping row'
      );
      return true;
    }

    const sessionId = (data.session_id as string) || (data.sessionId as string) || null;
    const trigger = (data.trigger as string) || 'unknown';
    const requestedAt = safeParseDate(data.timestamp ?? data.created_at);

    try {
      await db.execute(sql`
        INSERT INTO pattern_learning_artifacts (
          pattern_id, pattern_name, pattern_type, lifecycle_state,
          composite_score, scoring_evidence, signature, metrics,
          metadata, created_at, updated_at, projected_at
        )
        SELECT
          ${correlationId}::uuid,
          ${'learning_requested'}::varchar(255),
          ${'pipeline_request'}::varchar(100),
          ${'requested'}::text,
          ${0}::numeric(10,6),
          ${{}}::jsonb,
          ${{ session_id: sessionId, trigger }}::jsonb,
          ${{}}::jsonb,
          ${{ source: 'PatternLearningRequested', trigger, session_id: sessionId }}::jsonb,
          ${requestedAt},
          ${requestedAt},
          ${new Date()}
        WHERE NOT EXISTS (
          SELECT 1 FROM pattern_learning_artifacts WHERE pattern_id = ${correlationId}::uuid
        )
      `);
    } catch (err) {
      if (isTableMissingError(err, 'pattern_learning_artifacts')) {
        console.warn(
          '[ReadModelConsumer] pattern_learning_artifacts table not yet created -- ' +
            'run migrations to enable pattern learning request projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Plan review strategy run -> plan_review_runs (OMN-3324)
  // -------------------------------------------------------------------------

  private async projectPlanReviewStrategyRunEvent(
    parsed: unknown,
    _fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    try {
      if (!parsed || typeof parsed !== 'object') return false;
      const e = parsed as Record<string, unknown>;

      const runId = typeof e.run_id === 'string' && e.run_id ? e.run_id : null;
      const strategy = typeof e.strategy === 'string' && e.strategy ? e.strategy : null;
      const planTextHash = typeof e.plan_text_hash === 'string' ? e.plan_text_hash : '';
      if (!runId || !strategy) {
        console.warn('[plan-reviewer] missing required fields run_id/strategy, skipping');
        return false;
      }

      const rawEmitted = typeof e.emitted_at === 'string' ? new Date(e.emitted_at) : null;
      const emittedAt = rawEmitted && !isNaN(rawEmitted.getTime()) ? rawEmitted : new Date();

      await db
        .insert(planReviewRuns)
        .values({
          eventId: typeof e.event_id === 'string' ? e.event_id : crypto.randomUUID(),
          runId,
          strategy,
          modelsUsed: Array.isArray(e.models_used) ? e.models_used.map(String) : [],
          planTextHash,
          findingsCount: typeof e.findings_count === 'number' ? e.findings_count : 0,
          blocksCount: typeof e.blocks_count === 'number' ? e.blocks_count : 0,
          categoriesWithFindings: Array.isArray(e.categories_with_findings)
            ? e.categories_with_findings.map(String)
            : [],
          categoriesClean: Array.isArray(e.categories_clean) ? e.categories_clean.map(String) : [],
          avgConfidence: typeof e.avg_confidence === 'number' ? e.avg_confidence : null,
          tokensUsed: typeof e.tokens_used === 'number' ? e.tokens_used : null,
          durationMs: typeof e.duration_ms === 'number' ? e.duration_ms : null,
          strategyRunStored: Boolean(e.strategy_run_stored),
          modelWeights:
            e.model_weights && typeof e.model_weights === 'object'
              ? (e.model_weights as Record<string, unknown>)
              : {},
          emittedAt,
        })
        .onConflictDoNothing();

      return true;
    } catch (err) {
      console.error('[plan-reviewer] projection error:', err);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Run evaluated -> objective_evaluations / objective_gate_failures (OMN-5048)
  // -------------------------------------------------------------------------

  private async projectRunEvaluated(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const runId = (data.run_id as string) || (data.runId as string);
    if (!runId) {
      console.warn('[ReadModelConsumer] run-evaluated missing run_id -- skipping');
      return true;
    }

    const sessionId = (data.session_id as string) || (data.sessionId as string) || '';
    const agentName = (data.agent_name as string) || (data.agentName as string) || 'unknown';
    const taskClass = (data.task_class as string) || (data.taskClass as string) || 'default';
    const bundleFingerprint =
      (data.bundle_fingerprint as string) || (data.bundleFingerprint as string) || fallbackId;
    const passed = Boolean(data.passed);
    const failures = Array.isArray(data.failures) ? (data.failures as string[]) : [];
    const scoreCorrectness =
      typeof data.score_correctness === 'number' ? data.score_correctness : 0;
    const scoreSafety = typeof data.score_safety === 'number' ? data.score_safety : 0;
    const scoreCost = typeof data.score_cost === 'number' ? data.score_cost : 0;
    const scoreLatency = typeof data.score_latency === 'number' ? data.score_latency : 0;
    const scoreMaintainability =
      typeof data.score_maintainability === 'number' ? data.score_maintainability : 0;
    const scoreHumanTime = typeof data.score_human_time === 'number' ? data.score_human_time : 0;
    const evaluatedAt =
      (data.evaluated_at_utc as string) ||
      (data.evaluatedAtUtc as string) ||
      (data.evaluated_at as string) ||
      new Date().toISOString();

    try {
      const evalResult = await db.execute<{ id: string }>(sql`
        INSERT INTO objective_evaluations (
          run_id, session_id, agent_name, task_class, bundle_fingerprint,
          passed, failures,
          score_correctness, score_safety, score_cost, score_latency,
          score_maintainability, score_human_time, evaluated_at
        ) VALUES (
          ${runId}, ${sessionId}, ${agentName}, ${taskClass}, ${bundleFingerprint},
          ${passed}, ${failures},
          ${scoreCorrectness}, ${scoreSafety}, ${scoreCost}, ${scoreLatency},
          ${scoreMaintainability}, ${scoreHumanTime}, ${evaluatedAt}
        )
        ON CONFLICT (run_id, bundle_fingerprint) DO UPDATE SET
          evaluated_at = EXCLUDED.evaluated_at
        RETURNING id
      `);

      if (!passed && failures.length > 0 && evalResult.rows && evalResult.rows.length > 0) {
        const evaluationId = evalResult.rows[0].id;
        for (const gateId of failures) {
          await db.execute(sql`
            INSERT INTO objective_gate_failures (
              occurred_at, gate_type, session_id, agent_name,
              evaluation_id, attribution_refs, score_value, threshold
            ) VALUES (
              ${evaluatedAt}, ${gateId}, ${sessionId}, ${agentName},
              ${evaluationId}::uuid, '[]'::jsonb, ${0.0}, ${0.5}
            )
          `);
        }
      }

      return true;
    } catch (err) {
      if (isTableMissingError(err, 'objective_evaluations')) {
        console.warn(
          '[ReadModelConsumer] objective_evaluations table not yet created -- ' +
            'run migrations to enable objective evaluation projection'
        );
        return true;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Intent drift detected -> intent_drift_events (OMN-5281)
  // -------------------------------------------------------------------------

  private async projectIntentDriftDetected(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const row: InsertIntentDrift = {
      sessionId: (data.session_id as string) || (data.sessionId as string) || null,
      originalIntent: (data.original_intent as string) || (data.originalIntent as string) || null,
      currentIntent: (data.current_intent as string) || (data.currentIntent as string) || null,
      driftScore:
        typeof data.drift_score === 'number'
          ? data.drift_score
          : typeof data.driftScore === 'number'
            ? data.driftScore
            : null,
      severity: (data.severity as string) || null,
    };

    try {
      await db.insert(intentDriftEvents).values(row);
    } catch (err) {
      if (isTableMissingError(err, 'intent_drift_events')) {
        console.warn(
          '[ReadModelConsumer] intent_drift_events table not yet created -- ' +
            'run migrations to enable intent drift projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // CI debug escalation -> ci_debug_escalation_events (OMN-5282)
  // -------------------------------------------------------------------------

  private async projectCiDebugEscalation(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const runId = (data.run_id as string) || (data.runId as string) || fallbackId;
    const nodeId = (data.node_id as string) || (data.nodeId as string) || 'unknown';

    try {
      await db.execute(sql`
        INSERT INTO ci_debug_escalation_events (
          run_id, node_id, error_type, escalation_level, resolution, event_timestamp
        ) VALUES (
          ${runId},
          ${nodeId},
          ${(data.error_type as string) ?? (data.errorType as string) ?? 'unknown'},
          ${(data.escalation_level as string) ?? (data.escalationLevel as string) ?? 'low'},
          ${(data.resolution as string) ?? null},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (run_id, node_id) DO UPDATE SET
          error_type = EXCLUDED.error_type,
          escalation_level = EXCLUDED.escalation_level,
          resolution = EXCLUDED.resolution,
          event_timestamp = EXCLUDED.event_timestamp
      `);
    } catch (err) {
      if (isTableMissingError(err, 'ci_debug_escalation_events')) {
        console.warn(
          '[ReadModelConsumer] ci_debug_escalation_events table not yet created -- ' +
            'run migrations to enable CI debug escalation projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Routing feedback processed -> routing_feedback_events (OMN-5284)
  // -------------------------------------------------------------------------

  private async projectRoutingFeedbackProcessed(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    /** Parse a numeric field, returning null for NaN/Infinity. */
    const safeNum = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const agentId = String(data.agent_id ?? data.agentId ?? '').trim();
    const feedbackType = String(data.feedback_type ?? data.feedbackType ?? '').trim();
    const originalRoute = String(data.original_route ?? data.originalRoute ?? '').trim();

    if (!agentId || !feedbackType || !originalRoute) {
      console.warn(
        '[ReadModelConsumer] routing-feedback-processed missing required fields (agent_id, feedback_type, original_route)'
      );
      return true;
    }

    const row: InsertRoutingFeedbackEvent = {
      agentId,
      feedbackType,
      originalRoute,
      correctedRoute:
        data.corrected_route != null
          ? String(data.corrected_route)
          : data.correctedRoute != null
            ? String(data.correctedRoute)
            : null,
      accuracyScore:
        data.accuracy_score != null
          ? safeNum(data.accuracy_score)
          : data.accuracyScore != null
            ? safeNum(data.accuracyScore)
            : null,
    };

    try {
      await db.insert(routingFeedbackEvents).values(row);
      console.log(`[ReadModelConsumer] Projected routing-feedback for agent ${agentId}`);
    } catch (err) {
      if (isTableMissingError(err, 'routing_feedback_events')) {
        console.warn(
          '[ReadModelConsumer] routing_feedback_events table not yet created -- ' +
            'run migrations to enable routing feedback projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Compliance evaluated -> compliance_evaluations (OMN-5285)
  // -------------------------------------------------------------------------

  private async projectComplianceEvaluated(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const evaluationId = String(data.evaluation_id ?? data.evaluationId ?? '').trim();
    const repo = String(data.repo ?? '').trim();
    const ruleSet = String(data.rule_set ?? data.ruleSet ?? '').trim();

    if (!evaluationId || !repo || !ruleSet) {
      console.warn(
        '[ReadModelConsumer] compliance-evaluated missing required fields (evaluation_id, repo, rule_set)'
      );
      return true;
    }

    const score = Number(data.score ?? 0);
    const pass = Boolean(data.pass ?? false);
    const violations = Array.isArray(data.violations) ? data.violations : [];
    const eventTimestamp = safeParseDate(
      data.event_timestamp ?? data.eventTimestamp ?? data.timestamp
    );

    if (!eventTimestamp) {
      console.warn('[ReadModelConsumer] compliance-evaluated missing event_timestamp');
      return true;
    }

    const row: InsertComplianceEvaluation = {
      evaluationId,
      repo,
      ruleSet,
      score,
      violations,
      pass,
      eventTimestamp,
    };

    try {
      await db
        .insert(complianceEvaluations)
        .values(row)
        .onConflictDoNothing({ target: complianceEvaluations.evaluationId });
      console.log(
        `[ReadModelConsumer] Projected compliance evaluation ${evaluationId} for ${repo}`
      );
    } catch (err) {
      if (isTableMissingError(err, 'compliance_evaluations')) {
        console.warn(
          '[ReadModelConsumer] compliance_evaluations table not yet created -- ' +
            'run migrations to enable compliance projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  /**
   * Context effectiveness event (OMN-5286).
   *
   * The injection_effectiveness table is populated directly by omniintelligence
   * and queried by ContextEffectivenessProjection. This handler acknowledges the
   * event (advances the watermark) so the topic coverage gate passes.
   * The projection's TTL-based refresh picks up the new data on the next
   * ensureFresh() call without requiring explicit cache invalidation.
   */

  private async projectContextEffectiveness(_context: ProjectionContext): Promise<boolean> {
    // No read-model write required — ContextEffectivenessProjection queries
    // injection_effectiveness directly via its own TTL-based refresh cycle.
    // Emit effectiveness update so WebSocket clients receive fresh data immediately
    // rather than waiting for TTL expiry (mirrors emitEnrichmentInvalidate pattern).
    try {
      emitEffectivenessUpdate();
    } catch (e) {
      console.warn('[ReadModelConsumer] emitEffectivenessUpdate() failed post-commit:', e);
    }
    return true;
  }
}
