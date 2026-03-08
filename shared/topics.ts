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

/** Legacy environment prefixes (e.g. `dev.`, `staging.`). Old producers prepended these to topic names. Used to strip legacy prefixes from incoming Kafka messages so they match canonical names. */
export const ENVIRONMENT_PREFIXES = [
  'dev',
  'staging',
  'prod',
  'production',
  'test',
  'local',
] as const;
export type EnvironmentPrefix = (typeof ENVIRONMENT_PREFIXES)[number];

/**
 * Get the topic environment prefix from environment variables.
 * Defaults to 'dev' if not specified.
 *
 * **Client-side (browser)**: Vite replaces `process.env.*` at build time.
 * Since TOPIC_ENV_PREFIX / ONEX_ENV are not in the Vite define list,
 * the browser bundle always resolves to `'dev'`.
 *
 * **Server-side**: Reads from `TOPIC_ENV_PREFIX` or `ONEX_ENV` env vars.
 * These must be set BEFORE any module that imports from this file is evaluated,
 * because topic constants are resolved at module load time (not lazily).
 */
export function getTopicEnvPrefix(): string {
  if (typeof process !== 'undefined' && process.env !== undefined) {
    const prefix = process.env.TOPIC_ENV_PREFIX ?? process.env.ONEX_ENV;
    return prefix !== undefined && prefix !== '' ? prefix : 'dev';
  }
  return 'dev';
}

/**
 * Build a legacy-format topic name by prepending the environment prefix.
 * Only needed for compatibility with older producers/consumers that expect
 * the `{env}.{topic}` format. New code should use the canonical name directly.
 *
 * @example
 * resolveTopicName('onex.evt.platform.node-heartbeat.v1')
 * // => 'dev.onex.evt.platform.node-heartbeat.v1'  (legacy format)
 */
export function resolveTopicName(suffix: string, envPrefix?: string): string {
  const prefix = envPrefix ?? getTopicEnvPrefix();
  return `${prefix}.${suffix}`;
}

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

/** Registry announces it wants nodes to re-introspect (evt counterpart to the cmd variant) */
export const SUFFIX_REGISTRY_REQUEST_INTROSPECTION =
  'onex.evt.platform.registry-request-introspection.v1';

/** Topic catalog query/response topics (OMN-2315) */
export const SUFFIX_PLATFORM_TOPIC_CATALOG_QUERY = 'onex.cmd.platform.topic-catalog-query.v1';
export const SUFFIX_PLATFORM_TOPIC_CATALOG_RESPONSE = 'onex.evt.platform.topic-catalog-response.v1';
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
export const SUFFIX_INTELLIGENCE_SESSION_OUTCOME_CMD =
  'onex.cmd.omniintelligence.session-outcome.v1';
export const SUFFIX_INTELLIGENCE_SESSION_OUTCOME_EVT =
  'onex.evt.omniintelligence.session-outcome.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_SCORED = 'onex.evt.omniintelligence.pattern-scored.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_DISCOVERED =
  'onex.evt.omniintelligence.pattern-discovered.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_LEARNED = 'onex.evt.omniintelligence.pattern-learned.v1';
export const SUFFIX_INTELLIGENCE_TOOL_CONTENT = 'onex.cmd.omniintelligence.tool-content.v1';

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

/** Intelligence pattern lifecycle events */
export const SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITION_CMD =
  'onex.cmd.omniintelligence.pattern-lifecycle-transition.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED =
  'onex.evt.omniintelligence.pattern-lifecycle-transitioned.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_PROMOTED = 'onex.evt.omniintelligence.pattern-promoted.v1';
export const SUFFIX_INTELLIGENCE_PATTERN_STORED = 'onex.evt.omniintelligence.pattern-stored.v1';

/** Intelligence pattern projection snapshot (OMN-2924) */
export const SUFFIX_INTELLIGENCE_PATTERN_PROJECTION =
  'onex.evt.omniintelligence.pattern-projection.v1';

/** Full topic string: plan review strategy run completed event.
 * Emitted by node_plan_reviewer_multi_compute (omniintelligence).
 * Consumed only by READ_MODEL_TOPICS in read-model-consumer.ts (OMN-3282). */
export const TOPIC_INTELLIGENCE_PLAN_REVIEW_STRATEGY_RUN_COMPLETED =
  'onex.evt.omniintelligence.plan-review-strategy-run-completed.v1';

/** PR validation rollup events for the Model Efficiency Index (MEI) dashboard (OMN-3933).
 * Emitted by omniclaude pr-validation pipeline after a PR run completes.
 * Consumed only by the read-model-consumer via READ_MODEL_TOPICS. */
export const SUFFIX_OMNICLAUDE_PR_VALIDATION_ROLLUP = 'onex.evt.omniclaude.pr-validation-rollup.v1';

// ============================================================================
// Miscellaneous Topics
// ============================================================================

export const SUFFIX_PATTERN_DISCOVERED = 'onex.evt.pattern.discovered.v1';
export const SUFFIX_AGENT_STATUS = 'onex.evt.omniclaude.agent-status.v1';

// ============================================================================
// OmniMemory Topics
// ============================================================================

export const SUFFIX_MEMORY_INTENT_STORED = 'onex.evt.omnimemory.intent-stored.v1';
export const SUFFIX_MEMORY_INTENT_QUERY_RESPONSE = 'onex.evt.omnimemory.intent-query-response.v1';
export const SUFFIX_MEMORY_INTENT_QUERY_REQUESTED = 'onex.cmd.omnimemory.intent-query-requested.v1';

// ============================================================================
// GitHub / Git / Linear Status Topics (OMN-2658 — produced by OMN-2656 Kafka producers)
// NOTE: Intentionally excluded from buildSubscriptionTopics() / subscription groups —
// consumed only by the StatusProjection in-memory handler via event-consumer.ts.
// ============================================================================

/** GitHub PR status events emitted by the CI/CD Kafka producer (OMN-2656). */
export const SUFFIX_GITHUB_PR_STATUS = 'onex.evt.github.pr-status.v1';

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

/**
 * Canonical omniclaude agent topics consumed by the read-model-consumer.
 * Use this array as the single source of truth for agent-related subscriptions.
 * The regression test verifies every topic in this array has a handler in the switch.
 */
export const OMNICLAUDE_AGENT_TOPICS = [
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
] as const;

// ============================================================================
// Topic Groups (for subscription lists)
// ============================================================================

/** Platform node topic suffixes consumed by the dashboard */
export const PLATFORM_NODE_SUFFIXES = [
  SUFFIX_NODE_INTROSPECTION,
  SUFFIX_NODE_REGISTRATION,
  SUFFIX_REQUEST_INTROSPECTION,
  SUFFIX_REGISTRY_REQUEST_INTROSPECTION,
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
  SUFFIX_REGISTRATION_SNAPSHOTS,
  SUFFIX_FSM_STATE_TRANSITIONS,
  SUFFIX_RUNTIME_TICK,
] as const;

/** OmniClaude lifecycle topic suffixes */
export const OMNICLAUDE_SUFFIXES = [
  SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
  SUFFIX_OMNICLAUDE_SESSION_STARTED,
  SUFFIX_OMNICLAUDE_SESSION_ENDED,
  SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
] as const;

/** OmniClaude injection/extraction pipeline topic suffixes (OMN-1804) */
export const OMNICLAUDE_INJECTION_SUFFIXES = [
  SUFFIX_OMNICLAUDE_CONTEXT_UTILIZATION,
  SUFFIX_OMNICLAUDE_AGENT_MATCH,
  SUFFIX_OMNICLAUDE_LATENCY_BREAKDOWN,
] as const;

/** Extended OmniClaude topic suffixes used by `buildSubscriptionTopics()` for WebSocket subscription building. */
export const OMNICLAUDE_EXTENDED_SUFFIXES = [
  SUFFIX_OMNICLAUDE_ROUTING_DECISION,
  SUFFIX_OMNICLAUDE_SESSION_OUTCOME,
  SUFFIX_OMNICLAUDE_MANIFEST_INJECTED,
  SUFFIX_OMNICLAUDE_PHASE_METRICS,
  SUFFIX_OMNICLAUDE_NOTIFICATION_BLOCKED,
  SUFFIX_OMNICLAUDE_NOTIFICATION_COMPLETED,
  SUFFIX_OMNICLAUDE_TRANSFORMATION_COMPLETED,
] as const;

/** OmniIntelligence pipeline topic suffixes */
export const INTELLIGENCE_PIPELINE_SUFFIXES = [
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_CMD,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_COMPLETED,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED,
  // OMN-2371 (GAP-5): canonical LLM call topic emitted by NodeLlmInferenceEffect in omnibase_infra.
  // Dual-consumed: included here so buildSubscriptionTopics() forwards events to WebSocket clients
  // (real-time cost-trend feed), and also in READ_MODEL_TOPICS for durable projection via
  // projectLlmCostEvent(). Both consumers are intentional.
  // Placed in INTELLIGENCE_PIPELINE_SUFFIXES because the topic prefix is 'onex.evt.omniintelligence.*';
  // the producing service (NodeLlmInferenceEffect) lives in omnibase_infra.
  TOPIC_OMNIINTELLIGENCE_LLM_CALL_COMPLETED,
] as const;

/** Intelligence pattern lifecycle topic suffixes */
export const INTELLIGENCE_PATTERN_LIFECYCLE_SUFFIXES = [
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED,
  SUFFIX_INTELLIGENCE_PATTERN_PROMOTED,
  SUFFIX_INTELLIGENCE_PATTERN_STORED,
  SUFFIX_PATTERN_DISCOVERED,
] as const;

/** Intent topic suffixes */
export const INTENT_SUFFIXES = [
  SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED,
  SUFFIX_MEMORY_INTENT_STORED,
  SUFFIX_MEMORY_INTENT_QUERY_RESPONSE,
] as const;

/** Validation topic suffixes */
export const VALIDATION_SUFFIXES = [
  SUFFIX_VALIDATION_RUN_STARTED,
  SUFFIX_VALIDATION_VIOLATIONS_BATCH,
  SUFFIX_VALIDATION_RUN_COMPLETED,
  SUFFIX_VALIDATION_CANDIDATE_UPSERTED,
] as const;

/**
 * Build the complete subscription topic list for the event consumer.
 * All topics use canonical ONEX names (e.g. `onex.evt.omniclaude.agent-actions.v1`).
 *
 * @returns Array of topic strings suitable for passing to Kafka `consumer.subscribe()`
 */
export function buildSubscriptionTopics(): string[] {
  return [
    // Canonical ONEX agent topics
    ...OMNICLAUDE_AGENT_TOPICS,
    // Canonical ONEX platform/lifecycle topics
    ...PLATFORM_NODE_SUFFIXES,
    SUFFIX_INTELLIGENCE_CLAUDE_HOOK,
    SUFFIX_INTELLIGENCE_TOOL_CONTENT,
    SUFFIX_INTELLIGENCE_SESSION_OUTCOME_CMD,
    SUFFIX_AGENT_STATUS,
    ...OMNICLAUDE_SUFFIXES,
    ...OMNICLAUDE_INJECTION_SUFFIXES,
    ...OMNICLAUDE_EXTENDED_SUFFIXES,
    ...INTELLIGENCE_PIPELINE_SUFFIXES,
    ...INTELLIGENCE_PATTERN_LIFECYCLE_SUFFIXES,
    ...INTENT_SUFFIXES,
    ...VALIDATION_SUFFIXES,
    // Status dashboard topics (OMN-2658)
    SUFFIX_GITHUB_PR_STATUS,
    SUFFIX_GIT_HOOK,
    SUFFIX_LINEAR_SNAPSHOT,
  ];
}
