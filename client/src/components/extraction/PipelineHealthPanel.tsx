/**
 * Pipeline Health Panel (OMN-1804)
 *
 * Displays per-cohort health metrics: total events, success/failure counts,
 * success rate, and average latency. Clicking a row opens the CohortDetailSheet
 * flyout with full cohort breakdown.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { extractionSource } from '@/lib/data-sources/extraction-source';
import { queryKeys } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Activity, AlertTriangle } from 'lucide-react';
import { StatusBadge } from '@/components/HealthStatusBadge';
import type { HealthStatus } from '@shared/schemas';
import type { PipelineCohortHealth } from '@shared/extraction-types';
import { CohortDetailSheet, fromPipelineHealth, type CohortDetail } from './CohortDetailSheet';

function successRateToHealth(rate: number): HealthStatus {
  if (rate >= 0.95) return 'healthy';
  if (rate >= 0.8) return 'degraded';
  return 'unhealthy';
}

interface PipelineHealthPanelProps {
  /** Called whenever the mock-data status of this panel changes. */
  onMockStateChange?: (isMock: boolean) => void;
}

export function PipelineHealthPanel({ onMockStateChange }: PipelineHealthPanelProps) {
  const [selectedDetail, setSelectedDetail] = useState<CohortDetail | null>(null);

  const {
    data: result,
    isLoading,
    error,
  } = useQuery({
    queryKey: [...queryKeys.extraction.health()],
    queryFn: () => extractionSource.pipelineHealth(),
    refetchInterval: 30_000,
  });

  // Propagate isMock to parent after render to avoid setState-during-render.
  const isMock = false;
  useEffect(() => {
    onMockStateChange?.(isMock);
  }, [isMock, onMockStateChange]);

  const data = result;

  const handleRowClick = (cohort: PipelineCohortHealth) => {
    setSelectedDetail(fromPipelineHealth(cohort));
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Pipeline Health</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Per-cohort success rates and latency
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="w-4 h-4" />
              <span>Failed to load pipeline health</span>
            </div>
          )}

          {!isLoading && !error && data && data.cohorts.length === 0 && (
            <div className="text-sm text-muted-foreground text-center py-8">
              No pipeline data yet. Events will appear when the extraction pipeline starts emitting.
            </div>
          )}

          {!isLoading && !error && data && data.cohorts.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Cohort</TableHead>
                  <TableHead className="text-xs text-right">Events</TableHead>
                  <TableHead className="text-xs text-right">Success</TableHead>
                  <TableHead className="text-xs text-right">Failures</TableHead>
                  <TableHead className="text-xs text-right">Avg Latency</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.cohorts.map((cohort: PipelineCohortHealth) => (
                  <TableRow
                    key={cohort.cohort}
                    className="cursor-pointer hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    tabIndex={0}
                    role="button"
                    onClick={() => handleRowClick(cohort)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleRowClick(cohort);
                      }
                    }}
                  >
                    <TableCell className="text-xs font-mono">{cohort.cohort}</TableCell>
                    <TableCell className="text-xs text-right">{cohort.total_events}</TableCell>
                    <TableCell className="text-xs text-right text-green-500">
                      {cohort.success_count}
                    </TableCell>
                    <TableCell className="text-xs text-right text-red-500">
                      {cohort.failure_count}
                    </TableCell>
                    <TableCell className="text-xs text-right">
                      {cohort.avg_latency_ms != null
                        ? `${Math.round(cohort.avg_latency_ms)}ms`
                        : '--'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={successRateToHealth(cohort.success_rate)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CohortDetailSheet
        detail={selectedDetail}
        open={selectedDetail !== null}
        onOpenChange={(open) => !open && setSelectedDetail(null)}
      />
    </>
  );
}
