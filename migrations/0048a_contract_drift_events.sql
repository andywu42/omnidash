-- Contract drift events from onex_change_control (OMN-6753)
-- Source topic: onex.evt.onex-change-control.contract-drift-detected.v1

CREATE TABLE IF NOT EXISTS contract_drift_events (
  id SERIAL PRIMARY KEY,
  repo TEXT NOT NULL,
  node_name TEXT,
  drift_type TEXT NOT NULL,         -- schema_mismatch, version_skew, governance_violation
  severity TEXT,                     -- low, medium, high, critical
  description TEXT,
  expected_value TEXT,
  actual_value TEXT,
  contract_path TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cde_repo ON contract_drift_events(repo);
CREATE INDEX idx_cde_drift_type ON contract_drift_events(drift_type);
CREATE INDEX idx_cde_detected_at ON contract_drift_events(detected_at);
