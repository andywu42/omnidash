-- Migration: Hostile Reviewer Runs table (OMN-5864)
--
-- Stores projected events from:
--   onex.evt.omniclaude.hostile-reviewer-completed.v1 → hostile_reviewer_runs
--
-- This is an event-summary table keyed by event_id (one row per emission).
-- correlation_id is grouping context only — multiple hostile-reviewer completions
-- within the same correlation produce separate rows.

CREATE TABLE IF NOT EXISTS hostile_reviewer_runs (
  event_id         TEXT        NOT NULL UNIQUE,
  correlation_id   TEXT        NOT NULL,
  mode             TEXT        NOT NULL,
  target           TEXT        NOT NULL,
  models_attempted TEXT[]      NOT NULL DEFAULT '{}',
  models_succeeded TEXT[]      NOT NULL DEFAULT '{}',
  verdict          TEXT        NOT NULL,
  total_findings   INTEGER     NOT NULL DEFAULT 0,
  critical_count   INTEGER     NOT NULL DEFAULT 0,
  major_count      INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  projected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Time-series index for recent-runs queries
CREATE INDEX IF NOT EXISTS idx_hostile_reviewer_runs_created_at
  ON hostile_reviewer_runs (created_at DESC);

-- Index for verdict aggregation (summary counts)
CREATE INDEX IF NOT EXISTS idx_hostile_reviewer_runs_verdict
  ON hostile_reviewer_runs (verdict);

-- Index for correlation-based grouping queries
CREATE INDEX IF NOT EXISTS idx_hostile_reviewer_runs_correlation
  ON hostile_reviewer_runs (correlation_id);
