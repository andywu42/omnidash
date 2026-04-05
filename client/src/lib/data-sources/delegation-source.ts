/**
 * Delegation Data Source (OMN-2284)
 *
 * Fetches delegation metrics from the API.
 */

import type {
  DelegationSummary,
  DelegationByTaskType,
  DelegationCostSavingsTrendPoint,
  DelegationQualityGatePoint,
  DelegationShadowDivergence,
  DelegationTrendPoint,
  DelegationTimeWindow,
} from '@shared/delegation-types';
import { buildApiUrl } from '@/lib/data-sources/api-base';

class DelegationSource {
  private baseUrl = buildApiUrl('/api/delegation');

  private buildWindowParam(window: DelegationTimeWindow): string {
    return `?window=${encodeURIComponent(window)}`;
  }

  async summary(window: DelegationTimeWindow = '7d'): Promise<DelegationSummary> {
    const response = await fetch(`${this.baseUrl}/summary${this.buildWindowParam(window)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: DelegationSummary = await response.json();
    if (data.total_delegations == null) {
      throw new Error('Malformed response: missing total_delegations');
    }
    return data;
  }

  async byTaskType(window: DelegationTimeWindow = '7d'): Promise<DelegationByTaskType[]> {
    const response = await fetch(`${this.baseUrl}/by-task-type${this.buildWindowParam(window)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: DelegationByTaskType[] = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Malformed response: expected array');
    }
    return data;
  }

  async costSavings(
    window: DelegationTimeWindow = '7d'
  ): Promise<DelegationCostSavingsTrendPoint[]> {
    const response = await fetch(`${this.baseUrl}/cost-savings${this.buildWindowParam(window)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: DelegationCostSavingsTrendPoint[] = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Malformed response: expected array');
    }
    return data;
  }

  async qualityGates(window: DelegationTimeWindow = '7d'): Promise<DelegationQualityGatePoint[]> {
    const response = await fetch(`${this.baseUrl}/quality-gates${this.buildWindowParam(window)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: DelegationQualityGatePoint[] = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Malformed response: expected array');
    }
    return data;
  }

  async shadowDivergence(
    window: DelegationTimeWindow = '7d'
  ): Promise<DelegationShadowDivergence[]> {
    const response = await fetch(
      `${this.baseUrl}/shadow-divergence${this.buildWindowParam(window)}`
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: DelegationShadowDivergence[] = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Malformed response: expected array');
    }
    return data;
  }

  async trend(window: DelegationTimeWindow = '7d'): Promise<DelegationTrendPoint[]> {
    const response = await fetch(`${this.baseUrl}/trend${this.buildWindowParam(window)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: DelegationTrendPoint[] = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Malformed response: expected array');
    }
    return data;
  }
}

/** Singleton data source instance shared across components. */
export const delegationSource = new DelegationSource();
