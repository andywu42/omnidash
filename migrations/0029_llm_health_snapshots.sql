-- Migration: 0024_llm_health_snapshots.sql
-- LLM endpoint health snapshot table (OMN-5279)
-- Projected from onex.evt.omnibase-infra.llm-health-snapshot.v1 events.

CREATE TABLE IF NOT EXISTS llm_health_snapshots (
  id              SERIAL PRIMARY KEY,
  model_id        TEXT NOT NULL,
  endpoint_url    TEXT NOT NULL,
  latency_p50_ms  INTEGER,
  latency_p99_ms  INTEGER,
  error_rate      DOUBLE PRECISION,
  tokens_per_second DOUBLE PRECISION,
  status          TEXT NOT NULL DEFAULT 'unknown',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_health_model_id   ON llm_health_snapshots (model_id);
CREATE INDEX IF NOT EXISTS idx_llm_health_created_at ON llm_health_snapshots (created_at);
CREATE INDEX IF NOT EXISTS idx_llm_health_status     ON llm_health_snapshots (status);
-- Composite index for the primary read pattern: latest snapshot per model_id
CREATE INDEX IF NOT EXISTS idx_llm_health_model_created ON llm_health_snapshots (model_id, created_at DESC);
