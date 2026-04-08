/**
 * Cost Trend Data Source (OMN-2242)
 *
 * Fetches cost/token metrics from API. Returns real data or throws on failure.
 */

import type {
  CostSummary,
  CostTrendPoint,
  CostByModel,
  CostByRepo,
  CostByPattern,
  TokenUsagePoint,
  BudgetAlert,
  CostTimeWindow,
} from '@shared/cost-types';
import { buildApiUrl } from './api-base';

export interface CostFetchOptions {
  /** Include estimated data (default: false -- API-reported only). */
  includeEstimated?: boolean;
  /** Filter by a specific model name. */
  model?: string;
}

/**
 * Client-side data source for all cost dashboard endpoints.
 *
 * Each method calls the real API and throws on failure — no mock fallbacks.
 */
class CostSource {
  private baseUrl = buildApiUrl('/api/costs');

  /** Build URL query string from window, includeEstimated, and model options. */
  private buildParams(options: {
    window?: CostTimeWindow;
    includeEstimated?: boolean;
    model?: string;
  }): string {
    const params = new URLSearchParams();
    if (options.window) params.set('window', options.window);
    if (options.includeEstimated) params.set('includeEstimated', 'true');
    if (options.model) params.set('model', options.model);
    return params.toString() ? `?${params.toString()}` : '';
  }

  /** Fetch top-level cost summary metrics for the given time window. */
  async summary(
    window: CostTimeWindow = '7d',
    options: CostFetchOptions = {}
  ): Promise<CostSummary> {
    const { includeEstimated } = options;
    const response = await fetch(
      `${this.baseUrl}/summary${this.buildParams({ window, includeEstimated })}`
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** Fetch cost-over-time data points for the line chart. */
  async trend(
    window: CostTimeWindow = '7d',
    options: CostFetchOptions = {}
  ): Promise<CostTrendPoint[]> {
    const { includeEstimated, model } = options;
    const response = await fetch(
      `${this.baseUrl}/trend${this.buildParams({ window, includeEstimated, model })}`
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** Fetch aggregate cost breakdown grouped by LLM model. */
  async byModel(options: CostFetchOptions = {}): Promise<CostByModel[]> {
    const { includeEstimated } = options;
    const response = await fetch(
      `${this.baseUrl}/by-model${this.buildParams({ includeEstimated })}`
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** Fetch aggregate cost breakdown grouped by repository. */
  async byRepo(options: CostFetchOptions = {}): Promise<CostByRepo[]> {
    const { includeEstimated } = options;
    const response = await fetch(
      `${this.baseUrl}/by-repo${this.buildParams({ includeEstimated })}`
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** Fetch per-pattern cost and injection frequency data. */
  async byPattern(options: CostFetchOptions = {}): Promise<CostByPattern[]> {
    const { includeEstimated } = options;
    const response = await fetch(
      `${this.baseUrl}/by-pattern${this.buildParams({ includeEstimated })}`
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** Fetch prompt vs completion token breakdown for the stacked bar chart. */
  async tokenUsage(
    window: CostTimeWindow = '7d',
    options: CostFetchOptions = {}
  ): Promise<TokenUsagePoint[]> {
    const { includeEstimated } = options;
    const response = await fetch(
      `${this.baseUrl}/token-usage${this.buildParams({ window, includeEstimated })}`
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** Fetch configured budget threshold alerts and their current status. */
  async alerts(): Promise<BudgetAlert[]> {
    const response = await fetch(`${this.baseUrl}/alerts`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}

/** Singleton data source instance shared across components. */
export const costSource = new CostSource();
