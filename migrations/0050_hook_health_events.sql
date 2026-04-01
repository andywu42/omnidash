-- 0050_hook_health_events.sql
-- OMN-7157: Hook Health Error Events — append-only event store for hook error
-- observability. Drives the hook health dashboard card and summary API.
-- Source topic: onex.evt.omniclaude.hook-health-error.v1
-- Replay policy: INSERT (append-only, dedup by id).

CREATE TABLE IF NOT EXISTS hook_health_events (
    id                TEXT PRIMARY KEY,
    hook_name         TEXT NOT NULL,
    error_tier        TEXT NOT NULL,
    error_category    TEXT NOT NULL,
    error_message     TEXT NOT NULL DEFAULT '',
    session_id        TEXT NOT NULL DEFAULT '',
    python_version    TEXT NOT NULL DEFAULT '',
    fingerprint       TEXT NOT NULL DEFAULT '',
    emitted_at        TIMESTAMPTZ NOT NULL,
    ingested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hhe_error_tier     ON hook_health_events (error_tier);
CREATE INDEX IF NOT EXISTS idx_hhe_error_category ON hook_health_events (error_category);
CREATE INDEX IF NOT EXISTS idx_hhe_emitted_at     ON hook_health_events (emitted_at);
CREATE INDEX IF NOT EXISTS idx_hhe_fingerprint    ON hook_health_events (fingerprint);
CREATE INDEX IF NOT EXISTS idx_hhe_hook_name      ON hook_health_events (hook_name);
