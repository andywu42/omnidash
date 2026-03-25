/**
 * useStaleness Hook (OMN-6399)
 *
 * Fetches per-feature staleness info from GET /api/staleness with
 * TanStack Query. Auto-refreshes every 60 seconds.
 */

import { useQuery } from '@tanstack/react-query';
import { buildApiUrl } from '@/lib/data-sources/api-base';
import type { StalenessApiResponse } from '@shared/staleness-types';

const STALENESS_REFETCH_MS = 60_000;

export function useStaleness() {
  return useQuery<StalenessApiResponse>({
    queryKey: ['staleness'],
    queryFn: async () => {
      const res = await fetch(buildApiUrl('/staleness'));
      if (!res.ok) throw new Error(`Staleness API: HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: STALENESS_REFETCH_MS,
    staleTime: 30_000,
  });
}

/**
 * Convenience: returns the lastUpdated ISO string for a specific feature,
 * or undefined if the staleness data is not yet loaded.
 */
export function useFeatureStaleness(featureKey: string) {
  const { data } = useStaleness();
  return data?.features?.[featureKey]?.lastUpdated ?? undefined;
}
