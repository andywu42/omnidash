-- Migration: Rename duplicate-prefix migration filenames in schema_migrations (OMN-8623)
--
-- Migrations 0034 (4 files), 0038 (2 files), 0048 (2 files), 0049 (2 files),
-- and 0056 (2 files) each had multiple files sharing the same numeric prefix.
-- This migration updates the schema_migrations tracking table to match the
-- new filenames after adding a/b/c/d suffixes.
--
-- Idempotent: uses WHERE clause to only update rows that still have old names.

-- Fix 0034 collision (split to 0034a/0034b/0034c/0034d)
UPDATE schema_migrations SET filename = '0034a_add_routing_shadow_decisions.sql'
  WHERE filename = '0034_add_routing_shadow_decisions.sql';

UPDATE schema_migrations SET filename = '0034b_create_rl_episodes.sql'
  WHERE filename = '0034_create_rl_episodes.sql';

UPDATE schema_migrations SET filename = '0034c_savings_estimates.sql'
  WHERE filename = '0034_savings_estimates.sql';

UPDATE schema_migrations SET filename = '0034d_skill_invocations_status_dedup.sql'
  WHERE filename = '0034_skill_invocations_status_dedup.sql';

-- Fix 0038 collision (split to 0038a/0038b)
UPDATE schema_migrations SET filename = '0038a_pattern_learning_unique_pattern_id.sql'
  WHERE filename = '0038_pattern_learning_unique_pattern_id.sql';

UPDATE schema_migrations SET filename = '0038b_widen_pattern_name.sql'
  WHERE filename = '0038_widen_pattern_name.sql';

-- Fix 0048 collision (split to 0048a/0048b)
UPDATE schema_migrations SET filename = '0048a_contract_drift_events.sql'
  WHERE filename = '0048_contract_drift_events.sql';

UPDATE schema_migrations SET filename = '0048b_review_calibration_runs.sql'
  WHERE filename = '0048_review_calibration_runs.sql';

-- Fix 0049 collision (split to 0049a/0049b)
UPDATE schema_migrations SET filename = '0049a_eval_reports.sql'
  WHERE filename = '0049_eval_reports.sql';

UPDATE schema_migrations SET filename = '0049b_github_webhook_deliveries.sql'
  WHERE filename = '0049_github_webhook_deliveries.sql';

-- Fix 0056 collision (split to 0056a/0056b)
UPDATE schema_migrations SET filename = '0056a_session_post_mortems.sql'
  WHERE filename = '0056_session_post_mortems.sql';

UPDATE schema_migrations SET filename = '0056b_sweep_results.sql'
  WHERE filename = '0056_sweep_results.sql';
