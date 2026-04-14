-- Migration: Validation Lifecycle Candidates Table (OMN-2333)
--
-- Stores lifecycle candidates for the validation lifecycle dashboard.
-- Candidates represent validation rules/patterns progressing through tiers:
--   observed -> suggested -> shadow_apply -> promoted -> default
--
-- Populated by Kafka events from the OMN-2018 artifact store projected by
-- the ReadModelConsumer (handleValidationCandidateUpserted) in validation-routes.ts.
-- Queried by GET /api/validation/lifecycle/summary to power the Lifecycle tab
-- of the ValidationDashboard.
--
-- Idempotency: upserts on candidate_id are safe for event replay.

CREATE TABLE IF NOT EXISTS validation_candidates (
  -- Primary key is the upstream artifact ID from OMN-2018
  candidate_id        TEXT PRIMARY KEY,
  rule_name           TEXT NOT NULL,
  rule_id             TEXT NOT NULL,
  -- Lifecycle tier: observed | suggested | shadow_apply | promoted | default
  tier                TEXT NOT NULL DEFAULT 'observed',
  -- Validation status within tier: pending | pass | fail | quarantine
  status              TEXT NOT NULL DEFAULT 'pending',
  source_repo         TEXT NOT NULL,
  entered_tier_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pass_streak         INTEGER NOT NULL DEFAULT 0,
  fail_streak         INTEGER NOT NULL DEFAULT 0,
  total_runs          INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  projected_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_validation_candidates_tier
  ON validation_candidates (tier);

CREATE INDEX IF NOT EXISTS idx_validation_candidates_status
  ON validation_candidates (status);

CREATE INDEX IF NOT EXISTS idx_validation_candidates_last_validated
  ON validation_candidates (last_validated_at DESC);

CREATE INDEX IF NOT EXISTS idx_validation_candidates_source_repo
  ON validation_candidates (source_repo);

-- Composite index for the lifecycle summary tier+status aggregate query
CREATE INDEX IF NOT EXISTS idx_validation_candidates_tier_status
  ON validation_candidates (tier, status);
