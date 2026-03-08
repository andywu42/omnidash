/**
 * Model Efficiency Data Source (OMN-3939)
 *
 * Fetches MEI metrics from the API with graceful fallback to mock data.
 * Follows the same API-first + mock-fallback pattern as effectiveness-source.ts.
 */

import type {
  ModelEfficiencySummary,
  ModelEfficiencyTrendPoint,
  PrValidationRollup,
  ModelEfficiencyComparison,
} from '@shared/model-efficiency-types';
import {
  getMockModelEfficiencySummary,
  getMockModelEfficiencyTrend,
  getMockPrValidationRollups,
  getMockModelEfficiencyComparison,
} from '@/lib/mock-data/model-efficiency-mock';
import { buildApiUrl } from '@/lib/data-sources/api-base';

export interface ModelEfficiencyFetchOptions {
  /** Fall back to mock data on network/HTTP errors (default: false). */
  fallbackToMock?: boolean;
  /** Also fall back to mock when the API returns empty results (default: false). */
  mockOnEmpty?: boolean;
  /** Skip the API call entirely and return canned demo data. */
  demoMode?: boolean;
}

class ModelEfficiencySource {
  private baseUrl = buildApiUrl('/api/model-efficiency');
  private _mockEndpoints = new Set<string>();

  /** True if any endpoint fell back to mock data. */
  get isUsingMockData(): boolean {
    return this._mockEndpoints.size > 0;
  }

  private markReal(endpoint: string): void {
    this._mockEndpoints.delete(endpoint);
  }

  private markMock(endpoint: string): void {
    this._mockEndpoints.add(endpoint);
  }

  async summary(
    days = 30,
    options: ModelEfficiencyFetchOptions = {}
  ): Promise<ModelEfficiencySummary[]> {
    const { fallbackToMock = false, mockOnEmpty = false, demoMode = false } = options;
    if (demoMode) {
      this.markMock('summary');
      return getMockModelEfficiencySummary();
    }
    try {
      const response = await fetch(`${this.baseUrl}/summary?days=${days}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: ModelEfficiencySummary[] = await response.json();
      if (!Array.isArray(data)) {
        throw new Error('Malformed response: expected array');
      }
      if (mockOnEmpty && data.length === 0) {
        this.markMock('summary');
        return getMockModelEfficiencySummary();
      }
      this.markReal('summary');
      return data;
    } catch (error) {
      if (fallbackToMock) {
        console.warn('[ModelEfficiencySource] API unavailable for summary, using demo data');
        this.markMock('summary');
        return getMockModelEfficiencySummary();
      }
      throw error;
    }
  }

  async trend(
    days = 14,
    modelId?: string,
    options: ModelEfficiencyFetchOptions = {}
  ): Promise<ModelEfficiencyTrendPoint[]> {
    const { fallbackToMock = false, mockOnEmpty = false, demoMode = false } = options;
    if (demoMode) {
      this.markMock('trend');
      return getMockModelEfficiencyTrend();
    }
    try {
      let url = `${this.baseUrl}/trend?days=${days}`;
      if (modelId) url += `&model_id=${encodeURIComponent(modelId)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: ModelEfficiencyTrendPoint[] = await response.json();
      if (!Array.isArray(data)) {
        throw new Error('Malformed response: expected array');
      }
      if (mockOnEmpty && data.length === 0) {
        this.markMock('trend');
        return getMockModelEfficiencyTrend();
      }
      this.markReal('trend');
      return data;
    } catch (error) {
      if (fallbackToMock) {
        console.warn('[ModelEfficiencySource] API unavailable for trend, using demo data');
        this.markMock('trend');
        return getMockModelEfficiencyTrend();
      }
      throw error;
    }
  }

  async rollups(
    modelId?: string,
    limit = 50,
    status?: string,
    options: ModelEfficiencyFetchOptions = {}
  ): Promise<PrValidationRollup[]> {
    const { fallbackToMock = false, demoMode = false } = options;
    if (demoMode) {
      this.markMock('rollups');
      return getMockPrValidationRollups();
    }
    try {
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
      this.markReal('rollups');
      return data;
    } catch (error) {
      if (fallbackToMock) {
        console.warn('[ModelEfficiencySource] API unavailable for rollups, using demo data');
        this.markMock('rollups');
        return getMockPrValidationRollups();
      }
      throw error;
    }
  }

  async comparison(
    options: ModelEfficiencyFetchOptions = {}
  ): Promise<ModelEfficiencyComparison[]> {
    const { fallbackToMock = false, mockOnEmpty = false, demoMode = false } = options;
    if (demoMode) {
      this.markMock('comparison');
      return getMockModelEfficiencyComparison();
    }
    try {
      const response = await fetch(`${this.baseUrl}/comparison`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: ModelEfficiencyComparison[] = await response.json();
      if (!Array.isArray(data)) {
        throw new Error('Malformed response: expected array');
      }
      if (mockOnEmpty && data.length === 0) {
        this.markMock('comparison');
        return getMockModelEfficiencyComparison();
      }
      this.markReal('comparison');
      return data;
    } catch (error) {
      if (fallbackToMock) {
        console.warn('[ModelEfficiencySource] API unavailable for comparison, using demo data');
        this.markMock('comparison');
        return getMockModelEfficiencyComparison();
      }
      throw error;
    }
  }
}

/** Singleton data source instance shared across components. */
export const modelEfficiencySource = new ModelEfficiencySource();
