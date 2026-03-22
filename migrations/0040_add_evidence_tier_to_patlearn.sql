-- Migration 0040: Add evidence_tier column to pattern_learning_artifacts
-- The Drizzle schema (intelligence-schema.ts) defines this column but no SQL
-- migration existed to create it. Found during dashboard sweep (OMN-5818)
-- after WAL corruption recovery revealed the schema/table mismatch.

ALTER TABLE pattern_learning_artifacts
  ADD COLUMN IF NOT EXISTS evidence_tier TEXT NOT NULL DEFAULT 'unmeasured';
