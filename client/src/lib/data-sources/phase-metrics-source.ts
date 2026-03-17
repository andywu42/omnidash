/**
 * Phase Metrics Data Source (OMN-5184)
 *
 * Fetches phase metrics summary and by-phase data from the API.
 * Used by the SpeedCategory dashboard.
 */

import { buildApiUrl } from './api-base';

export interface PhaseMetricsSummary {
  totalPhaseRuns: number;
  avgDurationMs: number;
  byStatus: { success: number; failure: number; skipped: number };
  window: '24h' | '7d' | '30d';
}

export interface PhaseMetricsByPhase {
  phases: Array<{
    phase: string;
    count: number;
    avgDurationMs: number;
    successRate: number;
  }>;
  window: '24h' | '7d' | '30d';
}

class PhaseMetricsSource {
  private baseUrl = buildApiUrl('/api/phase-metrics');

  async summary(window: '24h' | '7d' | '30d' = '7d'): Promise<PhaseMetricsSummary> {
    const response = await fetch(`${this.baseUrl}/summary?window=${window}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async byPhase(window: '24h' | '7d' | '30d' = '7d'): Promise<PhaseMetricsByPhase> {
    const response = await fetch(`${this.baseUrl}/by-phase?window=${window}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}

export const phaseMetricsSource = new PhaseMetricsSource();
