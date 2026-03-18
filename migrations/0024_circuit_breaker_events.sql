-- 0024_circuit_breaker_events.sql
-- OMN-5293: Circuit Breaker Dashboard — stores infra CB state transitions.
-- Source topic: onex.evt.omnibase-infra.circuit-breaker.v1
-- Replay policy: INSERT (append-only audit log; one row per state transition).

CREATE TABLE IF NOT EXISTS circuit_breaker_events (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    service_name TEXT NOT NULL,
    state        TEXT NOT NULL,           -- CLOSED | OPEN | HALF_OPEN
    previous_state TEXT NOT NULL,
    failure_count  INTEGER NOT NULL DEFAULT 0,
    threshold      INTEGER NOT NULL DEFAULT 5,
    emitted_at     TIMESTAMPTZ NOT NULL,
    ingested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cbe_service_name   ON circuit_breaker_events (service_name);
CREATE INDEX IF NOT EXISTS idx_cbe_state          ON circuit_breaker_events (state);
CREATE INDEX IF NOT EXISTS idx_cbe_emitted_at     ON circuit_breaker_events (emitted_at DESC);
