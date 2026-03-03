/**
 * Centralized Query Key Factory for TanStack Query
 *
 * Provides consistent, type-safe cache keys across the application.
 * Using a factory pattern ensures:
 * - Consistent key structure for cache management
 * - Easy cache invalidation with hierarchical keys
 * - Type safety and autocomplete support
 * - Single source of truth for query keys
 *
 * @see https://tanstack.com/query/latest/docs/framework/react/community/lukemorales-query-key-factory
 *
 * @example
 * ```ts
 * import { queryKeys } from '@/lib/query-keys';
 *
 * // In a component
 * const { data } = useQuery({
 *   queryKey: queryKeys.patlearn.summary('24h'),
 *   queryFn: () => patlearnSource.summary('24h'),
 * });
 *
 * // For cache invalidation
 * queryClient.invalidateQueries({ queryKey: queryKeys.patlearn.all });
 * ```
 */

export const queryKeys = {
  // ============================================================================
  // PATLEARN Patterns
  // ============================================================================

  /**
   * PATLEARN Pattern query keys for code pattern learning dashboard
   *
   * Hierarchical key structure enables targeted cache invalidation:
   * - `all` invalidates everything (patterns, summaries, evidence)
   * - `lists()` invalidates only list queries
   * - `summaries()` invalidates only summary queries
   * - `details()` invalidates only detail queries
   *
   * @example Invalidate all PATLEARN queries after mutation
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.patlearn.all });
   * ```
   *
   * @example Invalidate only list queries (keeps summary/detail cached)
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.patlearn.lists() });
   * ```
   *
   * @example Invalidate a specific pattern's detail
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.patlearn.detail(patternId) });
   * ```
   *
   * @example Invalidate all summaries when time window changes
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.patlearn.summaries() });
   * ```
   *
   * @example Prefetch pattern evidence before navigation
   * ```ts
   * queryClient.prefetchQuery({
   *   queryKey: queryKeys.patlearn.evidence(patternId),
   *   queryFn: () => patlearnSource.evidence(patternId),
   * });
   * ```
   */
  patlearn: {
    /** Base key for all PATLEARN queries - use for broad invalidation */
    all: ['patlearn'] as const,

    /** List queries base */
    lists: () => [...queryKeys.patlearn.all, 'list'] as const,

    /** Filtered list query */
    list: (filter: string) => [...queryKeys.patlearn.lists(), filter] as const,

    /** Summary queries base */
    summaries: () => [...queryKeys.patlearn.all, 'summary'] as const,

    /** Summary for a specific time window */
    summary: (window: string) => [...queryKeys.patlearn.summaries(), window] as const,

    /** Detail queries base */
    details: () => [...queryKeys.patlearn.all, 'detail'] as const,

    /** Single pattern detail */
    detail: (id: string) => [...queryKeys.patlearn.details(), id] as const,

    /** Score evidence for a pattern */
    evidence: (id: string) => [...queryKeys.patlearn.all, 'evidence', id] as const,
  },

  // ============================================================================
  // Agent Operations
  // ============================================================================

  /**
   * Agent operation query keys for monitoring AI agents
   *
   * Supports 52+ AI agents with hierarchical invalidation:
   * - `all` invalidates all agent data
   * - `lists()` invalidates agent lists only
   * - `summaries()` invalidates summary metrics
   * - `actions(agentId?)` invalidates action logs (all or specific agent)
   *
   * @example Invalidate all agent data after configuration change
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
   * ```
   *
   * @example Refetch a single agent's actions after it completes work
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.agents.actions(agentId) });
   * ```
   *
   * @example Invalidate all action logs across all agents
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.agents.actions() });
   * ```
   *
   * @example Update only agent summaries (keep detail views cached)
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.agents.summaries() });
   * ```
   *
   * @example Force refetch a specific agent's detail
   * ```ts
   * queryClient.refetchQueries({ queryKey: queryKeys.agents.detail(agentId) });
   * ```
   */
  agents: {
    /** Base key for all agent queries */
    all: ['agents'] as const,

    /** List of agents */
    lists: () => [...queryKeys.agents.all, 'list'] as const,

    /** Filtered agent list */
    list: (filter?: string) => [...queryKeys.agents.lists(), filter ?? 'all'] as const,

    /** Agent summaries */
    summaries: () => [...queryKeys.agents.all, 'summary'] as const,

    /** Summary for a specific scope */
    summary: (scope: string) => [...queryKeys.agents.summaries(), scope] as const,

    /** Single agent detail */
    detail: (id: string) => [...queryKeys.agents.all, 'detail', id] as const,

    /** Agent actions */
    actions: (agentId?: string) =>
      agentId
        ? ([...queryKeys.agents.all, 'actions', agentId] as const)
        : ([...queryKeys.agents.all, 'actions'] as const),
  },

  // ============================================================================
  // Events
  // ============================================================================

  /**
   * Event query keys for Kafka/Redpanda event flow monitoring
   *
   * Keys support real-time event streaming and historical queries:
   * - `all` invalidates all event data
   * - `recent(limit?)` for paginated recent events
   * - `byType(type)` for filtered event queries
   * - `stream()` for WebSocket subscription state
   *
   * @example Invalidate all event data
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.events.all });
   * ```
   *
   * @example Clear recent events cache when switching time windows
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.events.recent() });
   * // This invalidates recent(50), recent(100), etc.
   * ```
   *
   * @example Invalidate events of a specific type
   * ```ts
   * queryClient.invalidateQueries({
   *   queryKey: queryKeys.events.byType('agent-routing-decisions'),
   * });
   * ```
   *
   * @example Reset stream subscription state on reconnect
   * ```ts
   * queryClient.resetQueries({ queryKey: queryKeys.events.stream() });
   * ```
   */
  events: {
    /** Base key for all event queries */
    all: ['events'] as const,

    /** Recent events */
    recent: (limit?: number) => [...queryKeys.events.all, 'recent', limit ?? 50] as const,

    /** Events by type */
    byType: (type: string) => [...queryKeys.events.all, 'type', type] as const,

    /** Event stream/subscription */
    stream: () => [...queryKeys.events.all, 'stream'] as const,
  },

  // ============================================================================
  // Intelligence
  // ============================================================================

  /**
   * Intelligence operation query keys for AI/ML metrics
   *
   * Covers 168+ AI operations with summary, quality, and routing metrics:
   * - `all` invalidates all intelligence data
   * - `summary()` for high-level operation metrics
   * - `quality()` for code quality gate results
   * - `routing()` for agent routing decision metrics
   *
   * @example Invalidate all intelligence data after bulk operation
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.intelligence.all });
   * ```
   *
   * @example Refresh only quality metrics after code analysis
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.intelligence.quality() });
   * ```
   *
   * @example Update routing metrics after agent configuration change
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.intelligence.routing() });
   * ```
   *
   * @example Refetch summary without affecting other intelligence queries
   * ```ts
   * queryClient.refetchQueries({ queryKey: queryKeys.intelligence.summary() });
   * ```
   */
  intelligence: {
    /** Base key for all intelligence queries */
    all: ['intelligence'] as const,

    /** Summary metrics */
    summary: () => [...queryKeys.intelligence.all, 'summary'] as const,

    /** Quality metrics */
    quality: () => [...queryKeys.intelligence.all, 'quality'] as const,

    /** Routing metrics */
    routing: () => [...queryKeys.intelligence.all, 'routing'] as const,
  },

  // ============================================================================
  // Health Monitoring
  // ============================================================================

  /**
   * Health monitoring query keys for platform observability
   *
   * Supports system-wide and service-specific health checks:
   * - `all` invalidates all health data (use sparingly)
   * - `system()` for overall platform health
   * - `service(name)` for individual service health
   * - `database()` for PostgreSQL connection health
   * - `eventBus()` for Kafka/Redpanda health
   *
   * @example Invalidate all health data after infrastructure change
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.health.all });
   * ```
   *
   * @example Refresh a specific service's health status
   * ```ts
   * queryClient.invalidateQueries({
   *   queryKey: queryKeys.health.service('archon-intelligence'),
   * });
   * ```
   *
   * @example Force recheck database connectivity
   * ```ts
   * queryClient.refetchQueries({ queryKey: queryKeys.health.database() });
   * ```
   *
   * @example Invalidate event bus health after Kafka reconnect
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.health.eventBus() });
   * ```
   *
   * @example Poll system health more frequently during incident
   * ```ts
   * queryClient.setQueryDefaults(queryKeys.health.system(), {
   *   refetchInterval: 5000, // 5 seconds during incident
   * });
   * ```
   */
  health: {
    /** Base key for all health queries */
    all: ['health'] as const,

    /** Overall system health */
    system: () => [...queryKeys.health.all, 'system'] as const,

    /** Service-specific health */
    service: (serviceName: string) => [...queryKeys.health.all, 'service', serviceName] as const,

    /** Database health */
    database: () => [...queryKeys.health.all, 'database'] as const,

    /** Kafka/event bus health */
    eventBus: () => [...queryKeys.health.all, 'event-bus'] as const,
  },

  // ============================================================================
  // Registry & Discovery
  // ============================================================================

  /**
   * Registry and service discovery query keys
   *
   * Covers ONEX node registry and service discovery:
   * - `all` invalidates all registry data
   * - `nodes()` for node listing queries
   * - `node(id)` for individual node details
   * - `services()` for service discovery data
   *
   * @example Invalidate all registry data after deployment
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.registry.all });
   * ```
   *
   * @example Refresh node list after new node registration
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.registry.nodes() });
   * ```
   *
   * @example Invalidate a specific node's cached data
   * ```ts
   * queryClient.invalidateQueries({
   *   queryKey: queryKeys.registry.node(nodeId),
   * });
   * ```
   *
   * @example Update services after Consul sync
   * ```ts
   * queryClient.invalidateQueries({ queryKey: queryKeys.registry.services() });
   * ```
   *
   * @example Remove stale node from cache
   * ```ts
   * queryClient.removeQueries({ queryKey: queryKeys.registry.node(staleNodeId) });
   * ```
   */
  registry: {
    /** Base key for all registry queries */
    all: ['registry'] as const,

    /** Node registry */
    nodes: () => [...queryKeys.registry.all, 'nodes'] as const,

    /** Single node detail */
    node: (nodeId: string) => [...queryKeys.registry.all, 'node', nodeId] as const,

    /** Service discovery */
    services: () => [...queryKeys.registry.all, 'services'] as const,
  },
  // ============================================================================
  // Validation
  // ============================================================================

  /**
   * Cross-repo validation query keys for validation dashboard
   */
  validation: {
    /** Base key for all validation queries */
    all: ['validation'] as const,

    /** Summary stats */
    summary: () => [...queryKeys.validation.all, 'summary'] as const,

    /** Run lists */
    lists: () => [...queryKeys.validation.all, 'list'] as const,

    /** Filtered run list */
    list: (filter: string) => [...queryKeys.validation.lists(), filter] as const,

    /** Single run detail */
    detail: (runId: string) => [...queryKeys.validation.all, 'detail', runId] as const,

    /** Per-repo trends */
    trends: (repo: string) => [...queryKeys.validation.all, 'trends', repo] as const,

    /** Lifecycle summary (OMN-2152) */
    lifecycle: () => [...queryKeys.validation.all, 'lifecycle'] as const,
  },
  // ============================================================================
  // Extraction Pipeline (OMN-1804)
  // ============================================================================

  /**
   * Extraction pipeline query keys for pattern extraction metrics dashboard.
   *
   * Supports WebSocket invalidation: on EXTRACTION_INVALIDATE, invalidate
   * `queryKeys.extraction.all` to refetch all panels.
   */
  extraction: {
    /** Base key for all extraction queries */
    all: ['extraction'] as const,

    /** Summary stats (metric cards) */
    summary: () => [...queryKeys.extraction.all, 'summary'] as const,

    /** Pipeline health by stage */
    health: () => [...queryKeys.extraction.all, 'health'] as const,

    /** Latency heatmap */
    latency: (window: string) => [...queryKeys.extraction.all, 'latency', window] as const,

    /** Pattern volume over time */
    volume: (window: string) => [...queryKeys.extraction.all, 'volume', window] as const,

    /** Error rates summary */
    errors: () => [...queryKeys.extraction.all, 'errors'] as const,
  },
  // ============================================================================
  // Injection Effectiveness (OMN-1891)
  // ============================================================================

  effectiveness: {
    /** Base key for all effectiveness queries */
    all: ['effectiveness'] as const,

    /** Executive summary */
    summary: () => [...queryKeys.effectiveness.all, 'summary'] as const,

    /** Auto-throttle status */
    throttle: () => [...queryKeys.effectiveness.all, 'throttle'] as const,

    /** Latency details */
    latency: () => [...queryKeys.effectiveness.all, 'latency'] as const,

    /** Utilization analytics */
    utilization: () => [...queryKeys.effectiveness.all, 'utilization'] as const,

    /** A/B comparison */
    ab: () => [...queryKeys.effectiveness.all, 'ab'] as const,

    /** Multi-metric trend */
    trend: () => [...queryKeys.effectiveness.all, 'trend'] as const,

    /** Single session detail */
    session: (id: string) => [...queryKeys.effectiveness.all, 'session', id] as const,
  },
  // ============================================================================
  // Baselines & ROI (OMN-2156)
  // ============================================================================

  /**
   * Baselines & ROI query keys for cost + outcome comparison dashboard.
   */
  baselines: {
    /** Base key for all baselines queries */
    all: ['baselines'] as const,

    /** Summary metrics */
    summary: () => [...queryKeys.baselines.all, 'summary'] as const,

    /** Pattern comparisons list */
    comparisons: () => [...queryKeys.baselines.all, 'comparisons'] as const,

    /** ROI trend over time (days defaults to 14) */
    trend: (days?: number) => [...queryKeys.baselines.all, 'trend', days ?? 14] as const,

    /** Recommendation breakdown */
    breakdown: () => [...queryKeys.baselines.all, 'breakdown'] as const,
  },

  // ============================================================================
  // Projections (OMN-2095)
  // ============================================================================

  /**
   * Projection query keys for server-side materialized views.
   *
   * Used by `useProjectionStream` hook for TanStack Query cache management.
   * On PROJECTION_INVALIDATE, invalidate the specific view's snapshot.
   */
  projections: {
    /** Base key for all projection queries */
    all: ['projections'] as const,

    /** All queries for a specific view */
    view: (viewId: string) => [...queryKeys.projections.all, viewId] as const,

    /** Snapshot query for a view */
    snapshot: (viewId: string, limit?: number) =>
      [...queryKeys.projections.view(viewId), 'snapshot', limit ?? 'default'] as const,

    /** Events-since query for a view */
    events: (viewId: string, cursor: number) =>
      [...queryKeys.projections.view(viewId), 'events', cursor] as const,
  },

  // ============================================================================
  // Cost Trends (OMN-2242)
  // ============================================================================

  /**
   * Cost trend query keys for LLM cost and token usage dashboard.
   */
  costs: {
    /** Base key for all cost queries */
    all: ['costs'] as const,

    /** Summary metrics for a time window */
    summary: (window: string) => [...queryKeys.costs.all, 'summary', window] as const,

    /** Cost trend over time */
    trend: (window: string) => [...queryKeys.costs.all, 'trend', window] as const,

    /** Cost breakdown by model */
    byModel: () => [...queryKeys.costs.all, 'by-model'] as const,

    /** Cost breakdown by repo */
    byRepo: () => [...queryKeys.costs.all, 'by-repo'] as const,

    /** Cost breakdown by pattern */
    byPattern: () => [...queryKeys.costs.all, 'by-pattern'] as const,

    /** Token usage breakdown */
    tokenUsage: (window: string) => [...queryKeys.costs.all, 'token-usage', window] as const,

    /** Budget alerts */
    alerts: () => [...queryKeys.costs.all, 'alerts'] as const,
  },

  // ============================================================================
  // Learned Insights (OMN-1407)
  // ============================================================================

  insights: {
    /** Base key for all insights queries */
    all: ['insights'] as const,

    /** Insights summary with full insight list */
    summary: () => [...queryKeys.insights.all, 'summary'] as const,

    /** Insight discovery trend */
    trend: () => [...queryKeys.insights.all, 'trend'] as const,
  },

  // ============================================================================
  // Pattern Enforcement (OMN-2275)
  // ============================================================================

  /**
   * Pattern enforcement query keys for the enforcement metrics dashboard.
   *
   * On ENFORCEMENT_INVALIDATE WebSocket event, invalidate `queryKeys.enforcement.all`
   * to trigger a full refetch of all enforcement panels.
   */
  enforcement: {
    /** Base key for all enforcement queries */
    all: ['enforcement'] as const,

    /** Summary metrics (hero cards) for a time window */
    summary: (window: string) => [...queryKeys.enforcement.all, 'summary', window] as const,

    /** Hit rate breakdown by language */
    byLanguage: (window: string) => [...queryKeys.enforcement.all, 'by-language', window] as const,

    /** Hit rate breakdown by domain */
    byDomain: (window: string) => [...queryKeys.enforcement.all, 'by-domain', window] as const,

    /** Top violated patterns table */
    violatedPatterns: (window: string) =>
      [...queryKeys.enforcement.all, 'violated-patterns', window] as const,

    /** Multi-metric trend data */
    trend: (window: string) => [...queryKeys.enforcement.all, 'trend', window] as const,
  },
  // ============================================================================
  // Context Enrichment (OMN-2280)
  // ============================================================================

  /**
   * Context enrichment query keys for the enrichment metrics dashboard.
   *
   * On ENRICHMENT_INVALIDATE WebSocket event, invalidate `queryKeys.enrichment.all`
   * to trigger a full refetch of all enrichment panels.
   */
  enrichment: {
    /** Base key for all enrichment queries */
    all: ['enrichment'] as const,

    /** Summary metrics (hero cards) for a time window */
    summary: (window: string) => [...queryKeys.enrichment.all, 'summary', window] as const,

    /** Hit rate breakdown by channel */
    byChannel: (window: string) => [...queryKeys.enrichment.all, 'by-channel', window] as const,

    /** Latency distribution per model */
    latencyDistribution: (window: string) =>
      [...queryKeys.enrichment.all, 'latency-distribution', window] as const,

    /** Token savings trend */
    tokenSavings: (window: string) =>
      [...queryKeys.enrichment.all, 'token-savings', window] as const,

    /** Similarity search quality trend */
    similarityQuality: (window: string) =>
      [...queryKeys.enrichment.all, 'similarity-quality', window] as const,

    /** Context inflation alerts */
    inflationAlerts: (window: string) =>
      [...queryKeys.enrichment.all, 'inflation-alerts', window] as const,
  },
  // ============================================================================
  // LLM Routing Effectiveness (OMN-2279)
  // ============================================================================

  /**
   * LLM routing effectiveness query keys for the LLM routing dashboard.
   *
   * On LLM_ROUTING_INVALIDATE WebSocket event, invalidate `queryKeys.llmRouting.all`
   * to trigger a full refetch of all routing panels.
   */
  llmRouting: {
    /** Base key for all LLM routing queries */
    all: ['llm-routing'] as const,

    /** Summary metrics (hero cards) for a time window */
    summary: (window: string) => [...queryKeys.llmRouting.all, 'summary', window] as const,

    /** Latency distribution per routing method */
    latency: (window: string) => [...queryKeys.llmRouting.all, 'latency', window] as const,

    /** Agreement rate by routing prompt version */
    byVersion: (window: string) => [...queryKeys.llmRouting.all, 'by-version', window] as const,

    /** Top LLM vs fuzzy disagreements */
    disagreements: (window: string) =>
      [...queryKeys.llmRouting.all, 'disagreements', window] as const,

    /** Multi-metric trend over time */
    trend: (window: string) => [...queryKeys.llmRouting.all, 'trend', window] as const,

    /** Per-model effectiveness metrics including token averages (OMN-3443, OMN-3449) */
    byModel: (window: string) => [...queryKeys.llmRouting.all, 'by-model', window] as const,

    /** ONEX path vs legacy path comparison (OMN-3450) */
    byOmninodeMode: (window: string) =>
      [...queryKeys.llmRouting.all, 'by-omninode-mode', window] as const,
  },
  // ============================================================================
  // Delegation Metrics (OMN-2284)
  // ============================================================================

  /**
   * Delegation metrics query keys for the delegation metrics dashboard.
   *
   * On DELEGATION_INVALIDATE WebSocket event, invalidate `queryKeys.delegation.all`
   * to trigger a full refetch of all delegation panels.
   */
  delegation: {
    /** Base key for all delegation queries */
    all: ['delegation'] as const,

    /** Summary metrics (hero cards) for a time window */
    summary: (window: string) => [...queryKeys.delegation.all, 'summary', window] as const,

    /** Delegation breakdown by task type */
    byTaskType: (window: string) => [...queryKeys.delegation.all, 'by-task-type', window] as const,

    /** Cost savings trend */
    costSavings: (window: string) => [...queryKeys.delegation.all, 'cost-savings', window] as const,

    /** Quality gate pass rate trend */
    qualityGates: (window: string) =>
      [...queryKeys.delegation.all, 'quality-gates', window] as const,

    /** Shadow divergence table */
    shadowDivergence: (window: string) =>
      [...queryKeys.delegation.all, 'shadow-divergence', window] as const,

    /** Multi-metric trend over time */
    trend: (window: string) => [...queryKeys.delegation.all, 'trend', window] as const,
  },
  // ============================================================================
  // Status Dashboard (OMN-2658)
  // ============================================================================

  /**
   * Status dashboard query keys for the /status page.
   *
   * On STATUS_INVALIDATE WebSocket event, invalidate `queryKeys.status.all`
   * to trigger a full refetch of all status panels.
   */
  status: {
    /** Base key for all status queries */
    all: ['status'] as const,

    /** All PRs grouped by triage state */
    prs: () => [...queryKeys.status.all, 'prs'] as const,

    /** PRs for a specific repo */
    prsByRepo: (repo: string) => [...queryKeys.status.all, 'prs', repo] as const,

    /** Recent hook events */
    hooks: (limit?: number) => [...queryKeys.status.all, 'hooks', limit ?? 50] as const,

    /** Summary (triage counts + CI failure repos) */
    summary: () => [...queryKeys.status.all, 'summary'] as const,

    /** Linear workstreams snapshot */
    workstreams: () => [...queryKeys.status.all, 'workstreams'] as const,
  },
  // ============================================================================
  // Wave 2 omniclaude state event dashboards (OMN-2602)
  // ============================================================================

  /** Gate decisions query keys (onex.evt.omniclaude.gate-decision.v1) */
  gateDecisions: {
    all: ['gate-decisions'] as const,
    snapshot: () => [...queryKeys.gateDecisions.all, 'snapshot'] as const,
  },

  /** Epic run query keys (onex.evt.omniclaude.epic-run-updated.v1) */
  epicRun: {
    all: ['epic-run'] as const,
    snapshot: () => [...queryKeys.epicRun.all, 'snapshot'] as const,
  },

  /** PR watch query keys (onex.evt.omniclaude.pr-watch-updated.v1) */
  prWatch: {
    all: ['pr-watch'] as const,
    snapshot: () => [...queryKeys.prWatch.all, 'snapshot'] as const,
  },

  /** Pipeline budget query keys (onex.evt.omniclaude.budget-cap-hit.v1) */
  pipelineBudget: {
    all: ['pipeline-budget'] as const,
    snapshot: () => [...queryKeys.pipelineBudget.all, 'snapshot'] as const,
  },

  /** Debug escalation query keys (onex.evt.omniclaude.circuit-breaker-tripped.v1) */
  debugEscalation: {
    all: ['debug-escalation'] as const,
    snapshot: () => [...queryKeys.debugEscalation.all, 'snapshot'] as const,
  },

  /** CDQA gate query keys — file-poll from ~/.claude/skill-results (OMN-3190) */
  cdqaGates: {
    all: ['cdqa-gates'] as const,
    summaries: () => [...queryKeys.cdqaGates.all, 'summaries'] as const,
  },

  /** Pipeline health query keys — file-poll from ~/.claude/pipelines (OMN-3192) */
  pipelineHealth: {
    all: ['pipeline-health'] as const,
    summaries: () => [...queryKeys.pipelineHealth.all, 'summaries'] as const,
    detail: (ticketId: string) => [...queryKeys.pipelineHealth.all, 'detail', ticketId] as const,
  },

  /** Event bus health query keys — polled from Redpanda Admin API (OMN-3192) */
  eventBusHealth: {
    all: ['event-bus-health'] as const,
    full: () => [...queryKeys.eventBusHealth.all, 'full'] as const,
    topics: () => [...queryKeys.eventBusHealth.all, 'topics'] as const,
    summary: () => [...queryKeys.eventBusHealth.all, 'summary'] as const,
  },

  // ============================================================================
  // Plan Reviewer (OMN-3324)
  // ============================================================================

  /** Plan reviewer query keys for /plan-reviewer dashboard */
  planReviewer: {
    /** Base key for all plan reviewer queries */
    all: ['plan-reviewer'] as const,

    /** Recent runs list (optionally filtered by strategy) */
    runs: (limit?: number, strategy?: string) =>
      [...queryKeys.planReviewer.all, 'runs', limit ?? 50, strategy ?? 'all'] as const,

    /** Per-strategy aggregates */
    strategies: () => [...queryKeys.planReviewer.all, 'strategies'] as const,

    /** Model accuracy leaderboard (latest snapshot) */
    accuracy: () => [...queryKeys.planReviewer.all, 'accuracy'] as const,
  },

  // ============================================================================
  // Objective Evaluation (OMN-2583)
  // ============================================================================

  /**
   * Objective evaluation query keys for score vectors, gate failures,
   * policy state, and anti-gaming alerts.
   *
   * Depends on OMN-2545 (ScoringReducer) and OMN-2557 (PolicyState) backends.
   * Falls back to mock data when those backends are unavailable.
   */
  objective: {
    /** Base key for all objective evaluation queries */
    all: ['objective'] as const,

    /** Per-layer score vector data (radar chart) */
    scoreVector: (window: string) => ['objective', 'score-vector', window] as const,

    /** Gate failure timeline bins and events */
    gateFailures: (window: string) => ['objective', 'gate-failures', window] as const,

    /** Policy state history points */
    policyState: (window: string) => ['objective', 'policy-state', window] as const,

    /** Anti-gaming alert feed */
    antiGaming: (window: string) => ['objective', 'anti-gaming', window] as const,
  },
} as const;

/**
 * Type helper for query keys
 */
export type QueryKeys = typeof queryKeys;
