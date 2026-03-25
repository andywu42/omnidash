# Read-Model Projection Architecture

## What Is Read-Model Projection?

In event-sourced systems, a _read model_ (also called a projection or query model) is a materialized view of event data optimized for reading. Rather than reconstructing state by replaying all events on every query, projections listen to Kafka topics and continuously write pre-computed rows into a relational database.

In omnidash this means:

- OmniNode platform services **publish** events to Kafka topics.
- The `ReadModelConsumer` **subscribes** to those topics and writes rows into `omnidash_analytics`.
- Express API routes **query** those tables with simple SQL and serve results to the React dashboards.

The result is a dashboard that can answer "how many routing decisions happened in the last hour?" with a single indexed SQL query instead of replaying thousands of Kafka messages.

## How `read-model-consumer.ts` Works

The `ReadModelConsumer` class (`server/read-model-consumer.ts`) is the heart of the projection system.

### Lifecycle

```text
server startup
     |
     v
ReadModelConsumer.start()
  - reads KAFKA_BROKERS from env
  - reads OMNIDASH_ANALYTICS_DB_URL from env (via tryGetIntelligenceDb())
  - connects KafkaJS consumer (group: omnidash-read-model-v1)
  - subscribes to all READ_MODEL_TOPICS (fromBeginning: true)
  - starts consumer.run() loop
     |
     | on each Kafka message
     v
ReadModelConsumer.handleMessage(payload)
  - parseMessage(): JSON.parse + envelope unwrapping ({ payload: {...} })
  - deterministicCorrelationId(): SHA-256 hash of topic:partition:offset
  - routes to the correct projection handler by topic
  - on success: increments stats, calls updateWatermark()
  - on DB unavailable (false return): skips watermark advancement
                                      (Kafka will redeliver)
```

### Replay Policy (OMN-6393)

The consumer subscribes with `fromBeginning: true`. This is intentional: when a new consumer group is created or the group offsets are reset, the consumer replays all events still within Kafka's retention window (default: 7 days).

**Why `fromBeginning: true`?** The previous setting (`false`) caused 56 of 70 tables in `omnidash_analytics` to remain permanently empty because events arriving before the consumer started were never replayed. With `true`, a consumer group reset triggers a full replay, populating all tables from retained events.

**Idempotency guarantee:** All projection handlers use `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE` (see Idempotency section below), so replaying the same event twice is always safe.

### Projection Handler Architecture (OMN-5192)

Events are dispatched to domain-specific projection handler classes:

| Handler Class | Topics | Domain |
|---|---|---|
| `OmniclaudeProjectionHandler` | 20+ omniclaude topics | Routing, actions, enforcement, enrichment, LLM routing, sessions, etc. |
| `DodProjectionHandler` | dod-verify-completed, dod-guard-fired | DoD verification |
| `OmniintelligenceProjectionHandler` | 12 intelligence topics | Patterns, costs, episodes, compliance, intent |
| `OmnibaseInfraProjectionHandler` | 7 infra topics | Baselines, LLM health, circuit breaker, savings |
| `PlatformProjectionHandler` | 3 platform topics | Intent storage, PR validation, DLQ |
| `OmniMemoryProjectionHandler` | 5 memory topics | Document discovery, storage, retrieval |

Each handler implements the `ProjectionHandler` interface:

```typescript
interface ProjectionHandler {
  canHandle(topic: string): boolean;
  projectEvent(topic, data, context, meta): Promise<boolean>;
}
```

### Handler Metrics (OMN-6400)

Every projection handler tracks in-memory counters:

- `received`: Total events dispatched to this handler
- `projected`: Events successfully written to the read-model
- `dropped`: Events skipped, broken down by reason:
  - `missing_field`: Required field absent from event payload
  - `guard_failed`: Type guard rejected the event shape
  - `db_unavailable`: Database connection unavailable
  - `table_missing`: Target table does not exist (migration not run)

Handler stats are exposed via `GET /api/projection-health` in the `handlerStats` field.

### Consumer Groups

| Consumer Group ID | File | Purpose |
|---|---|---|
| `omnidash-read-model-v1` | `read-model-consumer.ts` | Durable projection to PostgreSQL |
| `omnidash-consumers-v2` | `event-consumer.ts` | In-memory aggregation to WebSocket |

Separate group IDs ensure independent offset tracking. The read-model consumer can lag or be restarted without affecting real-time WebSocket delivery.

### Consumer Group Reset

To force a full replay of all retained events:

```bash
npx tsx scripts/reset-consumer-group.ts
```

This deletes the `omnidash-read-model-v1` consumer group offsets. On the next omnidash restart, the consumer replays from the earliest available offset.

## Projection Watermarks

The `projection_watermarks` table tracks consumer progress per topic-partition. It is used for observability (not for consumer offset management -- Kafka handles that via its own `__consumer_offsets` topic).

Schema (created via SQL migration):

```sql
INSERT INTO projection_watermarks
  (projection_name, last_offset, events_projected, updated_at)
VALUES
  ('agent-routing-decisions:0', 42, 1, NOW())
ON CONFLICT (projection_name) DO UPDATE SET
  last_offset        = GREATEST(projection_watermarks.last_offset, EXCLUDED.last_offset),
  events_projected   = projection_watermarks.events_projected + 1,
  last_projected_at  = NOW(),
  updated_at         = NOW()
```

`projection_name` is formatted as `"topic:partition"` so each partition is tracked independently.

The watermark is updated **only after a successful projection** (i.e., the DB write returned `true`). If the DB is unavailable, the watermark is not advanced so Kafka can redeliver the message later.

## Idempotency and Deduplication

Every projection method is designed to be safe when the same Kafka message is delivered twice (Kafka's at-least-once delivery guarantee).

**Strategy 1: ON CONFLICT DO NOTHING on `correlation_id`** (primary approach)

Used by `agent_routing_decisions`, `agent_actions`, `pattern_enforcement_events`, `context_enrichment_events`, `llm_routing_decisions`.

```typescript
await db
  .insert(agentRoutingDecisions)
  .values(row)
  .onConflictDoNothing({ target: agentRoutingDecisions.correlationId });
```

**Strategy 2: Deterministic fallback ID** (when `correlation_id` is absent)

When no `correlation_id` is present in the event, a SHA-256 hash of `topic:partition:offset` is used as the dedup key. Since `(topic, partition, offset)` uniquely identifies a Kafka message, the same message always produces the same fallback ID:

```typescript
function deterministicCorrelationId(topic: string, partition: number, offset: string): string {
  return crypto
    .createHash('sha256')
    .update(`${topic}:${partition}:${offset}`)
    .digest('hex')
    .slice(0, 32)
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}
```

**Strategy 3: Delete-then-insert in a transaction** (baselines snapshots)

Baselines snapshots contain child arrays (comparisons, trend, breakdown). Re-delivery of the same snapshot event deletes the old child rows and re-inserts the new ones inside a single transaction to prevent partial state.

**Strategy 4: Composite key dedup** (`agent_transformation_events`)

Events for this table lack a natural unique ID. Deduplication uses a composite key of `(source_agent, target_agent, created_at)`. Events with the same agent pair and timestamp within the same second are silently deduplicated. This is a best-effort strategy noted in the source as a future improvement point.

## Staleness Indicators (OMN-6397, OMN-6398, OMN-6399)

Dashboard pages display data freshness via `<StalenessIndicator />` components that query `GET /api/staleness` every 60 seconds.

### Severity Thresholds

| Severity | Age | Color |
|---|---|---|
| `fresh` | < 1 hour | Green |
| `aging` | 1-6 hours | Yellow |
| `stale` | 6-24 hours | Orange |
| `critical` | > 24 hours or never updated | Red |

### Pages with Staleness Indicators

- Pattern Learning (`/patterns`) -- key: `patterns`
- Pattern Enforcement (`/enforcement`) -- key: `enforcement`
- Effectiveness (`/effectiveness`) -- key: `effectiveness`
- RL Routing (`/rl-routing`) -- key: `rl-episodes`
- LLM Routing (`/llm-routing`) -- key: `llm-routing`
- Intent Dashboard (`/intents`) -- key: `intent-signals`

The staleness API maps each feature to a source table and queries `MAX(created_at)` to determine freshness.

## Consumer Group Lag Monitoring (OMN-6402)

The event-bus health poller tracks consumer group lag for `omnidash-read-model-v1` specifically:

- Lag is polled every 30 seconds via the Redpanda Admin API
- Per-topic-partition lag is available via `GET /api/projection-health` in the `consumerLag` field

### Lag Thresholds

| Total Lag | Status |
|---|---|
| < 10,000 | `healthy` |
| 10,000 - 100,000 | `degraded` |
| > 100,000 | `critical` |

## Observability Endpoints

### `GET /api/projection-health`

Returns comprehensive projection health including:

- **tables**: Row counts and last-updated timestamps for all tables in `omnidash_analytics`
- **watermarks**: Per-topic consumer progress from `projection_watermarks`
- **handlerStats**: Per-handler received/projected/dropped counters
- **consumerLag**: Read-model consumer group lag from Redpanda Admin API
- **summary**: Aggregate counts (total/populated/empty/stale tables)

### `GET /api/staleness`

Returns per-feature staleness info consumed by frontend `StalenessIndicator` components.

### `GET /api/projections/stats`

Returns `ReadModelConsumerStats` (events projected, errors, topic-level stats).

## Graceful Degradation on Missing Migrations

Tables for newer event types are created by SQL migrations in `migrations/`. If a migration has not been run yet, the projection method catches PostgreSQL error code `42P01` ("undefined_table"), logs a warning, and returns `true` (advancing the watermark) rather than crashing.

## Timestamp Safety

Two timestamp parsing helpers prevent bad data from corrupting ordering queries:

- **`safeParseDate(value)`**: Returns `new Date()` (wall-clock) for missing or malformed timestamps. Used for `created_at` fields where a "recent" fallback is appropriate.
- **`safeParseDateOrMin(value)`**: Returns `new Date(0)` (epoch-zero) for missing or malformed timestamps. Used specifically for `computed_at_utc` in baselines snapshots, where epoch-zero sorts as oldest.

## Architectural Invariant: No Direct Upstream DB Access

Omnidash **never** queries the upstream `omninode_bridge` database directly. All intelligence data originates from Kafka events projected into `omnidash_analytics`. This is enforced by a CI arch-guard rule introduced in commit `c78545e`.

The `omnidash_analytics` database is omnidash's own artifact -- it is populated, owned, and queried exclusively by omnidash.

## Pattern Backfill (OMN-6395)

For data that has aged out of Kafka retention (default 7 days), a backfill script fetches patterns directly from the omniintelligence API:

```bash
npx tsx scripts/backfill-patterns-from-intelligence.ts
```

This is the approved exception to the "no direct upstream DB access" rule -- it uses the omniintelligence REST API (not a direct DB connection) and upserts into `pattern_learning_artifacts`.

## Envelope Pattern

Some upstream producers wrap event payloads in a standard envelope:

```json
{
  "payload": { "correlation_id": "...", "selected_agent": "..." },
  "metadata": { ... }
}
```

The `parseMessage()` method detects this and unwraps it, making the inner payload available as the top-level object while preserving the original envelope under `_envelope` for debugging:

```typescript
if (raw.payload && typeof raw.payload === 'object') {
  return { ...raw.payload, _envelope: raw };
}
return raw;
```
