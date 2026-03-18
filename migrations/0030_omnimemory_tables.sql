-- 0024_omnimemory_tables.sql
-- OMN-5290: OmniMemory document ingestion and retrieval read-model tables.
-- Source topics:
--   onex.evt.omnimemory.document-discovered.v1
--   onex.evt.omnimemory.memory-stored.v1
--   onex.evt.omnimemory.memory-retrieval-response.v1
--   onex.evt.omnimemory.memory-expired.v1

-- Memory documents: one row per document (upsert on document_id).
CREATE TABLE IF NOT EXISTS memory_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id TEXT NOT NULL UNIQUE,
    source_path TEXT,
    source_type TEXT,
    content_hash TEXT,
    size_bytes INTEGER,
    status TEXT NOT NULL DEFAULT 'discovered',
    memory_backend TEXT,
    correlation_id TEXT,
    session_id TEXT,
    event_timestamp TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_documents_event_timestamp ON memory_documents (event_timestamp);
CREATE INDEX IF NOT EXISTS idx_memory_documents_status ON memory_documents (status);
CREATE INDEX IF NOT EXISTS idx_memory_documents_source_type ON memory_documents (source_type);

-- Memory retrievals: append-only, no natural dedup key.
CREATE TABLE IF NOT EXISTS memory_retrievals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id TEXT,
    session_id TEXT,
    query_type TEXT,
    result_count INTEGER NOT NULL DEFAULT 0,
    success BOOLEAN NOT NULL DEFAULT true,
    latency_ms INTEGER,
    error_message TEXT,
    event_timestamp TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_retrievals_event_timestamp ON memory_retrievals (event_timestamp);
CREATE INDEX IF NOT EXISTS idx_memory_retrievals_success ON memory_retrievals (success);
CREATE INDEX IF NOT EXISTS idx_memory_retrievals_session_id ON memory_retrievals (session_id);
