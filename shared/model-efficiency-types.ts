/**
 * Model Efficiency Index (MEI) Types (OMN-3939)
 *
 * Shared TypeScript interfaces for the MEI dashboard.
 * Used by both client data sources and server API routes.
 */

export interface ModelEfficiencySummary {
  model_id: string;
  pr_count: number;
  median_vts: number;
  median_vts_per_kloc: number;
  avg_vts: number;
  avg_vts_per_kloc: number;
  total_blocking_failures: number;
  total_reruns: number;
  total_autofixes: number;
  avg_time_to_green_ms: number;
  metric_version: string;
}

export interface ModelEfficiencyTrendPoint {
  date: string;
  model_id: string;
  median_vts: number;
  pr_count: number;
}

export interface PrValidationRollup {
  run_id: string;
  repo_id: string;
  pr_id: string;
  pr_url: string;
  model_id: string;
  producer_kind: string;
  rollup_status: 'final' | 'partial';
  vts: number;
  vts_per_kloc: number;
  blocking_failures: number;
  reruns: number;
  time_to_green_ms: number;
  missing_fields: string[];
  emitted_at: string;
}

export interface ModelEfficiencyComparison {
  model_id: string;
  pr_count: number;
  median_vts: number;
  median_vts_per_kloc: number;
  avg_vts: number;
  avg_vts_per_kloc: number;
  total_blocking_failures: number;
  total_reruns: number;
  total_autofixes: number;
  avg_time_to_green_ms: number;
  metric_version: string;
}
