/**
 * Session Outcome Data Source (OMN-5184)
 *
 * Fetches session outcome summary and trend data from the API.
 * Used by the SuccessCategory dashboard.
 */

import { buildApiUrl } from './api-base';

export interface SessionOutcomeSummary {
  totalSessions: number;
  byOutcome: { success: number; failed: number; abandoned: number; unknown: number };
  successRate: number;
  window: '24h' | '7d' | '30d';
}

export interface SessionOutcomeTrend {
  points: Array<{
    bucket: string;
    success: number;
    failed: number;
    abandoned: number;
    unknown: number;
  }>;
  granularity: 'hour' | 'day';
}

class SessionOutcomeSource {
  private baseUrl = buildApiUrl('/api/session-outcomes');

  async summary(window: '24h' | '7d' | '30d' = '7d'): Promise<SessionOutcomeSummary> {
    const response = await fetch(`${this.baseUrl}/summary?window=${window}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async trend(window: '24h' | '7d' | '30d' = '7d'): Promise<SessionOutcomeTrend> {
    const response = await fetch(`${this.baseUrl}/trend?window=${window}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}

export const sessionOutcomeSource = new SessionOutcomeSource();
