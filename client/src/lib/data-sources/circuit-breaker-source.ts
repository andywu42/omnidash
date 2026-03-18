/**
 * Circuit Breaker Data Source (OMN-5293)
 *
 * Fetches circuit breaker state summaries and recent events from the API.
 * Used by the CircuitBreakerDashboard page.
 */

import { buildApiUrl } from './api-base';

export type CircuitBreakerState = 'closed' | 'open' | 'half_open';
export type CircuitBreakerWindow = '1h' | '24h' | '7d';

export interface CircuitBreakerServiceSummary {
  serviceName: string;
  currentState: CircuitBreakerState;
  failureCount: number;
  threshold: number;
  lastTransitionAt: string;
}

export interface CircuitBreakerRecentEvent {
  id: string;
  serviceName: string;
  state: CircuitBreakerState;
  previousState: CircuitBreakerState;
  failureCount: number;
  threshold: number;
  emittedAt: string;
}

export interface CircuitBreakerSummary {
  services: CircuitBreakerServiceSummary[];
  stateCounts: { closed: number; open: number; half_open: number };
  totalEvents: number;
  window: CircuitBreakerWindow;
}

export interface CircuitBreakerEvents {
  events: CircuitBreakerRecentEvent[];
  window: CircuitBreakerWindow;
}

class CircuitBreakerSource {
  private baseUrl = buildApiUrl('/api/circuit-breaker');

  async summary(window: CircuitBreakerWindow = '24h'): Promise<CircuitBreakerSummary> {
    const response = await fetch(`${this.baseUrl}/summary?window=${window}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async events(window: CircuitBreakerWindow = '24h'): Promise<CircuitBreakerEvents> {
    const response = await fetch(`${this.baseUrl}/events?window=${window}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}

export const circuitBreakerSource = new CircuitBreakerSource();
