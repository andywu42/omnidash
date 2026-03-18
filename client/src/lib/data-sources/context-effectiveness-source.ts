/**
 * Context Effectiveness Data Source (OMN-5286)
 *
 * Fetches context effectiveness metrics from the API.
 * Falls back to empty data when the API is unavailable.
 */

import type {
  ContextEffectivenessSummary,
  UtilizationByMethod,
  EffectivenessTrendPoint,
  OutcomeBreakdown,
  LowUtilizationSession,
  ContextEffectivenessTimeWindow,
} from '@shared/context-effectiveness-types';
import { buildApiUrl } from '@/lib/data-sources/api-base';

const BASE = buildApiUrl('/api/context-effectiveness');

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url);
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export const contextEffectivenessSource = {
  summary(window: ContextEffectivenessTimeWindow): Promise<ContextEffectivenessSummary> {
    return fetchJson<ContextEffectivenessSummary>(`${BASE}/summary?window=${window}`, {
      avg_utilization_score: 0,
      total_injected_sessions: 0,
      injection_occurred_count: 0,
      injection_rate: 0,
      avg_patterns_count: 0,
      cache_hit_rate: 0,
      top_utilization_method: null,
    });
  },

  byMethod(window: ContextEffectivenessTimeWindow): Promise<UtilizationByMethod[]> {
    return fetchJson<UtilizationByMethod[]>(`${BASE}/by-method?window=${window}`, []);
  },

  trend(window: ContextEffectivenessTimeWindow): Promise<EffectivenessTrendPoint[]> {
    return fetchJson<EffectivenessTrendPoint[]>(`${BASE}/trend?window=${window}`, []);
  },

  outcomes(window: ContextEffectivenessTimeWindow): Promise<OutcomeBreakdown[]> {
    return fetchJson<OutcomeBreakdown[]>(`${BASE}/outcomes?window=${window}`, []);
  },

  lowUtilization(window: ContextEffectivenessTimeWindow): Promise<LowUtilizationSession[]> {
    return fetchJson<LowUtilizationSession[]>(`${BASE}/low-utilization?window=${window}`, []);
  },
};
