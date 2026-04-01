-- GitHub webhook delivery deduplication table [OMN-6722]
-- Tracks processed webhook delivery IDs for idempotency.

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
    delivery_id UUID PRIMARY KEY,
    event_type TEXT NOT NULL,
    repo TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

-- Index for cleanup of old entries (keep 7 days)
CREATE INDEX idx_github_webhook_deliveries_received_at
    ON github_webhook_deliveries (received_at);
