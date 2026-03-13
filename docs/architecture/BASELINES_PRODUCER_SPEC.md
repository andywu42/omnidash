# Baselines Producer Specification

## Status: Consumer Ready, Producer Needed

The omnidash consumer infrastructure for baselines is fully built:
- 4 database tables: `baselines_snapshots`, `baselines_comparisons`, `baselines_trend`, `baselines_breakdown`
- `BaselinesProjection` (DB-backed, TTL-cached)
- `read-model-consumer.ts` projection handlers
- API routes: `/api/baselines/summary`, `/api/baselines/comparisons`, `/api/baselines/trend`, `/api/baselines/breakdown`
- `BaselinesROI.tsx` page component with charts and comparison cards

The **producer** (baselines batch compute in omniclaude) does not yet exist.

## Required Producer

A baselines batch compute skill/script in omniclaude that:

1. Queries pattern performance data (token usage, latency, retry counts, test pass rates)
2. Compares treatment patterns against control baselines
3. Computes promotion recommendations (promote/shadow/suppress/fork)
4. Publishes `onex.evt.omniclaude.baseline-computed.v1` events to Kafka

## Event Schema

The consumer expects events matching the `baselines_*` table schemas:

### baselines_snapshots
- `snapshot_id` (UUID, partition key)
- `computed_at_utc` (timestamp)

### baselines_comparisons (per snapshot)
- `pattern_id`, `pattern_name`
- `sample_size`, `window_start`, `window_end`
- `token_delta`, `time_delta`, `retry_delta`, `test_pass_rate_delta`, `review_iteration_delta` (JSON DeltaMetric objects)
- `recommendation` (promote | shadow | suppress | fork)
- `confidence` (high | medium | low)
- `rationale` (text)

### baselines_trend (per snapshot)
- `date` (YYYY-MM-DD)
- `avg_cost_savings`, `avg_outcome_improvement` (numeric)
- `comparisons_evaluated` (int)

### baselines_breakdown (per snapshot)
- `action` (promote | shadow | suppress | fork)
- `count` (int)
- `avg_confidence` (numeric)

## Kafka Topic

`onex.evt.omniclaude.baseline-computed.v1`

Partition key: `snapshot_id`

## Trigger Options

1. **Scheduled batch**: Run daily or weekly via cron
2. **On-demand skill**: `claude /baselines-compute` skill
3. **Pipeline hook**: Triggered after sufficient new pattern data accumulates
