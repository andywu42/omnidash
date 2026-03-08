-- Migration 0017: Model Efficiency Rollups (OMN-3933)
--
-- Stores PR validation rollup events for the Model Efficiency Index (MEI)
-- dashboard. Each row represents a single PR validation run's aggregate
-- metrics, keyed by run_id. MEI calculations use only rollup_status='final'
-- rows.

CREATE TABLE IF NOT EXISTS model_efficiency_rollups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id TEXT NOT NULL UNIQUE,
    repo_id TEXT NOT NULL,
    pr_id TEXT DEFAULT '',
    pr_url TEXT DEFAULT '',
    ticket_id TEXT DEFAULT '',
    model_id TEXT NOT NULL,
    producer_kind TEXT NOT NULL DEFAULT 'unknown',
    rollup_status TEXT NOT NULL DEFAULT 'final',
    metric_version TEXT NOT NULL DEFAULT 'v1',
    files_changed INTEGER NOT NULL DEFAULT 0,
    lines_changed INTEGER NOT NULL DEFAULT 0,
    module_tags JSONB DEFAULT '[]'::jsonb,
    blocking_failures INTEGER NOT NULL DEFAULT 0 CHECK (blocking_failures >= 0),
    warn_findings INTEGER NOT NULL DEFAULT 0 CHECK (warn_findings >= 0),
    reruns INTEGER NOT NULL DEFAULT 0 CHECK (reruns >= 0),
    validator_runtime_ms INTEGER NOT NULL DEFAULT 0 CHECK (validator_runtime_ms >= 0),
    human_escalations INTEGER NOT NULL DEFAULT 0 CHECK (human_escalations >= 0),
    autofix_successes INTEGER NOT NULL DEFAULT 0 CHECK (autofix_successes >= 0),
    time_to_green_ms INTEGER NOT NULL DEFAULT 0 CHECK (time_to_green_ms >= 0),
    vts DOUBLE PRECISION NOT NULL DEFAULT 0,
    vts_per_kloc DOUBLE PRECISION NOT NULL DEFAULT 0,
    phase_count INTEGER NOT NULL DEFAULT 0 CHECK (phase_count >= 0),
    missing_fields JSONB DEFAULT '[]'::jsonb,
    emitted_at TIMESTAMP WITH TIME ZONE NOT NULL,
    projected_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_mer_model_id ON model_efficiency_rollups(model_id);
CREATE INDEX idx_mer_repo_id ON model_efficiency_rollups(repo_id);
CREATE INDEX idx_mer_emitted_at ON model_efficiency_rollups(emitted_at);
CREATE INDEX idx_mer_rollup_status ON model_efficiency_rollups(rollup_status);
