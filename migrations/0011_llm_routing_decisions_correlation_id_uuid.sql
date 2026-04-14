-- Migration: Normalize llm_routing_decisions.correlation_id to uuid (OMN-2960)
--
-- Problem: llm_routing_decisions.correlation_id was created as TEXT while
-- agent_routing_decisions.correlation_id is UUID. The type mismatch forced
-- every cross-table JOIN to use:
--
--   CAST(lrd.correlation_id AS uuid) = ard.correlation_id
--
-- This CAST is brittle (fails on non-UUID text values) and prevents Postgres
-- from using the index on correlation_id for the join column.
--
-- Fix: ALTER the column in-place using USING to cast existing values.
-- Precondition: all existing rows must already contain valid UUID strings.
-- If any row holds a non-UUID text value the migration will fail with
-- "invalid input syntax for type uuid" — which is intentional; it surfaces
-- data quality issues rather than silently truncating or NULLing bad rows.
--
-- Idempotency: The DO $$ block checks the current column type before
-- attempting the ALTER so re-running this migration is safe.

DO $$
BEGIN
  -- Only alter if the column is still TEXT; skip if already UUID (re-run safe).
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name   = 'llm_routing_decisions'
      AND column_name  = 'correlation_id'
      AND data_type    = 'text'
  ) THEN
    ALTER TABLE llm_routing_decisions
      ALTER COLUMN correlation_id TYPE uuid USING correlation_id::uuid;
  END IF;
END $$;
