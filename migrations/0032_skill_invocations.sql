CREATE TABLE IF NOT EXISTS skill_invocations (
  id SERIAL PRIMARY KEY,
  skill_name TEXT NOT NULL,
  session_id TEXT,
  duration_ms INTEGER,
  success BOOLEAN NOT NULL DEFAULT true,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_skill_invocations_name ON skill_invocations(skill_name);
CREATE INDEX IF NOT EXISTS idx_skill_invocations_ts ON skill_invocations(created_at);
