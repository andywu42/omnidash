/**
 * ONEX Topic Constants — Single Source of Truth
 *
 * Canonical topic names for all Kafka topics.
 * The canonical format IS `onex.<kind>.<producer>.<event-name>.v<version>` —
 * these are the real topic names, not suffixes.
 *
 * Legacy topics used a `{env}.` prefix (e.g. `dev.onex.evt...`).
 * New producers emit to the canonical name directly (no env prefix).
 * Constants are still named `SUFFIX_*` for historical reasons.
 *
 *   kind:     evt | cmd | intent | snapshot | dlq
 *   producer: platform | omniclaude | omniintelligence | omnimemory | validation
 *
 * @see omnibase_infra: src/omnibase_infra/topics/topic_resolver.py
 * @see omnibase_infra: src/omnibase_infra/topics/platform_topic_suffixes.py
 */

// ============================================================================
// Topic Kind Type
// ============================================================================

export type OnexTopicKind = 'evt' | 'cmd' | 'intent' | 'snapshot' | 'dlq';

// ============================================================================
// Environment Prefix Resolution
// ============================================================================

/**
 * Legacy environment prefixes (e.g. `dev.`, `staging.`).
 * Old producers prepended these to topic names. Used by extractSuffix() to strip
 * legacy prefixes from incoming Kafka messages so they match canonical names.
 */
export const ENVIRONMENT_PREFIXES = [
  'dev',
  'staging',
  'prod',
  'production',
  'test',
  'local',
] as const;
export type EnvironmentPrefix = (typeof ENVIRONMENT_PREFIXES)[number];

// ============================================================================
// Environment Prefix Stripping
// ============================================================================

/**
 * Strip a leading environment prefix from a topic name, returning the canonical suffix.
 *
 * If the topic starts with a known environment prefix (e.g. `dev.`, `staging.`),
 * the prefix is removed and the remainder is returned.
 * If no known prefix is found, the input is returned unchanged — this makes it
 * safe to call on topics that are already in canonical (suffix) form.
 *
 * @example
 * extractSuffix('dev.onex.evt.platform.node-heartbeat.v1')
 * // => 'onex.evt.platform.node-heartbeat.v1'
 *
 * extractSuffix('onex.evt.platform.node-heartbeat.v1')
 * // => 'onex.evt.platform.node-heartbeat.v1'  (already canonical, returned as-is)
 *
 * extractSuffix('agent-actions')
 * // => 'agent-actions'  (legacy flat name, no prefix to strip)
 */
export function extractSuffix(topic: string): string {
  for (const prefix of ENVIRONMENT_PREFIXES) {
    const prefixDot = prefix + '.';
    if (topic.startsWith(prefixDot)) {
      return topic.slice(prefixDot.length);
    }
  }
  return topic;
}

/**
 * Extract the producer name from an ONEX topic string.
 * Strips any environment prefix first via extractSuffix, then parses the
 * canonical format: onex.<kind>.<producer>.<event-name>.v<version>
 *
 * @example 'onex.evt.omniclaude.session-started.v1' => 'omniclaude'
 * @example 'dev.onex.cmd.omniintelligence.tool-content.v1' => 'omniintelligence'
 * @example 'production.onex.evt.platform.node-heartbeat.v1' => 'platform'
 * @example 'agent-actions' => null (legacy flat name, no producer to extract)
 */
export function extractProducerFromTopic(topic: string): string | null {
  const canonical = extractSuffix(topic);
  const segments = canonical.split('.');
  // Canonical ONEX format: onex.<kind>.<producer>.<event-name>.v<N>
  if (segments.length >= 5 && segments[0] === 'onex') {
    return segments[2]; // producer is the third segment
  }
  return null;
}

/**
 * Extract the producer name from an ONEX topic string, falling back to a
 * default value for legacy flat-name topics.
 *
 * This is a convenience wrapper around `extractProducerFromTopic` that
 * eliminates the need for callers to handle the `null` return. Use this
 * when you always want a non-null string (e.g. for display purposes).
 *
 * @example extractProducerFromTopicOrDefault('onex.evt.omniclaude.session-started.v1') => 'omniclaude'
 * @example extractProducerFromTopicOrDefault('agent-actions') => 'system'
 * @example extractProducerFromTopicOrDefault('agent-actions', 'unknown') => 'unknown'
 */
export function extractProducerFromTopicOrDefault(topic: string, defaultValue = 'system'): string {
  return extractProducerFromTopic(topic) ?? defaultValue;
}

/**
 * Extract the action name (event-name segment) from an ONEX topic string.
 * Strips any environment prefix first via extractSuffix, then parses the
 * canonical format: onex.<kind>.<producer>.<event-name>.v<version>
 *
 * For standard 5-segment topics the event-name is a single segment.
 * For 6+-segment topics (e.g. `onex.evt.omniclaude.transformation.completed.v1`)
 * all segments between the producer (index 2) and the version (last segment) are
 * joined with a hyphen, producing `'transformation-completed'`.
 *
 * @example 'onex.cmd.omniintelligence.tool-content.v1' => 'tool-content'
 * @example 'dev.onex.evt.omniclaude.session-started.v1' => 'session-started'
 * @example 'onex.evt.omniclaude.transformation.completed.v1' => 'transformation-completed'
 * @example 'agent-actions' => '' (legacy flat name, no action to extract)
 */
export function extractActionFromTopic(topic: string): string {
  const canonical = extractSuffix(topic);
  const segments = canonical.split('.');
  // Canonical ONEX format: onex.<kind>.<producer>.<event-name...>.v<N>
  // Minimum 5 segments; event-name spans segments[3] through segments[length-2].
  if (segments.length >= 5 && segments[0] === 'onex') {
    // Join all segments between producer (index 2) and version (last) with a hyphen.
    return segments.slice(3, -1).join('-');
  }
  return '';
}

/**
 * Look up a value from a topic-keyed map, normalizing env-prefixed topics first.
 *
 * Tries the raw topic key first for exact matches (works for legacy flat names
 * and canonical suffixes), then strips any env prefix and retries.
 *
 * Use this instead of direct `map[topic]` access when the topic may arrive with
 * an environment prefix (e.g. `dev.onex.evt...`) but the map is keyed by
 * canonical suffix (`onex.evt...`).
 *
 * @example
 * const meta = lookupByTopic(TOPIC_METADATA, 'dev.onex.evt.platform.node-heartbeat.v1');
 * // Finds the entry keyed by 'onex.evt.platform.node-heartbeat.v1'
 */
export function lookupByTopic<T>(map: Record<string, T>, topic: string): T | undefined {
  const direct = map[topic];
  if (direct !== undefined) return direct;

  const suffix = extractSuffix(topic);
  if (suffix !== topic) {
    return map[suffix];
  }

  return undefined;
}

// ============================================================================
// Platform Topics (from omnibase_infra platform_topic_suffixes.py)
// ============================================================================

export const SUFFIX_NODE_REGISTRATION = 'onex.evt.platform.node-registration.v1';
export const SUFFIX_NODE_INTROSPECTION = 'onex.evt.platform.node-introspection.v1';
export const SUFFIX_NODE_HEARTBEAT = 'onex.evt.platform.node-heartbeat.v1';
export const SUFFIX_REQUEST_INTROSPECTION = 'onex.cmd.platform.request-introspection.v1';
export const SUFFIX_FSM_STATE_TRANSITIONS = 'onex.evt.platform.fsm-state-transitions.v1';
export const SUFFIX_NODE_STATE_CHANGE = 'onex.evt.platform.node-state-change.v1';
export const SUFFIX_RUNTIME_TICK = 'onex.intent.platform.runtime-tick.v1';
export const SUFFIX_REGISTRATION_SNAPSHOTS = 'onex.snapshot.platform.registration-snapshots.v1';

/** Contract lifecycle events */
export const SUFFIX_CONTRACT_REGISTERED = 'onex.evt.platform.contract-registered.v1';
export const SUFFIX_CONTRACT_DEREGISTERED = 'onex.evt.platform.contract-deregistered.v1';

/** Granular node registration lifecycle events */
export const SUFFIX_NODE_REGISTRATION_INITIATED =
  'onex.evt.platform.node-registration-initiated.v1';
export const SUFFIX_NODE_REGISTRATION_ACCEPTED = 'onex.evt.platform.node-registration-accepted.v1';
export const SUFFIX_NODE_REGISTRATION_REJECTED = 'onex.evt.platform.node-registration-rejected.v1';

/** Dual-confirmation ACK flow events */
export const SUFFIX_NODE_REGISTRATION_ACKED = 'onex.cmd.platform.node-registration-acked.v1';
export const SUFFIX_NODE_REGISTRATION_RESULT = 'onex.evt.platform.node-registration-result.v1';
export const SUFFIX_NODE_REGISTRATION_ACK_RECEIVED =
  'onex.evt.platform.node-registration-ack-received.v1';
export const SUFFIX_NODE_REGISTRATION_ACK_TIMED_OUT =
  'onex.evt.platform.node-registration-ack-timed-out.v1';

/** Node activation event — emitted when a node transitions to ACTIVE (OMN-5132) */
export const SUFFIX_NODE_BECAME_ACTIVE = 'onex.evt.platform.node-became-active.v1';
/** Node liveness expiration — emitted when a node's liveness deadline passes */
export const SUFFIX_NODE_LIVENESS_EXPIRED = 'onex.evt.platform.node-liveness-expired.v1';

/** Registry announces it wants nodes to re-introspect (evt counterpart to the cmd variant) */
export const SUFFIX_REGISTRY_REQUEST_INTROSPECTION =
  'onex.evt.platform.registry-request-introspection.v1';

/** @deprecated (OMN-5030) Topic catalog query/response topics (OMN-2315) — replaced by registry-driven discovery */
export const SUFFIX_PLATFORM_TOPIC_CATALOG_QUERY = 'onex.cmd.platform.topic-catalog-query.v1';
/** @deprecated (OMN-5030) */
export const SUFFIX_PLATFORM_TOPIC_CATALOG_RESPONSE = 'onex.evt.platform.topic-catalog-response.v1';
/** @deprecated (OMN-5030) */
export const SUFFIX_PLATFORM_TOPIC_CATALOG_CHANGED = 'onex.evt.platform.topic-catalog-changed.v1';

// ============================================================================
// OmniClaude Topics
// ============================================================================

export const SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED = 'onex.evt.omniclaude.prompt-submitted.v1';
export const SUFFIX_OMNICLAUDE_SESSION_STARTED = 'onex.evt.omniclaude.session-started.v1';
export const SUFFIX_OMNICLAUDE_SESSION_ENDED = 'onex.evt.omniclaude.session-ended.v1';
export const SUFFIX_OMNICLAUDE_TOOL_EXECUTED = 'onex.evt.omniclaude.tool-executed.v1';
export const SUFFIX_OMNICLAUDE_CONTEXT_UTILIZATION = 'onex.evt.omniclaude.context-utilization.v1';
export const SUFFIX_OMNICLAUDE_AGENT_MATCH = 'onex.evt.omniclaude.agent-match.v1';
export const SUFFIX_OMNICLAUDE_LATENCY_BREAKDOWN = 'onex.evt.omniclaude.latency-breakdown.v1';

/** Extended OmniClaude events (routing, sessions, manifests, notifications) */
export const SUFFIX_OMNICLAUDE_ROUTING_DECISION = 'onex.evt.omniclaude.routing-decision.v1';
export const SUFFIX_OMNICLAUDE_SESSION_OUTCOME = 'onex.evt.omniclaude.session-outcome.v1';
export const SUFFIX_OMNICLAUDE_MANIFEST_INJECTED = 'onex.evt.omniclaude.manifest-injected.v1';
export const SUFFIX_OMNICLAUDE_PHASE_METRICS = 'onex.evt.omniclaude.phase-metrics.v1';
export const SUFFIX_OMNICLAUDE_NOTIFICATION_BLOCKED = 'onex.evt.omniclaude.notification-blocked.v1';
export const SUFFIX_OMNICLAUDE_NOTIFICATION_COMPLETED =
  'onex.evt.omniclaude.notification-completed.v1';
export const SUFFIX_OMNICLAUDE_TRANSFORMATION_COMPLETED =
  'onex.evt.omniclaude.transformation.completed.v1';

/**
 * Canonical LLM call completed topic emitted by NodeLlmInferenceEffect (omnibase_infra).
 *
 * Payload schema: ContractLlmCallMetrics (omnibase_spi) with fields:
 *   - model_id: string — model identifier (maps to model_name in llm_cost_aggregates)
 *   - prompt_tokens: number
 *   - completion_tokens: number
 *   - total_tokens: number
 *   - estimated_cost_usd: number | null
 *   - usage_normalized.source: 'API' | 'ESTIMATED' | 'MISSING'
 *   - timestamp_iso: ISO-8601 string
 *   - reporting_source: string — provenance label (maps to repo_name when it looks like a repo)
 *
 * This is the canonical producer for LLM cost data (OMN-2371 / GAP-5).
 * The read-model-consumer projects these per-call events into llm_cost_aggregates
 * so the cost trend dashboard has live data.
 */
export const TOPIC_OMNIINTELLIGENCE_LLM_CALL_COMPLETED =
  'onex.evt.omniintelligence.llm-call-completed.v1';

/** Wiring health snapshot events emitted by WiringHealthChecker (OMN-5292).
 * NOTE: Consumed only by the read-model-consumer via READ_MODEL_TOPICS. */
export const TOPIC_OMNIBASE_INFRA_WIRING_HEALTH_SNAPSHOT =
  'onex.evt.omnibase-infra.wiring-health-snapshot.v1';

/** Correlation trace span events emitted by the omniclaude trace emitter (OMN-5047).
 * NOTE: Intentionally excluded from buildSubscriptionTopics() / subscription groups —
 * consumed only by the read-model-consumer via READ_MODEL_TOPICS. */
export const SUFFIX_OMNICLAUDE_CORRELATION_TRACE = 'onex.evt.omniclaude.correlation-trace.v1';

/** Agent team coordination topics (OMN-7036).
 * NOTE: Consumed only by the read-model-consumer via READ_MODEL_TOPICS. */
export const SUFFIX_OMNICLAUDE_TASK_ASSIGNED = 'onex.evt.omniclaude.task-assigned.v1';
export const SUFFIX_OMNICLAUDE_TASK_PROGRESS = 'onex.evt.omniclaude.task-progress.v1';
export const SUFFIX_OMNICLAUDE_TASK_COMPLETED = 'onex.evt.omniclaude.task-completed.v1';
export const SUFFIX_OMNICLAUDE_EVIDENCE_WRITTEN = 'onex.evt.omniclaude.evidence-written.v1';

/** Context enrichment events emitted per enrichment operation (OMN-2280).
 * NOTE: Intentionally excluded from buildSubscriptionTopics() / subscription groups —
 * consumed only by the read-model-consumer via READ_MODEL_TOPICS. */
export const SUFFIX_OMNICLAUDE_CONTEXT_ENRICHMENT = 'onex.evt.omniclaude.context-enrichment.v1';

/** LLM routing decision events comparing LLM vs fuzzy routing (OMN-2279).
 * NOTE: Intentionally excluded from buildSubscriptionTopics() / subscription groups —
 * consumed only by the read-model-consumer via READ_MODEL_TOPICS. */
export const SUFFIX_OMNICLAUDE_LLM_ROUTING_DECISION = 'onex.evt.omniclaude.llm-routing-decision.v1';

/** Delegation task events emitted by the omniclaude delegation hook (OMN-2284).
 * NOTE: Intentionally excluded from buildSubscriptionTopics() / subscription groups —
 * consumed only by the read-model-consumer via READ_MODEL_TOPICS. */
export const SUFFIX_OMNICLAUDE_TASK_DELEGATED = 'onex.evt.omniclaude.task-delegated.v1';

/** Shadow comparison events for delegated tasks (OMN-2284).
 * NOTE: Intentionally excluded from buildSubscriptionTopics() / subscription groups —
 * consumed only by the read-model-consumer via READ_MODEL_TOPICS. */
export const SUFFIX_OMNICLAUDE_DELEGATION_SHADOW_COMPARISON =
  'onex.evt.omniclaude.delegation-shadow-comparison.v1';

// ============================================================================
// OmniClaude Wave 2 Topics (OMN-2596 — 5 new omniclaude tables)
// NOTE: Intentionally excluded from buildSubscriptionTopics() / subscription groups —
// consumed only by the read-model-consumer via READ_MODEL_TOPICS.
// ============================================================================

/** Gate decision events emitted when the CI gate evaluates a PR (gate_decisions table). */
export const SUFFIX_OMNICLAUDE_GATE_DECISION = 'onex.evt.omniclaude.gate-decision.v1';

/** Epic pipeline state-change events covering both epic_run_lease and epic_run_events tables. */
export const SUFFIX_OMNICLAUDE_EPIC_RUN_UPDATED = 'onex.evt.omniclaude.epic-run-updated.v1';

/** Emitted by omniclaude when a skill starts execution. */
export const SUFFIX_OMNICLAUDE_SKILL_STARTED = 'onex.evt.omniclaude.skill-started.v1';

/** Emitted by omniclaude when a skill completes execution. */
export const SUFFIX_OMNICLAUDE_SKILL_COMPLETED = 'onex.evt.omniclaude.skill-completed.v1';

/** PR watch state-change events (pr_watch_state table). */
export const SUFFIX_OMNICLAUDE_PR_WATCH_UPDATED = 'onex.evt.omniclaude.pr-watch-updated.v1';

/** Budget cap hit events (pipeline_budget_state table). */
export const SUFFIX_OMNICLAUDE_BUDGET_CAP_HIT = 'onex.evt.omniclaude.budget-cap-hit.v1';

/** Circuit breaker tripped events (debug_escalation_counts table). */
export const SUFFIX_OMNICLAUDE_CIRCUIT_BREAKER_TRIPPED =
  'onex.evt.omniclaude.circuit-breaker-tripped.v1';

// ============================================================================
// OmniIntelligence Topics
// ============================================================================

export const SUFFIX_INTELLIGENCE_CLAUDE_HOOK = 'onex.cmd.omniintelligence.claude-hook-event.v1';
export const SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED =
  'onex.evt.omniintelligence.intent-classified.v1';
// TODO(OMN-8163): verify omniclaude Kafka publisher for this topic; no confirmed active producer
export const SUFFIX_INTELLIGENCE_SESSION_OUTCOME_CMD =
  'onex.cmd.omniintelligence.session-outcome.v1';
// TODO(OMN-8161): producer not yet implemented in omniintelligence
export const SUFFIX_INTELLIGENCE_PATTERN_SCORED = 'onex.evt.omniintelligence.pattern-scored.v1';
// TODO(OMN-8162): producer not yet implemented in omniintelligence
export const SUFFIX_INTELLIGENCE_PATTERN_DISCOVERED =
  'onex.evt.omniintelligence.pattern-discovered.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_LEARNED = 'onex.evt.omniintelligence.pattern-learned.v1';
export const SUFFIX_INTELLIGENCE_TOOL_CONTENT = 'onex.cmd.omniintelligence.tool-content.v1';
export const SUFFIX_INTELLIGENCE_PROMOTION_CHECK_REQUESTED =
  'onex.cmd.omniintelligence.promotion-check-requested.v1';

/** Intelligence pipeline commands (consumed by omniintelligence) */
export const SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD = 'onex.cmd.omniintelligence.code-analysis.v1';
export const SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_CMD =
  'onex.cmd.omniintelligence.document-ingestion.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD =
  'onex.cmd.omniintelligence.pattern-learning.v1';
export const SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_CMD =
  'onex.cmd.omniintelligence.quality-assessment.v1';

/** Intelligence pipeline events (published by omniintelligence) */
export const SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED =
  'onex.evt.omniintelligence.code-analysis-completed.v1';
export const SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED =
  'onex.evt.omniintelligence.code-analysis-failed.v1';
export const SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_COMPLETED =
  'onex.evt.omniintelligence.document-ingestion-completed.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_LEARNING_COMPLETED =
  'onex.evt.omniintelligence.pattern-learning-completed.v1';
export const SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED =
  'onex.evt.omniintelligence.quality-assessment-completed.v1';
export const SUFFIX_INTELLIGENCE_COMPLIANCE_EVALUATED =
  'onex.evt.omniintelligence.compliance-evaluated.v1';

/** Context effectiveness event (OMN-5286).
 * Emitted by omniintelligence after measuring context utilization for a session.
 * Consumed by the ReadModelConsumer to invalidate the contextEffectivenessProjection cache. */
export const SUFFIX_INTELLIGENCE_CONTEXT_EFFECTIVENESS =
  'onex.evt.omniintelligence.context-effectiveness.v1';

/** Intelligence pattern lifecycle events */
export const SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITION_CMD =
  'onex.cmd.omniintelligence.pattern-lifecycle-transition.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED =
  'onex.evt.omniintelligence.pattern-lifecycle-transitioned.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_PROMOTED = 'onex.evt.omniintelligence.pattern-promoted.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_STORED = 'onex.evt.omniintelligence.pattern-stored.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_REFINED = 'onex.evt.omniintelligence.pattern-refined.v1';

/** OmniMemory document indexed event (OMN-8169) — producer emits document-indexed.v1, not document-ingested.v1 */
export const SUFFIX_OMNIMEMORY_DOCUMENT_INDEXED = 'onex.evt.omnimemory.document-indexed.v1';

/** OmniNode routing events (OMN-7810) */
export const SUFFIX_OMNINODE_ROUTING_REQUESTED = 'onex.cmd.omninode.routing-requested.v1';

/** Intelligence pattern projection snapshot (OMN-2924) */
export const SUFFIX_INTELLIGENCE_PATTERN_PROJECTION =
  'onex.evt.omniintelligence.pattern-projection.v1';

/** Objective evaluation result event (OMN-5048).
 * Emitted by NodeEvidenceCollectionEffect after each agent session evaluation.
 * Consumed by the ReadModelConsumer to project into objective_evaluations table. */
export const SUFFIX_INTELLIGENCE_RUN_EVALUATED = 'onex.evt.omniintelligence.run-evaluated.v1';

/** Intent drift detected event (OMN-5281).
 * Emitted when agent intent drifts from the original plan.
 * Consumed by the ReadModelConsumer to project into intent_drift_events table. */
export const SUFFIX_INTELLIGENCE_INTENT_DRIFT_DETECTED =
  'onex.evt.omniintelligence.intent-drift-detected.v1';

/** CI debug escalation event (OMN-5282).
 * Emitted by omniintelligence when a CI failure is escalated for debug analysis.
 * Consumed by the ReadModelConsumer to project into ci_debug_escalation_events table. */
export const SUFFIX_INTELLIGENCE_CI_DEBUG_ESCALATION =
  'onex.evt.omniintelligence.ci-debug-escalation.v1';

/** Routing feedback processed event (OMN-5284).
 * Emitted by omniintelligence after processing agent routing feedback.
 * Consumed by the ReadModelConsumer to project into routing_feedback_events table. */
export const SUFFIX_INTELLIGENCE_ROUTING_FEEDBACK_PROCESSED =
  'onex.evt.omniintelligence.routing-feedback-processed.v1';

/** Full topic string: plan review strategy run completed event.
 * Emitted by node_plan_reviewer_multi_compute (omniintelligence).
 * Consumed only by READ_MODEL_TOPICS in read-model-consumer.ts (OMN-3282). */
export const TOPIC_INTELLIGENCE_PLAN_REVIEW_STRATEGY_RUN_COMPLETED =
  'onex.evt.omniintelligence.plan-review-strategy-run-completed.v1';

/** Episode boundary event (OMN-5559).
 * Emitted by omniintelligence when an RL episode starts or completes.
 * Consumed by ReadModelConsumer to project into rl_episodes table. */
export const SUFFIX_INTELLIGENCE_EPISODE_BOUNDARY = 'onex.evt.omniintelligence.episode-boundary.v1';

/** Eval pipeline completed event (OMN-6798).
 * Emitted by omniintelligence after an autonomous evaluation run completes.
 * Consumed by ReadModelConsumer to project into eval results. */
export const SUFFIX_INTELLIGENCE_EVAL_COMPLETED = 'onex.evt.omniintelligence.eval-completed.v1';

/** Review calibration run completed event (OMN-6176).
 * Emitted by omniintelligence review-pairing calibration runner after a calibration run.
 * Consumed by ReadModelConsumer to project into review_calibration_runs_rm table. */
export const SUFFIX_INTELLIGENCE_CALIBRATION_RUN_COMPLETED =
  'onex.evt.review-pairing.calibration-run-completed.v1';

/** Pattern enforcement events emitted by the omniclaude PostToolUse hook.
 * Consumed by ReadModelConsumer to project into pattern_enforcement_events table. */
export const SUFFIX_OMNICLAUDE_PATTERN_ENFORCEMENT = 'onex.evt.omniclaude.pattern-enforcement.v1';

/** PR validation rollup events for the Model Efficiency Index (MEI) dashboard (OMN-3933).
 * Emitted by omniclaude pr-validation pipeline after a PR run completes.
 * Consumed only by the read-model-consumer via READ_MODEL_TOPICS. */
export const SUFFIX_OMNICLAUDE_PR_VALIDATION_ROLLUP = 'onex.evt.omniclaude.pr-validation-rollup.v1';

/** DoD verification completed event (OMN-5199).
 * Emitted by omniclaude dod-verify skill after running all DoD checks.
 * Consumed by ReadModelConsumer to project into dod_verify_runs table. */
export const SUFFIX_OMNICLAUDE_DOD_VERIFY_COMPLETED = 'onex.evt.omniclaude.dod-verify-completed.v1';

/** Bloom eval suite completed event (OMN-8146).
 * Emitted by node_bloom_eval_orchestrator after a full bloom eval run.
 * Consumed by ReadModelConsumer to project into intelligence_bloom_eval_results table. */
export const TOPIC_INTELLIGENCE_BLOOM_EVAL_COMPLETED =
  'onex.evt.omniintelligence.bloom-eval-completed.v1';

/** DoD guard fired event (OMN-5199).
 * Emitted by omniclaude dod-guard hook when a guard decision is made.
 * Consumed by ReadModelConsumer to project into dod_guard_events table. */
export const SUFFIX_OMNICLAUDE_DOD_GUARD_FIRED = 'onex.evt.omniclaude.dod-guard-fired.v1';

/** Debug trigger record event (OMN-5282).
 * Emitted by omniclaude when a debug escalation is triggered.
 * Consumed by ReadModelConsumer to project into debug_trigger_records table. */
export const SUFFIX_OMNICLAUDE_DEBUG_TRIGGER_RECORD = 'onex.evt.omniclaude.debug-trigger-record.v1';

/** Hostile reviewer completed event (OMN-5864).
 * Emitted by omniclaude hostile-reviewer skill on completion.
 * Consumed by ReadModelConsumer to project into hostile_reviewer_runs table. */
export const SUFFIX_OMNICLAUDE_HOSTILE_REVIEWER_COMPLETED =
  'onex.evt.omniclaude.hostile-reviewer-completed.v1';

/** DLQ message event (OMN-5287).
 * Emitted by platform consumer error handlers when a message fails processing and lands
 * in the dead-letter queue. Consumed by ReadModelConsumer to project into dlq_messages table. */
export const SUFFIX_PLATFORM_DLQ_MESSAGE = 'onex.evt.platform.dlq-message.v1';

// ============================================================================
// OmniBase Infra Topics
// ============================================================================

/** Baselines computed (OMN-5192).
 * Emitted by omnibase-infra after computing baseline comparisons.
 * Consumed by ReadModelConsumer to project into baselines_* tables. */
export const SUFFIX_OMNIBASE_INFRA_BASELINES_COMPUTED =
  'onex.evt.omnibase-infra.baselines-computed.v1';

/** LLM endpoint health snapshot (OMN-5279).
 * Emitted by omnibase-infra health poller after probing configured LLM endpoints.
 * Consumed by ReadModelConsumer to project into llm_health_snapshots table. */
export const SUFFIX_OMNIBASE_INFRA_LLM_HEALTH_SNAPSHOT =
  'onex.evt.omnibase-infra.llm-health-snapshot.v1';

/**
 * Emitted by omnibase-infra circuit breaker when a service transitions state.
 * States: CLOSED | OPEN | HALF_OPEN
 * (OMN-5293)
 */
export const TOPIC_OMNIBASE_INFRA_CIRCUIT_BREAKER = 'onex.evt.omnibase-infra.circuit-breaker.v1';
/** Alias for TOPIC_OMNIBASE_INFRA_CIRCUIT_BREAKER (SUFFIX_ naming convention). */
export const SUFFIX_OMNIBASE_INFRA_CIRCUIT_BREAKER = TOPIC_OMNIBASE_INFRA_CIRCUIT_BREAKER;

/** Tiered token savings attribution estimates (OMN-5552).
 * Consumed by ReadModelConsumer to project into savings_estimates table. */
export const SUFFIX_OMNIBASE_INFRA_SAVINGS_ESTIMATED =
  'onex.evt.omnibase-infra.savings-estimated.v1';

/** Infrastructure-level model routing decisions from AdapterModelRouter (OMN-7443).
 * Emitted by omnibase-infra after each provider selection decision.
 * Consumed by ReadModelConsumer to project into infra_routing_decisions table. */
export const TOPIC_OMNIBASE_INFRA_ROUTING_DECIDED = 'onex.evt.omnibase-infra.routing-decided.v1';

/** Runtime container error events from monitor_logs.py (OMN-5649).
 * Consumed by ReadModelConsumer to project into runtime_error_events table. */
export const TOPIC_OMNIBASE_INFRA_RUNTIME_ERROR = 'onex.evt.omnibase-infra.runtime-error.v1';

/** Runtime error triage results from NodeRuntimeErrorTriageEffect (OMN-5650).
 * Consumed by ReadModelConsumer to project into runtime_error_triage_state table. */
export const TOPIC_OMNIBASE_INFRA_ERROR_TRIAGED = 'onex.evt.omnibase-infra.error-triaged.v1';

/** Hook health error events from omniclaude hooks (OMN-7157).
 * Consumed by ReadModelConsumer to project into hook_health_events table. */
export const TOPIC_OMNICLAUDE_HOOK_HEALTH_ERROR = 'onex.evt.omniclaude.hook-health-error.v1';

// ============================================================================
// Miscellaneous Topics
// ============================================================================

export const SUFFIX_PATTERN_DISCOVERED = 'onex.evt.pattern.discovered.v1';
export const SUFFIX_AGENT_STATUS = 'onex.evt.omniclaude.agent-status.v1';

// ============================================================================
// onex_change_control Topics
// ============================================================================

/** Contract drift detected (OMN-6753).
 * Emitted by onex_change_control when cross-repo contract drift is detected.
 * Consumed by ReadModelConsumer to project into contract_drift_events table. */
export const SUFFIX_CHANGE_CONTROL_CONTRACT_DRIFT_DETECTED =
  'onex.evt.onex-change-control.contract-drift-detected.v1';

// ============================================================================
// OmniMemory Topics
// ============================================================================

export const SUFFIX_MEMORY_INTENT_STORED = 'onex.evt.omnimemory.intent-stored.v1';
export const SUFFIX_MEMORY_INTENT_QUERY_RESPONSE = 'onex.evt.omnimemory.intent-query-response.v1';
export const SUFFIX_MEMORY_INTENT_QUERY_REQUESTED = 'onex.cmd.omnimemory.intent-query-requested.v1';
// Document ingestion + memory lifecycle topics (OMN-5290)
export const SUFFIX_MEMORY_DOCUMENT_DISCOVERED = 'onex.evt.omnimemory.document-discovered.v1';
export const SUFFIX_MEMORY_STORED = 'onex.evt.omnimemory.memory-stored.v1';
export const SUFFIX_MEMORY_RETRIEVAL_RESPONSE = 'onex.evt.omnimemory.memory-retrieval-response.v1';
export const SUFFIX_MEMORY_EXPIRED = 'onex.evt.omnimemory.memory-expired.v1';

// ============================================================================
// GitHub / Git / Linear Status Topics (OMN-2658 — produced by OMN-2656 Kafka producers)
// NOTE: Intentionally excluded from buildSubscriptionTopics() / subscription groups —
// consumed only by the StatusProjection in-memory handler via event-consumer.ts.
// ============================================================================

/** GitHub PR status events emitted by the CI/CD Kafka producer (OMN-2656). */
export const SUFFIX_GITHUB_PR_STATUS = 'onex.evt.github.pr-status.v1';

/** GitHub webhook bridge events (OMN-7096). */
export const SUFFIX_GITHUB_PR_MERGED = 'onex.evt.github.pr-merged.v1';
export const SUFFIX_GITHUB_PUSH_TO_MAIN = 'onex.evt.github.push-to-main.v1';
export const SUFFIX_GITHUB_CHECK_SUITE_COMPLETED = 'onex.evt.github.check-suite-completed.v1';

/** Git hook events emitted on pre-commit / post-receive triggers (OMN-2656). */
export const SUFFIX_GIT_HOOK = 'onex.evt.git.hook.v1';

/** Linear snapshot events emitted on epic/ticket progress changes (OMN-2656). */
export const SUFFIX_LINEAR_SNAPSHOT = 'onex.evt.linear.snapshot.v1';

// ============================================================================
// Validation Topics (canonical format per topic_resolver.py)
// ============================================================================

export const SUFFIX_VALIDATION_RUN_STARTED = 'onex.evt.validation.cross-repo-run-started.v1';
export const SUFFIX_VALIDATION_VIOLATIONS_BATCH =
  'onex.evt.validation.cross-repo-violations-batch.v1';
export const SUFFIX_VALIDATION_RUN_COMPLETED = 'onex.evt.validation.cross-repo-run-completed.v1';
/** Lifecycle candidate upserted events from the OMN-2018 artifact store (OMN-2333). */
export const SUFFIX_VALIDATION_CANDIDATE_UPSERTED =
  'onex.evt.validation.lifecycle-candidate-upserted.v1';

// ============================================================================
// OmniClaude Agent Topics (canonical onex.evt.omniclaude.* namespace)
//
// These replace the legacy flat topic names (agent-actions, etc.).
// omniclaude now produces under the onex.evt.omniclaude.* namespace.
// The read-model-consumer subscribes to these canonical names.
// ============================================================================

/** Tool calls, decisions, errors, and successes from agent execution. */
export const TOPIC_OMNICLAUDE_AGENT_ACTIONS = 'onex.evt.omniclaude.agent-actions.v1';
/** Routing decision events emitted by the agent router. */
export const TOPIC_OMNICLAUDE_ROUTING_DECISIONS = 'onex.evt.omniclaude.routing-decision.v1';
/** Polymorphic agent transformation lifecycle events. */
export const TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION = 'onex.evt.omniclaude.agent-transformation.v1';
/** Routing performance metrics and cache statistics. */
export const TOPIC_OMNICLAUDE_PERFORMANCE_METRICS = 'onex.evt.omniclaude.performance-metrics.v1';

// ============================================================================
// OmniMarket Topics (OMN-7920)
// ============================================================================

/** Build loop orchestrator phase transition event.
 * Emitted by node_build_loop_orchestrator on each FSM state change.
 * Consumed by ReadModelConsumer to project into build_loop_orchestrator_events table. */
export const TOPIC_OMNIMARKET_BUILD_LOOP_ORCHESTRATOR_PHASE_TRANSITION =
  'onex.evt.omnimarket.build-loop-orchestrator-phase-transition.v1';

/** Build loop orchestrator completed event.
 * Emitted by node_build_loop_orchestrator when a run reaches COMPLETE or FAILED.
 * Consumed by ReadModelConsumer to project into build_loop_orchestrator_events table. */
export const TOPIC_OMNIMARKET_BUILD_LOOP_ORCHESTRATOR_COMPLETED =
  'onex.evt.omnimarket.build-loop-orchestrator-completed.v1';

// ============================================================================
// Topic Groups — DELETED (OMN-5252 / OMN-5031)
//
// The following arrays and buildSubscriptionTopics() were removed:
//   OMNICLAUDE_AGENT_TOPICS, PLATFORM_NODE_SUFFIXES, OMNICLAUDE_SUFFIXES,
//   OMNICLAUDE_INJECTION_SUFFIXES, OMNICLAUDE_EXTENDED_SUFFIXES,
//   INTELLIGENCE_PIPELINE_SUFFIXES, INTELLIGENCE_PATTERN_LIFECYCLE_SUFFIXES,
//   INTENT_SUFFIXES, VALIDATION_SUFFIXES, buildSubscriptionTopics()
//
// EventConsumer uses TopicDiscoveryCoordinator + loadManifestTopics() fallback.
// ReadModelConsumer uses topics.yaml via READ_MODEL_TOPICS.
// ============================================================================
