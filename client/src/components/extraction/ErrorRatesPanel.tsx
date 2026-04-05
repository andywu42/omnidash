/**
 * Error Rates Panel (OMN-1804)
 *
 * Displays error rates by pipeline cohort with recent error samples.
 * Clicking a row opens the CohortDetailSheet flyout with the errors tab
 * focused, showing the individual failed sessions.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { extractionSource } from '@/lib/data-sources/extraction-source';
import { queryKeys } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, XCircle } from 'lucide-react';
import { StatusBadge } from '@/components/HealthStatusBadge';
import type { HealthStatus } from '@shared/schemas';
import type { ErrorRateEntry } from '@shared/extraction-types';
import { CohortDetailSheet, fromErrorRate, type CohortDetail } from './CohortDetailSheet';

function errorRateToHealth(rate: number): HealthStatus {
  if (rate === 0) return 'healthy';
  if (rate < 0.05) return 'degraded';
  return 'unhealthy';
}

interface ErrorRatesPanelProps {
  /** Called whenever the mock-data status of this panel changes. */
  onMockStateChange?: (isMock: boolean) => void;
}

export function ErrorRatesPanel({ onMockStateChange }: ErrorRatesPanelProps) {
  const [selectedDetail, setSelectedDetail] = useState<CohortDetail | null>(null);

  const {
    data: result,
    isLoading,
    error,
  } = useQuery({
    queryKey: [...queryKeys.extraction.errors()],
    queryFn: () => extractionSource.errorsSummary(),
    refetchInterval: 30_000,
  });

  const data = result;

  // Propagate isMock to parent after render to avoid setState-during-render.
  const isMock = false;
  useEffect(() => {
    onMockStateChange?.(isMock);
  }, [isMock, onMockStateChange]);

  const handleRowClick = (entry: ErrorRateEntry) => {
    setSelectedDetail(fromErrorRate(entry));
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <XCircle className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">Error Rates</CardTitle>
            </div>
            {data && data.total_errors > 0 && (
              <Badge variant="outline" className="text-red-500 border-red-500/30 text-xs">
                {data.total_errors} total errors
              </Badge>
            )}
          </div>
          <CardDescription className="text-xs">Failure rates by cohort</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="w-4 h-4" />
              <span>Failed to load error rates</span>
            </div>
          )}

          {!isLoading && !error && data && data.entries.length === 0 && (
            <div className="text-sm text-muted-foreground text-center py-8">
              No error data yet. Error metrics will appear when pipeline events start flowing.
            </div>
          )}

          {!isLoading && !error && data && data.entries.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Cohort</TableHead>
                  <TableHead className="text-xs text-right">Total</TableHead>
                  <TableHead className="text-xs text-right">Failures</TableHead>
                  <TableHead className="text-xs">Error Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.entries.map((entry: ErrorRateEntry) => (
                  <TableRow
                    key={entry.cohort}
                    className="cursor-pointer hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    tabIndex={0}
                    role="button"
                    onClick={() => handleRowClick(entry)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleRowClick(entry);
                      }
                    }}
                  >
                    <TableCell className="text-xs font-mono">{entry.cohort}</TableCell>
                    <TableCell className="text-xs text-right">{entry.total_events}</TableCell>
                    <TableCell className="text-xs text-right text-red-500">
                      {entry.failure_count}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={errorRateToHealth(entry.error_rate)}
                        className="text-[10px]"
                      />
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
        showErrors
      />
    </>
  );
}
