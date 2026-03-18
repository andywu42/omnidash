-- Migration: Rename duplicate-prefix migration filenames in schema_migrations (OMN-5325)
--
-- Migrations 0020 had two files sharing the same prefix, and 0024 had nine.
-- This migration updates the schema_migrations tracking table to match the
-- new filenames after renumbering.
--
-- Idempotent: uses WHERE clause to only update rows that still have old names.

-- Fix 0020 collision (split to 0020a/0020b)
UPDATE schema_migrations SET filename = '0020a_correlation_trace_spans.sql'
  WHERE filename = '0020_correlation_trace_spans.sql';

UPDATE schema_migrations SET filename = '0020b_objective_evaluation_tables.sql'
  WHERE filename = '0020_objective_evaluation_tables.sql';

-- Fix 0024 collision (renumber to 0024-0032)
-- 0024_ci_debug_events.sql stays as 0024 (no rename needed)

UPDATE schema_migrations SET filename = '0025_circuit_breaker_events.sql'
  WHERE filename = '0024_circuit_breaker_events.sql';

UPDATE schema_migrations SET filename = '0026_compliance_evaluations.sql'
  WHERE filename = '0024_compliance_evaluations.sql';

UPDATE schema_migrations SET filename = '0027_dlq_messages.sql'
  WHERE filename = '0024_dlq_messages.sql';

UPDATE schema_migrations SET filename = '0028_intent_drift_events.sql'
  WHERE filename = '0024_intent_drift_events.sql';

UPDATE schema_migrations SET filename = '0029_llm_health_snapshots.sql'
  WHERE filename = '0024_llm_health_snapshots.sql';

UPDATE schema_migrations SET filename = '0030_omnimemory_tables.sql'
  WHERE filename = '0024_omnimemory_tables.sql';

UPDATE schema_migrations SET filename = '0031_routing_feedback_events.sql'
  WHERE filename = '0024_routing_feedback_events.sql';

UPDATE schema_migrations SET filename = '0032_skill_invocations.sql'
  WHERE filename = '0024_skill_invocations.sql';
