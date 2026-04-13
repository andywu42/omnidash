-- Migration: Add routing shadow decisions table (OMN-5570)
--
-- Stores shadow routing decisions from Bifrost gateway's learned policy
-- for comparison with static routing rules. Used by the RL Routing
-- dashboard to evaluate promotion gate criteria.
--
-- Shadow decisions are projected from Kafka events emitted by the
-- Bifrost gateway when shadow mode is enabled.

CREATE TABLE IF NOT EXISTS routing_shadow_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id UUID NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Static (actual) routing decision
    static_backend_selected TEXT NOT NULL,
    static_rule_id UUID,

    -- Shadow (learned policy) recommendation
    shadow_backend_recommended TEXT NOT NULL,
    agreed BOOLEAN NOT NULL,

    -- Request context
    request_operation_type TEXT NOT NULL,
    request_cost_tier TEXT NOT NULL,
    request_max_latency_ms INTEGER NOT NULL,
    estimated_token_count INTEGER,
    tenant_id UUID NOT NULL,

    -- Shadow policy metadata
    shadow_confidence DOUBLE PRECISION NOT NULL,
    shadow_latency_ms DOUBLE PRECISION NOT NULL,
    policy_version TEXT NOT NULL,
    shadow_action_distribution JSONB DEFAULT '{}'::jsonb,

    -- Cost/latency estimates for reward delta computation
    static_backend_estimated_cost DOUBLE PRECISION,
    shadow_backend_estimated_cost DOUBLE PRECISION,
    static_backend_estimated_latency_ms DOUBLE PRECISION,
    shadow_backend_estimated_latency_ms DOUBLE PRECISION,

    -- Projection metadata
    projected_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for correlation-based lookups
CREATE INDEX IF NOT EXISTS idx_rsd_correlation_id
    ON routing_shadow_decisions (correlation_id);

-- Index for time-range queries (dashboard aggregations)
CREATE INDEX IF NOT EXISTS idx_rsd_timestamp
    ON routing_shadow_decisions (timestamp);

-- Index for agreement rate by operation type
CREATE INDEX IF NOT EXISTS idx_rsd_operation_type_agreed
    ON routing_shadow_decisions (request_operation_type, agreed);

-- Index for policy version filtering
CREATE INDEX IF NOT EXISTS idx_rsd_policy_version
    ON routing_shadow_decisions (policy_version);

-- Index for backend distribution analysis
CREATE INDEX IF NOT EXISTS idx_rsd_shadow_backend
    ON routing_shadow_decisions (shadow_backend_recommended);

-- Index for disagreement analysis by cost tier
CREATE INDEX IF NOT EXISTS idx_rsd_cost_tier_agreed
    ON routing_shadow_decisions (request_cost_tier, agreed);
