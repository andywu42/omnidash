/**
 * Cross-cutting / platform projection handlers (OMN-5192).
 *
 * Projects events from platform-level or multi-service topics:
 * - Intent stored (omnimemory) -> intent_signals
 * - PR validation rollup -> model_efficiency_rollups
 */

import { sql } from 'drizzle-orm';
import { modelEfficiencyRollups, dlqMessages } from '@shared/intelligence-schema';
import {
  SUFFIX_MEMORY_INTENT_STORED,
  SUFFIX_OMNICLAUDE_PR_VALIDATION_ROLLUP,
  SUFFIX_PLATFORM_DLQ_MESSAGE,
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

const PLATFORM_TOPICS = new Set([
  SUFFIX_MEMORY_INTENT_STORED,
  SUFFIX_OMNICLAUDE_PR_VALIDATION_ROLLUP,
  SUFFIX_PLATFORM_DLQ_MESSAGE,
]);

export class PlatformProjectionHandler implements ProjectionHandler {
  readonly stats: ProjectionHandlerStats = createHandlerStats();

  constructor() {
    registerHandlerStats('PlatformProjectionHandler', this.stats);
  }

  canHandle(topic: string): boolean {
    return PLATFORM_TOPICS.has(topic);
  }

  async projectEvent(
    topic: string,
    data: Record<string, unknown>,
    context: ProjectionContext,
    meta: MessageMeta
  ): Promise<boolean> {
    this.stats.received++;
    const result = await this._dispatch(topic, data, context, meta);
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
    context: ProjectionContext,
    meta: MessageMeta
  ): Promise<boolean> {
    const { fallbackId } = meta;

    switch (topic) {
      case SUFFIX_MEMORY_INTENT_STORED:
        return this.projectIntentStoredEvent(data, fallbackId, context);
      case SUFFIX_OMNICLAUDE_PR_VALIDATION_ROLLUP:
        return this.projectPrValidationRollup(data, context);
      case SUFFIX_PLATFORM_DLQ_MESSAGE:
        return this.projectDlqMessage(data, context);
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Intent stored -> intent_signals (OMN-2889)
  // -------------------------------------------------------------------------

  private async projectIntentStoredEvent(
    data: Record<string, unknown>,
    fallbackId: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const correlationId =
      (data.correlation_id as string) || (data.correlationId as string) || fallbackId;

    try {
      await db.execute(sql`
        INSERT INTO intent_signals (
          correlation_id, event_id, intent_type, topic,
          raw_payload, created_at
        ) VALUES (
          ${correlationId},
          ${(data.event_id as string) ?? (data.eventId as string) ?? correlationId},
          ${(data.intent_type as string) ?? (data.intentType as string) ?? 'unknown'},
          ${'onex.evt.omnimemory.intent-stored.v1'},
          ${JSON.stringify(data)},
          ${safeParseDate(data.timestamp ?? data.created_at)}
        )
        ON CONFLICT (correlation_id) DO NOTHING
      `);
    } catch (err) {
      if (isTableMissingError(err, 'intent_signals')) {
        console.warn(
          '[ReadModelConsumer] intent_signals table not yet created -- ' +
            'run migrations to enable intent signal projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // PR validation rollup -> model_efficiency_rollups (OMN-3933)
  // -------------------------------------------------------------------------

  private async projectPrValidationRollup(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const runId = (data.run_id as string) || (data.runId as string);
    if (!runId) {
      console.warn('[ReadModelConsumer] pr-validation-rollup missing run_id -- skipping');
      return true;
    }

    const ext = (data.extensions ?? data.ext ?? {}) as Record<string, unknown>;
    const missingFields = ext.missing_fields ?? data.missing_fields ?? [];

    try {
      await db
        .insert(modelEfficiencyRollups)
        .values({
          runId,
          repoId: (data.repo_id as string) || (data.repoId as string) || 'unknown',
          prId: (data.pr_id as string) || (data.prId as string) || '',
          prUrl: (data.pr_url as string) || (data.prUrl as string) || '',
          ticketId: (data.ticket_id as string) || (data.ticketId as string) || '',
          modelId: (data.model_id as string) || (data.modelId as string) || 'unknown',
          producerKind:
            (data.producer_kind as string) || (data.producerKind as string) || 'unknown',
          rollupStatus: (data.rollup_status as string) || (data.rollupStatus as string) || 'final',
          metricVersion: (data.metric_version as string) || (data.metricVersion as string) || 'v1',
          filesChanged: typeof data.files_changed === 'number' ? data.files_changed : 0,
          linesChanged: typeof data.lines_changed === 'number' ? data.lines_changed : 0,
          moduleTags: Array.isArray(data.module_tags) ? data.module_tags : [],
          blockingFailures: typeof data.blocking_failures === 'number' ? data.blocking_failures : 0,
          warnFindings: typeof data.warn_findings === 'number' ? data.warn_findings : 0,
          reruns: typeof data.reruns === 'number' ? data.reruns : 0,
          validatorRuntimeMs:
            typeof data.validator_runtime_ms === 'number' ? data.validator_runtime_ms : 0,
          humanEscalations: typeof data.human_escalations === 'number' ? data.human_escalations : 0,
          autofixSuccesses: typeof data.autofix_successes === 'number' ? data.autofix_successes : 0,
          timeToGreenMs: typeof data.time_to_green_ms === 'number' ? data.time_to_green_ms : 0,
          vts: typeof data.vts === 'number' ? data.vts : 0,
          vtsPerKloc: typeof data.vts_per_kloc === 'number' ? data.vts_per_kloc : 0,
          phaseCount: typeof data.phase_count === 'number' ? data.phase_count : 0,
          missingFields: Array.isArray(missingFields) ? missingFields : [],
          emittedAt: safeParseDate(data.emitted_at ?? data.emittedAt ?? data.timestamp),
        })
        .onConflictDoNothing();

      return true;
    } catch (err) {
      if (isTableMissingError(err, 'model_efficiency_rollups')) {
        console.warn(
          '[ReadModelConsumer] model_efficiency_rollups table not yet created -- ' +
            'run migrations to enable MEI projection'
        );
        return true;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // DLQ message -> dlq_messages (OMN-5287)
  // -------------------------------------------------------------------------

  private async projectDlqMessage(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const originalTopic =
      (data.original_topic as string) || (data.originalTopic as string) || 'unknown';
    const errorMessage =
      (data.error_message as string) || (data.errorMessage as string) || 'unknown';
    const errorType = (data.error_type as string) || (data.errorType as string) || 'unknown';
    const consumerGroup =
      (data.consumer_group as string) || (data.consumerGroup as string) || 'unknown';

    try {
      await db.insert(dlqMessages).values({
        originalTopic,
        errorMessage,
        errorType,
        retryCount:
          typeof data.retry_count === 'number'
            ? data.retry_count
            : typeof data.retryCount === 'number'
              ? data.retryCount
              : 0,
        consumerGroup,
        messageKey: (data.message_key as string) || (data.messageKey as string) || null,
        rawPayload: typeof data === 'object' ? data : null,
        createdAt: safeParseDate(data.timestamp ?? data.created_at) ?? new Date(),
      });
      return true;
    } catch (err) {
      if (isTableMissingError(err, 'dlq_messages')) {
        console.warn(
          '[ReadModelConsumer] dlq_messages table not yet created -- ' +
            'run migrations to enable DLQ projection'
        );
        return true;
      }
      throw err;
    }
  }
}
