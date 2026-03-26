-- OMN-6718: Purge noise patterns from omnidash_analytics
--
-- Removes two categories of noise rows that pollute dashboard queries:
--
-- 1. ~6,643 file_access co-access pattern rows in pattern_learning_artifacts.
--    These are auto-generated file_access_pattern::co_access pairs with very
--    long pattern names that provide no actionable signal.
--
-- 2. ~1,257 stale "Requested" lifecycle_state rows in pattern_learning_artifacts.
--    These never advanced past the initial state and represent abandoned pipeline
--    artifacts.
--
-- Both DELETEs are idempotent — safe to re-run.

-- 1. Purge file_access co-access noise rows
DELETE FROM pattern_learning_artifacts
WHERE pattern_name LIKE 'file_access_pattern::co_access:%';

-- 2. Purge stale "Requested" rows that never advanced
DELETE FROM pattern_learning_artifacts
WHERE LOWER(lifecycle_state) = 'requested';
