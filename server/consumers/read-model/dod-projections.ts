/**
 * DoD verification domain projection handlers (OMN-5199).
 *
 * Projects events from omniclaude DoD topics into the omnidash_analytics read-model:
 * - dod-verify-completed.v1 -> dod_verify_runs (idempotent ON CONFLICT DO NOTHING on run_id)
 * - dod-guard-fired.v1 -> dod_guard_events (append-only, no dedup key)
 */

import { dodVerifyRuns, dodGuardEvents } from '@shared/intelligence-schema';
import {
  SUFFIX_OMNICLAUDE_DOD_VERIFY_COMPLETED,
  SUFFIX_OMNICLAUDE_DOD_GUARD_FIRED,
} from '@shared/topics';

import type {
  ProjectionHandler,
  ProjectionContext,
  MessageMeta,
  ProjectionHandlerStats,
} from './types';
import {
  safeParseDate,
  sanitizeSessionId,
  isTableMissingError,
  createHandlerStats,
  registerHandlerStats,
} from './types';

const DOD_TOPICS = new Set([
  SUFFIX_OMNICLAUDE_DOD_VERIFY_COMPLETED,
  SUFFIX_OMNICLAUDE_DOD_GUARD_FIRED,
]);

export class DodProjectionHandler implements ProjectionHandler {
  readonly stats: ProjectionHandlerStats = createHandlerStats();

  constructor() {
    registerHandlerStats('DodProjectionHandler', this.stats);
  }

  canHandle(topic: string): boolean {
    return DOD_TOPICS.has(topic);
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
      case SUFFIX_OMNICLAUDE_DOD_VERIFY_COMPLETED:
        return this.projectDodVerifyCompleted(data, context);
      case SUFFIX_OMNICLAUDE_DOD_GUARD_FIRED:
        return this.projectDodGuardFired(data, context);
      default:
        return true;
    }
  }

  // -------------------------------------------------------------------------
  // dod-verify-completed -> dod_verify_runs (OMN-5199)
  // -------------------------------------------------------------------------

  private async projectDodVerifyCompleted(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const ticketId = (data.ticket_id as string) || (data.ticketId as string);
    if (!ticketId) {
      console.warn('[ReadModelConsumer] dod-verify-completed event missing ticket_id -- skipping');
      return true;
    }

    const runId = (data.run_id as string) || (data.runId as string);
    if (!runId) {
      console.warn('[ReadModelConsumer] dod-verify-completed event missing run_id -- skipping');
      return true;
    }

    const sessionId = sanitizeSessionId(
      (data.session_id as string | null) ?? (data.sessionId as string | null)
    );
    const correlationId =
      (data.correlation_id as string | null) ?? (data.correlationId as string | null) ?? null;

    const totalChecks = Number(data.total_checks ?? data.totalChecks ?? 0);
    const passedChecks = Number(data.passed_checks ?? data.passedChecks ?? 0);
    const failedChecks = Number(data.failed_checks ?? data.failedChecks ?? 0);
    const skippedChecks = Number(data.skipped_checks ?? data.skippedChecks ?? 0);
    const overallPass = Boolean(data.overall_pass ?? data.overallPass ?? false);
    const policyMode = (data.policy_mode as string) || (data.policyMode as string) || 'unknown';
    const evidenceItems = (data.evidence_items ?? data.evidenceItems ?? []) as unknown;
    const eventTimestamp = safeParseDate(
      data.event_timestamp ?? data.eventTimestamp ?? data.timestamp ?? data.created_at
    );

    try {
      await db
        .insert(dodVerifyRuns)
        .values({
          ticketId,
          runId,
          sessionId: sessionId ?? null,
          correlationId,
          totalChecks,
          passedChecks,
          failedChecks,
          skippedChecks,
          overallPass,
          policyMode,
          evidenceItems,
          eventTimestamp,
        })
        .onConflictDoNothing();

      return true;
    } catch (err) {
      if (isTableMissingError(err, 'dod_verify_runs')) {
        console.warn(
          '[ReadModelConsumer] dod_verify_runs table not yet created -- ' +
            'run migrations to enable DoD verify projection'
        );
        return true;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // dod-guard-fired -> dod_guard_events (OMN-5199)
  // -------------------------------------------------------------------------

  private async projectDodGuardFired(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const ticketId = (data.ticket_id as string) || (data.ticketId as string);
    if (!ticketId) {
      console.warn('[ReadModelConsumer] dod-guard-fired event missing ticket_id -- skipping');
      return true;
    }

    const sessionId = sanitizeSessionId(
      (data.session_id as string | null) ?? (data.sessionId as string | null)
    );
    const guardOutcome =
      (data.guard_outcome as string) || (data.guardOutcome as string) || 'unknown';
    const policyMode = (data.policy_mode as string) || (data.policyMode as string) || 'unknown';
    const receiptAgeSeconds =
      data.receipt_age_seconds != null
        ? String(data.receipt_age_seconds)
        : data.receiptAgeSeconds != null
          ? String(data.receiptAgeSeconds)
          : null;
    const receiptPass =
      data.receipt_pass != null
        ? Boolean(data.receipt_pass)
        : data.receiptPass != null
          ? Boolean(data.receiptPass)
          : null;
    const eventTimestamp = safeParseDate(
      data.event_timestamp ?? data.eventTimestamp ?? data.timestamp ?? data.created_at
    );

    try {
      await db
        .insert(dodGuardEvents)
        .values({
          ticketId,
          sessionId: sessionId ?? null,
          guardOutcome,
          policyMode,
          receiptAgeSeconds,
          receiptPass,
          eventTimestamp,
        })
        .onConflictDoNothing();

      return true;
    } catch (err) {
      if (isTableMissingError(err, 'dod_guard_events')) {
        console.warn(
          '[ReadModelConsumer] dod_guard_events table not yet created -- ' +
            'run migrations to enable DoD guard projection'
        );
        return true;
      }
      throw err;
    }
  }
}
