-- Migration 0024: Compliance Evaluations Table (OMN-5285)
-- Stores compliance-evaluated.v1 events from onex.evt.omniintelligence.compliance-evaluated.v1
-- Replay policy: APPEND-ONLY with evaluation_id as natural dedup key.

CREATE TABLE IF NOT EXISTS compliance_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id TEXT NOT NULL UNIQUE,
  repo TEXT NOT NULL,
  rule_set TEXT NOT NULL,
  score REAL NOT NULL,
  violations JSONB DEFAULT '[]',
  pass BOOLEAN NOT NULL,
  event_timestamp TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_evaluations_repo
  ON compliance_evaluations (repo);

CREATE INDEX IF NOT EXISTS idx_compliance_evaluations_rule_set
  ON compliance_evaluations (rule_set);

CREATE INDEX IF NOT EXISTS idx_compliance_evaluations_event_timestamp
  ON compliance_evaluations (event_timestamp);

CREATE INDEX IF NOT EXISTS idx_compliance_evaluations_pass
  ON compliance_evaluations (pass);
