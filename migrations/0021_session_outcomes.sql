-- 0021_session_outcomes.sql
-- OMN-5184: Session outcome projection for the Success category dashboard.
-- Source topic: onex.evt.omniclaude.session-outcome.v1
-- Replay policy: UPSERT by session_id (latest-state-wins).

CREATE TABLE IF NOT EXISTS session_outcomes (
    session_id TEXT PRIMARY KEY,
    outcome TEXT NOT NULL,
    emitted_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_outcomes_outcome ON session_outcomes (outcome);
CREATE INDEX IF NOT EXISTS idx_session_outcomes_emitted_at ON session_outcomes (emitted_at);
