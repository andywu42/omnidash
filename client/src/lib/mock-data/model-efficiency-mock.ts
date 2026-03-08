/**
 * Mock Data: Model Efficiency Index (OMN-3939)
 *
 * Realistic demo data for the MEI dashboard.
 * Uses 3 generic models (model-alpha, model-beta, model-gamma) with
 * varied VTS scores and 14-day trend data.
 */

import type {
  ModelEfficiencySummary,
  ModelEfficiencyTrendPoint,
  PrValidationRollup,
  ModelEfficiencyComparison,
} from '@shared/model-efficiency-types';

// ============================================================================
// Helpers
// ============================================================================

function isoDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function isoTs(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

// ============================================================================
// Summary
// ============================================================================

export function getMockModelEfficiencySummary(): ModelEfficiencySummary[] {
  return [
    {
      model_id: 'model-alpha',
      pr_count: 42,
      median_vts: 12.3,
      median_vts_per_kloc: 4.1,
      avg_vts: 13.8,
      avg_vts_per_kloc: 4.6,
      total_blocking_failures: 3,
      total_reruns: 7,
      total_autofixes: 18,
      avg_time_to_green_ms: 45000,
      metric_version: 'v1',
    },
    {
      model_id: 'model-beta',
      pr_count: 38,
      median_vts: 18.7,
      median_vts_per_kloc: 6.2,
      avg_vts: 20.1,
      avg_vts_per_kloc: 6.7,
      total_blocking_failures: 8,
      total_reruns: 15,
      total_autofixes: 12,
      avg_time_to_green_ms: 62000,
      metric_version: 'v1',
    },
    {
      model_id: 'model-gamma',
      pr_count: 25,
      median_vts: 9.1,
      median_vts_per_kloc: 3.0,
      avg_vts: 10.4,
      avg_vts_per_kloc: 3.5,
      total_blocking_failures: 1,
      total_reruns: 3,
      total_autofixes: 22,
      avg_time_to_green_ms: 32000,
      metric_version: 'v1',
    },
  ];
}

// ============================================================================
// Trend (14-day)
// ============================================================================

export function getMockModelEfficiencyTrend(): ModelEfficiencyTrendPoint[] {
  const models = ['model-alpha', 'model-beta', 'model-gamma'];
  const baseVts: Record<string, number> = {
    'model-alpha': 13,
    'model-beta': 19,
    'model-gamma': 9.5,
  };

  const points: ModelEfficiencyTrendPoint[] = [];
  for (let day = 13; day >= 0; day--) {
    for (const model of models) {
      const base = baseVts[model];
      // Slight downward trend (improving) with day-to-day noise
      const noise = Math.sin(day * 1.3 + models.indexOf(model)) * 1.5;
      const trend = day * 0.15;
      points.push({
        date: isoDate(day),
        model_id: model,
        median_vts: Math.max(1, base + trend + noise),
        pr_count: 2 + Math.floor(Math.random() * 4),
      });
    }
  }
  return points;
}

// ============================================================================
// Rollups (raw drill-down)
// ============================================================================

export function getMockPrValidationRollups(): PrValidationRollup[] {
  const models = ['model-alpha', 'model-beta', 'model-gamma'];
  const rollups: PrValidationRollup[] = [];

  for (let i = 0; i < 15; i++) {
    const model = models[i % 3];
    const isFinal = i < 12;
    rollups.push({
      run_id: `run-${String(1000 + i)}`,
      repo_id: i % 2 === 0 ? 'omnibase_core' : 'omniclaude',
      pr_id: `${100 + i}`,
      pr_url: `https://github.com/OmniNode-ai/${i % 2 === 0 ? 'omnibase_core' : 'omniclaude'}/pull/${100 + i}`,
      model_id: model,
      producer_kind: 'ticket-pipeline',
      rollup_status: isFinal ? 'final' : 'partial',
      vts: 8 + Math.random() * 15,
      vts_per_kloc: 2 + Math.random() * 6,
      blocking_failures: Math.floor(Math.random() * 3),
      reruns: Math.floor(Math.random() * 4),
      time_to_green_ms: 20000 + Math.floor(Math.random() * 60000),
      missing_fields: i === 3 ? ['autofix_successes', 'human_escalations'] : [],
      emitted_at: isoTs(Math.floor(i / 3)),
    });
  }

  return rollups;
}

// ============================================================================
// Comparison (same shape as summary — used for side-by-side view)
// ============================================================================

export function getMockModelEfficiencyComparison(): ModelEfficiencyComparison[] {
  return getMockModelEfficiencySummary();
}
