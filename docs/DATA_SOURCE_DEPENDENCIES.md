# Data Source Dependencies

Maps every omnidash dashboard page to its upstream data source, producer service,
Kafka topic, read-model table, and the command needed to populate it.

> **Why this matters**: Many pages appear empty until their upstream producer has
> run at least once. This document is the single reference for activating every
> page in a fresh deployment.

---

## Skill-Dependent Pages (require omniclaude skill execution)

These pages are populated by events emitted during omniclaude skill sessions.
They will be empty until the corresponding skill has run at least once.

| Page | Route | Kafka Topic | Read-Model Table | Producer Skill | Trigger Command |
|------|-------|-------------|-----------------|----------------|-----------------|
| Epic Pipeline | `/epic-pipeline` | `onex.evt.omniclaude.epic-run-updated.v1` | `epic_run_events` + `epic_run_lease` | `epic-team` | Run any epic orchestration session |
| PR Watch | `/pr-watch` | `onex.evt.omniclaude.pr-watch-updated.v1` | `pr_watch_state` | `pr-watch` | Run a PR watch monitoring session |
| Gate Decisions | `/gate-decisions` | `onex.evt.omniclaude.gate-decision.v1` | `gate_decisions` | CI gate evaluation | Trigger CI on a PR with gate checks enabled |
| Pipeline Budget | `/pipeline-budget` | `onex.evt.omniclaude.budget-cap-hit.v1` | `pipeline_budget_state` | Budget enforcement | Run a pipeline that exceeds its configured budget cap |

## Batch-Compute Pages (require explicit batch trigger)

| Page | Route | Kafka Topic | Read-Model Tables | Producer | Trigger Command |
|------|-------|-------------|-------------------|----------|-----------------|
| Baselines & ROI | `/baselines` | `onex.evt.omniclaude.baseline-computed.v1` | `baselines_snapshots`, `baselines_comparisons`, `baselines_trend`, `baselines_breakdown` | omniclaude baselines compute | See "Baselines Activation" below |

### Baselines Activation

The baselines page requires a batch computation that compares pattern performance
against historical baselines. The pipeline:

1. **Producer**: omniclaude baseline compute (produces `baseline-computed` events)
2. **Consumer**: `read-model-consumer.ts` projects events into 4 `baselines_*` tables
3. **Projection**: `BaselinesProjection` (DB-backed, TTL-cached) reads from tables
4. **API**: `/api/baselines/summary`, `/api/baselines/comparisons`, `/api/baselines/trend`

To populate: run the baselines compute skill or wait for the scheduled batch job.

## Runtime-Effect Pages (require runtime infrastructure services)

| Page | Route | Data Source | Producer | Trigger |
|------|-------|-------------|----------|---------|
| Event Bus Health | `/system-health` | Redpanda Admin API (port 9644) | `event-bus-health-poller.ts` | Automatic (polls every 30s when Redpanda is running) |
| Status (PRs) | `/status` | `onex.evt.github.pr-status.v1` | `node_github_pr_poller_effect` (omnibase_infra) | Runtime tick event triggers polling every 60s |
| Status (Linear) | `/status` | `onex.evt.linear.snapshot.v1` | `onex-linear-relay` CLI (omnibase_infra) | `onex-linear-relay emit --snapshot-file <path>` |
| Validation | `/validation` | PostgreSQL `validation_runs` table | Validation orchestrator (omnibase_infra) | Trigger a validation run via runtime API |

## Always-Live Pages (populated by continuous event streams)

These pages are populated by events that flow continuously during normal platform
operation. They should show data as soon as the platform is running.

| Page | Route | Kafka Topic | Read-Model Table | Producer |
|------|-------|-------------|-----------------|----------|
| Event Bus Monitor | `/events` | All topics | In-memory projection | EventBusDataSource |
| Effectiveness | `/effectiveness` | `onex.evt.omniintelligence.intent-classified.v1` | `injection_effectiveness` | omniintelligence |
| Extraction | `/extraction` | Pattern events | `extraction_metrics` | omniintelligence |
| Patterns | `/patterns` | `onex.evt.omniintelligence.pattern-discovery.v1` | `pattern_learning_artifacts` | omniintelligence |
| Enrichment | `/enrichment` | Context enrichment events | `context_enrichment_events` | omniintelligence |
| Enforcement | `/enforcement` | Pattern enforcement events | `pattern_enforcement_events` | omniintelligence |
| LLM Routing | `/llm-routing` | LLM routing decisions | `llm_routing_decisions` | omnibase_infra runtime |
| Cost Trends | `/cost` | LLM cost events | `llm_cost_aggregates` | omnibase_infra runtime |
| Delegation | `/delegation` | Delegation events | `delegation_events` | omniclaude |
| Intent | `/intent` | Intent classification | In-memory projection | omniintelligence |

## Local Dev Expected Status (OMN-5141)

In local development environments (no K8S_NAMESPACE, NODE_ENV != production),
certain data sources are expected to be idle because their upstream producers
only run in cloud or during specific batch/agent sessions. The health panel
shows these as `expected_idle_local` (blue "Idle (local)" badge) instead of
`offline` or `mock`, so developers can distinguish "expected gap" from "broken".

| Source Key | Why Idle Locally | How to Activate |
|---|---|---|
| baselines | Daily GH Actions batch job | `uv run python scripts/run_baselines_batch_compute.py` |
| validation | Cross-repo validation pipeline | Run validation orchestrator |
| intents | Requires active agent sessions | Start an agent session producing intent events |
| patterns | Requires pattern extraction pipeline | Run pattern extraction |
| insights | Requires pattern_learning_artifacts | Run pattern extraction pipeline |
| topicParity | Requires all Kafka consumers connected | Ensure full runtime stack is up |
| envSync | Requires Infisical (secrets profile) | `docker compose --profile secrets up -d` + run sync |

## Architecture Notes

### Event Flow

```
Producer (omniclaude/omnibase_infra)
  --> Kafka topic
    --> read-model-consumer.ts (projects to PostgreSQL)
      --> DB-backed projection (TTL-cached read)
        --> Express route handler
          --> React page component
```

### Empty-State Behavior

Pages with no data display an empty-state component (`data-testid="empty-state"`)
that identifies:
- The data source name
- The producer skill or service
- A brief instruction for how to populate the page

This prevents confusion when a page appears blank after a fresh deployment.
