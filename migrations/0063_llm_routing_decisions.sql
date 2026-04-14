-- Migration: LLM Routing Decisions Table (OMN-2279)
--
-- Stores projected events from:
--   Kafka topic: onex.evt.omniclaude.llm-routing-decision.v1
--
-- Populated by the ReadModelConsumer running in the omnidash backend.
-- Queried by llm-routing-routes.ts to power the LLM routing effectiveness dashboard.
--
-- GOLDEN METRIC: agreement_rate (agreed / (agreed + disagreed)) > 60%.
-- Alert if disagreement rate exceeds 40% (disagreement_rate > 0.4).

CREATE TABLE IF NOT EXISTS llm_routing_decisions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Unique correlation ID for idempotent upserts (ON CONFLICT DO NOTHING).
  -- The UNIQUE constraint is declared inline here so it is created atomically
  -- with the table.  The INSERT in projectLlmRoutingDecisionEvent (server/
  -- read-model-consumer.ts) relies on this constraint being present; if it
  -- were created as a separate step (e.g. CREATE UNIQUE INDEX below) a failed
  -- partial migration would leave the table without the constraint and allow
  -- silent duplicate accumulation.  By embedding it here we guarantee
  -- atomicity: either the whole CREATE TABLE succeeds (constraint present) or
  -- it fails entirely (no table, no duplicates possible).
  --
  -- The separate idx_lrd_correlation_id index below is kept as a named alias
  -- so that the application can reference it by name in EXPLAIN plans and
  -- monitoring queries, but PostgreSQL will satisfy it with the unique index
  -- already created by the inline UNIQUE clause.
  correlation_id         TEXT NOT NULL UNIQUE,
  session_id             TEXT,
  -- Agent selected by LLM routing
  llm_agent              TEXT NOT NULL,
  -- Agent selected by fuzzy-string routing (may differ from llm_agent)
  fuzzy_agent            TEXT NOT NULL,
  -- Whether LLM and fuzzy agreed on the same agent
  agreement              BOOLEAN NOT NULL DEFAULT FALSE,
  -- Confidence scores (0-1); NULL when not provided by upstream
  llm_confidence         NUMERIC(5, 4) CHECK (llm_confidence IS NULL OR (llm_confidence >= 0 AND llm_confidence <= 1)),
  fuzzy_confidence       NUMERIC(5, 4) CHECK (fuzzy_confidence IS NULL OR (fuzzy_confidence >= 0 AND fuzzy_confidence <= 1)),
  -- Routing latency in milliseconds
  llm_latency_ms         INTEGER NOT NULL DEFAULT 0,
  fuzzy_latency_ms       INTEGER NOT NULL DEFAULT 0,
  -- Whether the fuzzy matcher was used as a fallback (LLM unavailable or timed out)
  used_fallback          BOOLEAN NOT NULL DEFAULT FALSE,
  -- Prompt version used for the LLM routing call (e.g. "v1.0.0")
  -- Enables longitudinal comparison of prompt quality over time.
  routing_prompt_version TEXT NOT NULL DEFAULT 'unknown',
  -- Original intent string that triggered routing (optional)
  intent                 TEXT,
  -- LLM model used for routing (optional)
  model                  TEXT,
  -- Estimated cost of the LLM routing call in USD (NULL when not reported)
  cost_usd               NUMERIC(12, 8) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  -- When the routing decision originally occurred
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When this row was projected from Kafka
  projected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Token tracking columns (added via 0013 on upgrade; included here for fresh-install parity)
  prompt_tokens          INTEGER NOT NULL DEFAULT 0,
  completion_tokens      INTEGER NOT NULL DEFAULT 0,
  total_tokens           INTEGER NOT NULL DEFAULT 0,
  omninode_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT chk_lrd_token_columns_nn CHECK (prompt_tokens >= 0 AND completion_tokens >= 0 AND total_tokens >= 0)
);

-- Named alias for the unique index that backs the inline UNIQUE constraint on
-- correlation_id.  PostgreSQL automatically creates an unnamed unique index
-- when UNIQUE is specified in the column definition above; this statement
-- creates a second named index so monitoring queries and EXPLAIN plans can
-- reference idx_lrd_correlation_id by name.  On a fresh migration both the
-- inline constraint and this named index will be present and PostgreSQL will
-- use the most recently created one for constraint enforcement.
-- Note: IF NOT EXISTS prevents failure on re-runs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lrd_correlation_id
  ON llm_routing_decisions (correlation_id);

-- Primary time-series index (most dashboard queries are time-window scoped)
CREATE INDEX IF NOT EXISTS idx_lrd_created_at
  ON llm_routing_decisions (created_at DESC);

-- Index for agreement-rate aggregation (GROUP BY agreement)
CREATE INDEX IF NOT EXISTS idx_lrd_agreement
  ON llm_routing_decisions (agreement, created_at DESC);

-- Index for fallback-rate aggregation
CREATE INDEX IF NOT EXISTS idx_lrd_used_fallback
  ON llm_routing_decisions (used_fallback, created_at DESC);

-- Index for longitudinal comparison by routing_prompt_version
CREATE INDEX IF NOT EXISTS idx_lrd_prompt_version
  ON llm_routing_decisions (routing_prompt_version, created_at DESC);

-- Composite index for disagreement pair queries (llm_agent, fuzzy_agent)
-- Used by the top-disagreements endpoint to find frequently diverging pairs.
CREATE INDEX IF NOT EXISTS idx_lrd_agent_pair
  ON llm_routing_decisions (llm_agent, fuzzy_agent, created_at DESC)
  WHERE agreement = FALSE;

-- Token and omninode indexes (mirror of 0013 for fresh-install parity)
CREATE INDEX IF NOT EXISTS idx_lrd_tokens   ON llm_routing_decisions(total_tokens) WHERE total_tokens > 0;
CREATE INDEX IF NOT EXISTS idx_lrd_omninode ON llm_routing_decisions(omninode_enabled);
