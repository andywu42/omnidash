/**
 * Baselines & ROI Data Source (OMN-2156)
 *
 * Fetches baselines/ROI metrics from API endpoints.
 */

import type {
  BaselinesSummary,
  PatternComparison,
  ROITrendPoint,
  RecommendationBreakdown,
} from '@shared/baselines-types';
import { buildApiUrl } from './api-base';

class BaselinesSource {
  private baseUrl = buildApiUrl('/api/baselines');

  async summary(): Promise<BaselinesSummary> {
    const response = await fetch(`${this.baseUrl}/summary`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    // Guard: older server versions may omit trend_point_count.
    const summary: BaselinesSummary =
      typeof data.trend_point_count === 'number'
        ? (data as BaselinesSummary)
        : { ...data, trend_point_count: 0 };
    return summary;
  }

  async comparisons(): Promise<PatternComparison[]> {
    const response = await fetch(`${this.baseUrl}/comparisons`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async trend(days?: number): Promise<ROITrendPoint[]> {
    const response = await fetch(`${this.baseUrl}/trend?days=${days ?? 14}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async breakdown(): Promise<RecommendationBreakdown[]> {
    const response = await fetch(`${this.baseUrl}/breakdown`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}

export const baselinesSource = new BaselinesSource();
