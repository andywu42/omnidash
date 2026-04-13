-- OMN-5558: Add status text column, emitted_at timestamp, and dedup unique
-- constraint to skill_invocations for idempotent upserts.

ALTER TABLE skill_invocations
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'success',
  ADD COLUMN IF NOT EXISTS emitted_at TIMESTAMPTZ;

-- Dedup key: same skill in the same session at the same emitted_at is a duplicate.
-- Rows with NULL session_id or emitted_at are excluded from dedup (NULLS NOT DISTINCT
-- not available on all PG versions, so we use a partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_invocations_dedup
  ON skill_invocations (session_id, skill_name, emitted_at)
  WHERE session_id IS NOT NULL AND emitted_at IS NOT NULL;
