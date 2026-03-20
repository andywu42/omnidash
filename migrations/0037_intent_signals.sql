-- 0037_intent_signals.sql
-- OMN-5620: Create intent_signals table for intent-classified and intent-stored projections.
-- Source topics:
--   onex.evt.omniintelligence.intent-classified.v1
--   onex.evt.omnimemory.intent-stored.v1
-- Replay policy: INSERT with ON CONFLICT DO NOTHING (correlation_id is dedup key).

CREATE TABLE IF NOT EXISTS intent_signals (
    id SERIAL PRIMARY KEY,
    correlation_id TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL,
    intent_type TEXT NOT NULL DEFAULT 'unknown',
    topic TEXT NOT NULL,
    raw_payload JSONB,
    created_at TIMESTAMPTZ,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intent_signals_intent_type ON intent_signals (intent_type);
CREATE INDEX IF NOT EXISTS idx_intent_signals_created_at ON intent_signals (created_at);
CREATE INDEX IF NOT EXISTS idx_intent_signals_topic ON intent_signals (topic);
