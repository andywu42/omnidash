/**
 * Omnibase-infra domain projection handlers (OMN-5192).
 *
 * Projects events from omnibase-infra topics into the omnidash_analytics read-model:
 * - Baselines computed -> baselines_snapshots / baselines_comparisons / baselines_trend / baselines_breakdown
 * - LLM health snapshot -> llm_health_snapshots (OMN-5279)
 * - Wiring health snapshot -> in-memory WiringHealthProjection (OMN-5292)
 */

import { eq } from 'drizzle-orm';
import {
  baselinesSnapshots,
  baselinesComparisons,
  baselinesTrend,
  baselinesBreakdown,
  llmHealthSnapshots,
} from '@shared/intelligence-schema';
import type {
  InsertBaselinesSnapshot,
  InsertBaselinesComparison,
  InsertBaselinesTrend,
  InsertBaselinesBreakdown,
  InsertLlmHealthSnapshot,
} from '@shared/intelligence-schema';
import { baselinesProjection } from '../../projection-bootstrap';
import { emitBaselinesUpdate } from '../../baselines-events';
import {
  SUFFIX_OMNIBASE_INFRA_BASELINES_COMPUTED,
  SUFFIX_OMNIBASE_INFRA_LLM_HEALTH_SNAPSHOT,
  TOPIC_OMNIBASE_INFRA_WIRING_HEALTH_SNAPSHOT,
} from '@shared/topics';
import { wiringHealthProjection } from '../../projections/wiring-health-projection';
import type { TopicWiringRecord } from '../../projections/wiring-health-projection';

import type { ProjectionHandler, ProjectionContext, MessageMeta } from './types';
import {
  safeParseDate,
  safeParseDateOrMin,
  isTableMissingError,
  deterministicCorrelationId,
  UUID_RE,
  MAX_BATCH_ROWS,
  VALID_PROMOTION_ACTIONS,
  VALID_CONFIDENCE_LEVELS,
} from './types';

const BASELINES_TOPIC = SUFFIX_OMNIBASE_INFRA_BASELINES_COMPUTED;
const LLM_HEALTH_TOPIC = SUFFIX_OMNIBASE_INFRA_LLM_HEALTH_SNAPSHOT;
const WIRING_HEALTH_TOPIC = TOPIC_OMNIBASE_INFRA_WIRING_HEALTH_SNAPSHOT;

const OMNIBASE_INFRA_TOPICS = new Set([
  SUFFIX_OMNIBASE_INFRA_BASELINES_COMPUTED,
  SUFFIX_OMNIBASE_INFRA_LLM_HEALTH_SNAPSHOT,
  TOPIC_OMNIBASE_INFRA_WIRING_HEALTH_SNAPSHOT,
]);

export class OmnibaseInfraProjectionHandler implements ProjectionHandler {
  canHandle(topic: string): boolean {
    return OMNIBASE_INFRA_TOPICS.has(topic);
  }

  async projectEvent(
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
    return false;
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
        const date = t.date ?? t.dateStr;
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
        date: String(t.date ?? t.dateStr),
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
}
