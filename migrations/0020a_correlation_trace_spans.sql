-- Migration: 0020_correlation_trace_spans
-- Purpose: Create correlation_trace_spans table for durable trace span projection (OMN-5047)
--
-- Background: omniclaude emits correlation-trace span events (PR #638) on the
-- topic onex.evt.omniclaude.correlation-trace.v1. Each span describes a hop in
-- the agent execution flow (routing, tool-call, manifest-injection, etc.).
-- The ReadModelConsumer projects these into this table so the /trace page can
-- render real session-aware trace timelines.

CREATE TABLE IF NOT EXISTS correlation_trace_spans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id        text NOT NULL,
  span_id         text NOT NULL,
  parent_span_id  text,
  correlation_id  uuid NOT NULL,
  session_id      text,
  span_kind       text NOT NULL,
  span_name       text NOT NULL,
  status          text NOT NULL DEFAULT 'ok',
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  duration_ms     integer,
  metadata        jsonb DEFAULT '{}'::jsonb,
  projected_at    timestamptz NOT NULL DEFAULT now(),

  -- Idempotency: a span_id is globally unique within a trace
  CONSTRAINT uq_trace_span UNIQUE (trace_id, span_id)
);

-- Index: look up all spans for a given trace
CREATE INDEX idx_cts_trace_id ON correlation_trace_spans (trace_id);

-- Index: look up spans by correlation_id (join with routing_decisions)
CREATE INDEX idx_cts_correlation_id ON correlation_trace_spans (correlation_id);

-- Index: look up spans by session_id for the /trace page session filter
CREATE INDEX idx_cts_session_id ON correlation_trace_spans (session_id);

-- Index: time-range queries (recent traces listing)
CREATE INDEX idx_cts_started_at ON correlation_trace_spans (started_at DESC);
