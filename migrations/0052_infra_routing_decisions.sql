-- 0052: Infrastructure-level model routing decisions (OMN-7447)
-- Projected from onex.evt.omnibase-infra.routing-decided.v1
-- Tracks AdapterModelRouter provider selection decisions

CREATE TABLE IF NOT EXISTS infra_routing_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id TEXT UNIQUE NOT NULL,
    session_id TEXT,
    selected_provider TEXT NOT NULL,
    selected_model TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    selection_mode TEXT NOT NULL DEFAULT 'round_robin',
    is_fallback BOOLEAN NOT NULL DEFAULT FALSE,
    candidates_evaluated INTEGER NOT NULL DEFAULT 1,
    task_type TEXT,
    latency_ms NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    projected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_infra_routing_created_at ON infra_routing_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_infra_routing_provider ON infra_routing_decisions(selected_provider);
CREATE INDEX IF NOT EXISTS idx_infra_routing_model ON infra_routing_decisions(selected_model);
CREATE INDEX IF NOT EXISTS idx_infra_routing_fallback ON infra_routing_decisions(is_fallback) WHERE is_fallback = TRUE;
