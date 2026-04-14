-- 0034_create_rl_episodes.sql
-- OMN-5559: RL episode boundary read-model table.
-- Two-phase lifecycle: started events INSERT, completed events UPDATE.
-- Source topic: onex.evt.omniintelligence.episode-boundary.v1

CREATE TABLE IF NOT EXISTS rl_episodes (
    id              SERIAL PRIMARY KEY,
    episode_id      UUID NOT NULL UNIQUE,
    surface         TEXT NOT NULL,
    phase           TEXT NOT NULL DEFAULT 'started',
    terminal_status TEXT,

    -- Pre-action observation (no outcome leakage)
    decision_snapshot       JSONB NOT NULL DEFAULT '{}'::jsonb,
    observation_timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Action taken
    action_taken    JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Post-execution outcome (populated on completed events)
    outcome_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Timestamps
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    emitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    projected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rl_episodes_surface ON rl_episodes (surface);
CREATE INDEX IF NOT EXISTS idx_rl_episodes_phase ON rl_episodes (phase);
CREATE INDEX IF NOT EXISTS idx_rl_episodes_terminal_status ON rl_episodes (terminal_status);
CREATE INDEX IF NOT EXISTS idx_rl_episodes_started_at ON rl_episodes (started_at);
CREATE INDEX IF NOT EXISTS idx_rl_episodes_surface_status ON rl_episodes (surface, terminal_status);
