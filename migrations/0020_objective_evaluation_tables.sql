-- Migration: 0020_objective_evaluation_tables
-- Description: Create read-model tables for /objective dashboard (OMN-5048)
--
-- Three tables projected from Kafka events:
--   1. objective_evaluations: from onex.evt.omniintelligence.run-evaluated.v1
--   2. objective_gate_failures: derived from evaluation failures at projection time
--   3. objective_anti_gaming_alerts: from anti-gaming detection (future topic)
--
-- The policy_state table is NOT created here — it lives in omniintelligence
-- and the routes query it via tryGetIntelligenceDb() which connects to the
-- same omnidash_analytics DB where the ReadModelConsumer projects.

-- ============================================================================
-- objective_evaluations (projected from run-evaluated.v1)
-- ============================================================================

CREATE TABLE IF NOT EXISTS objective_evaluations (
    id                      UUID        NOT NULL DEFAULT gen_random_uuid(),
    run_id                  TEXT        NOT NULL,
    session_id              TEXT        NOT NULL,
    agent_name              TEXT        NOT NULL DEFAULT 'unknown',
    task_class              TEXT        NOT NULL DEFAULT 'default',
    bundle_fingerprint      TEXT        NOT NULL,
    passed                  BOOLEAN     NOT NULL,
    failures                TEXT[]      NOT NULL DEFAULT '{}',
    score_correctness       FLOAT8      NOT NULL DEFAULT 0.0
                                        CHECK (score_correctness >= 0.0 AND score_correctness <= 1.0),
    score_safety            FLOAT8      NOT NULL DEFAULT 0.0
                                        CHECK (score_safety >= 0.0 AND score_safety <= 1.0),
    score_cost              FLOAT8      NOT NULL DEFAULT 0.0
                                        CHECK (score_cost >= 0.0 AND score_cost <= 1.0),
    score_latency           FLOAT8      NOT NULL DEFAULT 0.0
                                        CHECK (score_latency >= 0.0 AND score_latency <= 1.0),
    score_maintainability   FLOAT8      NOT NULL DEFAULT 0.0
                                        CHECK (score_maintainability >= 0.0 AND score_maintainability <= 1.0),
    score_human_time        FLOAT8      NOT NULL DEFAULT 0.0
                                        CHECK (score_human_time >= 0.0 AND score_human_time <= 1.0),
    evaluated_at            TEXT        NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT pk_objective_evaluations PRIMARY KEY (id),
    CONSTRAINT uq_objective_evaluations_run_bundle
        UNIQUE (run_id, bundle_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_objective_evaluations_session_id
    ON objective_evaluations(session_id);
CREATE INDEX IF NOT EXISTS idx_objective_evaluations_agent_name
    ON objective_evaluations(agent_name);
CREATE INDEX IF NOT EXISTS idx_objective_evaluations_created_at
    ON objective_evaluations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_objective_evaluations_task_class
    ON objective_evaluations(task_class);

-- ============================================================================
-- objective_gate_failures (derived from evaluation failures at projection time)
-- ============================================================================

CREATE TABLE IF NOT EXISTS objective_gate_failures (
    id                          UUID        NOT NULL DEFAULT gen_random_uuid(),
    occurred_at                 TEXT        NOT NULL,
    gate_type                   TEXT        NOT NULL,
    session_id                  TEXT        NOT NULL,
    agent_name                  TEXT        NOT NULL DEFAULT 'unknown',
    evaluation_id               UUID        NOT NULL,
    attribution_refs            JSONB       NOT NULL DEFAULT '[]',
    score_value                 FLOAT8      NOT NULL DEFAULT 0.0,
    threshold                   FLOAT8      NOT NULL DEFAULT 0.5,
    increased_vs_prev_window    BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT pk_objective_gate_failures PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_objective_gate_failures_occurred_at
    ON objective_gate_failures(occurred_at);
CREATE INDEX IF NOT EXISTS idx_objective_gate_failures_gate_type
    ON objective_gate_failures(gate_type);
CREATE INDEX IF NOT EXISTS idx_objective_gate_failures_evaluation_id
    ON objective_gate_failures(evaluation_id);

-- ============================================================================
-- objective_anti_gaming_alerts (placeholder — populated by future detection topic)
-- ============================================================================

CREATE TABLE IF NOT EXISTS objective_anti_gaming_alerts (
    alert_id                TEXT        NOT NULL,
    alert_type              TEXT        NOT NULL,
    triggered_at            TEXT        NOT NULL,
    metric_name             TEXT        NOT NULL,
    proxy_metric            TEXT        NOT NULL,
    delta                   FLOAT8      NOT NULL DEFAULT 0.0,
    description             TEXT        NOT NULL DEFAULT '',
    session_id              TEXT        NOT NULL,
    acknowledged            BOOLEAN     NOT NULL DEFAULT FALSE,
    acknowledged_at         TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT pk_objective_anti_gaming_alerts PRIMARY KEY (alert_id)
);

CREATE INDEX IF NOT EXISTS idx_objective_anti_gaming_alerts_triggered_at
    ON objective_anti_gaming_alerts(triggered_at);
CREATE INDEX IF NOT EXISTS idx_objective_anti_gaming_alerts_alert_type
    ON objective_anti_gaming_alerts(alert_type);

-- ============================================================================
-- policy_state (projected from future policy state events)
-- ============================================================================

CREATE TABLE IF NOT EXISTS policy_state (
    id                      UUID        NOT NULL DEFAULT gen_random_uuid(),
    recorded_at             TEXT        NOT NULL,
    policy_id               TEXT        NOT NULL,
    policy_type             TEXT        NOT NULL,
    policy_version          TEXT        NOT NULL DEFAULT 'v1.0',
    lifecycle_state         TEXT        NOT NULL DEFAULT 'candidate',
    reliability_0_1         FLOAT8      NOT NULL DEFAULT 0.5,
    confidence_0_1          FLOAT8      NOT NULL DEFAULT 0.5,
    is_transition           BOOLEAN     NOT NULL DEFAULT FALSE,
    is_auto_blacklist       BOOLEAN     NOT NULL DEFAULT FALSE,
    has_tool_degraded_alert BOOLEAN     NOT NULL DEFAULT FALSE,
    tool_degraded_message   TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT pk_policy_state PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_policy_state_recorded_at
    ON policy_state(recorded_at);
CREATE INDEX IF NOT EXISTS idx_policy_state_policy_id
    ON policy_state(policy_id);
