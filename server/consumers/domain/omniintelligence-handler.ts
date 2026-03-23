/**
 * OmniIntelligence domain handler [OMN-5191]
 *
 * Handles topics with the omniintelligence prefix:
 * - Intent classified events
 * - Intelligence pipeline commands and completions
 * - Pattern lifecycle events
 * - Session outcome commands
 * - Validation events (cross-repo)
 */

import crypto from 'node:crypto';
import type { KafkaMessage } from 'kafkajs';
import {
  INTENT_CLASSIFIED_TOPIC,
  EVENT_TYPE_NAMES,
  isIntentClassifiedEvent,
  type IntentRecordPayload,
} from '@shared/intent-types';
import { getIntentEventEmitter } from '../../intent-events';
import {
  SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_CMD,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_COMPLETED,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED,
  SUFFIX_INTELLIGENCE_PATTERN_PROMOTED,
  SUFFIX_INTELLIGENCE_PATTERN_STORED,
  SUFFIX_PATTERN_DISCOVERED,
  SUFFIX_INTELLIGENCE_SESSION_OUTCOME_CMD,
  SUFFIX_INTELLIGENCE_CI_DEBUG_ESCALATION,
  SUFFIX_VALIDATION_RUN_STARTED,
  SUFFIX_VALIDATION_VIOLATIONS_BATCH,
  SUFFIX_VALIDATION_RUN_COMPLETED,
  SUFFIX_VALIDATION_CANDIDATE_UPSERTED,
} from '@shared/topics';
import {
  isValidationRunStarted,
  isValidationViolationsBatch,
  isValidationRunCompleted,
  isValidationCandidateUpserted,
} from '@shared/validation-types';
import {
  handleValidationRunStarted,
  handleValidationViolationsBatch,
  handleValidationRunCompleted,
  handleValidationCandidateUpserted,
} from '../../validation-routes';
import type {
  DomainHandler,
  ConsumerContext,
  InternalIntentClassifiedEvent,
  RawIntentClassifiedEvent,
} from './types';
import { intentLogger, sanitizeTimestamp } from './consumer-utils';

/** All topic suffixes this handler responds to */
const HANDLED_TOPICS = new Set([
  SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_CMD,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED,
  SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_LEARNING_COMPLETED,
  SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITION_CMD,
  SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED,
  SUFFIX_INTELLIGENCE_PATTERN_PROMOTED,
  SUFFIX_INTELLIGENCE_PATTERN_STORED,
  SUFFIX_PATTERN_DISCOVERED,
  SUFFIX_INTELLIGENCE_SESSION_OUTCOME_CMD,
  SUFFIX_INTELLIGENCE_CI_DEBUG_ESCALATION,
  SUFFIX_VALIDATION_RUN_STARTED,
  SUFFIX_VALIDATION_VIOLATIONS_BATCH,
  SUFFIX_VALIDATION_RUN_COMPLETED,
  SUFFIX_VALIDATION_CANDIDATE_UPSERTED,
]);

// ============================================================================
// Handler Functions
// ============================================================================

function handleIntentClassified(event: RawIntentClassifiedEvent, ctx: ConsumerContext): void {
  try {
    if (event.event_type && event.event_type !== EVENT_TYPE_NAMES.INTENT_CLASSIFIED) {
      intentLogger.warn(
        `Unexpected event_type: expected "${EVENT_TYPE_NAMES.INTENT_CLASSIFIED}", got "${event.event_type}". Processing anyway for backward compatibility.`
      );
    }

    const intentType =
      event.intent_category ||
      event.intentCategory ||
      event.intent_type ||
      event.intentType ||
      'unknown';

    const createdAt = sanitizeTimestamp(
      event.timestamp || event.created_at || event.createdAt,
      new Date()
    );

    const intentEvent: InternalIntentClassifiedEvent = {
      id: event.id || crypto.randomUUID(),
      correlationId: event.correlation_id || event.correlationId || '',
      sessionId: event.session_id || event.sessionId || '',
      intentType,
      confidence: event.confidence ?? 0,
      keywords: Array.isArray(event.keywords) ? event.keywords : [],
      rawText: event.raw_text || event.rawText || '',
      extractedEntities: event.extracted_entities || event.extractedEntities,
      metadata: event.metadata,
      createdAt,
    };

    ctx.recentIntents.unshift(intentEvent);
    if (ctx.recentIntents.length > ctx.maxIntents) {
      ctx.recentIntents = ctx.recentIntents.slice(0, ctx.maxIntents);
    }

    const existing = ctx.intentDistributionWithTimestamps.get(intentType);
    const eventTimestamp = createdAt.getTime();
    if (existing) {
      existing.count++;
      existing.timestamps.push(eventTimestamp);
      if (existing.timestamps.length > ctx.MAX_TIMESTAMPS_PER_CATEGORY) {
        existing.timestamps = existing.timestamps.slice(-ctx.MAX_TIMESTAMPS_PER_CATEGORY);
      }
    } else {
      ctx.intentDistributionWithTimestamps.set(intentType, {
        count: 1,
        timestamps: [eventTimestamp],
      });
    }

    // ── REGRESSION WARNING ────────────────────────────────────────────────
    // 'intent-event' carries intentEvent verbatim — camelCase fields only:
    //   intentType, sessionId, createdAt, correlationId, confidence, ...
    //
    // projection-instance.ts forwards this payload directly to ProjectionService,
    // so the stored ProjectionEvent.payload has camelCase keys.
    // IntentDashboard reads them with dual-casing fallbacks:
    //   intent_category ?? intentType,  session_ref ?? sessionId, etc.
    //
    // 'intentUpdate' (below) is the WebSocket path — it manually adds
    // snake_case aliases (intent_category, session_ref, created_at) so
    // RecentIntents' WebSocket handler can read them directly.
    //
    // If you rename fields on InternalIntentClassifiedEvent, update BOTH
    // the fallback chains in IntentDashboard.tsx AND the aliases on intentUpdate.
    // ─────────────────────────────────────────────────────────────────────
    ctx.emit('intent-event', {
      topic: INTENT_CLASSIFIED_TOPIC,
      payload: intentEvent,
      timestamp: new Date().toISOString(),
    });

    ctx.emit('intentUpdate', {
      ...intentEvent,
      session_ref: intentEvent.sessionId || '',
      intent_category: intentType,
      created_at: createdAt.toISOString(),
      topic: INTENT_CLASSIFIED_TOPIC,
      type: 'intent-classified',
      actionType: 'intent-classified',
      timestamp: new Date().toISOString(),
    });

    if (isIntentClassifiedEvent(event)) {
      const intentRecordPayload: IntentRecordPayload = {
        intent_id: intentEvent.id,
        session_ref: intentEvent.sessionId || '',
        intent_category: intentType,
        confidence: intentEvent.confidence,
        keywords: [],
        created_at: createdAt.toISOString(),
      };
      getIntentEventEmitter().emitIntentStored(intentRecordPayload);
      intentLogger.debug(
        `Forwarded intent classified to IntentEventEmitter: ${intentRecordPayload.intent_id}`
      );
    }

    intentLogger.info(
      `Processed intent classified: ${intentType} (confidence: ${intentEvent.confidence}, session: ${intentEvent.sessionId || 'unknown'})`
    );
  } catch (error) {
    const errorContext = {
      eventId: event.id ?? 'unknown',
      correlationId: event.correlation_id ?? event.correlationId ?? 'unknown',
      sessionId: event.session_id ?? event.sessionId ?? 'unknown',
      intentCategory: event.intent_category ?? event.intentCategory ?? 'unknown',
      intentType: event.intent_type ?? event.intentType ?? 'unknown',
      confidence: event.confidence ?? 'unknown',
      timestamp: event.timestamp ?? event.created_at ?? event.createdAt ?? 'unknown',
      eventType: event.event_type ?? 'unknown',
    };

    intentLogger.error(
      `Error processing intent classified event. Context: ${JSON.stringify(errorContext)}`,
      error
    );

    ctx.emit('error', {
      type: 'intent-classification-error',
      context: errorContext,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      originalError: error,
      timestamp: new Date().toISOString(),
    });
  }
}

// ============================================================================
// DomainHandler Implementation
// ============================================================================

export class OmniintelligenceHandler implements DomainHandler {
  readonly name = 'omniintelligence';

  canHandle(topic: string): boolean {
    return HANDLED_TOPICS.has(topic);
  }

  async handleEvent(
    topic: string,
    event: Record<string, unknown>,
    _message: KafkaMessage,
    ctx: ConsumerContext
  ): Promise<void> {
    switch (topic) {
      case SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED:
        if (ctx.isDebug) {
          intentLogger.debug(
            `Processing intent classified: ${event.intent_type || event.intentType} (confidence: ${event.confidence})`
          );
        }
        handleIntentClassified(event as RawIntentClassifiedEvent, ctx);
        break;

      // Cross-repo validation topics
      case SUFFIX_VALIDATION_RUN_STARTED:
        if (isValidationRunStarted(event)) {
          if (ctx.isDebug) {
            intentLogger.debug(`Processing validation run started: ${event.run_id}`);
          }
          await handleValidationRunStarted(event);
          ctx.emit('validation-event', { type: 'run-started', event });
        } else {
          console.warn('[validation] Dropped malformed run-started event on topic', topic);
        }
        break;

      case SUFFIX_VALIDATION_VIOLATIONS_BATCH:
        if (isValidationViolationsBatch(event)) {
          if (ctx.isDebug) {
            intentLogger.debug(
              `Processing validation violations batch: ${event.run_id} (${event.violations.length} violations)`
            );
          }
          await handleValidationViolationsBatch(event);
          ctx.emit('validation-event', { type: 'violations-batch', event });
        } else {
          console.warn('[validation] Dropped malformed violations-batch event on topic', topic);
        }
        break;

      case SUFFIX_VALIDATION_RUN_COMPLETED:
        if (isValidationRunCompleted(event)) {
          if (ctx.isDebug) {
            intentLogger.debug(
              `Processing validation run completed: ${event.run_id} (${event.status})`
            );
          }
          await handleValidationRunCompleted(event);
          ctx.emit('validation-event', { type: 'run-completed', event });
        } else {
          console.warn('[validation] Dropped malformed run-completed event on topic', topic);
        }
        break;

      case SUFFIX_VALIDATION_CANDIDATE_UPSERTED:
        if (isValidationCandidateUpserted(event)) {
          if (ctx.isDebug) {
            intentLogger.debug(
              `Processing validation candidate upserted: ${(event as { candidate_id: string }).candidate_id}`
            );
          }
          await handleValidationCandidateUpserted(event);
          ctx.emit('validation-event', { type: 'candidate-upserted', event });
        } else {
          console.warn('[validation] Dropped malformed candidate-upserted event on topic', topic);
        }
        break;

      // Intelligence pipeline commands + completions (OMN-5601)
      case SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD:
      case SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_CMD:
      case SUFFIX_INTELLIGENCE_PATTERN_LEARNING_CMD:
      case SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_CMD:
      case SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED:
      case SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED:
      case SUFFIX_INTELLIGENCE_DOCUMENT_INGESTION_COMPLETED:
      case SUFFIX_INTELLIGENCE_PATTERN_LEARNING_COMPLETED:
      case SUFFIX_INTELLIGENCE_QUALITY_ASSESSMENT_COMPLETED:
        // intentional-skip: pipeline job projections deferred to OMN-5601 (intelligence_pipeline_jobs table).
        // Domain handler advances offset; read-model projection pending table creation.
        if (ctx.isDebug) {
          intentLogger.debug(`Processing intelligence pipeline event from topic: ${topic}`);
        }
        break;

      // Pattern lifecycle events (OMN-5602)
      case SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITION_CMD:
      case SUFFIX_INTELLIGENCE_PATTERN_LIFECYCLE_TRANSITIONED:
      case SUFFIX_INTELLIGENCE_PATTERN_PROMOTED:
      case SUFFIX_INTELLIGENCE_PATTERN_STORED:
      case SUFFIX_PATTERN_DISCOVERED:
        // intentional-skip: TRANSITIONED + LEARNING_CMD projected by read-model consumer.
        // PROMOTED/STORED/DISCOVERED projections deferred to OMN-5602.
        if (ctx.isDebug) {
          intentLogger.debug(`Processing pattern lifecycle event from topic: ${topic}`);
        }
        break;

      case SUFFIX_INTELLIGENCE_SESSION_OUTCOME_CMD:
        // intentional-skip: command routed to omniintelligence service, not a dashboard-projectable event.
        // Session outcome DATA is projected via SUFFIX_OMNICLAUDE_SESSION_OUTCOME (see omniclaude-handler).
        break;

      // CI debug escalation events (OMN-6143)
      // DB projection handled by read-model consumer (omniintelligence-projections.ts).
      // Forward to WebSocket for real-time /debug-escalation page updates.
      case SUFFIX_INTELLIGENCE_CI_DEBUG_ESCALATION:
        if (ctx.isDebug) {
          intentLogger.debug(
            `Processing CI debug escalation: ${event.escalation_id || event.escalationId || 'unknown'}`
          );
        }
        ctx.emit('debug-escalation-event', {
          type: 'ci-debug-escalation',
          topic: SUFFIX_INTELLIGENCE_CI_DEBUG_ESCALATION,
          payload: event,
          timestamp: new Date().toISOString(),
        });
        break;
    }
  }
}
