-- 0024_routing_feedback_events.sql
-- OMN-5284: Routing feedback read-model projection table.
-- Source topic: onex.evt.omniintelligence.routing-feedback-processed.v1

CREATE TABLE IF NOT EXISTS routing_feedback_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id TEXT NOT NULL,
    feedback_type TEXT NOT NULL,
    original_route TEXT NOT NULL,
    corrected_route TEXT,
    accuracy_score DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routing_feedback_agent_id ON routing_feedback_events (agent_id);
CREATE INDEX IF NOT EXISTS idx_routing_feedback_created_at ON routing_feedback_events (created_at);
CREATE INDEX IF NOT EXISTS idx_routing_feedback_type ON routing_feedback_events (feedback_type);
