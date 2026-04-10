-- Migration 0056: sweep_results table
-- Stores historical sweep skill run results for dashboard visibility.
-- Populated by omnidash read-model consumer projecting onex.evt.omnimarket.sweep-result.v1.
CREATE TABLE IF NOT EXISTS sweep_results (
    id BIGSERIAL PRIMARY KEY,
    sweep_type VARCHAR(64) NOT NULL,
    session_id UUID NOT NULL,
    correlation_id UUID NOT NULL,
    ran_at TIMESTAMPTZ NOT NULL,
    duration_seconds DOUBLE PRECISION,
    passed BOOLEAN NOT NULL,
    finding_count INTEGER DEFAULT 0,
    critical_count INTEGER DEFAULT 0,
    warning_count INTEGER DEFAULT 0,
    repos_scanned TEXT[] DEFAULT '{}',
    summary TEXT,
    output_path TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sweep_results_sweep_type ON sweep_results (sweep_type);
CREATE INDEX IF NOT EXISTS idx_sweep_results_ran_at ON sweep_results (ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_sweep_results_passed ON sweep_results (passed);
