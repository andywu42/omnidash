-- OMN-1988: Create pattern pipeline tables for effectiveness dashboard
--
-- These are read-model projections of tables that exist in omniintelligence.
-- No FK references to learned_patterns — validation happens upstream.
-- Writes occur only in the Kafka read-model consumer; omnidash API routes never mutate.
--
-- Source schemas:
--   omnidash/shared/intelligence-schema.ts (lines 1219-1370)
--   omniintelligence migrations 007, 010, 012, 013

-- Enable pgcrypto for gen_random_uuid() on PG < 13
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Trigger function for auto-updating updated_at columns
CREATE OR REPLACE FUNCTION omnidash_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Table 1: pattern_injections (19 columns + updated_at trigger)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pattern_injections (
  injection_id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           UUID         NOT NULL,
  correlation_id       UUID,
  pattern_ids          UUID[]       NOT NULL DEFAULT '{}'::uuid[],
  injected_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  injection_context    VARCHAR(30)  NOT NULL,
  cohort               VARCHAR(20)  NOT NULL DEFAULT 'treatment',
  assignment_seed      BIGINT       NOT NULL,
  compiled_content     TEXT,
  compiled_token_count INTEGER,
  outcome_recorded     BOOLEAN      NOT NULL DEFAULT FALSE,
  outcome_success      BOOLEAN,
  outcome_recorded_at  TIMESTAMPTZ,
  outcome_failure_reason TEXT,
  contribution_heuristic JSONB,
  heuristic_method     VARCHAR(50),
  heuristic_confidence DOUBLE PRECISION,
  run_id               UUID,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pi_session_id      ON pattern_injections(session_id);
CREATE INDEX IF NOT EXISTS idx_pi_cohort           ON pattern_injections(cohort);
CREATE INDEX IF NOT EXISTS idx_pi_injected_at      ON pattern_injections(injected_at);
CREATE INDEX IF NOT EXISTS idx_pi_correlation_id   ON pattern_injections(correlation_id)  WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pi_run_id           ON pattern_injections(run_id)           WHERE run_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON pattern_injections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON pattern_injections
  FOR EACH ROW EXECUTE FUNCTION omnidash_set_updated_at();

-- ---------------------------------------------------------------------------
-- Table 2: pattern_lifecycle_transitions (11 columns)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pattern_lifecycle_transitions (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          UUID         NOT NULL,
  pattern_id          UUID         NOT NULL,
  from_status         VARCHAR(20)  NOT NULL,
  to_status           VARCHAR(20)  NOT NULL,
  transition_trigger  VARCHAR(50)  NOT NULL,
  correlation_id      UUID,
  actor               VARCHAR(100),
  reason              TEXT,
  gate_snapshot       JSONB,
  transition_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plt_pattern_id      ON pattern_lifecycle_transitions(pattern_id);
CREATE INDEX IF NOT EXISTS idx_plt_transition_at    ON pattern_lifecycle_transitions(transition_at);
CREATE INDEX IF NOT EXISTS idx_plt_correlation_id   ON pattern_lifecycle_transitions(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plt_trigger          ON pattern_lifecycle_transitions(transition_trigger);
CREATE INDEX IF NOT EXISTS idx_plt_from_to_status   ON pattern_lifecycle_transitions(from_status, to_status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plt_request_pattern ON pattern_lifecycle_transitions(request_id, pattern_id);

-- ---------------------------------------------------------------------------
-- Table 3: pattern_measured_attributions (8 columns)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pattern_measured_attributions (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id               UUID         NOT NULL,
  session_id               UUID         NOT NULL,
  run_id                   UUID,
  evidence_tier            TEXT         NOT NULL,
  measured_attribution_json JSONB,
  correlation_id           UUID,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pma_pattern_created       ON pattern_measured_attributions(pattern_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pma_session               ON pattern_measured_attributions(session_id);
CREATE INDEX IF NOT EXISTS idx_pma_run_id                ON pattern_measured_attributions(run_id)         WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pma_correlation           ON pattern_measured_attributions(correlation_id) WHERE correlation_id IS NOT NULL;

-- Idempotency indexes: prevent duplicate attributions per pattern+session+run combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_pma_idempotent          ON pattern_measured_attributions(pattern_id, session_id, run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pma_idempotent_observed ON pattern_measured_attributions(pattern_id, session_id)         WHERE run_id IS NULL;
