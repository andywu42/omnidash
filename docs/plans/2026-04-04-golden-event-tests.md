# Golden Event Tests — Implementation Plan

**Date**: 2026-04-04
**Status**: Ready for execution
**Ticket**: SOW-Phase2

---

## Goal

Verify every Kafka topic to DB projection to API route pipeline end-to-end via golden event tests. Each test publishes a known event payload, asserts the projection handler writes correct fields to the DB, and asserts the API returns the data. A CI gate fails the build if any `topics.yaml` read-model topic lacks a golden test or any golden test fails.

## Architecture

```
topics.yaml (source of truth)
    |
    v
golden-chain-coverage.yml (CI gate)
    |
    v
GoldenEventTestRunner (base class)
    |-- GOLDEN_MODE=unit   -> direct handleMessage + mock DB assertions
    |-- GOLDEN_MODE=integration -> real Kafka (192.168.86.201:19092) + real Postgres
    |
    v
server/__tests__/golden-chain/<pipeline>.golden.test.ts
```

**Dual mode**: Same test code, `GOLDEN_MODE` env var swaps the backend:
- `GOLDEN_MODE=unit` (CI default): calls projection handler directly via `ReadModelConsumer.handleMessage`; mock DB captures insert arguments for field-level assertions.
- `GOLDEN_MODE=integration` (local): Publishes to real Kafka via KafkaJS; polls real Postgres for arrival.

## Tech Stack

- **Test framework**: Vitest (existing, `vitest.config.ts`)
- **DB access**: Drizzle ORM (existing `shared/intelligence-schema.ts`)
- **Kafka mock**: Direct handler invocation via `ReadModelConsumer.handleMessage` (existing pattern from `read-model-consumer.test.ts`)
- **HTTP assertions**: Supertest (existing dev dependency)
- **CI**: GitHub Actions (existing `.github/workflows/`)

## Known Types Inventory

### Existing Test Patterns (server/__tests__/)

| Pattern | Example File | Technique |
|---------|-------------|-----------|
| Projection unit test | `read-model-consumer.test.ts` | Mock DB insert/execute, call `handleMessage` directly |
| Integration test | `integration/patterns-api.integration.test.ts` | Real test DB, `createTestApp()`, supertest |
| Golden path helpers | `integration/golden-path-helpers.ts` | `verifyPatternArrival()`, `verifyEffectivenessArrival()` |
| Test DB helpers | `integration/helpers.ts` | `getTestDb()`, `createTestApp()`, `seedPatterns()`, `truncatePatterns()` |
| Kafka payload factory | `read-model-consumer.test.ts` | `makeKafkaPayload(topic, data)` -> `EachMessagePayload` |

### Projection Handler Inventory (from `server/consumers/read-model/`)

| Handler File | Handler Class | Topics Handled |
|-------------|---------------|---------------|
| `omniintelligence-projections.ts` | `OmniintelligenceProjectionHandler` | 18 topics (llm-call-completed, pattern-*, run-evaluated, etc.) |
| `omniclaude-projections.ts` | `OmniclaudeProjectionHandler` | 28 topics (routing-decision, task-delegated, session-outcome, budget-cap-hit, etc.) |
| `omnibase-infra-projections.ts` | `OmnibaseInfraProjectionHandler` | 8 topics (baselines-computed, savings-estimated, circuit-breaker, etc.) |
| `platform-projections.ts` | `PlatformProjectionHandler` | 7 topics (node-introspection, node-heartbeat, dlq-message, etc.) |
| `omnimemory-projections.ts` | `OmnimemoryProjectionHandler` | 5 topics (document-discovered, memory-stored, etc.) |
| `dod-projections.ts` | `DodProjectionHandler` | 2 topics (dod-guard-fired, dod-verify-completed) |
| `eval-projections.ts` | `EvalProjectionHandler` | topic count TBD |
| `change-control-projections.ts` | `ChangeControlProjectionHandler` | 1 topic (contract-drift-detected) |

---

## Task 1: Create GoldenEventTestRunner Base Class

**Files**:
- `server/__tests__/golden-chain/runner.ts`

**Steps**:

1. Create `server/__tests__/golden-chain/` directory.

2. Implement `GoldenEventTestRunner` with the following interface:

```typescript
// server/__tests__/golden-chain/runner.ts
import { randomUUID } from 'crypto';
import type { EachMessagePayload } from 'kafkajs';
import { sql } from 'drizzle-orm';

export type GoldenMode = 'unit' | 'integration';

export function getMode(): GoldenMode {
  return (process.env.GOLDEN_MODE || 'unit') as GoldenMode;
}

/**
 * Build a minimal EachMessagePayload for testing handleMessage.
 * Reuses the proven pattern from read-model-consumer.test.ts.
 */
export function makeKafkaPayload(
  topic: string,
  data: Record<string, unknown>
): EachMessagePayload {
  return {
    topic,
    partition: 0,
    message: {
      key: null,
      value: Buffer.from(JSON.stringify(data)),
      offset: '0',
      timestamp: Date.now().toString(),
      size: 0,
      attributes: 0,
      headers: {},
    },
    heartbeat: () => Promise.resolve(),
    pause: () => () => {},
  };
}

/**
 * Publish an event through the projection pipeline.
 * In unit mode: calls ReadModelConsumer.handleMessage directly.
 * In integration mode: publishes to real Kafka and polls for DB arrival.
 */
export async function publishEvent(
  topic: string,
  payload: Record<string, unknown>,
  consumer: { handleMessage: (p: EachMessagePayload) => Promise<void> }
): Promise<void> {
  const mode = getMode();
  if (mode === 'unit') {
    await consumer.handleMessage(makeKafkaPayload(topic, payload));
  } else {
    // Integration mode: publish via KafkaJS producer
    const { Kafka } = await import('kafkajs');
    const kafka = new Kafka({
      clientId: 'golden-test-producer',
      brokers: [process.env.KAFKA_BROKERS || '192.168.86.201:19092'],
    });
    const producer = kafka.producer();
    await producer.connect();
    await producer.send({
      topic,
      messages: [{ value: JSON.stringify(payload) }],
    });
    await producer.disconnect();
  }
}

/**
 * Assert a row exists in the given table matching the provided conditions.
 * Returns the matching rows for further field-level assertions.
 *
 * SAFETY: This is test infrastructure only. The tableName and where parameters
 * are hardcoded in test files, never from user input. In integration mode,
 * this polls real Postgres with a timeout for eventual consistency.
 */
export async function assertDbRow(
  db: ReturnType<typeof import('drizzle-orm/node-postgres').drizzle>,
  tableName: string,
  whereClause: string,
  options: { timeout?: number; pollInterval?: number } = {}
): Promise<Record<string, unknown>[]> {
  // Validate tableName is a safe identifier (letters, digits, underscores only)
  if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
    throw new Error(`assertDbRow: invalid table name "${tableName}"`);
  }

  const mode = getMode();
  const timeout = options.timeout || (mode === 'integration' ? 10000 : 0);
  const pollInterval = options.pollInterval || 500;

  const query = sql.raw(`SELECT * FROM ${tableName} WHERE ${whereClause}`);
  const start = Date.now();

  while (true) {
    const result = await db.execute(query);
    const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
    if (rows && rows.length > 0) return rows;
    if (Date.now() - start >= timeout) {
      throw new Error(
        `assertDbRow: no rows found in ${tableName} matching [${whereClause}] after ${timeout}ms`
      );
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}

/**
 * Generate a deterministic correlation ID for golden tests.
 * Uses a prefix to make golden test data easy to identify and clean up.
 */
export function goldenId(suffix?: string): string {
  return suffix ? `golden-${suffix}-${randomUUID()}` : `golden-${randomUUID()}`;
}
```

**Test command**: `npx vitest run server/__tests__/golden-chain/runner.test.ts`

---

## Task 2: Create Mock Infrastructure Adapters

**Files**:
- `server/__tests__/golden-chain/adapters.ts`

**Steps**:

1. Create adapter layer with mock DB factory and consumer factory.

**Important**: `vi.mock()` calls are hoisted to the top of the file by Vitest's transform. They cannot be called from imported functions. Each golden test file MUST declare its own `vi.mock()` calls at the top level. The standard mock block (storage, kafkajs, projection-bootstrap, baselines-events, topic-catalog-manager, and all event emitters) is provided as a copy-paste template in the auto-generator (Task 14) and in the LLM Cost golden test (Task 3).

The required mocks for ALL golden chain tests (copy into each `.golden.test.ts`):
```typescript
vi.mock('../../storage', () => ({
  tryGetIntelligenceDb: vi.fn(),
  getIntelligenceDb: vi.fn(),
  isDatabaseConfigured: vi.fn(() => false),
}));
vi.mock('kafkajs', () => ({
  Kafka: vi.fn(() => ({
    consumer: vi.fn(() => ({
      connect: vi.fn(), subscribe: vi.fn(), run: vi.fn(), disconnect: vi.fn(),
    })),
  })),
}));
vi.mock('../../projection-bootstrap', () => ({
  baselinesProjection: { reset: vi.fn() },
  llmRoutingProjection: { invalidateCache: vi.fn() },
}));
vi.mock('../../baselines-events', () => ({ emitBaselinesUpdate: vi.fn() }));
vi.mock('../../topic-catalog-manager', () => ({
  TopicCatalogManager: vi.fn(() => ({
    bootstrap: vi.fn(), stop: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(), on: vi.fn(),
  })),
}));
// Event emitter mocks (projection handlers call these on success)
vi.mock('../../llm-routing-events', () => ({ emitLlmRoutingInvalidate: vi.fn() }));
vi.mock('../../delegation-events', () => ({ emitDelegationInvalidate: vi.fn() }));
vi.mock('../../enrichment-events', () => ({ emitEnrichmentInvalidate: vi.fn() }));
vi.mock('../../enforcement-events', () => ({ emitEnforcementInvalidate: vi.fn() }));
vi.mock('../../omniclaude-state-events', () => ({
  emitGateDecisionInvalidate: vi.fn(),
  emitEpicRunInvalidate: vi.fn(),
  emitPrWatchInvalidate: vi.fn(),
  emitPipelineBudgetInvalidate: vi.fn(),
  emitCircuitBreakerInvalidate: vi.fn(),
}));
vi.mock('../../effectiveness-events', () => ({ emitEffectivenessUpdate: vi.fn() }));
```

```typescript
// server/__tests__/golden-chain/adapters.ts
import { vi } from 'vitest';
import { ReadModelConsumer } from '../../read-model-consumer';

/**
 * Build a mock DB that tracks insert calls and returns their arguments.
 * Supports both drizzle insert().values().onConflictDoNothing() chains
 * and raw db.execute(sql`...`) calls.
 */
export function createMockDb() {
  const insertedRows: { table: string; values: Record<string, unknown> }[] = [];
  const executedQueries: unknown[] = [];

  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);

  const valuesMock = vi.fn().mockImplementation((row: Record<string, unknown>) => {
    return {
      onConflictDoNothing,
      onConflictDoUpdate,
    };
  });

  const insertMock = vi.fn().mockImplementation((table: unknown) => {
    return { values: valuesMock };
  });

  const executeMock = vi.fn().mockResolvedValue(undefined);

  const db = {
    insert: insertMock,
    execute: executeMock,
    insertedRows,
    executedQueries,
  };

  return { db, insertMock, valuesMock, executeMock, onConflictDoNothing, onConflictDoUpdate };
}

/**
 * Build a ReadModelConsumer with access to its private handleMessage.
 */
export function createTestConsumer(): {
  consumer: ReadModelConsumer;
  handleMessage: (p: import('kafkajs').EachMessagePayload) => Promise<void>;
} {
  const consumer = new ReadModelConsumer();
  const handleMessage = (
    consumer as unknown as {
      handleMessage: (p: import('kafkajs').EachMessagePayload) => Promise<void>;
    }
  ).handleMessage.bind(consumer);
  return { consumer, handleMessage };
}
```

---

## Task 3: Golden Test — LLM Cost Pipeline

**Pipeline**: `onex.evt.omniintelligence.llm-call-completed.v1` -> `llm_cost_aggregates` -> `/api/costs/summary`

**Files**:
- `server/__tests__/golden-chain/llm-cost.golden.test.ts`

**Steps**:

1. Create the golden test file:

```typescript
// server/__tests__/golden-chain/llm-cost.golden.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeKafkaPayload } from './runner';

// Mock infrastructure (must precede consumer import)
vi.mock('../../storage', () => ({
  tryGetIntelligenceDb: vi.fn(),
  getIntelligenceDb: vi.fn(),
  isDatabaseConfigured: vi.fn(() => false),
}));
vi.mock('kafkajs', () => ({
  Kafka: vi.fn(() => ({
    consumer: vi.fn(() => ({
      connect: vi.fn(), subscribe: vi.fn(), run: vi.fn(), disconnect: vi.fn(),
    })),
  })),
}));
vi.mock('../../projection-bootstrap', () => ({
  baselinesProjection: { reset: vi.fn() },
  llmRoutingProjection: { invalidateCache: vi.fn() },
}));
vi.mock('../../baselines-events', () => ({ emitBaselinesUpdate: vi.fn() }));
vi.mock('../../topic-catalog-manager', () => ({
  TopicCatalogManager: vi.fn(() => ({
    bootstrap: vi.fn(), stop: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(), on: vi.fn(),
  })),
}));
vi.mock('../../llm-routing-events', () => ({ emitLlmRoutingInvalidate: vi.fn() }));
vi.mock('../../delegation-events', () => ({ emitDelegationInvalidate: vi.fn() }));
vi.mock('../../enrichment-events', () => ({ emitEnrichmentInvalidate: vi.fn() }));
vi.mock('../../enforcement-events', () => ({ emitEnforcementInvalidate: vi.fn() }));
vi.mock('../../omniclaude-state-events', () => ({
  emitGateDecisionInvalidate: vi.fn(),
  emitEpicRunInvalidate: vi.fn(),
  emitPrWatchInvalidate: vi.fn(),
  emitPipelineBudgetInvalidate: vi.fn(),
  emitCircuitBreakerInvalidate: vi.fn(),
}));
vi.mock('../../effectiveness-events', () => ({ emitEffectivenessUpdate: vi.fn() }));

import { ReadModelConsumer } from '../../read-model-consumer';

const TOPIC = 'onex.evt.omniintelligence.llm-call-completed.v1';
const TABLE = 'llm_cost_aggregates';

describe(`Golden Chain: ${TOPIC} -> ${TABLE}`, () => {
  let consumer: ReadModelConsumer;
  let handleMessage: (p: import('kafkajs').EachMessagePayload) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    consumer = new ReadModelConsumer();
    handleMessage = (
      consumer as unknown as { handleMessage: (p: import('kafkajs').EachMessagePayload) => Promise<void> }
    ).handleMessage.bind(consumer);
  });

  it('projects canonical ContractLlmCallMetrics payload to llm_cost_aggregates', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi.fn().mockReturnValue({ values: insertValues });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock, execute: executeMock,
    });

    const payload = {
      model_id: 'claude-sonnet-4-6',
      prompt_tokens: 2500,
      completion_tokens: 800,
      total_tokens: 3300,
      estimated_cost_usd: 0.015,
      usage_normalized: { source: 'API' },
      timestamp_iso: '2026-04-04T12:00:00Z',
      reporting_source: 'omniclaude',
      session_id: 'golden-session-001',
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    expect(insertMock).toHaveBeenCalled();
    const row = insertValues.mock.calls[0]?.[0];
    expect(row).toBeDefined();

    // Field-level assertions — the golden contract
    expect(row.modelName).toBe('claude-sonnet-4-6');
    expect(row.promptTokens).toBe(2500);
    expect(row.completionTokens).toBe(800);
    expect(row.totalTokens).toBe(3300);
    expect(row.estimatedCostUsd).toBe('0.015');
    expect(row.usageSource).toBe('API');
    expect(row.repoName).toBe('omniclaude');
    expect(row.sessionId).toBe('golden-session-001');
    expect(row.bucketTime).toBeInstanceOf(Date);
    expect(row.granularity).toBe('hour');

    const stats = consumer.getStats();
    expect(stats.eventsProjected).toBe(1);
    expect(stats.errorsCount).toBe(0);
  });
});
```

**API verification** (integration mode extension, Task 11):
- `GET /api/costs/summary` should return aggregated costs including the golden event's model.

**Test command**: `npx vitest run server/__tests__/golden-chain/llm-cost.golden.test.ts`

---

## Task 4: Golden Test — LLM Routing Pipeline

**Pipeline**: `onex.evt.omniclaude.llm-routing-decision.v1` -> `llm_routing_decisions` -> `/api/intelligence/routing/summary`

**Files**:
- `server/__tests__/golden-chain/llm-routing.golden.test.ts`

**Payload fields** (from `projectLlmRoutingDecisionEvent`):
- `correlation_id` (UUID, required)
- `session_id`
- `selected_agent` / `llm_selected_candidate` -> `llm_agent`
- `fuzzy_top_candidate` / `fuzzy_agent` -> `fuzzy_agent`
- `agreement` (bool, derived if absent: `llm_agent === fuzzy_agent`)
- `llm_confidence`, `fuzzy_confidence`
- `llm_latency_ms`, `fuzzy_latency_ms`
- `routing_prompt_version`
- `intent`, `model`, `cost_usd`
- `prompt_tokens`, `completion_tokens`, `total_tokens`
- `omninode_enabled` (defaults true)
- `fallback_used` (if true, event is skipped -- not projected)

**Golden assertions**:
- Row inserted into `llm_routing_decisions` with correct `llm_agent`, `fuzzy_agent`, `agreement`
- `used_fallback=false` events are projected; `used_fallback=true` events are skipped
- Non-UUID `correlation_id` events are skipped with warning

---

## Task 5: Golden Test — Savings Pipeline

**Pipeline**: `onex.evt.omnibase-infra.savings-estimated.v1` -> `savings_estimates` -> `/api/savings/summary`

**Files**:
- `server/__tests__/golden-chain/savings.golden.test.ts`

**Payload fields** (from `projectSavingsEstimated`):
- `session_id` (required, skip if empty)
- `correlation_id` -> `source_event_id` (or deterministic from Kafka coords)
- `schema_version`
- `actual_total_tokens`, `actual_cost_usd`, `actual_model_id`
- `counterfactual_model_id`
- `direct_savings_usd`, `direct_tokens_saved`
- `estimated_total_savings_usd`, `estimated_total_tokens_saved`
- `categories` (JSON array)
- `direct_confidence`, `heuristic_confidence_avg`
- `estimation_method`, `treatment_group`, `is_measured`
- `completeness_status`, `pricing_manifest_version`
- `timestamp_iso` -> `event_timestamp`

**Golden assertions**:
- Row inserted into `savings_estimates` with all monetary fields as strings (numeric precision)
- Upsert on `source_event_id` updates existing row
- Missing `session_id` returns true (skipped) without DB write

---

## Task 6: Golden Test — Baselines Pipeline

**Pipeline**: `onex.evt.omnibase-infra.baselines-computed.v1` -> `baselines_snapshots` + child tables -> `/api/baselines/summary`

**Files**:
- `server/__tests__/golden-chain/baselines.golden.test.ts`

**Payload fields** (from `projectBaselinesSnapshot`):
- `snapshot_id` (UUID or derived from Kafka coords)
- `contract_version`, `computed_at_utc`
- `window_start_utc`, `window_end_utc`
- `comparisons[]` -> `baselines_comparisons` (pattern_id, recommendation, confidence)
- `trend[]` -> `baselines_trend` (date YYYY-MM-DD, avg_cost_savings, avg_outcome_improvement)
- `breakdown[]` -> `baselines_breakdown` (action, count, avg_confidence)

**Golden assertions**:
- Transaction writes to all 4 tables atomically
- Invalid `recommendation` values coerce to `'shadow'`
- Invalid `confidence` values coerce to `'low'`
- Malformed trend dates are filtered with warning
- `baselinesProjection.reset()` and `emitBaselinesUpdate()` called post-commit

---

## Task 7: Golden Test — Budget Cap Pipeline

**Pipeline**: `onex.evt.omniclaude.budget-cap-hit.v1` -> `pipeline_budget_state` -> `/api/costs/alerts`

**Files**:
- `server/__tests__/golden-chain/budget-cap.golden.test.ts`

**Payload fields** (from `projectBudgetCapHitEvent`):
- `correlation_id` (fallback to `fallbackId`)
- `pipeline_id` (fallback to `correlation_id`)
- `budget_type` (default `'tokens'`)
- `cap_value` (numeric)
- `current_value` (numeric)
- `cap_hit` (boolean, default true)
- `repo`
- `timestamp` / `created_at`

**Golden assertions**:
- Row inserted into `pipeline_budget_state` with correct budget_type and cap values
- `emitPipelineBudgetInvalidate()` called with correct correlation_id
- ON CONFLICT DO NOTHING on duplicate correlation_id

---

## Task 8: Golden Test — Node Introspection Pipeline

**Pipeline**: `onex.evt.platform.node-introspection.v1` -> `node_service_registry` -> `/api/intelligence/registry/nodes`

**Files**:
- `server/__tests__/golden-chain/node-introspection.golden.test.ts`

**Payload fields** (from `projectNodeIntrospectionEvent`):
- `node_name` / `node_id` -> `service_name` (priority: `service_name` > `node_name` > `node_id`)
- `service_url`
- `service_type` / `node_type`
- `health_status` / `current_state` (default `'unknown'`)
- `metadata` (enriched with `node_name` and `node_id`)

**Golden assertions**:
- Row upserted into `node_service_registry` with `is_active=true`
- `last_health_check` set to NOW()
- `metadata` JSONB contains `node_name` and `node_id`
- ON CONFLICT updates all fields (full upsert)

---

## Task 9: Golden Test — Task Delegated Pipeline

**Pipeline**: `onex.evt.omniclaude.task-delegated.v1` -> `delegation_events` -> `/api/delegation/summary`

**Files**:
- `server/__tests__/golden-chain/task-delegated.golden.test.ts`

**Payload fields** (from `projectTaskDelegatedEvent`):
- `correlation_id` (required)
- `session_id`
- `timestamp` / `emitted_at`
- `task_type` (required, skip if missing)
- `delegated_to` / `model_used` (required, skip if missing)
- `delegated_by` / `handler_used`
- `quality_gate_passed` (boolean)
- `quality_gates_checked` (string array)
- `quality_gates_failed` (string array)
- `cost_usd` (numeric string)
- `cost_savings_usd` / `estimated_savings_usd`
- `delegation_latency_ms` / `latency_ms`
- `repo`
- `is_shadow` (boolean)

**Golden assertions**:
- Row inserted into `delegation_events` with correct task_type, delegated_to
- Missing `task_type` or `delegated_to` returns true (skipped) with warning
- `emitDelegationInvalidate()` called with correct correlation_id
- Cost fields stored as numeric strings

---

## Task 10: Golden Test — Routing Decision Pipeline

**Pipeline**: `onex.evt.omniclaude.routing-decision.v1` -> `agent_routing_decisions` -> `/api/intelligence/routing/decisions`

**Files**:
- `server/__tests__/golden-chain/routing-decision.golden.test.ts`

**Payload fields** (from `projectRoutingDecision`):
- `correlation_id` (required)
- `session_id` (sanitized via `sanitizeSessionId`)
- `user_request` / `prompt_preview` / `metadata.prompt_preview` -> `userRequest`
- `user_request_hash`
- `context_snapshot`
- `selected_agent` (default `'unknown'`)
- `confidence_score` / `confidence` -> `confidenceScore` (string)
- `routing_strategy` / `metadata.routing_method` (default `'unknown'`)
- `trigger_confidence`, `context_confidence`, `capability_confidence`, `historical_confidence`
- `alternatives` (JSONB)
- `reasoning` / `routing_reason`
- `routing_time_ms` / `metadata.latency_ms` (default 0)
- `cache_hit`, `selection_validated`, `actual_success`, `execution_succeeded`
- `actual_quality_score`

**Golden assertions**:
- Row inserted into `agent_routing_decisions` with all field aliases resolved
- `prompt_preview` maps to `userRequest` when `user_request` absent (OMN-3320)
- `confidence` maps to `confidenceScore` when `confidence_score` absent
- `routing_strategy` defaults to `'unknown'` when absent
- ON CONFLICT DO NOTHING on duplicate `correlation_id`

---

## Task 11: Golden Test — Session Outcome Pipeline

**Pipeline**: `onex.evt.omniclaude.session-outcome.v1` -> `session_outcomes` -> `/api/session-outcomes/summary`

**Files**:
- `server/__tests__/golden-chain/session-outcome.golden.test.ts`

**Payload fields** (from `projectSessionOutcome`):
- `session_id` / `correlation_id` / `_correlation_id` (required, skip if empty)
- `outcome` (default `'unknown'`)
- `emitted_at` / `timestamp` / `created_at` -> `emittedAt`

**Golden assertions**:
- Row inserted into `session_outcomes` with correct session_id, outcome
- ON CONFLICT (session_id) DO UPDATE -- upsert behavior (later events overwrite)
- Missing session_id returns true (skipped) with warning listing available keys
- `ingestedAt` set to `NOW()` on upsert

**API endpoint**: `/api/session-outcomes/summary` (from `server/session-outcome-routes.ts`)

---

## Task 12: Coverage Gate Manifest Scanner

**Files**:
- `server/__tests__/golden-chain/coverage-gate.test.ts`

**Steps**:

1. Create the coverage gate test that reads `topics.yaml` and checks each read-model topic has a corresponding golden test file:

```typescript
// server/__tests__/golden-chain/coverage-gate.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

describe('Golden Chain Coverage Gate', () => {
  const topicsPath = resolve(__dirname, '../../../topics.yaml');
  const goldenDir = resolve(__dirname, '.');

  it('every read_model_topics entry has a golden test or is explicitly exempted', () => {
    const raw = readFileSync(topicsPath, 'utf8');
    const manifest = parseYaml(raw);
    const topics: string[] = manifest.read_model_topics.map(
      (entry: { topic: string }) => entry.topic
    );

    // Scan golden-chain directory for *.golden.test.ts files
    const goldenFiles = readdirSync(goldenDir).filter((f) =>
      f.endsWith('.golden.test.ts')
    );

    // Read each golden file and extract the TOPIC constant
    const coveredTopics = new Set<string>();
    for (const file of goldenFiles) {
      const content = readFileSync(resolve(goldenDir, file), 'utf8');
      // Match: const TOPIC = 'onex.evt...' or TOPICS array
      const singleMatch = content.match(/const TOPIC\s*=\s*'([^']+)'/);
      if (singleMatch) coveredTopics.add(singleMatch[1]);
      // Match array entries
      const arrayMatches = content.matchAll(
        /['"]onex\.(evt|cmd)\.[^'"]+['"]/g
      );
      for (const m of arrayMatches) {
        coveredTopics.add(m[0].replace(/['"]/g, ''));
      }
    }

    // Phase 1: Only enforce coverage for Tier 1 topics.
    // As Tier 2 tests are added, move topics from TIER2_NOT_YET_REQUIRED
    // into TIER1_REQUIRED. Once all topics are in TIER1_REQUIRED, delete
    // the tier system and enforce full coverage.
    const TIER1_REQUIRED = new Set([
      'onex.evt.omniintelligence.llm-call-completed.v1',
      'onex.evt.omniclaude.llm-routing-decision.v1',
      'onex.evt.omnibase-infra.savings-estimated.v1',
      'onex.evt.omnibase-infra.baselines-computed.v1',
      'onex.evt.omniclaude.budget-cap-hit.v1',
      'onex.evt.platform.node-introspection.v1',
      'onex.evt.omniclaude.task-delegated.v1',
      'onex.evt.omniclaude.routing-decision.v1',
      'onex.evt.omniclaude.session-outcome.v1',
    ]);

    // Topics with no DB write (ack-only or in-memory) — permanently exempt
    const PERMANENTLY_EXEMPT = new Set([
      'onex.evt.omniclaude.performance-metrics.v1',
      'onex.evt.omniintelligence.context-effectiveness.v1',
      'onex.evt.omniintelligence.eval-completed.v1',
    ]);

    // Log tier coverage stats for CI visibility
    const tier2Count = topics.filter(
      (t: string) => !TIER1_REQUIRED.has(t) && !PERMANENTLY_EXEMPT.has(t)
    ).length;
    console.log(
      `[coverage-gate] Tier 1: ${TIER1_REQUIRED.size} required, ` +
      `${tier2Count} deferred to Tier 2, ` +
      `${PERMANENTLY_EXEMPT.size} permanently exempt`
    );

    const EXEMPTIONS = new Set([
      ...PERMANENTLY_EXEMPT,
      ...topics.filter(
        (t: string) => !TIER1_REQUIRED.has(t) && !PERMANENTLY_EXEMPT.has(t)
      ),
    ]);

    const uncovered: string[] = [];
    for (const topic of topics) {
      if (!coveredTopics.has(topic) && !EXEMPTIONS.has(topic)) {
        uncovered.push(topic);
      }
    }

    if (uncovered.length > 0) {
      throw new Error(
        `${uncovered.length} topics in topics.yaml lack golden tests:\n` +
          uncovered.map((t) => `  - ${t}`).join('\n') +
          '\n\nAdd a golden test in server/__tests__/golden-chain/ or add to EXEMPTIONS.'
      );
    }
  });

  it('no golden test references a topic not in topics.yaml', () => {
    const raw = readFileSync(topicsPath, 'utf8');
    const manifest = parseYaml(raw);
    const manifestTopics = new Set(
      manifest.read_model_topics.map((e: { topic: string }) => e.topic)
    );

    const goldenFiles = readdirSync(goldenDir).filter((f) =>
      f.endsWith('.golden.test.ts')
    );

    const orphanTopics: string[] = [];
    for (const file of goldenFiles) {
      const content = readFileSync(resolve(goldenDir, file), 'utf8');
      const matches = content.matchAll(
        /['"]onex\.(evt|cmd)\.[^'"]+['"]/g
      );
      for (const m of matches) {
        const topic = m[0].replace(/['"]/g, '');
        if (!manifestTopics.has(topic)) {
          orphanTopics.push(`${file}: ${topic}`);
        }
      }
    }

    expect(orphanTopics).toEqual([]);
  });
});
```

**Test command**: `npx vitest run server/__tests__/golden-chain/coverage-gate.test.ts`

---

## Task 13: CI Workflow — golden-chain-coverage.yml

**Files**:
- `.github/workflows/golden-chain-coverage.yml`

**Steps**:

1. Create the GitHub Actions workflow:

```yaml
# .github/workflows/golden-chain-coverage.yml
name: Golden Chain Coverage Gate

on:
  pull_request:
    paths:
      - 'server/consumers/read-model/**'
      - 'server/__tests__/golden-chain/**'
      - 'topics.yaml'
      - 'shared/intelligence-schema.ts'
  push:
    branches: [main]

jobs:
  golden-chain:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - name: Run golden chain tests (unit mode)
        run: npx vitest run server/__tests__/golden-chain/ --reporter=verbose
        env:
          GOLDEN_MODE: unit

      - name: Verify coverage gate
        run: npx vitest run server/__tests__/golden-chain/coverage-gate.test.ts --reporter=verbose
```

---

## Task 14: Auto-Generator Script

**Files**:
- `scripts/generate-golden-test.ts`

**Steps**:

1. Create a script that generates a golden test skeleton from a topic name and handler:

```typescript
#!/usr/bin/env npx tsx
// scripts/generate-golden-test.ts
//
// Usage: npx tsx scripts/generate-golden-test.ts \
//          --topic onex.evt.omniclaude.new-event.v1 \
//          --table new_events \
//          --handler projectNewEvent

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parseArgs } from 'util';

const { values } = parseArgs({
  options: {
    topic: { type: 'string' },
    table: { type: 'string' },
    handler: { type: 'string' },
  },
});

if (!values.topic || !values.table || !values.handler) {
  console.error('Usage: --topic <topic> --table <table> --handler <handler>');
  process.exit(1);
}

const slug = values.topic
  .replace(/^onex\.(evt|cmd)\./, '')
  .replace(/\.v\d+$/, '')
  .replace(/\./g, '-');

const outPath = resolve(
  __dirname,
  `../server/__tests__/golden-chain/${slug}.golden.test.ts`
);

if (existsSync(outPath)) {
  console.error(`File already exists: ${outPath}`);
  process.exit(1);
}

const template = `/**
 * Golden Chain Test: ${values.topic}
 * Table: ${values.table}
 * Handler: ${values.handler}
 *
 * AUTO-GENERATED — fill in payload fields and assertions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeKafkaPayload } from './runner';

// Mock infrastructure
vi.mock('../../storage', () => ({
  tryGetIntelligenceDb: vi.fn(),
  getIntelligenceDb: vi.fn(),
  isDatabaseConfigured: vi.fn(() => false),
}));
vi.mock('kafkajs', () => ({
  Kafka: vi.fn(() => ({
    consumer: vi.fn(() => ({
      connect: vi.fn(), subscribe: vi.fn(), run: vi.fn(), disconnect: vi.fn(),
    })),
  })),
}));
vi.mock('../../projection-bootstrap', () => ({
  baselinesProjection: { reset: vi.fn() },
  llmRoutingProjection: { invalidateCache: vi.fn() },
}));
vi.mock('../../baselines-events', () => ({ emitBaselinesUpdate: vi.fn() }));
vi.mock('../../topic-catalog-manager', () => ({
  TopicCatalogManager: vi.fn(() => ({
    bootstrap: vi.fn(), stop: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(), on: vi.fn(),
  })),
}));
vi.mock('../../llm-routing-events', () => ({ emitLlmRoutingInvalidate: vi.fn() }));
vi.mock('../../delegation-events', () => ({ emitDelegationInvalidate: vi.fn() }));
vi.mock('../../enrichment-events', () => ({ emitEnrichmentInvalidate: vi.fn() }));
vi.mock('../../enforcement-events', () => ({ emitEnforcementInvalidate: vi.fn() }));
vi.mock('../../omniclaude-state-events', () => ({
  emitGateDecisionInvalidate: vi.fn(),
  emitEpicRunInvalidate: vi.fn(),
  emitPrWatchInvalidate: vi.fn(),
  emitPipelineBudgetInvalidate: vi.fn(),
  emitCircuitBreakerInvalidate: vi.fn(),
}));
vi.mock('../../effectiveness-events', () => ({ emitEffectivenessUpdate: vi.fn() }));

import { ReadModelConsumer } from '../../read-model-consumer';

const TOPIC = '\${values.topic}';
const TABLE = '\${values.table}';

describe(\`Golden Chain: \${TOPIC} -> \${TABLE}\`, () => {
  let consumer: ReadModelConsumer;
  let handleMessage: (p: import('kafkajs').EachMessagePayload) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    consumer = new ReadModelConsumer();
    handleMessage = (
      consumer as unknown as { handleMessage: (p: import('kafkajs').EachMessagePayload) => Promise<void> }
    ).handleMessage.bind(consumer);
  });

  it('projects golden payload to ${values.table}', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi.fn().mockReturnValue({ values: insertValues });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock, execute: executeMock,
    });

    const payload = {
      // TODO: Fill in golden payload fields from handler source
      correlation_id: crypto.randomUUID(),
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // TODO: Add field-level assertions
    expect(consumer.getStats().eventsProjected).toBe(1);
    expect(consumer.getStats().errorsCount).toBe(0);
  });

  it('handles missing DB gracefully', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await handleMessage(makeKafkaPayload(TOPIC, {
      correlation_id: crypto.randomUUID(),
    }));

    expect(consumer.getStats().eventsProjected).toBe(0);
  });
});
`;

writeFileSync(outPath, template);
console.log(`Generated: ${outPath}`);
```

**Usage**: `npx tsx scripts/generate-golden-test.ts --topic onex.evt.omniclaude.new-event.v1 --table new_events --handler projectNewEvent`

---

## Task 15: Proof of Life — End-to-End Verification

**Steps**:

1. Run all 9 Tier 1 golden tests in unit mode:
```bash
cd ~/Code/omni_home/omnidash
npx vitest run server/__tests__/golden-chain/ --reporter=verbose
```

2. Run the coverage gate to verify all Tier 1 topics are covered:
```bash
npx vitest run server/__tests__/golden-chain/coverage-gate.test.ts --reporter=verbose
```

3. Run the full test suite to verify no regressions:
```bash
npm run test
```

4. Run TypeScript type checking:
```bash
npm run check
```

5. Verify the auto-generator produces valid skeletons:
```bash
npx tsx scripts/generate-golden-test.ts \
  --topic onex.evt.omniclaude.hook-health-error.v1 \
  --table hook_health_events \
  --handler projectHookHealthError
# Verify generated file compiles
npx vitest run server/__tests__/golden-chain/omniclaude-hook-health-error.golden.test.ts
# Clean up
rm server/__tests__/golden-chain/omniclaude-hook-health-error.golden.test.ts
```

6. Verify CI workflow syntax:
```bash
gh workflow lint .github/workflows/golden-chain-coverage.yml 2>/dev/null || echo "Lint manually"
```

**Success criteria**:
- All 9 Tier 1 golden tests pass in unit mode
- Coverage gate reports 0 uncovered Tier 1 topics
- No regressions in existing test suite
- Auto-generator produces compilable test skeletons
- CI workflow is valid YAML with correct trigger paths

---

## Tier 2 Expansion (post-Tier 1)

After Tier 1 is proven, expand golden tests to cover all remaining `topics.yaml` entries. The coverage gate will automatically fail CI when new topics are added without golden tests, driving incremental coverage.

**Remaining topics** (by handler file):
- omniclaude: agent-actions, agent-transformation, pattern-enforcement, context-enrichment, circuit-breaker-tripped, correlation-trace, phase-metrics, debug-trigger-record, skill-started/completed, hostile-reviewer-completed, context-utilization, agent-match, latency-breakdown, task-assigned/progress/completed, evidence-written, hook-health-error, epic-run-updated, pr-watch-updated, gate-decision, delegation-shadow-comparison
- omniintelligence: pattern-projection, pattern-lifecycle-transitioned, pattern-learning-cmd, plan-review-strategy-run, run-evaluated, intent-classified, intent-drift-detected, ci-debug-escalation, routing-feedback-processed, compliance-evaluated, episode-boundary, calibration-run-completed, pattern-promoted/stored, pattern-discovered
- omnibase-infra: llm-health-snapshot, wiring-health-snapshot, circuit-breaker, routing-decided, runtime-error, error-triaged
- platform: dlq-message, node-heartbeat, node-state-change, agent-status
- omnimemory: document-discovered, intent-stored, memory-expired, memory-retrieval-response, memory-stored
- change-control: contract-drift-detected
- review-pairing: calibration-run-completed
