/**
 * useHealthProbe Hook (OMN-4515)
 *
 * Polls the public /api/health-probe endpoint (no auth required) to determine
 * aggregate system health status. Used by the top-bar health indicator so that
 * operators see real status even when they have no active session (e.g. k8s
 * environments where the service account has no user session).
 *
 * The endpoint is designed to be safe for unauthenticated access — it returns
 * only non-sensitive aggregate signals (up/degraded/down per service).
 */

import { useQuery } from '@tanstack/react-query';

export type HealthProbeStatus = 'up' | 'degraded' | 'down' | 'unknown';

export interface HealthProbeResult {
  status: HealthProbeStatus;
  services?: {
    eventConsumer: 'up' | 'down';
    eventBus: 'up' | 'down';
  };
  checkedAt?: string;
}

/**
 * Fetch the public health probe endpoint.
 * Returns 'unknown' status on any network or parse error.
 */
async function fetchHealthProbe(): Promise<HealthProbeResult> {
  try {
    const response = await fetch('/api/health-probe');
    if (!response.ok) {
      return { status: 'unknown' };
    }
    const data = (await response.json()) as HealthProbeResult;
    return data;
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * Hook: poll the public /api/health-probe endpoint every 30 seconds.
 *
 * @returns The current health probe result and TanStack Query state.
 */
export function useHealthProbe() {
  const { data, isLoading, isError } = useQuery<HealthProbeResult>({
    queryKey: ['health-probe'],
    queryFn: fetchHealthProbe,
    // Poll every 30 seconds — health changes infrequently
    refetchInterval: 30_000,
    // Keep stale data while revalidating to avoid indicator flicker
    staleTime: 15_000,
    // Retry once on failure (network blip)
    retry: 1,
    // No window focus refetch — this is a background probe
    refetchOnWindowFocus: false,
  });

  const status: HealthProbeStatus =
    isLoading ? 'unknown' : isError ? 'unknown' : (data?.status ?? 'unknown');

  return {
    status,
    services: data?.services,
    checkedAt: data?.checkedAt,
    isLoading,
    isError,
  };
}
