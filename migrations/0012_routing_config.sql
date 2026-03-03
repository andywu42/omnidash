-- Migration: routing_config table (OMN-3445)
--
-- Generic key-value store for routing configuration.
-- Handles model switcher (active_routing_model) and
-- prompt version tracking (routing_prompt_version).

CREATE TABLE IF NOT EXISTS routing_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO routing_config (key, value) VALUES
  ('active_routing_model',   'Qwen/Qwen3-14B-AWQ'),
  ('routing_prompt_version', '1.0.0')
ON CONFLICT (key) DO NOTHING;
