/**
 * OmniIntelligence domain projection handlers (OMN-5192).
 *
 * Projects events from omniintelligence topics into the omnidash_analytics read-model:
 * - LLM call completed -> llm_cost_aggregates
 * - Pattern projection -> pattern_learning_artifacts (upsert) + pattern_quality_metrics (upsert)
 * - Pattern lifecycle transitioned -> pattern_learning_artifacts (update) + pattern_lifecycle_transitions (insert)
 * - Pattern learning requested -> pattern_learning_artifacts (insert pending)
 * - Plan review strategy run -> plan_review_runs
 * - Run evaluated -> objective_evaluations / objective_gate_failures
 * - Episode boundary -> rl_episodes (upsert by episode_id)
 */

import crypto from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import {
  llmCostAggregates,
  patternLearningArtifacts,
  patternQualityMetrics,
  patternLifecycleTransitions,
  planReviewRuns,
  intentDriftEvents,
  routingFeedbackEvents,
  complianceEvaluations,
  rlEpisodes,
  reviewCalibrationRuns,
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
  SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED,
  SUFFIX_INTELLIGENCE_INTENT_DRIFT_DETECTED,
  SUFFIX_INTELLIGENCE_CI_DEBUG_ESCALATION,
  SUFFIX_INTELLIGENCE_ROUTING_FEEDBACK_PROCESSED,
  SUFFIX_INTELLIGENCE_COMPLIANCE_EVALUATED,
  SUFFIX_INTELLIGENCE_CONTEXT_EFFECTIVENESS,
  SUFFIX_INTELLIGENCE_EPISODE_BOUNDARY,
  SUFFIX_INTELLIGENCE_CALIBRATION_RUN_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_PROMOTED,
  SUFFIX_INTELLIGENCE_PATTERN_STORED,
  SUFFIX_PATTERN_DISCOVERED,
  SUFFIX_INTELLIGENCE_EVAL_COMPLETED,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED,
} from '@shared/topics';
import { emitEffectivenessUpdate } from '../../effectiveness-events';
import {
  PatternProjectionEventSchema,
  PatternLifecycleTransitionedEventSchema,
  PatternLearningRequestedEventSchema,
  validateEvent,
} from '@shared/event-schemas';

import type {
  ProjectionHandler,
  ProjectionContext,
  MessageMeta,
  ProjectionHandlerStats,
} from './types';
import {
  safeParseDate,
  isTableMissingError,
  UUID_RE,
  createHandlerStats,
  registerHandlerStats,
} from './types';

// -------------------------------------------------------------------------
// Pattern signature display-name derivation (OMN-5644)
// -------------------------------------------------------------------------

/**
 * Derive a human-readable display name and type from a raw pattern_signature.
 *
 * Signature format: "type_prefix::sub_type: details..."
 * Examples:
 *   "file_access_pattern::co_access: /path/a, /path/b"
 *     -> displayName: "File Access: Co-Access"
 *        patternTypeFromSig: "file_access_pattern"
 *
 *   "tool_sequence_pattern::Read,Edit: common editing flow"
 *     -> displayName: "Tool Sequence: Read, Edit"
 *        patternTypeFromSig: "tool_sequence_pattern"
 */
function derivePatternDisplayName(signature: string): {
  displayName: string;
  patternTypeFromSig: string;
} {
  if (!signature) return { displayName: '', patternTypeFromSig: '' };

  // Split on "::" to get type prefix and remainder
  const colonColonIdx = signature.indexOf('::');
  if (colonColonIdx === -1) {
    // No :: separator — use the whole signature as a name (truncated)
    const truncated = signature.length > 80 ? signature.slice(0, 77) + '...' : signature;
    return { displayName: truncated, patternTypeFromSig: '' };
  }

  const typePrefix = signature.slice(0, colonColonIdx).trim();
  const remainder = signature.slice(colonColonIdx + 2).trim();

  // Convert type_prefix from snake_case to Title Case
  // e.g. "file_access_pattern" -> "File Access"
  const typeName = typePrefix
    .replace(/_pattern$/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  // Extract sub-type (before first colon in remainder)
  const colonIdx = remainder.indexOf(':');
  if (colonIdx === -1) {
    // No sub-type details, just sub-type name
    const subType = remainder
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    const displayName = `${typeName}: ${subType}`.slice(0, 255);
    return { displayName, patternTypeFromSig: typePrefix };
  }

  const subTypePart = remainder.slice(0, colonIdx).trim();
  const detailsPart = remainder.slice(colonIdx + 1).trim();

  // Format sub-type
  const subType = subTypePart
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  // Shorten file paths in details for readability
  const shortDetails = detailsPart
    .split(',')
    .map((p) => {
      const trimmed = p.trim();
      // Extract just the filename from long paths
      const lastSlash = trimmed.lastIndexOf('/');
      return lastSlash > 20 ? '...' + trimmed.slice(lastSlash) : trimmed;
    })
    .join(', ');

  const displayName = `${typeName}: ${subType} (${shortDetails})`.slice(0, 255);
  return { displayName, patternTypeFromSig: typePrefix };
}

// OMN-8707: Allowlist of pattern types that may be written into pattern_learning_artifacts.
// Any type not in this set is rejected at ingestion (watermark advances, no retry).
// To add a new type: update docs/process/pattern-intelligence-taxonomy.md first.
const ALLOWED_PATTERN_TYPES = new Set([
  'tool_usage_pattern',
  'architecture_pattern',
  'entry_point_pattern',
  'function_signature',
  'class_definition',
  'import_pattern',
  'bug_repetition',
  'contract_violation',
  'test_gap',
  'anti_pattern',
  'circular_dep',
]);

// OMN-8710: Substring denylist — defense-in-depth against noise that slips past the allowlist.
const NOISE_PATTERN_SUBSTRINGS = ['_co_', 'module_boundary', 'proximity', 'colocation'];

function isAllowedPatternType(patternType: string): boolean {
  if (!ALLOWED_PATTERN_TYPES.has(patternType)) return false;
  return !NOISE_PATTERN_SUBSTRINGS.some((sub) => patternType.includes(sub));
}

const OMNIINTELLIGENCE_TOPICS = new Set([
  TOPIC_OMNIINTELLIGENCE_LLM_CALL_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_PROJECTION,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
  TOPIC_INTELLIGENCE_PLAN_REVIEW_STRATEGY_RUN_COMPLETED,
  SUFFIX_INTELLIGENCE_RUN_EVALUATED,
  SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED,
  SUFFIX_INTELLIGENCE_INTENT_DRIFT_DETECTED,
  SUFFIX_INTELLIGENCE_CI_DEBUG_ESCALATION,
  SUFFIX_INTELLIGENCE_ROUTING_FEEDBACK_PROCESSED,
  SUFFIX_INTELLIGENCE_COMPLIANCE_EVALUATED,
  SUFFIX_INTELLIGENCE_CONTEXT_EFFECTIVENESS,
  SUFFIX_INTELLIGENCE_EPISODE_BOUNDARY,
  SUFFIX_INTELLIGENCE_CALIBRATION_RUN_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_PROMOTED,
  SUFFIX_INTELLIGENCE_PATTERN_STORED,
  SUFFIX_PATTERN_DISCOVERED,
  SUFFIX_INTELLIGENCE_EVAL_COMPLETED,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED,
]);

export class OmniintelligenceProjectionHandler implements ProjectionHandler {
  readonly stats: ProjectionHandlerStats = createHandlerStats();

  constructor() {
    registerHandlerStats('OmniintelligenceProjectionHandler', this.stats);
  }

  canHandle(topic: string): boolean {
    return OMNIINTELLIGENCE_TOPICS.has(topic);
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
      case SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED:
        return this.projectIntentClassifiedEvent(data, fallbackId, context);
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
      case SUFFIX_INTELLIGENCE_EPISODE_BOUNDARY:
        return this.projectEpisodeEvent(data, context);
      case SUFFIX_INTELLIGENCE_CALIBRATION_RUN_COMPLETED:
        return this.projectCalibrationRunCompleted(data, context);
      case SUFFIX_INTELLIGENCE_PATTERN_PROMOTED: {
        const pid = (data.pattern_id as string) || (data.patternId as string);
        if (!pid) {
          console.warn('[ReadModelConsumer] Pattern promoted event missing pattern_id -- skipping');
          return true;
        }
        return this.projectPatternLifecycleStateChange(data, 'promoted', fallbackId, context);
      }
      case SUFFIX_INTELLIGENCE_PATTERN_STORED: {
        const pid = (data.pattern_id as string) || (data.patternId as string);
        if (!pid) {
          console.warn('[ReadModelConsumer] Pattern stored event missing pattern_id -- skipping');
          return true;
        }
        return this.projectPatternLifecycleStateChange(data, 'stored', fallbackId, context);
      }
      case SUFFIX_INTELLIGENCE_EVAL_COMPLETED:
        return this.projectEvalCompleted(data, context);
      case SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED:
        return this.projectQualityAssessmentCompleted(data, context);
      case SUFFIX_PATTERN_DISCOVERED: {
        const pid = (data.pattern_id as string) || (data.patternId as string);
        if (!pid) {
          console.warn(
            '[ReadModelConsumer] Pattern discovered event missing pattern_id -- skipping'
          );
          return true;
        }
        return this.projectPatternDiscoveredEvent(data, fallbackId, context);
      }
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

    // OMN-8019: eval_llm_client emits `cost_usd` (flat field) rather than
    // `estimated_cost_usd` / `total_cost_usd`. Accept it as a fallback so local
    // model calls (Qwen3, DeepSeek) are visible even at $0.00.
    const rawCostUsdFlat = data.cost_usd ?? data.costUsd;

    const rawEstimatedCost = data.estimated_cost_usd ?? data.estimatedCostUsd ?? rawCostUsdFlat;
    const nEstimatedCost = Number(rawEstimatedCost);
    const estimatedCostUsd = String(Number.isFinite(nEstimatedCost) ? nEstimatedCost : 0);

    const rawTotalCost =
      data.total_cost_usd ?? data.totalCostUsd ?? rawCostUsdFlat ?? rawEstimatedCost;
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

        // Derive meaningful display name from pattern_signature (OMN-5644).
        // pattern_signature format: "type_prefix::sub_type: details"
        // e.g. "file_access_pattern::co_access: /path/a, /path/b"
        const rawSignature =
          (pattern.pattern_signature as string) || (pattern.patternSignature as string) || '';
        const { displayName, patternTypeFromSig } = derivePatternDisplayName(rawSignature);

        const patternName =
          displayName ||
          (pattern.pattern_name as string) ||
          (pattern.patternName as string) ||
          (pattern.domain_id as string) ||
          'unknown';

        // OMN-7014: Reject placeholder patterns that add no analytical value.
        // These accumulate as duplicates (1,950+ "learning_requested" copies).
        const REJECTED_PATTERN_NAMES = new Set([
          'learning_requested',
          'learning requested',
          'general',
          'stored_placeholder',
        ]);
        if (REJECTED_PATTERN_NAMES.has(patternName.toLowerCase())) {
          continue; // Skip placeholder patterns
        }

        // OMN-7014: Reject zero-score unmeasured patterns — never promoted, no value.
        const rawCompositeScore = Number(
          pattern.quality_score ?? pattern.composite_score ?? pattern.compositeScore ?? 0
        );
        const rawEvidenceTier =
          (pattern.evidence_tier as string) ?? (pattern.evidenceTier as string) ?? 'unmeasured';
        if (rawCompositeScore === 0 && rawEvidenceTier === 'unmeasured') {
          continue; // Skip zero-score unmeasured patterns
        }

        const patternType =
          patternTypeFromSig ||
          ((pattern.pattern_type as string) !== 'unmeasured'
            ? (pattern.pattern_type as string)
            : undefined) ||
          ((pattern.patternType as string) !== 'unmeasured'
            ? (pattern.patternType as string)
            : undefined) ||
          'learned_pattern';

        // OMN-8707: Reject pattern types not in the taxonomy allowlist.
        if (!isAllowedPatternType(patternType)) {
          console.debug(
            `[ReadModelConsumer] Pattern type "${patternType}" not in allowlist -- dropping`
          );
          continue;
        }

        const lifecycleState =
          (pattern.status as string) ||
          (pattern.lifecycle_state as string) ||
          (pattern.lifecycleState as string) ||
          'candidate';

        const compositeScore = String(
          pattern.quality_score ?? pattern.composite_score ?? pattern.compositeScore ?? 0
        );

        const scoringEvidence = pattern.scoring_evidence ?? pattern.scoringEvidence ?? {};
        const rawSigObj = pattern.signature ?? { hash: pattern.signature_hash ?? '' };
        // Enrich signature JSONB with the full pattern_signature text (OMN-5644)
        const signature =
          rawSignature && typeof rawSigObj === 'object' && rawSigObj !== null
            ? { ...(rawSigObj as Record<string, unknown>), pattern_signature: rawSignature }
            : rawSigObj;
        const metrics = pattern.metrics ?? {};
        const rawMeta = (pattern.metadata ?? {}) as Record<string, unknown>;
        // Store pattern_signature and domain_id in metadata for display (OMN-5644)
        const metadata = rawSignature
          ? {
              ...rawMeta,
              pattern_signature: rawSignature,
              domain_id: (pattern.domain_id as string) || undefined,
            }
          : rawMeta;

        // Derive evidence_tier from scoring_evidence or pattern-level field (OMN-5644)
        const evidenceTier =
          (pattern.evidence_tier as string) ||
          ((scoringEvidence as Record<string, unknown>).evidence_tier as string) ||
          'unmeasured';

        // Derive language from keywords array if present
        const keywords = pattern.keywords as string[] | undefined;
        const language =
          (pattern.language as string) ||
          (Array.isArray(keywords) && keywords.length > 0 ? keywords[0] : undefined) ||
          undefined;

        const row: InsertPatternLearningArtifact = {
          patternId,
          patternName,
          patternType,
          language,
          lifecycleState,
          compositeScore,
          scoringEvidence,
          signature,
          metrics,
          metadata,
          evidenceTier,
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
              language: row.language,
              lifecycleState: row.lifecycleState,
              compositeScore: row.compositeScore,
              scoringEvidence: row.scoringEvidence,
              signature: row.signature,
              metrics: row.metrics,
              metadata: row.metadata,
              evidenceTier: row.evidenceTier,
              updatedAt: row.updatedAt,
              projectedAt: row.projectedAt,
            },
          });

        // OMN-6804: Also project into pattern_quality_metrics
        const qualityScore = Number(
          pattern.quality_score ?? pattern.composite_score ?? pattern.compositeScore ?? 0
        );
        const scoringEvidenceObj =
          typeof pattern.scoring_evidence === 'object' && pattern.scoring_evidence !== null
            ? (pattern.scoring_evidence as Record<string, unknown>)
            : typeof pattern.scoringEvidence === 'object' && pattern.scoringEvidence !== null
              ? (pattern.scoringEvidence as Record<string, unknown>)
              : null;
        const confidence = Number(pattern.confidence ?? scoringEvidenceObj?.confidence ?? 0.5);

        try {
          await db
            .insert(patternQualityMetrics)
            .values({
              patternId,
              qualityScore: Number.isFinite(qualityScore) ? qualityScore : 0,
              confidence: Number.isFinite(confidence) ? confidence : 0.5, // fallback-ok: NaN safety guard
              measurementTimestamp:
                safeParseDate(data.snapshot_at ?? data.snapshotAt) ?? new Date(),
              version: '1.0.0',
              metadata: { source: 'pattern-projection.v1' },
              projectedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: patternQualityMetrics.patternId,
              set: {
                qualityScore: Number.isFinite(qualityScore) ? qualityScore : 0,
                confidence: Number.isFinite(confidence) ? confidence : 0.5, // fallback-ok: NaN safety guard
                measurementTimestamp:
                  safeParseDate(data.snapshot_at ?? data.snapshotAt) ?? new Date(),
                updatedAt: new Date(),
                projectedAt: new Date(),
              },
            });
        } catch (qmErr) {
          if (isTableMissingError(qmErr, 'pattern_quality_metrics')) {
            console.warn(
              '[ReadModelConsumer] pattern_quality_metrics table not yet created -- ' +
                'run migrations to enable quality metrics projection'
            );
          } else {
            console.warn(
              `[ReadModelConsumer] pattern_quality_metrics upsert failed for ${patternId}:`,
              qmErr
            );
          }
          // Non-fatal: continue processing remaining patterns
        }
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
  // Pattern lifecycle transitioned -> pattern_learning_artifacts + pattern_lifecycle_transitions (OMN-2924, OMN-6804)
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

    const fromStatus = (data.from_status as string) || (data.fromStatus as string) || 'unknown';
    const transitionTrigger =
      (data.trigger as string) ||
      (data.transition_trigger as string) ||
      (data.transitionTrigger as string) ||
      'lifecycle_event';
    const correlationId = (data.correlation_id as string) || (data.correlationId as string) || null;
    const actor = (data.actor as string) || null;
    const reason = (data.reason as string) || null;
    const requestId =
      (data.request_id as string) ||
      (data.requestId as string) ||
      (data.event_id as string) ||
      (data.eventId as string) ||
      crypto.randomUUID();
    const gateSnapshot =
      (data.gate_snapshot as Record<string, unknown>) ||
      (data.gateSnapshot as Record<string, unknown>) ||
      null;

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

    // OMN-6804: Also insert into pattern_lifecycle_transitions audit table
    try {
      await db
        .insert(patternLifecycleTransitions)
        .values({
          requestId,
          patternId,
          fromStatus,
          toStatus,
          transitionTrigger,
          correlationId,
          actor,
          reason,
          gateSnapshot,
          transitionAt: transitionedAt ?? new Date(),
        })
        .onConflictDoNothing();
    } catch (err) {
      if (isTableMissingError(err, 'pattern_lifecycle_transitions')) {
        console.warn(
          '[ReadModelConsumer] pattern_lifecycle_transitions table not yet created -- ' +
            'run migrations to enable lifecycle transition audit'
        );
      } else {
        console.warn(
          `[ReadModelConsumer] pattern_lifecycle_transitions insert failed for ${patternId}:`,
          err
        );
      }
      // Non-fatal: the primary projection (pattern_learning_artifacts) succeeded
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Pattern promoted / stored -> update lifecycle_state + audit row (OMN-5602)
  // -------------------------------------------------------------------------

  private async projectPatternLifecycleStateChange(
    data: Record<string, unknown>,
    targetState: string,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const patternId = (data.pattern_id as string) || (data.patternId as string);
    if (!patternId) {
      console.warn(
        `[ReadModelConsumer] Pattern ${targetState} event missing pattern_id -- skipping`
      );
      return true;
    }

    const fromStatus = (data.from_status as string) || (data.fromStatus as string) || 'unknown';
    const transitionTrigger =
      (data.trigger as string) ||
      (data.transition_trigger as string) ||
      (data.transitionTrigger as string) ||
      `${targetState}_event`;
    const correlationId = (data.correlation_id as string) || (data.correlationId as string) || null;
    const actor = (data.actor as string) || null;
    const reason = (data.reason as string) || null;
    const requestId =
      (data.request_id as string) ||
      (data.requestId as string) ||
      (data.event_id as string) ||
      (data.eventId as string) ||
      fallbackId ||
      crypto.randomUUID();
    const eventTimestamp = safeParseDate(
      data.promoted_at ??
        data.promotedAt ??
        data.stored_at ??
        data.storedAt ??
        data.timestamp ??
        data.created_at
    );

    // Update lifecycle_state in pattern_learning_artifacts.
    // If the artifact row doesn't exist yet (zero rows affected), insert a
    // minimal placeholder so the lifecycle transition is not silently lost.
    try {
      const result = await db
        .update(patternLearningArtifacts)
        .set({
          lifecycleState: targetState,
          stateChangedAt: eventTimestamp,
          updatedAt: new Date(),
        })
        .where(eq(patternLearningArtifacts.patternId, patternId));

      // Drizzle returns { rowCount } for pg driver
      const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
      if (rowCount === 0) {
        // No existing artifact row -- insert a placeholder so the lifecycle
        // state is captured and the audit trail remains consistent.
        await db
          .insert(patternLearningArtifacts)
          .values({
            patternId,
            patternName: `${targetState}_placeholder`,
            patternType: 'learned_pattern',
            lifecycleState: targetState,
            stateChangedAt: eventTimestamp,
            compositeScore: '0',
            scoringEvidence: {},
            signature: { hash: '' },
            metrics: {},
            metadata: {},
            evidenceTier: 'unmeasured',
            updatedAt: eventTimestamp,
            projectedAt: new Date(),
          })
          .onConflictDoNothing();
      }
    } catch (err) {
      if (isTableMissingError(err, 'pattern_learning_artifacts')) {
        console.warn(
          `[ReadModelConsumer] pattern_learning_artifacts table not yet created -- ` +
            `skipping ${targetState} projection`
        );
        return true;
      }
      throw err;
    }

    // Insert audit row into pattern_lifecycle_transitions
    try {
      await db
        .insert(patternLifecycleTransitions)
        .values({
          requestId,
          patternId,
          fromStatus,
          toStatus: targetState,
          transitionTrigger,
          correlationId,
          actor,
          reason,
          transitionAt: eventTimestamp ?? new Date(),
        })
        .onConflictDoNothing();
    } catch (err) {
      if (isTableMissingError(err, 'pattern_lifecycle_transitions')) {
        console.warn(
          '[ReadModelConsumer] pattern_lifecycle_transitions table not yet created -- ' +
            'run migrations to enable lifecycle transition audit'
        );
      } else {
        console.warn(
          `[ReadModelConsumer] pattern_lifecycle_transitions insert failed for ${patternId}:`,
          err
        );
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Pattern discovered -> insert new pattern_learning_artifacts row (OMN-5602)
  // -------------------------------------------------------------------------

  private async projectPatternDiscoveredEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const patternId = (data.pattern_id as string) || (data.patternId as string);
    if (!patternId) {
      console.warn('[ReadModelConsumer] Pattern discovered event missing pattern_id -- skipping');
      return true;
    }

    const patternName =
      (data.pattern_name as string) || (data.patternName as string) || 'discovered_pattern';
    const patternType =
      (data.pattern_type as string) || (data.patternType as string) || 'learned_pattern';
    const compositeScore = String(
      data.quality_score ?? data.composite_score ?? data.compositeScore ?? 0
    );
    const language = (data.language as string) || null;
    const eventTimestamp = safeParseDate(
      data.discovered_at ?? data.discoveredAt ?? data.timestamp ?? data.created_at
    );

    // Insert or update pattern_learning_artifacts with 'discovered' state.
    // On conflict, merge the full artifact payload but do NOT regress
    // lifecycleState if the row is already at a later stage (promoted/stored).
    try {
      await db
        .insert(patternLearningArtifacts)
        .values({
          patternId,
          patternName,
          patternType,
          language,
          lifecycleState: 'discovered',
          stateChangedAt: eventTimestamp,
          compositeScore,
          scoringEvidence: data.scoring_evidence ?? data.scoringEvidence ?? {},
          signature: data.signature ?? { hash: '' },
          metrics: data.metrics ?? {},
          metadata: data.metadata ?? {},
          evidenceTier: (data.evidence_tier as string) || 'unmeasured',
          updatedAt: eventTimestamp,
          projectedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: patternLearningArtifacts.patternId,
          set: {
            // Always merge artifact data so placeholder rows get populated
            patternName,
            patternType,
            language,
            compositeScore,
            scoringEvidence: data.scoring_evidence ?? data.scoringEvidence ?? {},
            signature: data.signature ?? { hash: '' },
            metrics: data.metrics ?? {},
            metadata: data.metadata ?? {},
            evidenceTier: (data.evidence_tier as string) || 'unmeasured',
            // Only set lifecycleState to 'discovered' if the row is still at
            // a placeholder or null state -- use SQL CASE to avoid regressing
            // promoted/stored rows back to discovered.
            lifecycleState: sql`CASE
              WHEN ${patternLearningArtifacts.lifecycleState} IS NULL
                OR ${patternLearningArtifacts.lifecycleState} = 'pending'
                OR ${patternLearningArtifacts.lifecycleState} = 'discovered'
              THEN 'discovered'
              ELSE ${patternLearningArtifacts.lifecycleState}
            END`,
            stateChangedAt: sql`CASE
              WHEN ${patternLearningArtifacts.lifecycleState} IS NULL
                OR ${patternLearningArtifacts.lifecycleState} = 'pending'
                OR ${patternLearningArtifacts.lifecycleState} = 'discovered'
              THEN ${eventTimestamp ?? new Date()}
              ELSE ${patternLearningArtifacts.stateChangedAt}
            END`,
            updatedAt: new Date(),
            projectedAt: new Date(),
          },
        });
    } catch (err) {
      if (isTableMissingError(err, 'pattern_learning_artifacts')) {
        console.warn(
          '[ReadModelConsumer] pattern_learning_artifacts table not yet created -- ' +
            'skipping discovered projection'
        );
        return true;
      }
      throw err;
    }

    // Insert audit row into pattern_lifecycle_transitions
    const requestId =
      (data.request_id as string) ||
      (data.requestId as string) ||
      (data.event_id as string) ||
      (data.eventId as string) ||
      fallbackId ||
      crypto.randomUUID();
    const correlationId = (data.correlation_id as string) || (data.correlationId as string) || null;

    try {
      await db
        .insert(patternLifecycleTransitions)
        .values({
          requestId,
          patternId,
          fromStatus: 'none',
          toStatus: 'discovered',
          transitionTrigger: 'discovery_event',
          correlationId,
          actor: (data.actor as string) || null,
          reason: (data.reason as string) || null,
          transitionAt: eventTimestamp ?? new Date(),
        })
        .onConflictDoNothing();
    } catch (err) {
      if (isTableMissingError(err, 'pattern_lifecycle_transitions')) {
        console.warn(
          '[ReadModelConsumer] pattern_lifecycle_transitions table not yet created -- ' +
            'run migrations to enable lifecycle transition audit'
        );
      } else {
        console.warn(
          `[ReadModelConsumer] pattern_lifecycle_transitions insert failed for ${patternId}:`,
          err
        );
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Pattern learning requested -> pattern_learning_artifacts (OMN-2920)
  // -------------------------------------------------------------------------

  private async projectPatternLearningRequestedEvent(
    _data: Record<string, unknown>,
    _fallbackId: string,
    _context: ProjectionContext
  ): Promise<boolean> {
    // OMN-7014: Learning-requested events carry no pattern name, confidence,
    // or analytical payload — they are bare lifecycle triggers.  Inserting
    // placeholder rows (pattern_name='learning_requested', score=0) created
    // thousands of noise rows that polluted the pattern intelligence page.
    // Real pattern data arrives via pattern-projection events, which already
    // have the OMN-7014 quality filter.  Acknowledge the event without
    // writing to the database.
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
  // Intent classified -> intent_signals (OMN-5620)
  // -------------------------------------------------------------------------

  private async projectIntentClassifiedEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;

    const intentType =
      (data.intent_category as string) ||
      (data.intentCategory as string) ||
      (data.intent_type as string) ||
      (data.intentType as string) ||
      'unknown';

    const eventId =
      (data.id as string) || (data.event_id as string) || (data.eventId as string) || correlationId;

    try {
      await db.execute(sql`
        INSERT INTO intent_signals (
          correlation_id, event_id, intent_type, topic,
          raw_payload, created_at
        ) VALUES (
          ${correlationId},
          ${eventId},
          ${intentType},
          ${SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED},
          ${JSON.stringify(data)},
          ${safeParseDate(data.timestamp ?? data.created_at ?? data.createdAt)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      if (isTableMissingError(err, 'intent_signals')) {
        console.error(
          '[ReadModelConsumer] intent_signals table missing -- ' +
            'run `npm run db:migrate` to apply migration 0037. ' +
            'Returning false so event routes to DLQ for visibility.'
        );
        return false;
      }
      throw err;
    }

    return true;
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
        console.error(
          '[ReadModelConsumer] intent_drift_events table missing -- ' +
            'run `npm run db:migrate` to apply migrations. ' +
            'Returning false so event routes to DLQ for visibility.'
        );
        return false;
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

  // -------------------------------------------------------------------------
  // Eval completed -> log & ack (OMN-6798)
  // -------------------------------------------------------------------------

  private async projectEvalCompleted(
    data: Record<string, unknown>,
    _context: ProjectionContext
  ): Promise<boolean> {
    // Acknowledge the event to advance the watermark.
    // Eval-completed events are informational signals from omniintelligence;
    // the objective_evaluations table is populated by the run-evaluated handler.
    const evalId =
      (data.eval_id as string) ||
      (data.evalId as string) ||
      (data.evaluation_id as string) ||
      (data.evaluationId as string) ||
      'unknown';
    console.log(`[ReadModelConsumer] eval-completed acknowledged: ${evalId}`);
    return true;
  }

  // -------------------------------------------------------------------------
  // quality-assessment-completed -> pattern_quality_metrics (SOW Phase 2)
  //
  // The quality-assessment-completed.v1 event is emitted by the
  // _quality_assessment_handler in omniintelligence after running
  // NodeQualityScoringCompute. The `source_path` field carries the pattern UUID
  // (set from `entity_id` in the originating command from NodePatternFeedbackEffect).
  // Upserts computed scores into pattern_quality_metrics keyed on pattern_id.
  // -------------------------------------------------------------------------

  private async projectQualityAssessmentCompleted(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    // source_path carries the pattern UUID (set from entity_id in the command)
    const patternId =
      (data.source_path as string) ||
      (data.sourcePath as string) ||
      (data.pattern_id as string) ||
      (data.patternId as string) ||
      (data.entity_id as string);

    if (!patternId || !UUID_RE.test(patternId)) {
      console.warn(
        `[ReadModelConsumer] quality-assessment-completed missing or invalid pattern_id "${patternId}" -- skipping`
      );
      return true;
    }

    const qualityScore = Number(data.quality_score ?? data.qualityScore ?? 0);
    const dimensionsRaw = data.dimensions;
    const dimensions = dimensionsRaw && typeof dimensionsRaw === 'object' ? dimensionsRaw : {};
    const confidence = Number(
      (dimensions as Record<string, unknown>).confidence ??
        (data.metadata as Record<string, unknown> | undefined)?.confidence ??
        0.5
    );

    try {
      await db
        .insert(patternQualityMetrics)
        .values({
          patternId,
          qualityScore: Number.isFinite(qualityScore) ? qualityScore : 0,
          confidence: Number.isFinite(confidence) ? confidence : 0.5,
          measurementTimestamp: new Date(),
          version: '1.0.0',
          metadata: {
            source: 'quality-assessment-completed.v1',
            onex_compliant: data.onex_compliant ?? data.onexCompliant ?? false,
            dimensions,
            recommendations: data.recommendations ?? [],
            correlation_id: data.correlation_id ?? data.correlationId,
          },
          projectedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: patternQualityMetrics.patternId,
          set: {
            qualityScore: Number.isFinite(qualityScore) ? qualityScore : 0,
            confidence: Number.isFinite(confidence) ? confidence : 0.5,
            measurementTimestamp: new Date(),
            metadata: {
              source: 'quality-assessment-completed.v1',
              onex_compliant: data.onex_compliant ?? data.onexCompliant ?? false,
              dimensions,
              recommendations: data.recommendations ?? [],
              correlation_id: data.correlation_id ?? data.correlationId,
            },
            updatedAt: new Date(),
            projectedAt: new Date(),
          },
        });
      console.log(
        `[ReadModelConsumer] quality-assessment-completed projected: pattern_id=${patternId} quality_score=${qualityScore}`
      );
      return true;
    } catch (err) {
      if (isTableMissingError(err, 'pattern_quality_metrics')) {
        console.warn(
          '[ReadModelConsumer] pattern_quality_metrics table not yet created -- ' +
            'run migrations to enable quality metrics projection'
        );
        return true;
      }
      console.warn(
        `[ReadModelConsumer] quality-assessment-completed upsert failed for ${patternId}:`,
        err
      );
      return false;
    }
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

  // -------------------------------------------------------------------------
  // Episode boundary -> rl_episodes (OMN-5559)
  // Start events CREATE the row, complete events UPDATE with outcome data.
  // Idempotent by episode_id (upsert).
  // -------------------------------------------------------------------------

  private async projectEpisodeEvent(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const episodeId = (data.episode_id as string) || (data.episodeId as string);
    if (!episodeId || !UUID_RE.test(episodeId)) {
      console.warn(
        `[ReadModelConsumer] episode-boundary missing or invalid episode_id "${episodeId}" -- skipping`
      );
      return true;
    }

    const phase = (data.phase as string) || 'started';
    const surface = (data.surface as string) || 'routing';

    try {
      if (phase === 'completed') {
        // Complete event: UPDATE existing row with outcome data
        const terminalStatus =
          (data.terminal_status as string) || (data.terminalStatus as string) || 'incomplete';
        const outcomeMetrics =
          (data.outcome_metrics as Record<string, unknown>) ||
          (data.outcomeMetrics as Record<string, unknown>) ||
          {};
        const emittedAt = safeParseDate(data.emitted_at ?? data.emittedAt);

        const result = await db
          .update(rlEpisodes)
          .set({
            phase: 'completed',
            terminalStatus,
            outcomeMetrics,
            completedAt: emittedAt ?? new Date(),
            projectedAt: new Date(),
          })
          .where(eq(rlEpisodes.episodeId, episodeId))
          .returning({ id: rlEpisodes.id });

        if (result.length === 0) {
          // Start event may not have arrived yet — insert a complete row
          await db.execute(sql`
            INSERT INTO rl_episodes (
              episode_id, surface, phase, terminal_status,
              decision_snapshot, observation_timestamp, action_taken,
              outcome_metrics, started_at, completed_at, emitted_at, projected_at
            ) VALUES (
              ${episodeId}::uuid,
              ${surface},
              ${'completed'},
              ${terminalStatus},
              ${(data.decision_snapshot as Record<string, unknown>) || (data.decisionSnapshot as Record<string, unknown>) || {}}::jsonb,
              ${safeParseDate(data.observation_timestamp ?? data.observationTimestamp) ?? new Date()},
              ${(data.action_taken as Record<string, unknown>) || (data.actionTaken as Record<string, unknown>) || {}}::jsonb,
              ${outcomeMetrics}::jsonb,
              ${safeParseDate(data.observation_timestamp ?? data.observationTimestamp) ?? new Date()},
              ${emittedAt ?? new Date()},
              ${emittedAt ?? new Date()},
              ${new Date()}
            )
            ON CONFLICT (episode_id) DO UPDATE SET
              phase = EXCLUDED.phase,
              terminal_status = EXCLUDED.terminal_status,
              outcome_metrics = EXCLUDED.outcome_metrics,
              completed_at = EXCLUDED.completed_at,
              projected_at = EXCLUDED.projected_at
          `);
        }
      } else {
        // Start event: INSERT new row (or no-op if already exists)
        const decisionSnapshot =
          (data.decision_snapshot as Record<string, unknown>) ||
          (data.decisionSnapshot as Record<string, unknown>) ||
          {};
        const observationTimestamp = safeParseDate(
          data.observation_timestamp ?? data.observationTimestamp
        );
        const actionTaken =
          (data.action_taken as Record<string, unknown>) ||
          (data.actionTaken as Record<string, unknown>) ||
          {};
        const emittedAt = safeParseDate(data.emitted_at ?? data.emittedAt);

        await db.execute(sql`
          INSERT INTO rl_episodes (
            episode_id, surface, phase, decision_snapshot,
            observation_timestamp, action_taken, started_at, emitted_at, projected_at
          ) VALUES (
            ${episodeId}::uuid,
            ${surface},
            ${'started'},
            ${decisionSnapshot}::jsonb,
            ${observationTimestamp ?? new Date()},
            ${actionTaken}::jsonb,
            ${observationTimestamp ?? new Date()},
            ${emittedAt ?? new Date()},
            ${new Date()}
          )
          ON CONFLICT (episode_id) DO NOTHING
        `);
      }
    } catch (err) {
      if (isTableMissingError(err, 'rl_episodes')) {
        console.warn(
          '[ReadModelConsumer] rl_episodes table not yet created -- ' +
            'run migrations to enable episode projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Calibration run completed -> review_calibration_runs_rm (OMN-6176)
  // -------------------------------------------------------------------------

  private async projectCalibrationRunCompleted(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const runId = String(data.run_id ?? data.runId ?? '');
    if (!runId) {
      console.warn('[ReadModelConsumer] calibration-run-completed missing run_id -- skipping');
      return true;
    }

    const groundTruthModel = String(data.ground_truth_model ?? data.groundTruthModel ?? 'unknown');
    const challengerModel = String(data.challenger_model ?? data.challengerModel ?? 'unknown');
    const precision = Number(data.precision ?? 0);
    const recall = Number(data.recall ?? 0);
    const f1 = Number(data.f1 ?? 0);
    const noiseRatio = Number(data.noise_ratio ?? data.noiseRatio ?? 0);
    const sampleSize =
      data.sample_size != null || data.sampleSize != null
        ? Number(data.sample_size ?? data.sampleSize)
        : null;
    const createdAt = safeParseDate(data.created_at ?? data.createdAt);

    try {
      await db.insert(reviewCalibrationRuns).values({
        runId,
        groundTruthModel,
        challengerModel,
        precision,
        recall,
        f1,
        noiseRatio,
        sampleSize,
        createdAt,
      });
    } catch (err) {
      if (isTableMissingError(err, 'review_calibration_runs_rm')) {
        console.warn(
          '[ReadModelConsumer] review_calibration_runs_rm table not yet created -- ' +
            'run migrations to enable calibration projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }
}
