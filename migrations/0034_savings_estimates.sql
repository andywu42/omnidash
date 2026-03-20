-- Migration 0034: Savings Estimates Table (OMN-5552)
-- Stores savings-estimated.v1 events from onex.evt.omnibase-infra.savings-estimated.v1
-- Replay policy: UPSERT on source_event_id (idempotent).

CREATE TABLE IF NOT EXISTS savings_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  correlation_id TEXT,
  schema_version TEXT NOT NULL DEFAULT '1.0',
  actual_total_tokens INTEGER NOT NULL DEFAULT 0,
  actual_cost_usd NUMERIC(12, 10) NOT NULL DEFAULT 0,
  actual_model_id TEXT,
  counterfactual_model_id TEXT,
  direct_savings_usd NUMERIC(12, 10) NOT NULL DEFAULT 0,
  direct_tokens_saved INTEGER NOT NULL DEFAULT 0,
  estimated_total_savings_usd NUMERIC(12, 10) NOT NULL DEFAULT 0,
  estimated_total_tokens_saved INTEGER NOT NULL DEFAULT 0,
  categories JSONB NOT NULL DEFAULT '[]',
  direct_confidence REAL NOT NULL DEFAULT 0,
  heuristic_confidence_avg REAL NOT NULL DEFAULT 0,
  estimation_method TEXT NOT NULL DEFAULT 'tiered_attribution_v1',
  treatment_group TEXT,
  is_measured BOOLEAN NOT NULL DEFAULT FALSE,
  completeness_status TEXT NOT NULL DEFAULT 'complete',
  pricing_manifest_version TEXT,
  event_timestamp TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_savings_estimates_session_id
  ON savings_estimates (session_id);

CREATE INDEX IF NOT EXISTS idx_savings_estimates_event_timestamp
  ON savings_estimates (event_timestamp);

CREATE INDEX IF NOT EXISTS idx_savings_estimates_estimation_method
  ON savings_estimates (estimation_method);
