/**
 * Sweep result projection handler (OMN-8172).
 *
 * Projects sweep-result events into the sweep_results table for dashboard visibility.
 * Each sweep node (aislop, coverage, compliance, contract, dashboard, runtime, data_flow)
 * emits this event after completing a run.
 *
 * Subscribes to: TOPIC_OMNIMARKET_SWEEP_RESULT
 *   onex.evt.omnimarket.sweep-result.v1
 *
 * Payload fields (from ModelSweepResult in omnibase_compat.telemetry):
 *   schema_version, sweep_type, session_id, correlation_id, ran_at,
 *   duration_seconds, passed, finding_count, critical_count, warning_count,
 *   repos_scanned, summary, output_path
 */

import { sql } from 'drizzle-orm';
import { TOPIC_OMNIMARKET_SWEEP_RESULT } from '@shared/topics';

import type {
  ProjectionHandler,
  ProjectionContext,
  MessageMeta,
  ProjectionHandlerStats,
} from './types';
import {
  isTableMissingError,
  createHandlerStats,
  registerHandlerStats,
  safeParseDate,
} from './types';

const SWEEP_TOPICS = new Set([TOPIC_OMNIMARKET_SWEEP_RESULT]);

export class SweepProjectionHandler implements ProjectionHandler {
  readonly stats: ProjectionHandlerStats = createHandlerStats();

  constructor() {
    registerHandlerStats('SweepProjectionHandler', this.stats);
  }

  canHandle(topic: string): boolean {
    return SWEEP_TOPICS.has(topic);
  }

  async projectEvent(
    topic: string,
    data: Record<string, unknown>,
    context: ProjectionContext,
    _meta: MessageMeta
  ): Promise<boolean> {
    this.stats.received++;

    if (topic === TOPIC_OMNIMARKET_SWEEP_RESULT) {
      const result = await this.projectSweepResult(data, context);
      if (result) {
        this.stats.projected++;
      }
      return result;
    }

    return false;
  }

  private async projectSweepResult(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) {
      this.stats.dropped.db_unavailable++;
      return false;
    }

    const sweepType = data.sweep_type as string | undefined;
    if (!sweepType) {
      this.stats.dropped.missing_field++;
      return false;
    }

    const sessionId = data.session_id as string | undefined;
    if (!sessionId) {
      this.stats.dropped.missing_field++;
      return false;
    }

    const correlationId = data.correlation_id as string | undefined;
    if (!correlationId) {
      this.stats.dropped.missing_field++;
      return false;
    }

    const ranAt = safeParseDate(data.ran_at as string | undefined);
    const passed = Boolean(data.passed);
    const durationSeconds =
      typeof data.duration_seconds === 'number' ? data.duration_seconds : null;
    const findingCount = typeof data.finding_count === 'number' ? data.finding_count : 0;
    const criticalCount = typeof data.critical_count === 'number' ? data.critical_count : 0;
    const warningCount = typeof data.warning_count === 'number' ? data.warning_count : 0;
    const reposScanned = Array.isArray(data.repos_scanned) ? (data.repos_scanned as string[]) : [];
    const summary = typeof data.summary === 'string' ? data.summary : null;
    const outputPath = typeof data.output_path === 'string' ? data.output_path : null;

    try {
      await db.execute(sql`
        INSERT INTO sweep_results (
          sweep_type, session_id, correlation_id, ran_at,
          duration_seconds, passed, finding_count, critical_count,
          warning_count, repos_scanned, summary, output_path
        ) VALUES (
          ${sweepType},
          ${sessionId}::uuid,
          ${correlationId}::uuid,
          ${ranAt},
          ${durationSeconds},
          ${passed},
          ${findingCount},
          ${criticalCount},
          ${warningCount},
          ${reposScanned},
          ${summary},
          ${outputPath}
        ) ON CONFLICT DO NOTHING
      `);
      return true;
    } catch (err) {
      if (isTableMissingError(err, 'sweep_results')) {
        this.stats.dropped.table_missing++;
        console.warn(
          '[SweepProjectionHandler] sweep_results table does not exist yet — run migrations'
        );
        return false;
      }
      throw err;
    }
  }
}
