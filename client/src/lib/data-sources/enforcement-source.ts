/**
 * Pattern Enforcement Data Source (OMN-2275)
 *
 * Fetches enforcement metrics from the API.
 */

import type {
  EnforcementSummary,
  EnforcementByLanguage,
  EnforcementByDomain,
  ViolatedPattern,
  EnforcementTrendPoint,
  EnforcementTimeWindow,
} from '@shared/enforcement-types';
import { buildApiUrl } from './api-base';

class EnforcementSource {
  private baseUrl = buildApiUrl('/api/enforcement');

  private buildWindowParam(window: EnforcementTimeWindow): string {
    return `?window=${encodeURIComponent(window)}`;
  }

  async summary(window: EnforcementTimeWindow = '7d'): Promise<EnforcementSummary> {
    const response = await fetch(`${this.baseUrl}/summary${this.buildWindowParam(window)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async byLanguage(window: EnforcementTimeWindow = '7d'): Promise<EnforcementByLanguage[]> {
    const response = await fetch(`${this.baseUrl}/by-language${this.buildWindowParam(window)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async byDomain(window: EnforcementTimeWindow = '7d'): Promise<EnforcementByDomain[]> {
    const response = await fetch(`${this.baseUrl}/by-domain${this.buildWindowParam(window)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async violatedPatterns(window: EnforcementTimeWindow = '7d'): Promise<ViolatedPattern[]> {
    const response = await fetch(
      `${this.baseUrl}/violated-patterns${this.buildWindowParam(window)}`
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async trend(window: EnforcementTimeWindow = '7d'): Promise<EnforcementTrendPoint[]> {
    const response = await fetch(`${this.baseUrl}/trend${this.buildWindowParam(window)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}

/** Singleton data source instance shared across components. */
export const enforcementSource = new EnforcementSource();
