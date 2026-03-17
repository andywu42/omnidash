-- 0022_phase_metrics_events.sql
-- OMN-5184: Phase metrics projection for the Speed category dashboard.
-- Source topic: onex.evt.omniclaude.phase-metrics.v1
-- Replay policy: APPEND-ONLY with natural dedup key (session_id, phase, emitted_at).

CREATE TABLE IF NOT EXISTS phase_metrics_events (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    ticket_id TEXT,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    emitted_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_phase_metrics_dedup UNIQUE (session_id, phase, emitted_at)
);

CREATE INDEX IF NOT EXISTS idx_phase_metrics_session_id ON phase_metrics_events (session_id);
CREATE INDEX IF NOT EXISTS idx_phase_metrics_phase ON phase_metrics_events (phase);
CREATE INDEX IF NOT EXISTS idx_phase_metrics_emitted_at ON phase_metrics_events (emitted_at);
