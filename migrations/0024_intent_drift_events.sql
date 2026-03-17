-- Migration 0024: Intent drift events table (OMN-5281)
-- Tracks when agent intent drifts from the original plan.
-- Source topic: onex.evt.omniintelligence.intent-drift-detected.v1

CREATE TABLE IF NOT EXISTS intent_drift_events (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  original_intent TEXT,
  current_intent TEXT,
  drift_score REAL,
  severity TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intent_drift_session ON intent_drift_events(session_id);
