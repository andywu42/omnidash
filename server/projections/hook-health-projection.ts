/**
 * Hook health error events projection (OMN-7160).
 *
 * Provides time-windowed summary of hook error events for the
 * hook health dashboard card and API route.
 */

import { hookHealthEvents } from '@shared/intelligence-schema';
import { desc, gte, count, max, sql } from 'drizzle-orm';
import { tryGetIntelligenceDb } from '../storage';

export interface HookHealthSummary {
  total_errors: number;
  tier_counts: Record<string, number>;
  category_counts: Record<string, number>;
  hook_counts: Record<string, number>;
  top_fingerprints: Array<{
    fingerprint: string;
    hook_name: string;
    error_category: string;
    error_message: string;
    occurrence_count: number;
    last_seen: string;
  }>;
}

const EMPTY_SUMMARY: HookHealthSummary = {
  total_errors: 0,
  tier_counts: {},
  category_counts: {},
  hook_counts: {},
  top_fingerprints: [],
};

export class HookHealthProjection {
  async summary(windowMinutes: number = 1440): Promise<HookHealthSummary> {
    const db = tryGetIntelligenceDb();
    if (!db) return EMPTY_SUMMARY;

    const since = new Date(Date.now() - windowMinutes * 60 * 1000);

    try {
      // All aggregations use SQL GROUP BY for accuracy across the full window
      // (no in-memory capping that would skew breakdowns vs total_errors).

      const [totalResult, tierResult, categoryResult, hookResult, fingerprintResult] =
        await Promise.all([
          // Total error count
          db
            .select({ count: count() })
            .from(hookHealthEvents)
            .where(gte(hookHealthEvents.emittedAt, since)),

          // Tier breakdown
          db
            .select({
              tier: hookHealthEvents.errorTier,
              count: count(),
            })
            .from(hookHealthEvents)
            .where(gte(hookHealthEvents.emittedAt, since))
            .groupBy(hookHealthEvents.errorTier),

          // Category breakdown
          db
            .select({
              category: hookHealthEvents.errorCategory,
              count: count(),
            })
            .from(hookHealthEvents)
            .where(gte(hookHealthEvents.emittedAt, since))
            .groupBy(hookHealthEvents.errorCategory),

          // Hook breakdown
          db
            .select({
              hookName: hookHealthEvents.hookName,
              count: count(),
            })
            .from(hookHealthEvents)
            .where(gte(hookHealthEvents.emittedAt, since))
            .groupBy(hookHealthEvents.hookName),

          // Top fingerprints (skip blank fingerprints)
          db
            .select({
              fingerprint: hookHealthEvents.fingerprint,
              hookName: hookHealthEvents.hookName,
              errorCategory: hookHealthEvents.errorCategory,
              errorMessage: hookHealthEvents.errorMessage,
              count: count(),
              lastSeen: max(hookHealthEvents.emittedAt),
            })
            .from(hookHealthEvents)
            .where(gte(hookHealthEvents.emittedAt, since))
            .groupBy(
              hookHealthEvents.fingerprint,
              hookHealthEvents.hookName,
              hookHealthEvents.errorCategory,
              hookHealthEvents.errorMessage
            )
            .having(sql`trim(${hookHealthEvents.fingerprint}) != ''`)
            .orderBy(desc(count()))
            .limit(10),
        ]);

      const tierCounts: Record<string, number> = {};
      for (const r of tierResult) {
        tierCounts[r.tier] = r.count;
      }

      const categoryCounts: Record<string, number> = {};
      for (const r of categoryResult) {
        categoryCounts[r.category] = r.count;
      }

      const hookCounts: Record<string, number> = {};
      for (const r of hookResult) {
        hookCounts[r.hookName] = r.count;
      }

      const topFingerprints = fingerprintResult.map((r) => ({
        fingerprint: r.fingerprint,
        hook_name: r.hookName,
        error_category: r.errorCategory,
        error_message: (r.errorMessage ?? '').slice(0, 200),
        occurrence_count: r.count,
        last_seen: r.lastSeen?.toISOString() ?? new Date().toISOString(),
      }));

      return {
        total_errors: totalResult[0]?.count ?? 0,
        tier_counts: tierCounts,
        category_counts: categoryCounts,
        hook_counts: hookCounts,
        top_fingerprints: topFingerprints,
      };
    } catch {
      console.warn('[HookHealthProjection] query failed, returning empty summary');
      return EMPTY_SUMMARY;
    }
  }
}
