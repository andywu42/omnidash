-- Migration: Context Enrichment Events Table (OMN-2280)
--
-- Stores projected events from:
--   Kafka topic: onex.evt.omniclaude.context-enrichment.v1
--
-- Populated by the ReadModelConsumer running in the omnidash backend.
-- Queried by enrichment-routes.ts to power the context enrichment dashboard.
--
-- GOLDEN METRIC: net_tokens_saved > 0 indicates value delivered by enrichment.
-- Context inflation (net_tokens_saved < 0 and outcome = 'inflated') triggers alerts.

CREATE TABLE IF NOT EXISTS context_enrichment_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Unique correlation ID for idempotency (ON CONFLICT DO NOTHING)
  -- Uniqueness enforced by idx_cee_correlation_id below.
  correlation_id   TEXT NOT NULL,
  session_id       TEXT,
  -- Enrichment channel (e.g. "qdrant", "pattern-cache", "similarity-search")
  channel          TEXT NOT NULL,
  -- Model used for enrichment
  model_name       TEXT NOT NULL DEFAULT 'unknown',
  -- Whether the result came from cache
  cache_hit        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Enrichment outcome: hit | miss | error | inflated
  -- NOTE: These values are duplicated in server/read-model-consumer.ts
  -- (see the `!['hit', 'miss', 'error', 'inflated'].includes(outcome)` guard).
  -- If you add or rename an outcome value here, update that validation in sync.
  outcome          TEXT NOT NULL CHECK (outcome IN ('hit', 'miss', 'error', 'inflated')),
  -- Latency in milliseconds
  latency_ms       INTEGER NOT NULL DEFAULT 0,
  -- Token counts before and after enrichment
  tokens_before    INTEGER NOT NULL DEFAULT 0,
  tokens_after     INTEGER NOT NULL DEFAULT 0,
  -- Net tokens saved (positive = compressed, negative = inflated)
  -- GOLDEN METRIC: net_tokens_saved > 0 means the enrichment delivered value
  net_tokens_saved INTEGER NOT NULL DEFAULT 0,
  -- Similarity and quality scores (NULL when not a similarity-search operation)
  similarity_score NUMERIC(5, 4) CHECK (similarity_score IS NULL OR (similarity_score >= 0 AND similarity_score <= 1)),
  quality_score    NUMERIC(5, 4) CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
  repo             TEXT,
  agent_name       TEXT,
  -- When the enrichment event originally occurred
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When this row was projected from Kafka
  projected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique index for idempotent upserts
CREATE UNIQUE INDEX IF NOT EXISTS idx_cee_correlation_id
  ON context_enrichment_events (correlation_id);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_cee_created_at
  ON context_enrichment_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cee_outcome
  ON context_enrichment_events (outcome);

CREATE INDEX IF NOT EXISTS idx_cee_channel
  ON context_enrichment_events (channel);

CREATE INDEX IF NOT EXISTS idx_cee_model_name
  ON context_enrichment_events (model_name);

-- Composite index for window-based queries by channel
CREATE INDEX IF NOT EXISTS idx_cee_created_channel
  ON context_enrichment_events (channel, created_at DESC);

-- Index to support inflation alert queries (outcome = 'inflated', ordered by time)
CREATE INDEX IF NOT EXISTS idx_cee_inflated_created
  ON context_enrichment_events (created_at DESC)
  WHERE outcome = 'inflated';

-- Index to support similarity quality queries
CREATE INDEX IF NOT EXISTS idx_cee_similarity_created
  ON context_enrichment_events (created_at DESC)
  WHERE similarity_score IS NOT NULL;
