// SPDX-License-Identifier: MIT
/**
 * Objective Evaluation Data Source (OMN-2583)
 *
 * Fetches objective evaluation dashboard data from the API.
 */

import type {
  ScoreVectorSummaryResponse,
  GateFailureTimelineResponse,
  PolicyStateHistoryResponse,
  AntiGamingAlertFeedResponse,
  ObjectiveTimeWindow,
} from '@shared/objective-types';
import { buildApiUrl } from '@/lib/data-sources/api-base';

class ObjectiveSource {
  private baseUrl = buildApiUrl('/api/objective');

  async scoreVector(window: ObjectiveTimeWindow): Promise<ScoreVectorSummaryResponse> {
    const res = await fetch(`${this.baseUrl}/score-vector?window=${window}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<ScoreVectorSummaryResponse>;
  }

  async gateFailureTimeline(window: ObjectiveTimeWindow): Promise<GateFailureTimelineResponse> {
    const res = await fetch(`${this.baseUrl}/gate-failures?window=${window}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<GateFailureTimelineResponse>;
  }

  async policyStateHistory(window: ObjectiveTimeWindow): Promise<PolicyStateHistoryResponse> {
    const res = await fetch(`${this.baseUrl}/policy-state?window=${window}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<PolicyStateHistoryResponse>;
  }

  async antiGamingAlerts(window: ObjectiveTimeWindow): Promise<AntiGamingAlertFeedResponse> {
    const res = await fetch(`${this.baseUrl}/anti-gaming-alerts?window=${window}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<AntiGamingAlertFeedResponse>;
  }

  async acknowledgeAlert(alertId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/anti-gaming-alerts/${alertId}/acknowledge`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to acknowledge alert`);
  }
}

export const objectiveSource = new ObjectiveSource();
