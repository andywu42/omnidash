-- Migration: Purge orphaned a-suffix records from schema_migrations (OMN-8606)
--
-- Migration 0059 renamed schema_migrations records from bare numeric prefixes to
-- a-suffix form (0005_ -> 0005a_, etc.). This branch reverses those renames at
-- the file level. The old a-suffix rows remain orphaned in schema_migrations
-- while the non-suffixed files have been re-run as new migrations.
--
-- This migration deletes those 9 orphaned rows to restore parity.
-- Idempotent: DELETE WHERE only removes rows that still exist.

DELETE FROM schema_migrations WHERE filename IN (
  '0005a_baselines_trend_unique.sql',
  '0006a_baselines_breakdown_unique.sql',
  '0011a_llm_routing_decisions_correlation_id_uuid.sql',
  '0020a_correlation_trace_spans.sql',
  '0034a_add_routing_shadow_decisions.sql',
  '0038a_pattern_learning_unique_pattern_id.sql',
  '0048a_contract_drift_events.sql',
  '0049a_eval_reports.sql',
  '0056a_session_post_mortems.sql'
);
