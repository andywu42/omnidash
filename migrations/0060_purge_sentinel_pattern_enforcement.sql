-- OMN-7996: Purge 27 rows with sentinel timestamp 2025-01-01 from pattern_enforcement_events.
--
-- These rows were projected with a stale payload timestamp (2025-01-01T00:00:00Z) from
-- early enforcement events where emitted_at was not preferred over the payload timestamp.
-- The projection handler now prefers data.emitted_at over evt.timestamp.
--
-- Rows with created_at = 2025-01-01 are sentinel placeholders, not real enforcement data.
-- They cause the database sweep to classify the table as STALE and suppress dashboard activity.
--
-- Idempotent: safe to run multiple times.

DELETE FROM pattern_enforcement_events
WHERE created_at = '2025-01-01 00:00:00'::timestamp;
