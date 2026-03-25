/**
 * OmniMemory domain projection handlers (OMN-5290).
 *
 * Projects events from omnimemory topics into the omnidash_analytics read-model:
 * - document-discovered.v1 -> memory_documents (upsert on document_id)
 * - memory-stored.v1       -> memory_documents (upsert status -> stored)
 * - memory-retrieval-response.v1 -> memory_retrievals (append-only)
 * - memory-expired.v1      -> memory_documents (upsert status -> expired)
 */

import { sql } from 'drizzle-orm';
import { memoryDocuments, memoryRetrievals } from '@shared/intelligence-schema';
import type { InsertMemoryDocument, InsertMemoryRetrieval } from '@shared/intelligence-schema';
import {
  SUFFIX_MEMORY_DOCUMENT_DISCOVERED,
  SUFFIX_MEMORY_STORED,
  SUFFIX_MEMORY_RETRIEVAL_RESPONSE,
  SUFFIX_MEMORY_EXPIRED,
  SUFFIX_MEMORY_INTENT_STORED,
} from '@shared/topics';

import type {
  ProjectionHandler,
  ProjectionContext,
  MessageMeta,
  ProjectionHandlerStats,
} from './types';
import {
  safeParseDate,
  isTableMissingError,
  createHandlerStats,
  registerHandlerStats,
} from './types';

const OMNIMEMORY_TOPICS = new Set([
  SUFFIX_MEMORY_DOCUMENT_DISCOVERED,
  SUFFIX_MEMORY_STORED,
  SUFFIX_MEMORY_RETRIEVAL_RESPONSE,
  SUFFIX_MEMORY_EXPIRED,
  SUFFIX_MEMORY_INTENT_STORED,
]);

export class OmniMemoryProjectionHandler implements ProjectionHandler {
  readonly stats: ProjectionHandlerStats = createHandlerStats();

  constructor() {
    registerHandlerStats('OmniMemoryProjectionHandler', this.stats);
  }

  canHandle(topic: string): boolean {
    return OMNIMEMORY_TOPICS.has(topic);
  }

  async projectEvent(
    topic: string,
    data: Record<string, unknown>,
    context: ProjectionContext,
    _meta: MessageMeta
  ): Promise<boolean> {
    this.stats.received++;
    const result = await this._dispatch(topic, data, context);
    if (result) {
      this.stats.projected++;
    } else {
      this.stats.dropped.db_unavailable++;
    }
    return result;
  }

  private async _dispatch(
    topic: string,
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    switch (topic) {
      case SUFFIX_MEMORY_DOCUMENT_DISCOVERED:
        return this.projectDocumentDiscovered(data, context);
      case SUFFIX_MEMORY_STORED:
        return this.projectMemoryStored(data, context);
      case SUFFIX_MEMORY_RETRIEVAL_RESPONSE:
        return this.projectRetrievalResponse(data, context);
      case SUFFIX_MEMORY_EXPIRED:
        return this.projectMemoryExpired(data, context);
      case SUFFIX_MEMORY_INTENT_STORED:
        // intent-stored events carry session-level intent metadata.
        // No dedicated read-model table yet — acknowledge to advance watermark.
        return true;
      default:
        return true;
    }
  }

  // -------------------------------------------------------------------------
  // document-discovered -> memory_documents (OMN-5290)
  // -------------------------------------------------------------------------

  private async projectDocumentDiscovered(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const documentId =
      (data.document_id as string | null) ?? (data.documentId as string | null) ?? null;
    if (!documentId) {
      console.warn('[ReadModelConsumer] document-discovered event missing document_id -- skipping');
      return true;
    }

    const row: InsertMemoryDocument = {
      documentId,
      sourcePath: (data.source_path as string | null) ?? (data.sourcePath as string | null) ?? null,
      sourceType: (data.source_type as string | null) ?? (data.sourceType as string | null) ?? null,
      contentHash:
        (data.content_hash as string | null) ?? (data.contentHash as string | null) ?? null,
      sizeBytes:
        data.size_bytes != null
          ? Number(data.size_bytes)
          : data.sizeBytes != null
            ? Number(data.sizeBytes)
            : null,
      status: 'discovered',
      memoryBackend:
        (data.memory_backend as string | null) ?? (data.memoryBackend as string | null) ?? null,
      correlationId:
        (data.correlation_id as string | null) ?? (data.correlationId as string | null) ?? null,
      sessionId: (data.session_id as string | null) ?? (data.sessionId as string | null) ?? null,
      eventTimestamp: safeParseDate(
        data.event_timestamp ?? data.eventTimestamp ?? data.timestamp ?? data.created_at
      ),
    };

    try {
      await db
        .insert(memoryDocuments)
        .values(row)
        .onConflictDoUpdate({
          target: memoryDocuments.documentId,
          set: {
            sourcePath: sql`EXCLUDED.source_path`,
            sourceType: sql`EXCLUDED.source_type`,
            contentHash: sql`EXCLUDED.content_hash`,
            sizeBytes: sql`EXCLUDED.size_bytes`,
            status: sql`EXCLUDED.status`,
            memoryBackend: sql`EXCLUDED.memory_backend`,
            eventTimestamp: sql`EXCLUDED.event_timestamp`,
          },
        });
      return true;
    } catch (err) {
      if (isTableMissingError(err, 'memory_documents')) {
        console.warn(
          '[ReadModelConsumer] memory_documents table not yet created -- ' +
            'run migrations to enable OmniMemory projection'
        );
        return true;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // memory-stored -> memory_documents (upsert status -> stored)
  // -------------------------------------------------------------------------

  private async projectMemoryStored(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const documentId =
      (data.document_id as string | null) ?? (data.documentId as string | null) ?? null;
    if (!documentId) {
      console.warn('[ReadModelConsumer] memory-stored event missing document_id -- skipping');
      return true;
    }

    const row: InsertMemoryDocument = {
      documentId,
      sourcePath: (data.source_path as string | null) ?? (data.sourcePath as string | null) ?? null,
      sourceType: (data.source_type as string | null) ?? (data.sourceType as string | null) ?? null,
      contentHash:
        (data.content_hash as string | null) ?? (data.contentHash as string | null) ?? null,
      sizeBytes:
        data.size_bytes != null
          ? Number(data.size_bytes)
          : data.sizeBytes != null
            ? Number(data.sizeBytes)
            : null,
      status: 'stored',
      memoryBackend:
        (data.memory_backend as string | null) ?? (data.memoryBackend as string | null) ?? null,
      correlationId:
        (data.correlation_id as string | null) ?? (data.correlationId as string | null) ?? null,
      sessionId: (data.session_id as string | null) ?? (data.sessionId as string | null) ?? null,
      eventTimestamp: safeParseDate(
        data.event_timestamp ?? data.eventTimestamp ?? data.timestamp ?? data.created_at
      ),
    };

    try {
      await db
        .insert(memoryDocuments)
        .values(row)
        .onConflictDoUpdate({
          target: memoryDocuments.documentId,
          set: {
            status: sql`'stored'`,
            contentHash: sql`EXCLUDED.content_hash`,
            sizeBytes: sql`EXCLUDED.size_bytes`,
            memoryBackend: sql`EXCLUDED.memory_backend`,
            eventTimestamp: sql`EXCLUDED.event_timestamp`,
          },
        });
      return true;
    } catch (err) {
      if (isTableMissingError(err, 'memory_documents')) {
        console.warn(
          '[ReadModelConsumer] memory_documents table not yet created -- ' +
            'run migrations to enable OmniMemory projection'
        );
        return true;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // memory-retrieval-response -> memory_retrievals (append-only)
  // -------------------------------------------------------------------------

  private async projectRetrievalResponse(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const resultCount =
      data.result_count != null
        ? Number(data.result_count)
        : data.resultCount != null
          ? Number(data.resultCount)
          : data.total_count != null
            ? Number(data.total_count)
            : 0;

    const success =
      data.status === 'success' ||
      data.success === true ||
      (data.status == null && data.success == null && resultCount >= 0);

    const row: InsertMemoryRetrieval = {
      correlationId:
        (data.correlation_id as string | null) ?? (data.correlationId as string | null) ?? null,
      sessionId: (data.session_id as string | null) ?? (data.sessionId as string | null) ?? null,
      queryType: (data.query_type as string | null) ?? (data.queryType as string | null) ?? null,
      resultCount,
      success,
      latencyMs:
        data.latency_ms != null
          ? Number(data.latency_ms)
          : data.latencyMs != null
            ? Number(data.latencyMs)
            : null,
      errorMessage:
        (data.error_message as string | null) ?? (data.errorMessage as string | null) ?? null,
      eventTimestamp: safeParseDate(
        data.event_timestamp ?? data.eventTimestamp ?? data.timestamp ?? data.created_at
      ),
    };

    try {
      await db.insert(memoryRetrievals).values(row);
      return true;
    } catch (err) {
      if (isTableMissingError(err, 'memory_retrievals')) {
        console.warn(
          '[ReadModelConsumer] memory_retrievals table not yet created -- ' +
            'run migrations to enable OmniMemory projection'
        );
        return true;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // memory-expired -> memory_documents (upsert status -> expired)
  // -------------------------------------------------------------------------

  private async projectMemoryExpired(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const documentId =
      (data.document_id as string | null) ?? (data.documentId as string | null) ?? null;
    if (!documentId) {
      console.warn('[ReadModelConsumer] memory-expired event missing document_id -- skipping');
      return true;
    }

    const row: InsertMemoryDocument = {
      documentId,
      status: 'expired',
      eventTimestamp: safeParseDate(
        data.event_timestamp ?? data.eventTimestamp ?? data.timestamp ?? data.created_at
      ),
    };

    try {
      await db
        .insert(memoryDocuments)
        .values(row)
        .onConflictDoUpdate({
          target: memoryDocuments.documentId,
          set: {
            status: sql`'expired'`,
            eventTimestamp: sql`EXCLUDED.event_timestamp`,
          },
        });
      return true;
    } catch (err) {
      if (isTableMissingError(err, 'memory_documents')) {
        console.warn(
          '[ReadModelConsumer] memory_documents table not yet created -- ' +
            'run migrations to enable OmniMemory projection'
        );
        return true;
      }
      throw err;
    }
  }
}
