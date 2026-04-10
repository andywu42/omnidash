/**
 * Omnibase-infra domain projection handlers (OMN-5192).
 *
 * Projects events from omnibase-infra topics into the omnidash_analytics read-model:
 * - Baselines computed -> baselines_snapshots / baselines_comparisons / baselines_trend / baselines_breakdown
 * - LLM health snapshot -> llm_health_snapshots (OMN-5279)
 * - Wiring health snapshot -> in-memory WiringHealthProjection (OMN-5292)
 * - Circuit breaker event -> circuit_breaker_events (OMN-5293)
 * - Savings estimated -> savings_estimates (OMN-5552)
 * - Consumer health event -> consumer_health_events (OMN-5527)
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import {
  baselinesSnapshots,
  baselinesComparisons,
  baselinesTrend,
  baselinesBreakdown,
  llmHealthSnapshots,
  circuitBreakerEvents,
  savingsEstimates,
  runtimeErrorEvents,
  runtimeErrorTriageState,
  infraRoutingDecisions,
  consumerHealthEvents,
} from '@shared/intelligence-schema';
import type {
  InsertBaselinesSnapshot,
  InsertBaselinesComparison,
  InsertBaselinesTrend,
  InsertBaselinesBreakdown,
  InsertLlmHealthSnapshot,
  InsertCircuitBreakerEvent,
  InsertSavingsEstimate,
  InsertRuntimeErrorEvent,
  InsertRuntimeErrorTriageState,
  InsertInfraRoutingDecision,
  InsertConsumerHealthEvent,
} from '@shared/intelligence-schema';
import { baselinesProjection } from '../../projection-bootstrap';
import { emitBaselinesUpdate } from '../../baselines-events';
import {
  SUFFIX_OMNIBASE_INFRA_BASELINES_COMPUTED,
  SUFFIX_OMNIBASE_INFRA_LLM_HEALTH_SNAPSHOT,
  TOPIC_OMNIBASE_INFRA_WIRING_HEALTH_SNAPSHOT,
  TOPIC_OMNIBASE_INFRA_CIRCUIT_BREAKER,
  SUFFIX_OMNIBASE_INFRA_SAVINGS_ESTIMATED,
  TOPIC_OMNIBASE_INFRA_RUNTIME_ERROR,
  TOPIC_OMNIBASE_INFRA_ERROR_TRIAGED,
  TOPIC_OMNIBASE_INFRA_ROUTING_DECIDED,
  TOPIC_OMNIBASE_INFRA_CONSUMER_HEALTH,
} from '@shared/topics';
import { wiringHealthProjection } from '../../projections/wiring-health-projection';
import type { TopicWiringRecord } from '../../projections/wiring-health-projection';

import type {
  ProjectionHandler,
  ProjectionContext,
  MessageMeta,
  ProjectionHandlerStats,
} from './types';
import {
  safeParseDate,
  safeParseDateOrMin,
  isTableMissingError,
  deterministicCorrelationId,
  UUID_RE,
  MAX_BATCH_ROWS,
  VALID_PROMOTION_ACTIONS,
  VALID_CONFIDENCE_LEVELS,
  createHandlerStats,
  registerHandlerStats,
} from './types';

const BASELINES_TOPIC = SUFFIX_OMNIBASE_INFRA_BASELINES_COMPUTED;
const LLM_HEALTH_TOPIC = SUFFIX_OMNIBASE_INFRA_LLM_HEALTH_SNAPSHOT;
const WIRING_HEALTH_TOPIC = TOPIC_OMNIBASE_INFRA_WIRING_HEALTH_SNAPSHOT;
const CIRCUIT_BREAKER_TOPIC = TOPIC_OMNIBASE_INFRA_CIRCUIT_BREAKER;
const SAVINGS_ESTIMATED_TOPIC = SUFFIX_OMNIBASE_INFRA_SAVINGS_ESTIMATED;

const RUNTIME_ERROR_TOPIC = TOPIC_OMNIBASE_INFRA_RUNTIME_ERROR;
const ERROR_TRIAGED_TOPIC = TOPIC_OMNIBASE_INFRA_ERROR_TRIAGED;
const ROUTING_DECIDED_TOPIC = TOPIC_OMNIBASE_INFRA_ROUTING_DECIDED;
const CONSUMER_HEALTH_TOPIC = TOPIC_OMNIBASE_INFRA_CONSUMER_HEALTH;

const OMNIBASE_INFRA_TOPICS = new Set([
  SUFFIX_OMNIBASE_INFRA_BASELINES_COMPUTED,
  SUFFIX_OMNIBASE_INFRA_LLM_HEALTH_SNAPSHOT,
  TOPIC_OMNIBASE_INFRA_WIRING_HEALTH_SNAPSHOT,
  TOPIC_OMNIBASE_INFRA_CIRCUIT_BREAKER,
  SUFFIX_OMNIBASE_INFRA_SAVINGS_ESTIMATED,
  TOPIC_OMNIBASE_INFRA_RUNTIME_ERROR,
  TOPIC_OMNIBASE_INFRA_ERROR_TRIAGED,
  TOPIC_OMNIBASE_INFRA_ROUTING_DECIDED,
  TOPIC_OMNIBASE_INFRA_CONSUMER_HEALTH,
]);

export class OmnibaseInfraProjectionHandler implements ProjectionHandler {
  readonly stats: ProjectionHandlerStats = createHandlerStats();

  constructor() {
    registerHandlerStats('OmnibaseInfraProjectionHandler', this.stats);
  }

  canHandle(topic: string): boolean {
    return OMNIBASE_INFRA_TOPICS.has(topic);
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
    if (topic === BASELINES_TOPIC) {
      return this.projectBaselinesSnapshot(data, meta.partition, meta.offset, context);
    }
    if (topic === LLM_HEALTH_TOPIC) {
      return this.projectLlmHealthSnapshot(data, context);
    }
    if (topic === WIRING_HEALTH_TOPIC) {
      return this.projectWiringHealthSnapshot(data);
    }
    if (topic === CIRCUIT_BREAKER_TOPIC) {
      return this.projectCircuitBreakerEvent(data, context);
    }
    if (topic === SAVINGS_ESTIMATED_TOPIC) {
      return this.projectSavingsEstimated(data, context, meta);
    }
    if (topic === RUNTIME_ERROR_TOPIC) {
      return this.projectRuntimeErrorEvent(data, context);
    }
    if (topic === ERROR_TRIAGED_TOPIC) {
      return this.projectErrorTriaged(data, context);
    }
    if (topic === ROUTING_DECIDED_TOPIC) {
      return this.projectInfraRoutingDecided(data, context);
    }
    if (topic === CONSUMER_HEALTH_TOPIC) {
      return this.projectConsumerHealth(data, context, meta);
    }
    return false;
  }

  private async projectCircuitBreakerEvent(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const id = String(data.id ?? data.event_id ?? '').trim();
    const serviceName = String(data.service_name ?? data.serviceName ?? '').trim();
    const state = String(data.state ?? '')
      .trim()
      .toLowerCase();
    const previousState = String(data.previous_state ?? data.previousState ?? '')
      .trim()
      .toLowerCase();

    if (!serviceName || !state || !previousState) {
      console.warn('[ReadModelConsumer] circuit-breaker event missing required fields', {
        serviceName,
        state,
        previousState,
      });
      return true;
    }

    const emittedAt = safeParseDateOrMin(data.emitted_at ?? data.emittedAt ?? data.timestamp);

    const row: InsertCircuitBreakerEvent = {
      id: id || randomUUID(),
      serviceName,
      state,
      previousState,
      failureCount: Number(data.failure_count ?? data.failureCount ?? 0),
      threshold: Number(data.threshold ?? 5),
      emittedAt,
    };

    try {
      await db.insert(circuitBreakerEvents).values(row).onConflictDoNothing();
      console.log(
        `[ReadModelConsumer] Projected circuit-breaker event for ${serviceName}: ${previousState} -> ${state}`
      );
    } catch (err) {
      if (isTableMissingError(err, 'circuit_breaker_events')) {
        console.warn(
          '[ReadModelConsumer] circuit_breaker_events table not yet created -- ' +
            'run migrations to enable circuit breaker projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  private async projectLlmHealthSnapshot(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const modelId = String(data.model_id ?? data.modelId ?? '').trim();
    const endpointUrl = String(data.endpoint_url ?? data.endpointUrl ?? '').trim();

    if (!modelId || !endpointUrl) {
      console.warn('[ReadModelConsumer] llm-health-snapshot missing model_id or endpoint_url');
      return true;
    }

    /** Parse a numeric field, returning null for NaN/Infinity/non-finite values. */
    const safeNum = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const row: InsertLlmHealthSnapshot = {
      modelId,
      endpointUrl,
      latencyP50Ms:
        data.latency_p50_ms != null
          ? safeNum(data.latency_p50_ms)
          : data.latencyP50Ms != null
            ? safeNum(data.latencyP50Ms)
            : null,
      latencyP99Ms:
        data.latency_p99_ms != null
          ? safeNum(data.latency_p99_ms)
          : data.latencyP99Ms != null
            ? safeNum(data.latencyP99Ms)
            : null,
      errorRate:
        data.error_rate != null
          ? safeNum(data.error_rate)
          : data.errorRate != null
            ? safeNum(data.errorRate)
            : null,
      tokensPerSecond:
        data.tokens_per_second != null
          ? safeNum(data.tokens_per_second)
          : data.tokensPerSecond != null
            ? safeNum(data.tokensPerSecond)
            : null,
      status: String(data.status ?? 'unknown'),
    };

    try {
      await db.insert(llmHealthSnapshots).values(row);
      console.log(`[ReadModelConsumer] Projected llm-health-snapshot for ${modelId}`);
    } catch (err) {
      if (isTableMissingError(err, 'llm_health_snapshots')) {
        console.warn(
          '[ReadModelConsumer] llm_health_snapshots table not yet created -- ' +
            'run migrations to enable llm health projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  private projectWiringHealthSnapshot(data: Record<string, unknown>): boolean {
    try {
      /** Explicit boolean parse: handles boolean, "true"/"false" strings, and numbers. */
      const parseBool = (value: unknown, fallback: boolean): boolean => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
          const normalized = value.trim().toLowerCase();
          if (normalized === 'true') return true;
          if (normalized === 'false') return false;
        }
        if (typeof value === 'number') return value !== 0;
        return fallback;
      };

      const rawTopics = Array.isArray(data.topics) ? data.topics : [];
      const topics: TopicWiringRecord[] = (rawTopics as Record<string, unknown>[]).map((t) => ({
        topic: String(t.topic ?? ''),
        emitCount: Number(t.emit_count ?? t.emitCount ?? 0),
        consumeCount: Number(t.consume_count ?? t.consumeCount ?? 0),
        mismatchRatio: Number(t.mismatch_ratio ?? t.mismatchRatio ?? 0),
        isHealthy: parseBool(t.is_healthy ?? t.isHealthy, true),
      }));

      wiringHealthProjection.ingest({
        timestamp: String(data.timestamp ?? new Date().toISOString()),
        overallHealthy: parseBool(data.overall_healthy ?? data.overallHealthy, true),
        unhealthyCount: Number(data.unhealthy_count ?? data.unhealthyCount ?? 0),
        threshold: Number(data.threshold ?? 0.05),
        topics,
        correlationId: String(data.correlation_id ?? data.correlationId ?? ''),
        receivedAt: new Date().toISOString(),
      });
      return true;
    } catch (err) {
      console.error('[ReadModelConsumer] Failed to project wiring health snapshot:', err);
      return false;
    }
  }

  private async projectBaselinesSnapshot(
    data: Record<string, unknown>,
    partition: number,
    offset: string,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const rawSnapshotId = data.snapshot_id as string | undefined;
    const snapshotId =
      rawSnapshotId && UUID_RE.test(rawSnapshotId)
        ? rawSnapshotId
        : deterministicCorrelationId('baselines-computed', partition, offset);

    const contractVersion = parseInt(String(data.contract_version), 10) || 1;
    const computedAtUtc = safeParseDateOrMin(
      data.computed_at_utc ?? data.computedAtUtc ?? data.computed_at
    );
    const windowStartUtc = data.window_start_utc
      ? safeParseDate(data.window_start_utc)
      : data.windowStartUtc
        ? safeParseDate(data.windowStartUtc)
        : null;
    const windowEndUtc = data.window_end_utc
      ? safeParseDate(data.window_end_utc)
      : data.windowEndUtc
        ? safeParseDate(data.windowEndUtc)
        : null;

    // Parse child arrays with batch-row caps
    const rawComparisonsAll = Array.isArray(data.comparisons) ? data.comparisons : [];
    if (rawComparisonsAll.length > MAX_BATCH_ROWS) {
      console.warn(
        `[ReadModelConsumer] baselines snapshot ${snapshotId} contains ` +
          `${rawComparisonsAll.length} comparison rows -- capping at ${MAX_BATCH_ROWS}`
      );
    }
    const rawComparisons = rawComparisonsAll.slice(0, MAX_BATCH_ROWS);

    const rawTrendAll = Array.isArray(data.trend) ? data.trend : [];
    if (rawTrendAll.length > MAX_BATCH_ROWS) {
      console.warn(
        `[ReadModelConsumer] baselines snapshot ${snapshotId} contains ` +
          `${rawTrendAll.length} trend rows -- capping at ${MAX_BATCH_ROWS}`
      );
    }
    const rawTrend = rawTrendAll.slice(0, MAX_BATCH_ROWS);

    const rawBreakdownAll = Array.isArray(data.breakdown) ? data.breakdown : [];
    if (rawBreakdownAll.length > MAX_BATCH_ROWS) {
      console.warn(
        `[ReadModelConsumer] baselines snapshot ${snapshotId} contains ` +
          `${rawBreakdownAll.length} breakdown rows -- capping at ${MAX_BATCH_ROWS}`
      );
    }
    const rawBreakdown = rawBreakdownAll.slice(0, MAX_BATCH_ROWS);

    // Build trend rows
    const trendRows: InsertBaselinesTrend[] = (rawTrend as Record<string, unknown>[])
      .filter((t) => {
        // Accept date, dateStr, or trend_date (upstream producer uses trend_date)
        const date = t.date ?? t.dateStr ?? t.trend_date;
        if (date == null || date === '') {
          console.warn(
            '[ReadModelConsumer] Skipping trend row with blank/null date:',
            JSON.stringify(t)
          );
          return false;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
          console.warn(
            '[ReadModelConsumer] Skipping trend row with malformed date format (expected YYYY-MM-DD):',
            JSON.stringify(t)
          );
          return false;
        }
        return true;
      })
      .map((t) => ({
        snapshotId,
        date: String(t.date ?? t.dateStr ?? t.trend_date),
        avgCostSavings: String(
          Math.min(Math.max(Number(t.avg_cost_savings ?? t.avgCostSavings ?? 0), 0), 99)
        ),
        avgOutcomeImprovement: String(
          Math.min(
            Math.max(Number(t.avg_outcome_improvement ?? t.avgOutcomeImprovement ?? 0), 0),
            99
          )
        ),
        comparisonsEvaluated: Number(t.comparisons_evaluated ?? t.comparisonsEvaluated ?? 0),
      }));

    // Deduplicate trend rows by date
    const trendRowsByDate = new Map<string, (typeof trendRows)[0]>();
    for (const row of trendRows) {
      trendRowsByDate.set(row.date, row);
    }
    const dedupedTrendRows = [...trendRowsByDate.values()];
    if (dedupedTrendRows.length < trendRows.length) {
      console.warn(
        `[read-model-consumer] Deduplicated ${trendRows.length - dedupedTrendRows.length} ` +
          `duplicate trend date(s) for snapshot ${snapshotId}`
      );
    }
    const finalTrendRows = dedupedTrendRows;
    if (rawTrend.length > 0 && finalTrendRows.length === 0) {
      console.warn(
        `[baselines] all ${rawTrend.length} trend rows filtered out for snapshot ${snapshotId} -- check upstream data`
      );
    }

    try {
      const snapshotRow: InsertBaselinesSnapshot = {
        snapshotId,
        contractVersion,
        computedAtUtc,
        windowStartUtc: windowStartUtc ?? undefined,
        windowEndUtc: windowEndUtc ?? undefined,
      };

      let insertedComparisonCount = 0;
      let insertedBreakdownCount = 0;
      await db.transaction(async (tx) => {
        // 1. Upsert snapshot header
        await tx
          .insert(baselinesSnapshots)
          .values(snapshotRow)
          .onConflictDoUpdate({
            target: baselinesSnapshots.snapshotId,
            set: {
              contractVersion: snapshotRow.contractVersion,
              computedAtUtc: snapshotRow.computedAtUtc,
              windowStartUtc: snapshotRow.windowStartUtc,
              windowEndUtc: snapshotRow.windowEndUtc,
              projectedAt: new Date(),
            },
          });

        // 2. Replace child rows atomically
        await tx
          .delete(baselinesComparisons)
          .where(eq(baselinesComparisons.snapshotId, snapshotId));

        if (rawComparisons.length > 0) {
          const comparisonRows: InsertBaselinesComparison[] = (
            rawComparisons as Record<string, unknown>[]
          )
            .filter((c) => {
              const pid = String(c.pattern_id ?? c.patternId ?? '').trim();
              if (!pid) {
                console.warn(
                  `[read-model-consumer] Skipping comparison row with blank pattern_id for snapshot ${snapshotId}`
                );
                return false;
              }
              return true;
            })
            .map((c) => ({
              snapshotId,
              patternId: String(c.pattern_id ?? c.patternId ?? ''),
              patternName: String(c.pattern_name ?? c.patternName ?? ''),
              sampleSize: Number(c.sample_size ?? c.sampleSize ?? 0),
              windowStart: String(c.window_start ?? c.windowStart ?? ''),
              windowEnd: String(c.window_end ?? c.windowEnd ?? ''),
              tokenDelta: (c.token_delta ?? c.tokenDelta ?? {}) as Record<string, unknown>,
              timeDelta: (c.time_delta ?? c.timeDelta ?? {}) as Record<string, unknown>,
              retryDelta: (c.retry_delta ?? c.retryDelta ?? {}) as Record<string, unknown>,
              testPassRateDelta: (c.test_pass_rate_delta ?? c.testPassRateDelta ?? {}) as Record<
                string,
                unknown
              >,
              reviewIterationDelta: (c.review_iteration_delta ??
                c.reviewIterationDelta ??
                {}) as Record<string, unknown>,
              recommendation: (() => {
                const raw = String(c.recommendation ?? '');
                return VALID_PROMOTION_ACTIONS.has(raw) ? raw : 'shadow';
              })(),
              confidence: (() => {
                const raw = String(c.confidence ?? '').toLowerCase();
                return VALID_CONFIDENCE_LEVELS.has(raw) ? raw : 'low';
              })(),
              rationale: String(c.rationale ?? ''),
            }));
          if (comparisonRows.length === 0) {
            console.warn(
              `[baselines] all ${rawComparisons.length} comparison rows filtered out for snapshot ${snapshotId} -- check upstream data`
            );
          } else {
            await tx.insert(baselinesComparisons).values(comparisonRows);
          }
          insertedComparisonCount = comparisonRows.length;
        }

        await tx.delete(baselinesTrend).where(eq(baselinesTrend.snapshotId, snapshotId));

        if (finalTrendRows.length > 0) {
          await tx.insert(baselinesTrend).values(finalTrendRows);
        }

        await tx.delete(baselinesBreakdown).where(eq(baselinesBreakdown.snapshotId, snapshotId));

        if (rawBreakdown.length > 0) {
          const breakdownRowsRaw: InsertBaselinesBreakdown[] = (
            rawBreakdown as Record<string, unknown>[]
          ).map((b) => {
            const rawAction = String(b.action ?? '');
            const action = VALID_PROMOTION_ACTIONS.has(rawAction) ? rawAction : 'shadow';
            return {
              snapshotId,
              action,
              count: Number(b.count ?? 0),
              avgConfidence: String(
                Math.min(Math.max(Number(b.avg_confidence ?? b.avgConfidence ?? 0), 0), 1)
              ),
            };
          });

          const breakdownByAction = new Map<string, (typeof breakdownRowsRaw)[0]>();
          for (const row of breakdownRowsRaw) {
            breakdownByAction.set(row.action, row);
          }
          const breakdownRows = [...breakdownByAction.values()];
          if (breakdownRows.length < breakdownRowsRaw.length) {
            console.warn(
              `[read-model-consumer] Deduplicated ${breakdownRowsRaw.length - breakdownRows.length} ` +
                `duplicate breakdown action(s) for snapshot ${snapshotId}`
            );
          }

          if (breakdownRows.length === 0) {
            console.warn(
              `[baselines] all ${rawBreakdown.length} breakdown rows filtered out for snapshot ${snapshotId} -- check upstream data`
            );
          } else {
            await tx.insert(baselinesBreakdown).values(breakdownRows);
          }
          insertedBreakdownCount = breakdownRows.length;
        }
      });

      try {
        baselinesProjection.reset();
      } catch (e) {
        console.warn('[read-model-consumer] baselinesProjection.reset() failed post-commit:', e);
      }

      try {
        emitBaselinesUpdate(snapshotId);
      } catch (e) {
        console.warn('[read-model-consumer] emitBaselinesUpdate() failed post-commit:', e);
      }

      console.log(
        `[ReadModelConsumer] Projected baselines snapshot ${snapshotId} ` +
          `(${insertedComparisonCount} comparisons, ${finalTrendRows.length} trend points, ` +
          `${insertedBreakdownCount} breakdown rows)`
      );
    } catch (err) {
      if (isTableMissingError(err, 'baselines_snapshots')) {
        console.warn(
          '[ReadModelConsumer] baselines_* tables not yet created -- ' +
            'run migrations to enable baselines projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  private async projectSavingsEstimated(
    data: Record<string, unknown>,
    context: ProjectionContext,
    meta: MessageMeta
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const sessionId = String(data.session_id ?? data.sessionId ?? '').trim();
    if (!sessionId) {
      console.warn('[ReadModelConsumer] savings-estimated event missing session_id');
      return true;
    }

    // Derive a deterministic source_event_id for idempotency.
    // Prefer correlation_id from the event; fall back to Kafka coordinates.
    const correlationId = String(data.correlation_id ?? data.correlationId ?? '').trim();
    const sourceEventId =
      correlationId ||
      deterministicCorrelationId(SAVINGS_ESTIMATED_TOPIC, meta.partition, meta.offset);

    const eventTimestamp = safeParseDate(data.timestamp_iso ?? data.timestamp ?? data.emitted_at);

    const row: InsertSavingsEstimate = {
      sourceEventId,
      sessionId,
      correlationId: correlationId || null,
      schemaVersion: String(data.schema_version ?? '1.0'),
      actualTotalTokens: Number(data.actual_total_tokens ?? data.actualTotalTokens ?? 0),
      actualCostUsd: String(Number(data.actual_cost_usd ?? data.actualCostUsd ?? 0)),
      actualModelId:
        data.actual_model_id != null
          ? String(data.actual_model_id)
          : data.actualModelId != null
            ? String(data.actualModelId)
            : null,
      counterfactualModelId:
        data.counterfactual_model_id != null
          ? String(data.counterfactual_model_id)
          : data.counterfactualModelId != null
            ? String(data.counterfactualModelId)
            : null,
      directSavingsUsd: String(Number(data.direct_savings_usd ?? data.directSavingsUsd ?? 0)),
      directTokensSaved: Number(data.direct_tokens_saved ?? data.directTokensSaved ?? 0),
      estimatedTotalSavingsUsd: String(
        Number(data.estimated_total_savings_usd ?? data.estimatedTotalSavingsUsd ?? 0)
      ),
      estimatedTotalTokensSaved: Number(
        data.estimated_total_tokens_saved ?? data.estimatedTotalTokensSaved ?? 0
      ),
      categories: (data.categories ?? []) as Record<string, unknown>[],
      directConfidence: Number(data.direct_confidence ?? data.directConfidence ?? 0),
      heuristicConfidenceAvg: Number(
        data.heuristic_confidence_avg ?? data.heuristicConfidenceAvg ?? 0
      ),
      estimationMethod: String(
        data.estimation_method ?? data.estimationMethod ?? 'tiered_attribution_v1'
      ),
      treatmentGroup:
        data.treatment_group != null
          ? String(data.treatment_group)
          : data.treatmentGroup != null
            ? String(data.treatmentGroup)
            : null,
      isMeasured: Boolean(data.is_measured ?? data.isMeasured ?? false),
      completenessStatus: String(data.completeness_status ?? data.completenessStatus ?? 'complete'),
      pricingManifestVersion:
        data.pricing_manifest_version != null
          ? String(data.pricing_manifest_version)
          : data.pricingManifestVersion != null
            ? String(data.pricingManifestVersion)
            : null,
      eventTimestamp,
    };

    try {
      await db
        .insert(savingsEstimates)
        .values(row)
        .onConflictDoUpdate({
          target: savingsEstimates.sourceEventId,
          set: {
            actualTotalTokens: row.actualTotalTokens,
            actualCostUsd: row.actualCostUsd,
            directSavingsUsd: row.directSavingsUsd,
            directTokensSaved: row.directTokensSaved,
            estimatedTotalSavingsUsd: row.estimatedTotalSavingsUsd,
            estimatedTotalTokensSaved: row.estimatedTotalTokensSaved,
            categories: row.categories,
            directConfidence: row.directConfidence,
            heuristicConfidenceAvg: row.heuristicConfidenceAvg,
            completenessStatus: row.completenessStatus,
            ingestedAt: new Date(),
          },
        });
      console.log(
        `[ReadModelConsumer] Projected savings-estimated for session ${sessionId} ` +
          `(total_savings=$${Number(row.estimatedTotalSavingsUsd).toFixed(4)})`
      );
    } catch (err) {
      if (isTableMissingError(err, 'savings_estimates')) {
        console.warn(
          '[ReadModelConsumer] savings_estimates table not yet created -- ' +
            'run migrations to enable savings projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // --------------------------------------------------------------------------
  // Runtime error event projection (OMN-5652)
  // --------------------------------------------------------------------------

  private async projectRuntimeErrorEvent(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const fingerprint = String(data.fingerprint ?? '').trim();
    const errorCategory = String(data.error_category ?? data.errorCategory ?? 'UNKNOWN').trim();
    const severity = String(data.severity ?? 'MEDIUM').trim();
    const logLevel = String(data.log_level ?? data.logLevel ?? 'ERROR').trim();
    const loggerFamily = String(data.logger_family ?? data.loggerFamily ?? 'unknown').trim();
    const errorMessage = String(data.error_message ?? data.errorMessage ?? '').trim();
    const rawLine = String(data.raw_line ?? data.rawLine ?? '').trim();
    const exceptionType = String(data.exception_type ?? data.exceptionType ?? '').trim();
    const stackTrace = String(data.stack_trace ?? data.stackTrace ?? '').trim();
    const container = String(data.container ?? '').trim();
    const emittedAtRaw =
      data.detected_at ?? data.detectedAt ?? data.first_seen_at ?? data.firstSeenAt;
    const emittedAt = safeParseDate(emittedAtRaw) ?? new Date();

    if (!fingerprint) {
      console.warn('[ReadModelConsumer] runtime-error event missing fingerprint, skipping');
      return true;
    }

    const row: InsertRuntimeErrorEvent = {
      id: String(data.event_id ?? data.eventId ?? randomUUID()),
      loggerFamily,
      logLevel,
      messageTemplate: errorMessage.slice(0, 500),
      rawMessage: rawLine.slice(0, 2000),
      errorCategory,
      severity,
      fingerprint,
      exceptionType,
      exceptionMessage: errorMessage.slice(0, 1000),
      stackTrace: stackTrace.slice(0, 5000),
      hostname: container,
      serviceLabel: String(data.source_service ?? data.sourceService ?? container).trim(),
      emittedAt,
    };

    try {
      await db.insert(runtimeErrorEvents).values(row).onConflictDoNothing();
      console.log(
        `[ReadModelConsumer] Projected runtime-error event (fp=${fingerprint.slice(0, 12)}..., cat=${errorCategory})`
      );
    } catch (err) {
      if (isTableMissingError(err, 'runtime_error_events')) {
        console.warn(
          '[ReadModelConsumer] runtime_error_events table not yet created -- ' +
            'run migrations to enable runtime error projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // --------------------------------------------------------------------------
  // Error triage state projection (OMN-5652)
  // --------------------------------------------------------------------------

  private async projectErrorTriaged(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const fingerprint = String(data.fingerprint ?? '').trim();
    const action = String(data.action ?? '').trim();
    const actionStatus = String(data.action_status ?? data.actionStatus ?? 'SUCCESS').trim();

    if (!fingerprint || !action) {
      console.warn(
        '[ReadModelConsumer] error-triaged event missing fingerprint or action, skipping'
      );
      return true;
    }

    const triagedAtRaw = data.triaged_at ?? data.triagedAt;
    const triagedAt = safeParseDate(triagedAtRaw) ?? new Date();
    const firstSeenAtRaw = data.first_seen_at ?? data.firstSeenAt;
    const firstSeenAt = safeParseDate(firstSeenAtRaw) ?? triagedAt;

    const row: InsertRuntimeErrorTriageState = {
      fingerprint,
      lastEventId: String(data.event_id ?? data.eventId ?? randomUUID()),
      action,
      actionStatus,
      ticketId: data.ticket_id != null ? String(data.ticket_id) : null,
      ticketUrl: data.ticket_url != null ? String(data.ticket_url) : null,
      autoFixType: data.auto_fix_type != null ? String(data.auto_fix_type) : null,
      autoFixVerified: data.auto_fix_verified != null ? Boolean(data.auto_fix_verified) : null,
      severity: String(data.severity ?? 'MEDIUM').trim(),
      errorCategory: String(data.error_category ?? data.errorCategory ?? 'UNKNOWN').trim(),
      container: String(data.container ?? '').trim(),
      operatorAttentionRequired: Boolean(
        data.operator_attention_required ?? data.operatorAttentionRequired ?? false
      ),
      recurrenceCount: Number(data.recurrence_count ?? data.recurrenceCount ?? 1),
      firstSeenAt,
      lastSeenAt: triagedAt,
      lastTriagedAt: triagedAt,
    };

    try {
      await db
        .insert(runtimeErrorTriageState)
        .values(row)
        .onConflictDoUpdate({
          target: runtimeErrorTriageState.fingerprint,
          set: {
            lastEventId: row.lastEventId,
            action: row.action,
            actionStatus: row.actionStatus,
            ticketId: row.ticketId,
            ticketUrl: row.ticketUrl,
            autoFixType: row.autoFixType,
            autoFixVerified: row.autoFixVerified,
            severity: row.severity,
            errorCategory: row.errorCategory,
            container: row.container,
            operatorAttentionRequired: row.operatorAttentionRequired,
            recurrenceCount: row.recurrenceCount,
            lastSeenAt: row.lastSeenAt,
            lastTriagedAt: row.lastTriagedAt,
            updatedAt: new Date(),
          },
        });
      console.log(
        `[ReadModelConsumer] Projected error-triaged (fp=${fingerprint.slice(0, 12)}..., action=${action})`
      );
    } catch (err) {
      if (isTableMissingError(err, 'runtime_error_triage_state')) {
        console.warn(
          '[ReadModelConsumer] runtime_error_triage_state table not yet created -- ' +
            'run migrations to enable triage state projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // --------------------------------------------------------------------------
  // Infrastructure routing decision projection (OMN-7447)
  // --------------------------------------------------------------------------

  private async projectInfraRoutingDecided(
    data: Record<string, unknown>,
    context: ProjectionContext
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const correlationId = String(data.correlation_id ?? data.correlationId ?? '').trim();
    const selectedProvider = String(data.selected_provider ?? data.selectedProvider ?? '').trim();

    if (!correlationId || !selectedProvider) {
      console.warn(
        '[ReadModelConsumer] routing-decided event missing correlation_id or selected_provider'
      );
      return true;
    }

    const row: InsertInfraRoutingDecision = {
      correlationId,
      sessionId:
        data.session_id != null
          ? String(data.session_id)
          : data.sessionId != null
            ? String(data.sessionId)
            : null,
      selectedProvider,
      selectedTier: String(data.selected_tier ?? data.selectedTier ?? 'claude'),
      selectedModel: String(data.selected_model ?? data.selectedModel ?? ''),
      reason: String(data.reason ?? ''),
      selectionMode: String(data.selection_mode ?? data.selectionMode ?? 'round_robin'),
      isFallback: Boolean(data.is_fallback ?? data.isFallback ?? false),
      candidatesEvaluated: Number(data.candidates_evaluated ?? data.candidatesEvaluated ?? 1),
      taskType:
        data.task_type != null
          ? String(data.task_type)
          : data.taskType != null
            ? String(data.taskType)
            : null,
      latencyMs:
        data.latency_ms != null
          ? String(data.latency_ms)
          : data.latencyMs != null
            ? String(data.latencyMs)
            : null,
      createdAt: safeParseDate(data.timestamp ?? data.created_at ?? data.createdAt) ?? new Date(),
    };

    try {
      await db
        .insert(infraRoutingDecisions)
        .values(row)
        .onConflictDoUpdate({
          target: infraRoutingDecisions.correlationId,
          set: {
            selectedProvider: row.selectedProvider,
            selectedTier: row.selectedTier,
            selectedModel: row.selectedModel,
            reason: row.reason,
            selectionMode: row.selectionMode,
            isFallback: row.isFallback,
            candidatesEvaluated: row.candidatesEvaluated,
            latencyMs: row.latencyMs,
            projectedAt: new Date(),
          },
        });
      console.log(
        `[ReadModelConsumer] Projected infra routing-decided (provider=${selectedProvider}, fallback=${row.isFallback})`
      );
    } catch (err) {
      if (isTableMissingError(err, 'infra_routing_decisions')) {
        console.warn(
          '[ReadModelConsumer] infra_routing_decisions table not yet created -- ' +
            'run migrations to enable infra routing projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Consumer health events -> consumer_health_events (OMN-5527)
  // -------------------------------------------------------------------------

  private async projectConsumerHealth(
    data: Record<string, unknown>,
    context: ProjectionContext,
    meta: MessageMeta
  ): Promise<boolean> {
    const { db } = context;
    if (!db) return false;

    const rawId = String(data.event_id ?? data.eventId ?? data.id ?? '').trim();
    const id = rawId && UUID_RE.test(rawId) ? rawId : meta.fallbackId;

    const toNullableNumber = (value: unknown): number | null => {
      if (value == null || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const consumerIdentity = String(data.consumer_identity ?? data.consumerIdentity ?? '').trim();
    const consumerGroup = String(data.consumer_group ?? data.consumerGroup ?? '').trim();
    const topic = String(data.topic ?? '').trim();
    const eventType = String(data.event_type ?? data.eventType ?? '').trim();
    const severity = String(data.severity ?? 'INFO').trim();

    if (!consumerIdentity || !topic || !eventType) {
      console.warn('[ReadModelConsumer] consumer-health event missing required fields', {
        consumerIdentity,
        topic,
        eventType,
      });
      return true;
    }

    const row: InsertConsumerHealthEvent = {
      id,
      consumerIdentity,
      consumerGroup,
      topic,
      eventType,
      severity,
      fingerprint: String(data.fingerprint ?? '').trim(),
      errorMessage: String(data.error_message ?? data.errorMessage ?? '').slice(0, 2000),
      errorType: String(data.error_type ?? data.errorType ?? '').trim(),
      hostname: String(data.hostname ?? '').trim(),
      serviceLabel: String(data.service_label ?? data.serviceLabel ?? '').trim(),
      rebalanceDurationMs: toNullableNumber(
        data.rebalance_duration_ms ?? data.rebalanceDurationMs
      ),
      partitionsAssigned: toNullableNumber(
        data.partitions_assigned ?? data.partitionsAssigned
      ),
      partitionsRevoked: toNullableNumber(
        data.partitions_revoked ?? data.partitionsRevoked
      ),
      emittedAt: safeParseDate(data.emitted_at ?? data.emittedAt ?? data.timestamp),
    };

    try {
      await db.insert(consumerHealthEvents).values(row).onConflictDoNothing();
    } catch (err) {
      if (isTableMissingError(err, 'consumer_health_events')) {
        console.warn(
          '[ReadModelConsumer] consumer_health_events table not yet created -- ' +
            'run migrations to enable consumer health projection'
        );
        return true;
      }
      throw err;
    }

    return true;
  }
}
