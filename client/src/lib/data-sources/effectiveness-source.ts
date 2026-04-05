/**
 * Injection Effectiveness Data Source
 *
 * Fetches effectiveness metrics from API endpoints.
 *
 * @see OMN-1891 - Build Effectiveness Dashboard
 * @see OMN-2330 - Remove mock fallback, serve real data
 */

import type {
  EffectivenessSummary,
  ThrottleStatus,
  LatencyDetails,
  UtilizationDetails,
  ABComparison,
  EffectivenessTrendPoint,
  SessionDetail,
} from '@shared/effectiveness-types';

class EffectivenessSource {
  private baseUrl = '/api/effectiveness';

  async summary(): Promise<EffectivenessSummary> {
    const response = await fetch(`${this.baseUrl}/summary`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async throttleStatus(): Promise<ThrottleStatus> {
    const response = await fetch(`${this.baseUrl}/throttle`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async latencyDetails(): Promise<LatencyDetails> {
    const response = await fetch(`${this.baseUrl}/latency`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async utilizationDetails(): Promise<UtilizationDetails> {
    const response = await fetch(`${this.baseUrl}/utilization`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async abComparison(): Promise<ABComparison> {
    const response = await fetch(`${this.baseUrl}/ab`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async sessionDetail(sessionId: string): Promise<SessionDetail> {
    const response = await fetch(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async trend(days?: number): Promise<EffectivenessTrendPoint[]> {
    const response = await fetch(`${this.baseUrl}/trend?days=${days ?? 14}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: EffectivenessTrendPoint[] = await response.json();
    if (!Array.isArray(data)) {
      console.warn('[EffectivenessSource] /trend response is not an array, returning empty');
      return [];
    }
    return data;
  }
}

export const effectivenessSource = new EffectivenessSource();
