-- Migration: Make fuzzy_agent nullable in llm_routing_decisions (OMN-2920)
--
-- The omniclaude producer (ModelLlmRoutingDecisionPayload) emits
-- fuzzy_top_candidate=null whenever fallback_used=true and no fuzzy
-- candidate was ranked. The original schema declared fuzzy_agent NOT NULL,
-- which caused all projected events to be silently dropped by the
-- projector's early-exit guard rather than inserted with a NULL fuzzy_agent.
--
-- Making fuzzy_agent nullable aligns the schema with the actual event payload
-- and allows projector rows to be written for the common fallback_used=true case.
--
-- The downstream LlmRoutingProjection and API routes treat NULL fuzzy_agent
-- as "no fuzzy candidate available" which is semantically correct.

ALTER TABLE llm_routing_decisions ALTER COLUMN fuzzy_agent DROP NOT NULL;
