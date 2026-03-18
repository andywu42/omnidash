-- 0024_dlq_messages.sql
-- OMN-5287: DLQ Monitor Dashboard read-model projection table.
-- Source topic: onex.evt.platform.dlq-message.v1

CREATE TABLE IF NOT EXISTS dlq_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_topic TEXT NOT NULL,
    error_message TEXT NOT NULL,
    error_type TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    consumer_group TEXT NOT NULL,
    message_key TEXT,
    raw_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dlq_messages_original_topic ON dlq_messages (original_topic);
CREATE INDEX IF NOT EXISTS idx_dlq_messages_error_type ON dlq_messages (error_type);
CREATE INDEX IF NOT EXISTS idx_dlq_messages_consumer_group ON dlq_messages (consumer_group);
CREATE INDEX IF NOT EXISTS idx_dlq_messages_created_at ON dlq_messages (created_at);
