# GitHub Webhook to Kafka Bridge

**Date**: 2026-03-26
**Status**: Reviewed (R1-R7 pass)
**Repos**: omnidash (primary), omnibase_infra (topic registration)
**Goal**: Receive GitHub webhook events and publish normalized ONEX events to Kafka, enabling automated post-merge workflows (version bumps, integration sweep, merge sweep).

---

## Known Types Inventory

### Existing Types (omnidash)

| Type | Location | Purpose |
|------|----------|---------|
| `EventEnvelope<T>` | `shared/schemas/event-envelope.ts` | Standard ONEX event envelope (envelope_id, correlation_id, causation_id, envelope_timestamp, payload) |
| `EventEnvelopeSchema` | `shared/schemas/event-envelope.ts` | Zod schema for envelope validation with legacy field normalization |
| `validateBridgeEmit()` | `shared/schemas/bridge-events.ts` | Defensive Zod validation at emit boundary (warn, don't crash) |
| `resolveBrokers()` | `server/bus-config.ts` | Broker resolution singleton (KAFKA_BOOTSTRAP_SERVERS > KAFKA_BROKERS) |
| `validateOnexTopicFormat()` | `server/topic-validator.ts` | ONEX 5-segment topic name validation |
| `DomainHandler` | `server/consumers/domain/types.ts` | Interface for domain-specific Kafka message handlers |
| `ConsumerContext` | `server/consumers/domain/types.ts` | Context passed to domain handlers (emitter, state maps) |
| `SUFFIX_GITHUB_PR_STATUS` | `shared/topics.ts:504` | Existing topic constant: `onex.evt.github.pr-status.v1` |

### Existing Infrastructure

| Component | Location | Relevance |
|-----------|----------|-----------|
| `rawBody` capture | `server/index.ts:58-64` | Already captures raw request body Buffer for HMAC signature verification |
| Kafka producer | `server/event-consumer.ts:132` | Existing KafkaJS producer instance in EventConsumer singleton |
| Route registration | `server/routes.ts` | Central route registration via `registerRoutes(app)` |
| Express app | `server/index.ts:51` | Express instance with JSON parsing and rawBody middleware |

### New Types to Create

| Type | Location | Purpose |
|------|----------|---------|
| `GitHubWebhookPayload` | `shared/schemas/github-webhook.ts` | Union of normalized GitHub event payloads |
| `GitHubPrMergedPayload` | `shared/schemas/github-webhook.ts` | PR merged event payload |
| `GitHubPushToMainPayload` | `shared/schemas/github-webhook.ts` | Push-to-main event payload |
| `GitHubCheckSuiteCompletedPayload` | `shared/schemas/github-webhook.ts` | Check suite completed payload |

### New Topics

| Topic | Purpose |
|-------|---------|
| `onex.evt.github.pr-merged.v1` | PR was merged into any branch |
| `onex.evt.github.push-to-main.v1` | Push to default branch (main) |
| `onex.evt.github.check-suite-completed.v1` | All CI checks completed |

---

## Task List

### Task 1: Define Zod schemas for GitHub webhook payloads

**File**: `shared/schemas/github-webhook.ts`

Define Zod schemas for the three normalized GitHub webhook event payloads. These are the ONEX-side payloads (not raw GitHub payloads -- normalize at the boundary).

```typescript
// GitHubPrMergedPayloadSchema — normalized from GitHub pull_request.closed+merged event
// Fields: repo (owner/name), pr_number, pr_title, pr_branch (head), base_branch, merge_sha, merged_by, merged_at
//
// GitHubPushToMainPayloadSchema — normalized from GitHub push event to default branch
// Fields: repo (owner/name), ref, before_sha, after_sha, pusher, commits (array of {sha, message, author})
//
// GitHubCheckSuiteCompletedPayloadSchema — normalized from GitHub check_suite.completed
// Fields: repo (owner/name), head_sha, head_branch, conclusion, check_suite_id, app_name
```

Also export a discriminated union `GitHubWebhookPayloadSchema` with a `kind` discriminator field (`pr_merged | push_to_main | check_suite_completed`).

**TDD**: Write `shared/schemas/__tests__/github-webhook.test.ts` first. Test each schema parses a valid fixture and rejects missing required fields.

**DoD**: Schemas parse valid fixtures, reject invalid input, Zod inference types exported.

---

### Task 2: Add topic constants for new GitHub event topics

**File**: `shared/topics.ts`

Add three new topic constants to the GitHub section (near existing `SUFFIX_GITHUB_PR_STATUS` at line 504):

```typescript
export const SUFFIX_GITHUB_PR_MERGED = 'onex.evt.github.pr-merged.v1';
export const SUFFIX_GITHUB_PUSH_TO_MAIN = 'onex.evt.github.push-to-main.v1';
export const SUFFIX_GITHUB_CHECK_SUITE_COMPLETED = 'onex.evt.github.check-suite-completed.v1';
```

**TDD**: Verify the constants pass `validateOnexTopicFormat()` -- add a test case in `server/__tests__/topic-validator.test.ts` (or a new file if that test doesn't exist).

**DoD**: Constants exported, pass topic format validation.

---

### Task 3: Implement HMAC-SHA256 webhook signature verification middleware

**File**: `server/lib/github-webhook-signature.ts`

Create an Express middleware that:

1. Reads `X-Hub-Signature-256` header
2. Reads `req.rawBody` (already captured by `server/index.ts:58-64`)
3. Computes HMAC-SHA256 with secret from `process.env.GITHUB_WEBHOOK_SECRET`
4. Uses `crypto.timingSafeEqual()` to compare
5. Returns 401 on missing/invalid signature
6. Returns 500 if `GITHUB_WEBHOOK_SECRET` is not configured

The middleware must be applied only to webhook routes, not globally.

**TDD**: Write `server/__tests__/github-webhook-signature.test.ts` first. Test cases:
- Valid signature passes
- Invalid signature returns 401
- Missing header returns 401
- Missing secret env var returns 500
- Timing-safe comparison (no short-circuit on prefix match)

**DoD**: Middleware passes all test cases, uses `crypto.timingSafeEqual`.

---

### Task 4: Implement webhook-to-Kafka publisher service

**File**: `server/services/github-webhook-publisher.ts`

Create a stateless service class `GitHubWebhookPublisher` that:

1. Accepts a KafkaJS `Producer` instance (injected -- reuse from EventConsumer)
2. Exposes `publishPrMerged(payload)`, `publishPushToMain(payload)`, `publishCheckSuiteCompleted(payload)`
3. Each method wraps the payload in an ONEX `EventEnvelope` (generate `envelope_id` UUID, set `envelope_timestamp` to now, use GitHub delivery ID as `correlation_id`)
4. Publishes to the correct topic constant from Task 2
5. Uses `validateBridgeEmit()` for defensive schema validation before publishing

Idempotency: Use the `X-GitHub-Delivery` header UUID as the Kafka message key. Kafka's log compaction + consumer dedup on this key ensures at-least-once is safe.

**TDD**: Write `server/__tests__/github-webhook-publisher.test.ts`. Mock the KafkaJS producer. Verify:
- Correct topic is used for each event type
- Payload is wrapped in valid EventEnvelope
- Message key is set to delivery ID
- Schema validation is called

**DoD**: Publisher passes all tests, envelope is spec-compliant.

---

### Task 5: Implement GitHub event normalizer

**File**: `server/lib/github-event-normalizer.ts`

Create pure functions that transform raw GitHub webhook JSON into the normalized Zod-validated payloads from Task 1:

- `normalizePrMerged(rawGitHubPayload): GitHubPrMergedPayload | null` -- returns null if PR was closed without merge
- `normalizePushToMain(rawGitHubPayload): GitHubPushToMainPayload | null` -- returns null if push is not to default branch
- `normalizeCheckSuiteCompleted(rawGitHubPayload): GitHubCheckSuiteCompletedPayload | null` -- returns null if conclusion is not `success` or `failure`

Each normalizer extracts only the fields defined in the Zod schema, discarding the rest of the raw GitHub payload (which can be very large).

**TDD**: Write `server/__tests__/github-event-normalizer.test.ts`. Use real GitHub webhook payload fixtures (create `server/test/fixtures/github-webhook-pr-merged.json`, etc.). Test:
- PR merged event normalizes correctly
- PR closed-without-merge returns null
- Push to main normalizes correctly
- Push to non-default branch returns null
- Check suite completed normalizes correctly
- Malformed payloads return null (don't throw)

**DoD**: All normalizers pass test cases, pure functions, no side effects.

---

### Task 6: Implement webhook route handler

**File**: `server/github-webhook-routes.ts`

Create an Express router with a single endpoint:

```
POST /api/webhooks/github
```

The handler:
1. Reads `X-GitHub-Event` header to determine event type
2. Reads `X-GitHub-Delivery` header for correlation/idempotency
3. Dispatches to the appropriate normalizer (Task 5)
4. If normalizer returns null (irrelevant event), respond 200 OK with `{ "status": "ignored", "reason": "..." }`
5. Calls the publisher (Task 4) to emit to Kafka
6. Responds 202 Accepted with `{ "status": "published", "topic": "...", "delivery_id": "..." }`
7. On publisher error, responds 500 with `{ "status": "error", "message": "..." }`
8. Unsupported event types respond 200 OK with `{ "status": "unsupported", "event": "..." }`

The route must be mounted with the signature verification middleware from Task 3.

**TDD**: Write `server/__tests__/github-webhook-routes.test.ts`. Use supertest. Test:
- PR merged event publishes and returns 202
- PR closed without merge returns 200 ignored
- Push to main publishes and returns 202
- Push to feature branch returns 200 ignored
- Check suite completed publishes and returns 202
- Invalid signature returns 401
- Unsupported event type returns 200

**DoD**: Route handler passes all test cases, proper HTTP status codes.

---

### Task 7: Mount webhook routes in server/routes.ts

**File**: `server/routes.ts`

Add the webhook route import and mount it in `registerRoutes()`:

```typescript
import githubWebhookRoutes from './github-webhook-routes';
// ...
app.use('/api/webhooks', githubWebhookRoutes);
```

The webhook routes must NOT be behind the auth middleware (GitHub sends unauthenticated requests -- the HMAC signature is the auth mechanism).

**TDD**: Verify the route is reachable in the existing `server/__tests__/index.test.ts` or a new integration test.

**DoD**: Route mounted, accessible without auth, signature middleware applied.

---

### Task 8: Add GitHub webhook domain handler for consumer side

**File**: `server/consumers/domain/github-handler.ts`

Create a `DomainHandler` that processes the three new GitHub event topics on the consumer side. This enables omnidash to:

1. Store webhook events in the read-model for the status dashboard
2. Emit bridge events for WebSocket subscribers (live event stream)

Follow the existing pattern from `platform-handler.ts` and `omniclaude-handler.ts`:
- Implement the `DomainHandler` interface
- Register topic subscriptions
- Parse with Zod schemas from Task 1
- Emit bridge events via `ConsumerContext`

**TDD**: Write `server/__tests__/github-handler.test.ts`. Mock ConsumerContext. Verify:
- Each event type is handled
- Bridge events are emitted
- Malformed events are warned but not crashed

**DoD**: Handler processes all three event types, registered in domain handler index.

---

### Task 9: Register domain handler in consumer index

**File**: `server/consumers/domain/index.ts`

Add the GitHub handler to `createDomainHandlers()` so the EventConsumer subscribes to the three new topics.

**TDD**: Verify via existing consumer integration test pattern that new topics appear in subscription list.

**DoD**: GitHub topics are consumed by EventConsumer on startup.

---

### Task 10: Add deduplication table for webhook delivery IDs

**File**: `migrations/0043_github_webhook_deliveries.sql`

Create a table to track processed webhook delivery IDs for idempotency:

```sql
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
    delivery_id UUID PRIMARY KEY,
    event_type TEXT NOT NULL,
    repo TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

-- Auto-cleanup old entries (keep 7 days)
CREATE INDEX idx_github_webhook_deliveries_received_at ON github_webhook_deliveries (received_at);
```

Also add the corresponding Drizzle table definition in `shared/intelligence-schema.ts`.

**TDD**: Run `npm run db:migrate` and verify with `npm run db:check-parity`.

**DoD**: Migration applies cleanly, Drizzle schema matches, parity check passes.

---

### Task 11: Wire deduplication check into webhook route

**File**: `server/github-webhook-routes.ts` (update from Task 6)

Before publishing to Kafka, check the `github_webhook_deliveries` table:
1. If `delivery_id` already exists with `published_at IS NOT NULL`, respond 200 OK with `{ "status": "duplicate", "delivery_id": "..." }`
2. Insert the delivery record before publishing
3. Update `published_at` after successful Kafka publish
4. On Kafka publish failure, leave `published_at` NULL so retry can succeed

**TDD**: Add dedup test cases to `server/__tests__/github-webhook-routes.test.ts`:
- First delivery publishes
- Duplicate delivery returns 200 duplicate
- Failed publish leaves published_at NULL for retry

**DoD**: Deduplication works end-to-end, retry-safe.

---

### Task 12: Add GITHUB_WEBHOOK_SECRET to Infisical config

**Repo**: omnibase_infra

Add `GITHUB_WEBHOOK_SECRET` to the appropriate ONEX contract YAML so `seed-infisical.py` picks it up, and add a placeholder to `~/.omnibase/.env`.

Also add to omnidash's `.env` template / documentation.

**TDD**: Run `seed-infisical.py --dry-run` and verify the key appears.

**DoD**: Secret registered in Infisical contract, placeholder in env, documented.

---

### Task 13: Add health check endpoint for webhook subsystem

**File**: `server/github-webhook-routes.ts` (extend)

Add `GET /api/webhooks/github/health` that returns:
- Whether `GITHUB_WEBHOOK_SECRET` is configured
- Count of deliveries in last hour / last 24h (from dedup table)
- Last delivery timestamp
- Kafka producer connectivity status

This endpoint does NOT require signature verification (it's a health check, not a webhook).

**TDD**: Add health check test to `server/__tests__/github-webhook-routes.test.ts`.

**DoD**: Health endpoint returns structured status, no auth required.

---

### Task 14: Integration test with real GitHub payload fixtures

**File**: `server/__tests__/integration/github-webhook-integration.test.ts`

End-to-end integration test that:
1. Sends a real GitHub PR merged webhook payload (from fixture) to the endpoint
2. Verifies signature validation passes with test secret
3. Verifies the correct Kafka topic receives a valid ONEX envelope
4. Verifies the delivery is recorded in the dedup table
5. Verifies duplicate delivery is rejected
6. Verifies the health endpoint reflects the delivery

Uses a mock Kafka producer (not real Kafka) but a real database (test database).

**TDD**: This IS the test.

**DoD**: Integration test passes end-to-end with fixtures.

---

### Task 15: Document webhook setup and GitHub configuration

**File**: `docs/architecture/GITHUB_WEBHOOK_BRIDGE.md`

Document:
1. Architecture diagram (GitHub -> omnidash -> Kafka -> consumers)
2. Topic catalog (three new topics with payload schemas)
3. GitHub webhook configuration instructions (org-level or per-repo)
4. Required environment variables (`GITHUB_WEBHOOK_SECRET`)
5. Health check endpoint
6. Idempotency guarantees
7. Failure modes and retry behavior
8. How to test locally with `curl` and a test signature

**DoD**: Documentation complete, includes setup instructions for both local and production.

---

## Execution Order & Dependencies

```
Task 1 (schemas) ─────────────────────────┐
Task 2 (topic constants) ─────────────────┤
Task 3 (signature middleware) ────────────┤
                                          ├─> Task 5 (normalizer, needs 1)
                                          ├─> Task 4 (publisher, needs 1, 2)
                                          │
Task 5 ───────────────────────────────────┤
Task 4 ───────────────────────────────────┤
Task 3 ───────────────────────────────────┼─> Task 6 (route handler, needs 3, 4, 5)
                                          │
Task 6 ───────────────────────────────────┼─> Task 7 (mount routes)
                                          ├─> Task 8 (consumer handler, needs 1, 2)
                                          ├─> Task 9 (register handler, needs 8)
                                          │
Task 10 (migration) ─────────────────────┼─> Task 11 (dedup wiring, needs 6, 10)
                                          │
Task 12 (Infisical) ──── independent ─────┤
Task 13 (health check, needs 6, 10) ─────┤
                                          │
All above ────────────────────────────────┼─> Task 14 (integration test)
                                          └─> Task 15 (documentation)
```

**Wave 1 (parallel)**: Tasks 1, 2, 3, 10, 12
**Wave 2 (parallel)**: Tasks 4, 5
**Wave 3**: Task 6
**Wave 4 (parallel)**: Tasks 7, 8, 9, 11, 13
**Wave 5 (parallel)**: Tasks 14, 15

---

## Scope Boundaries

**In scope**: GitHub webhook receiver, ONEX event normalization, Kafka publishing, idempotency, signature validation, consumer-side read-model projection, health check.

**Out of scope** (separate tickets):
- Downstream automation consumers (version bump trigger, integration sweep trigger, merge sweep trigger). These will subscribe to the three new topics and are intentionally decoupled from the bridge.
- GitHub webhook configuration (org-level or per-repo) -- documented in Task 15 but manual setup.
- Webhook retry dashboard UI -- the health endpoint (Task 13) provides the data; a dashboard page is future work.

---

## Adversarial Review Notes (R1-R7)

### R1 Finding: Producer access

The KafkaJS `Producer` in `EventConsumer` is private. Task 4 must either:
- **(Preferred)** Create a standalone `GitHubWebhookPublisher` that instantiates its own KafkaJS producer via `resolveBrokers()`. This avoids coupling to EventConsumer internals and follows the pattern used by `TopicCatalogManager` (which creates its own dedicated producer+consumer).
- Alternatively, expose the producer from EventConsumer via a getter. This is less preferred because it creates a dependency on the consumer lifecycle.

Decision: Use standalone producer (TopicCatalogManager pattern).

### R2 Finding: Database degradation in dedup check

If `omnidash_analytics` is unavailable when the webhook arrives, the dedup check in Task 11 must degrade gracefully:
- Log a warning
- Skip dedup and publish to Kafka anyway (at-least-once is acceptable; downstream consumers must be idempotent regardless)
- Do NOT return 500 to GitHub (would trigger retries, making the situation worse)

### R3 Finding: Rate limiting

GitHub can send bursts of webhooks (e.g., batch merge of 20 PRs). The plan does not include rate limiting. This is acceptable because:
- Kafka handles bursty producers well
- The webhook endpoint does minimal processing (normalize + publish)
- If needed, Express rate limiting (`express-rate-limit`) can be added to the webhook route with a generous limit (e.g., 100 req/min)

No task needed -- note for future hardening if volume is high.

### R4-R7: Pass

No additional findings.
