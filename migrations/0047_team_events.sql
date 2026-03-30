-- 0047_team_events.sql
-- OMN-7036: Agent Team Events — append-only projection for team lifecycle events
-- (task assigned, progress, completed, evidence written).
-- Source topics: onex.evt.omniclaude.team-task-*.v1, onex.evt.omniclaude.team-evidence-written.v1
-- Replay policy: APPEND (idempotent via unique event_id).

CREATE TABLE IF NOT EXISTS team_events (
    event_id          TEXT PRIMARY KEY,
    correlation_id    TEXT NOT NULL,
    task_id           TEXT NOT NULL,
    event_type        TEXT NOT NULL,
    dispatch_surface  TEXT NOT NULL,
    agent_model       TEXT,
    status            TEXT,
    payload           TEXT,
    emitted_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_te_correlation_id    ON team_events (correlation_id);
CREATE INDEX IF NOT EXISTS idx_te_task_id           ON team_events (task_id);
CREATE INDEX IF NOT EXISTS idx_te_emitted_at        ON team_events (emitted_at);
CREATE INDEX IF NOT EXISTS idx_te_event_type        ON team_events (event_type);
CREATE INDEX IF NOT EXISTS idx_te_dispatch_surface  ON team_events (dispatch_surface);
