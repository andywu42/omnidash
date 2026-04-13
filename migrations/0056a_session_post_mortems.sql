-- Migration 0056: session_post_mortems
-- Projects onex.evt.omnimarket.session-post-mortem.v1 into a queryable
-- read-model table for post-mortem observability (OMN-8189).

CREATE TABLE IF NOT EXISTS session_post_mortems (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           TEXT        NOT NULL,
  session_label        TEXT        NOT NULL DEFAULT '',
  outcome              TEXT        NOT NULL CHECK (outcome IN ('completed', 'partial', 'failed', 'aborted')),
  phases_planned       TEXT[]      NOT NULL DEFAULT '{}',
  phases_completed     TEXT[]      NOT NULL DEFAULT '{}',
  phases_failed        TEXT[]      NOT NULL DEFAULT '{}',
  phases_skipped       TEXT[]      NOT NULL DEFAULT '{}',
  stalled_agents       TEXT[]      NOT NULL DEFAULT '{}',
  prs_merged           TEXT[]      NOT NULL DEFAULT '{}',
  prs_open             TEXT[]      NOT NULL DEFAULT '{}',
  prs_failed           TEXT[]      NOT NULL DEFAULT '{}',
  carry_forward_items  TEXT[]      NOT NULL DEFAULT '{}',
  friction_event_count INTEGER     NOT NULL DEFAULT 0,
  report_path          TEXT,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  emitted_at           TIMESTAMPTZ,
  projected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload          JSONB
);

-- Unique on session_id so upsert / onConflictDoNothing() is idempotent
ALTER TABLE session_post_mortems
  ADD CONSTRAINT uq_session_post_mortems_session_id
  UNIQUE (session_id);

CREATE INDEX IF NOT EXISTS idx_spm_projected_at   ON session_post_mortems (projected_at DESC);
CREATE INDEX IF NOT EXISTS idx_spm_completed_at   ON session_post_mortems (completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_spm_outcome        ON session_post_mortems (outcome);
