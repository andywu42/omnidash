-- ============================================================================
-- OMN-2328 / OMN-2331: Add UNIQUE(snapshot_id, action) to baselines_breakdown
--
-- The ReadModelConsumer deduplicates breakdown rows by action in-memory before
-- inserting, but without a DB-level constraint a future code path or direct
-- insert could produce duplicate (snapshot_id, action) pairs, silently
-- double-counting promote_count/shadow_count/etc. in
-- BaselinesProjection._deriveSummary().
-- ============================================================================

-- CREATE UNIQUE INDEX ... IF NOT EXISTS is used for consistency with 0005 and
-- works on all PostgreSQL versions.
CREATE UNIQUE INDEX IF NOT EXISTS baselines_breakdown_snapshot_action_unique
  ON baselines_breakdown (snapshot_id, action);
