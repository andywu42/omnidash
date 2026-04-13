-- Eval reports projection table (OMN-6781)
-- Stores A/B eval comparison results projected from
-- onex.evt.onex-change-control.eval-completed.v1 events.

CREATE TABLE IF NOT EXISTS eval_reports (
  report_id       TEXT PRIMARY KEY,
  suite_id        TEXT NOT NULL,
  suite_version   TEXT NOT NULL DEFAULT '',
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Summary statistics
  total_tasks           INTEGER NOT NULL DEFAULT 0,
  onex_better_count     INTEGER NOT NULL DEFAULT 0,
  onex_worse_count      INTEGER NOT NULL DEFAULT 0,
  neutral_count         INTEGER NOT NULL DEFAULT 0,
  avg_latency_delta_ms  DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_token_delta       DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_success_rate_on   DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_success_rate_off  DOUBLE PRECISION NOT NULL DEFAULT 0,
  pattern_hit_rate_on   DOUBLE PRECISION NOT NULL DEFAULT 0,

  -- Full event payload for drill-down
  raw_payload JSONB,

  -- Bookkeeping
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_reports_suite_id ON eval_reports(suite_id);
CREATE INDEX IF NOT EXISTS idx_eval_reports_generated_at ON eval_reports(generated_at DESC);
