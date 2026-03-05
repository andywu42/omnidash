# Cross-Service Schema Coupling Map

**OMN-3751** | Last updated: 2026-03-05

This document tracks the schema coupling between Kafka event producers (typically omniintelligence) and the omnidash read-model consumer. Every topic listed here has a Zod validation schema in `shared/event-schemas.ts` that is enforced at consumption time.

## Critical Pattern Topics

These topics project into the `pattern_learning_artifacts` table. A schema change in the producer that is not reflected in the consumer causes **silent data corruption** (missing fields default to sentinel values, status transitions are silently dropped).

| Topic | Producer | Producer Model | Consumer Handler | Target Table | Zod Schema | Coupling Risk |
|-------|----------|---------------|------------------|-------------|------------|---------------|
| `onex.evt.omniintelligence.pattern-projection.v1` | omniintelligence `NodePatternProjectionEffect` | `ModelPatternProjectionEvent` (contains `ModelPatternSummary[]`) | `projectPatternProjectionEvent()` | `pattern_learning_artifacts` | `PatternProjectionEventSchema` | **CRITICAL** |
| `onex.evt.omniintelligence.pattern-lifecycle-transitioned.v1` | omniintelligence `NodePatternLifecycleEffect` | `ModelPatternLifecycleEvent` | `projectPatternLifecycleTransitionedEvent()` | `pattern_learning_artifacts` | `PatternLifecycleTransitionedEventSchema` | **CRITICAL** |
| `onex.cmd.omniintelligence.pattern-learning.v1` | various (pipeline entry) | (untyped command) | `projectPatternLearningRequestedEvent()` | `pattern_learning_artifacts` | `PatternLearningRequestedEventSchema` | **HIGH** |

## Field Coupling Details

### pattern-projection.v1

The producer emits a `patterns` array where each item is a `ModelPatternSummary`. The consumer accepts **both snake_case and camelCase** field names for resilience:

| Required Field | Snake Case | Camel Case | What Happens If Missing |
|---------------|-----------|------------|------------------------|
| Pattern ID | `id`, `pattern_id` | `patternId` | **Zod rejects** (at least one required) |
| Pattern Name | `pattern_name`, `domain_id` | `patternName` | Falls back to `'unknown'` |
| Pattern Type | `pattern_type` | `patternType` | Falls back to `'unknown'` |
| Lifecycle State | `status`, `lifecycle_state` | `lifecycleState` | Falls back to `'candidate'` |
| Quality Score | `quality_score`, `composite_score` | `compositeScore` | Falls back to `0` |

### pattern-lifecycle-transitioned.v1

| Required Field | Snake Case | Camel Case | What Happens If Missing |
|---------------|-----------|------------|------------------------|
| Pattern ID | `pattern_id` | `patternId` | **Zod rejects** |
| Target Status | `to_status` | `toStatus` | **Zod rejects** |
| Transition Time | `transitioned_at`, `timestamp`, `created_at` | `transitionedAt` | Falls back to `new Date()` |

### pattern-learning.v1

| Required Field | Snake Case | Camel Case | What Happens If Missing |
|---------------|-----------|------------|------------------------|
| Correlation ID | `correlation_id` | `correlationId` | **Zod rejects** |
| Session ID | `session_id` | `sessionId` | Optional (null) |
| Trigger | `trigger` | - | Optional (`'unknown'`) |

## Validation Behavior

When a message fails Zod validation:

1. A structured JSON error is logged with topic name, field-level details, and a truncated data excerpt
2. The dead-letter counter for that topic is incremented (in-memory, queryable via `getEventValidationStats()`)
3. The message is **skipped** -- the consumer does not attempt to project it
4. The error counter in `ReadModelConsumerStats` is incremented

This replaces the previous behavior where missing fields would silently default to sentinel values.

## How to Add a New Validated Topic

1. Define a Zod schema in `shared/event-schemas.ts`
2. Add a `validateEvent()` call in the `handleMessage()` switch case in `server/read-model-consumer.ts`
3. Add the topic to this coupling map
4. Add test cases in `shared/__tests__/event-schemas.test.ts`

## Monitoring

The `/api/health/schema` endpoint (OMN-3751) provides runtime migration parity checks. Event validation statistics are available via the `getEventValidationStats()` export from `shared/event-schemas.ts`.
