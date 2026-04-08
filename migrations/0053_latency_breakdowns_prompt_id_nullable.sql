-- Make prompt_id nullable on latency_breakdowns.
-- The Python emitter (extraction_event_emitter.py) emits correlation_id but has
-- no prompt_id concept. The consumer must accept events that lack prompt_id.
-- See: OMN-7919

ALTER TABLE "latency_breakdowns" ALTER COLUMN "prompt_id" DROP NOT NULL;

-- Drop unique index that included prompt_id — NULL values make it non-enforceable
-- and duplicate NULLs would cause constraint violations for all events without prompt_id.
DROP INDEX IF EXISTS "uq_lb_session_prompt_cohort";
