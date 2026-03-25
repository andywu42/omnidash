# Projection Gap Recovery Runbook

## When to Use This Runbook

Use this runbook when:

- Dashboard pages show empty or stale data
- `GET /api/projection-health` reports many empty tables
- Staleness indicators show "critical" (red) on dashboard pages
- Consumer group lag is stuck at a high number
- After a consumer group ID change or omnidash redeployment

## Quick Health Check

```bash
# 1. Check projection health (from host)
curl -s http://localhost:3000/api/projection-health | jq '.summary'

# Expected output:
# { "totalTables": 70, "populatedTables": 40+, "emptyTables": ..., "staleTables": ... }

# 2. Check staleness
curl -s http://localhost:3000/api/staleness | jq '.features | to_entries[] | select(.value.stale) | .key'

# 3. Check handler stats
curl -s http://localhost:3000/api/projection-health | jq '.handlerStats'

# 4. Check consumer lag
curl -s http://localhost:3000/api/projection-health | jq '.consumerLag'
```

## Common Scenarios

### Scenario 1: Most Tables Empty After Fresh Deployment

**Symptom**: `populatedTables` is very low (< 20 out of 70), staleness indicators show "Never updated" or "critical" across most pages.

**Root Cause**: Consumer group offsets were reset or this is a new deployment. Events within Kafka retention window need to be replayed.

**Fix**:

```bash
# 1. Reset consumer group to replay from earliest
cd /path/to/omnidash
npx tsx scripts/reset-consumer-group.ts

# 2. Restart omnidash (consumer will replay from beginning)
# If running locally:
npm run dev

# 3. Monitor replay progress
watch -n 5 'curl -s http://localhost:3000/api/projection-health | jq .summary'
```

Replay typically takes 2-5 minutes depending on the volume of retained events.

### Scenario 2: Specific Tables Empty Despite Events Existing

**Symptom**: Some tables have data, others are empty. Handler stats show `dropped` counts.

**Diagnosis**:

```bash
# Check which handlers are dropping events
curl -s http://localhost:3000/api/projection-health | jq '.handlerStats | to_entries[] | select(.value.dropped | to_entries[] | select(.value > 0))'
```

**Common causes**:
- `missing_field`: Upstream producer changed event schema. Check event shape.
- `guard_failed`: Type guard is too strict. Check `isLatencyBreakdownEvent`, `isContextUtilizationEvent`, etc.
- `db_unavailable`: PostgreSQL connection issue. Check `OMNIDASH_ANALYTICS_DB_URL`.
- `table_missing`: Migration not run. Execute `npx drizzle-kit push`.

### Scenario 3: Data Stale (Staleness > 24h) but Consumer is Running

**Symptom**: Tables have data but `lastUpdated` is days old. Consumer is running with no errors.

**Root Cause**: Upstream producer stopped emitting events.

**Check**:

```bash
# Check if events are arriving on the topic
kcat -C -b localhost:19092 -t onex.evt.omniclaude.session-outcome.v1 -c 1 -e 2>/dev/null
# If no output: upstream producer is not running

# Check consumer group lag
curl -s http://localhost:3000/api/projection-health | jq '.consumerLag'
# If totalLag is 0 and status is "healthy": consumer is caught up, no new events
```

**Fix**: Restart the upstream producer (omniclaude, omniintelligence, etc.) or verify the service is healthy.

### Scenario 4: Consumer Lag Growing Unbounded

**Symptom**: `consumerLag.status` is "degraded" or "critical", `totalLag` > 10,000.

**Possible causes**:
1. Slow DB writes (check PostgreSQL performance)
2. Handler throwing uncaught exceptions (check omnidash logs)
3. Network issues between consumer and Kafka

**Fix**:

```bash
# Check omnidash logs for errors
docker logs -f omnidash --tail 100 2>&1 | grep -i error

# If DB is slow, check PostgreSQL
psql -h localhost -p 5436 -U postgres -d omnidash_analytics -c "SELECT * FROM pg_stat_activity WHERE state = 'active';"
```

### Scenario 5: Pattern Data Missing (Aged Out of Kafka)

**Symptom**: `pattern_learning_artifacts` has fewer rows than expected. Events aged out of Kafka's 7-day retention.

**Fix**: Run the backfill script to fetch from the omniintelligence API.

```bash
# Dry-run first
npx tsx scripts/backfill-patterns-from-intelligence.ts --dry-run

# Execute backfill
npx tsx scripts/backfill-patterns-from-intelligence.ts
```

The script paginates through all patterns from `GET http://localhost:8053/api/v1/patterns` and upserts into `pattern_learning_artifacts`.

## Consumer Group Reset Procedure

Full procedure for resetting the read-model consumer group:

```bash
# 1. Stop omnidash (or the consumer will immediately re-register)
# If running in Docker:
docker stop omnidash

# 2. Reset consumer group offsets
npx tsx scripts/reset-consumer-group.ts

# 3. Optionally verify the group was deleted
docker exec omnibase-infra-redpanda rpk group describe omnidash-read-model-v1
# Should show "group not found" or empty offsets

# 4. Restart omnidash
docker start omnidash

# 5. Monitor replay
watch -n 5 'curl -s http://localhost:3000/api/projection-health | jq .summary'
```

## Monitoring Thresholds

| Metric | Healthy | Warning | Critical |
|---|---|---|---|
| Populated tables | > 40 | 20-40 | < 20 |
| Consumer lag | < 10,000 | 10,000-100,000 | > 100,000 |
| Handler drop rate | < 5% | 5-20% | > 20% |
| Staleness (key tables) | < 1h | 1-6h | > 6h |

## Key Tables to Monitor

These tables should always have recent data when the platform is running:

| Table | Source | Expected Freshness |
|---|---|---|
| `agent_routing_decisions` | omniclaude routing | Minutes (every agent session) |
| `session_outcomes` | omniclaude session end | Minutes |
| `pattern_learning_artifacts` | omniintelligence patterns | Hours |
| `llm_routing_decisions` | omniclaude LLM routing | Minutes |
| `intent_signals` | omniintelligence intents | Minutes |
| `pattern_enforcement_events` | omniclaude enforcement | Hours |

## Related Documentation

- [Read-Model Projection Architecture](../architecture/READ_MODEL_PROJECTION_ARCHITECTURE.md)
- [Topic Catalog Architecture](../architecture/TOPIC_CATALOG_ARCHITECTURE.md)
