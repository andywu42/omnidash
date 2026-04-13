-- 0048_review_calibration_runs.sql
-- OMN-6176: Review calibration runs read-model table
-- Stores calibration run results projected from Kafka events by the
-- ReadModelConsumer (omniintelligence-projections.ts).
-- Used by the review calibration dashboard to display model accuracy over time.

CREATE TABLE IF NOT EXISTS review_calibration_runs_rm (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          TEXT NOT NULL,
    ground_truth_model TEXT NOT NULL,
    challenger_model TEXT NOT NULL,
    precision       DOUBLE PRECISION NOT NULL,
    recall          DOUBLE PRECISION NOT NULL,
    f1              DOUBLE PRECISION NOT NULL,
    noise_ratio     DOUBLE PRECISION NOT NULL,
    sample_size     INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    projected_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rcr_run_id ON review_calibration_runs_rm (run_id);
CREATE INDEX IF NOT EXISTS idx_rcr_challenger_model ON review_calibration_runs_rm (challenger_model);
CREATE INDEX IF NOT EXISTS idx_rcr_created_at ON review_calibration_runs_rm (created_at);
