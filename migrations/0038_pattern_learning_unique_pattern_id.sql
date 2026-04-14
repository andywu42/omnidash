-- OMN-5644: Add unique index on pattern_id for upsert support
-- The onConflictDoUpdate in the pattern projection consumer requires a unique
-- constraint on pattern_id. Without this, Drizzle ORM cannot target the column
-- for upsert operations.

-- First, deduplicate any existing rows (keep the most recently updated one)
DELETE FROM pattern_learning_artifacts a
USING pattern_learning_artifacts b
WHERE a.pattern_id = b.pattern_id
  AND a.id <> b.id
  AND a.updated_at < b.updated_at;

-- Now add the unique index
CREATE UNIQUE INDEX IF NOT EXISTS idx_patlearn_pattern_id_unique
  ON pattern_learning_artifacts (pattern_id);
