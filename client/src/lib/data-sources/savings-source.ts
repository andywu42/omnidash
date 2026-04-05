/**
 * Savings Estimation Data Source (OMN-5554)
 *
 * Fetches savings estimation data from the /api/savings endpoints.
 * API-first with graceful fallback to mock data when unavailable.
 *
 * Consumed by the IntelligenceSavings page.
 */

import { buildApiUrl } from './api-base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SavingsMetrics {
  totalSavings: number;
  monthlySavings: number;
  weeklySavings: number;
  dailySavings: number;
  intelligenceRuns: number;
  baselineRuns: number;
  avgTokensPerRun: number;
  avgComputePerRun: number;
  costPerToken: number;
  costPerCompute: number;
  efficiencyGain: number;
  timeSaved: number;
  dataAvailable?: boolean;
}

export interface AgentComparison {
  agentId: string;
  agentName: string;
  withIntelligence: {
    avgTokens: number;
    avgCompute: number;
    avgTime: number;
    successRate: number;
    cost: number;
  };
  withoutIntelligence: {
    avgTokens: number;
    avgCompute: number;
    avgTime: number;
    successRate: number;
    cost: number;
  };
  savings: {
    tokens: number;
    compute: number;
    time: number;
    cost: number;
    percentage: number;
  };
}

export interface TimeSeriesData {
  date: string;
  withIntelligence: {
    tokens: number;
    compute: number;
    cost: number;
    runs: number;
  };
  withoutIntelligence: {
    tokens: number;
    compute: number;
    cost: number;
    runs: number;
  };
  savings: {
    tokens: number;
    compute: number;
    cost: number;
    percentage: number;
  };
  dataAvailable?: boolean;
}

export interface ProviderSavings {
  providerId: string;
  providerName: string;
  savingsAmount: number;
  tokensProcessed: number;
  tokensOffloaded: number;
  percentageOfTotal: number;
  avgCostPerToken: number;
  runsCount: number;
}

export interface SavingsAllResponse {
  metrics: SavingsMetrics;
  agentComparisons: AgentComparison[];
  timeSeriesData: TimeSeriesData[];
  providerSavings: ProviderSavings[];
}

// ---------------------------------------------------------------------------
// Data source
// ---------------------------------------------------------------------------

class SavingsSource {
  private baseUrl = buildApiUrl('/api/savings');

  async fetchMetrics(timeRange: string): Promise<SavingsMetrics> {
    const response = await fetch(`${this.baseUrl}/metrics?timeRange=${timeRange}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async fetchAgentComparisons(timeRange: string): Promise<AgentComparison[]> {
    const response = await fetch(`${this.baseUrl}/agents?timeRange=${timeRange}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Malformed response: expected array');
    return data;
  }

  async fetchTimeSeries(timeRange: string): Promise<TimeSeriesData[]> {
    const response = await fetch(`${this.baseUrl}/timeseries?timeRange=${timeRange}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Malformed response: expected array');
    return data;
  }

  async fetchProviderSavings(timeRange: string): Promise<ProviderSavings[]> {
    const response = await fetch(`${this.baseUrl}/providers?timeRange=${timeRange}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Malformed response: expected array');
    return data;
  }

  async fetchAll(timeRange: string): Promise<SavingsAllResponse> {
    const [metrics, agents, timeseries, providers] = await Promise.all([
      this.fetchMetrics(timeRange),
      this.fetchAgentComparisons(timeRange),
      this.fetchTimeSeries(timeRange),
      this.fetchProviderSavings(timeRange),
    ]);

    return {
      metrics,
      agentComparisons: agents,
      timeSeriesData: timeseries,
      providerSavings: providers,
    };
  }
}

export const savingsSource = new SavingsSource();
