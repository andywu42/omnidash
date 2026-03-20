/**
 * useFeatureFlags Hook (OMN-5582)
 *
 * Fetches feature flag data from the BFF and provides a toggle mutation.
 * Polls every 30 seconds. Shows toast notifications on toggle success/failure.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { POLLING_INTERVAL_MEDIUM, getPollingInterval } from '@/lib/constants/query-config';

// ============================================================================
// Types
// ============================================================================

export interface FeatureFlag {
  name: string;
  default_value: boolean;
  requested_value: boolean | null;
  process_value: boolean;
  effective_value: boolean | null;
  effective_value_status: string;
  state_alignment: string;
  value_source: string;
  description: string;
  category: string;
  env_var: string | null;
  owner: string | null;
  ownership_mode: string;
  conflict_status: string;
  conflict_details: string[] | null;
  declaring_nodes: string[];
  declaring_nodes_count: number;
  writable: boolean;
  last_changed_at: string | null;
}

export interface FeatureFlagsResponse {
  flags: FeatureFlag[];
  degraded: boolean;
  degraded_reason?: string;
}

// ============================================================================
// Hook
// ============================================================================

export function useFeatureFlags() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const query = useQuery<FeatureFlagsResponse>({
    queryKey: ['feature-flags'],
    queryFn: async () => {
      const res = await fetch('/api/feature-flags', { credentials: 'include' });
      if (!res.ok) {
        throw new Error(`${res.status}: ${res.statusText}`);
      }
      return res.json();
    },
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  const toggleFlag = useMutation({
    mutationFn: async ({ flagName, value }: { flagName: string; value: boolean }) => {
      const res = await apiRequest('PUT', `/api/feature-flags/${encodeURIComponent(flagName)}`, {
        requested_value: value,
      });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      toast({
        title: 'Flag updated',
        description: `${variables.flagName} set to ${variables.value}`,
      });
      queryClient.invalidateQueries({ queryKey: ['feature-flags'] });
    },
    onError: (error: Error, variables) => {
      toast({
        title: 'Toggle failed',
        description: error.message || `Failed to toggle ${variables.flagName}`,
        variant: 'destructive',
      });
    },
  });

  return {
    data: query.data,
    flags: query.data?.flags ?? [],
    degraded: query.data?.degraded ?? false,
    degradedReason: query.data?.degraded_reason,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    toggleFlag,
  };
}
