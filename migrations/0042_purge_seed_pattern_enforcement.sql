-- OMN-6394: Purge fake seed data from pattern_enforcement_events
--
-- Removes 662 demo/seed rows with dates from 2024/2025 that were
-- inserted by scripts/seed-demo-patterns.ts. These rows pollute the
-- dashboard with unrealistic historical data.
--
-- This migration is idempotent: DELETE WHERE is safe to run multiple times.

DELETE FROM pattern_enforcement_events
WHERE created_at < '2026-01-01'::timestamp;
