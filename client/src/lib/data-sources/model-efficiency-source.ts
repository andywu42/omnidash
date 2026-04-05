/**
 * Model Efficiency Data Source (OMN-3939)
 *
 * Fetches MEI metrics from the API.
 */

import type {
  ModelEfficiencySummary,
  ModelEfficiencyTrendPoint,
  PrValidationRollup,
  ModelEfficiencyComparison,
} from '@shared/model-efficiency-types';
import { buildApiUrl } from '@/lib/data-sources/api-base';

class ModelEfficiencySource {
  private baseUrl = buildApiUrl('/api/model-efficiency');

  async summary(days = 30): Promise<ModelEfficiencySummary[]> {
    const response = await fetch(`${this.baseUrl}/summary?days=${days}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: ModelEfficiencySummary[] = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Malformed response: expected array');
    }
    return data;
  }

  async trend(days = 14, modelId?: string): Promise<ModelEfficiencyTrendPoint[]> {
    let url = `${this.baseUrl}/trend?days=${days}`;
    if (modelId) url += `&model_id=${encodeURIComponent(modelId)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: ModelEfficiencyTrendPoint[] = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Malformed response: expected array');
    }
    return data;
  }

  async rollups(modelId?: string, limit = 50, status?: string): Promise<PrValidationRollup[]> {
    const params = new URLSearchParams();
    if (modelId) params.set('model_id', modelId);
    params.set('limit', String(limit));
    if (status) params.set('status', status);
    const response = await fetch(`${this.baseUrl}/rollups?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: PrValidationRollup[] = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Malformed response: expected array');
    }
    return data;
  }

  async comparison(): Promise<ModelEfficiencyComparison[]> {
    const response = await fetch(`${this.baseUrl}/comparison`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: ModelEfficiencyComparison[] = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Malformed response: expected array');
    }
    return data;
  }
}

/** Singleton data source instance shared across components. */
export const modelEfficiencySource = new ModelEfficiencySource();
