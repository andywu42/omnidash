-- 0054: Add selected_tier to infra_routing_decisions (OMN-8026)
-- Enriches routing decision events with delegation tier visibility.
-- Values: 'local' (on-prem models), 'cheap_cloud' (GLM/OpenRouter), 'claude'

ALTER TABLE infra_routing_decisions
    ADD COLUMN IF NOT EXISTS selected_tier TEXT NOT NULL DEFAULT 'claude';

CREATE INDEX IF NOT EXISTS idx_infra_routing_tier ON infra_routing_decisions(selected_tier);
