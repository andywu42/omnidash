-- 0058_session_outcomes_correlation_id.sql
-- OMN-8521: Add correlation_id to session_outcomes for golden chain evaluation chain.
-- The evaluation chain previously had no correlation_id column; it now uses this
-- column as the standard lookup key, enabling consistent golden chain validation.

ALTER TABLE session_outcomes
    ADD COLUMN IF NOT EXISTS correlation_id UUID;

CREATE INDEX IF NOT EXISTS idx_session_outcomes_correlation_id
    ON session_outcomes (correlation_id)
    WHERE correlation_id IS NOT NULL;
