/**
 * Latency Heatmap Panel (OMN-1804)
 *
 * CSS grid-based heatmap displaying P50/P95/P99 latency percentiles
 * across time buckets. Uses colored grid cells matching Carbon Design density.
 *
 * recharts has no native heatmap widget, so this uses a custom CSS grid approach.
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { extractionSource } from '@/lib/data-sources/extraction-source';
import { queryKeys } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, Clock } from 'lucide-react';
import type { LatencyBucket } from '@shared/extraction-types';

const PERCENTILE_LABELS = ['P50', 'P95', 'P99'] as const;

/**
 * Map a latency value to a background color intensity.
 * Lower is better (green), higher is worse (red).
 */
function latencyColor(ms: number | null): string {
  if (ms == null) return 'bg-muted/30';
  if (ms < 50) return 'bg-green-500/20 text-green-400';
  if (ms < 100) return 'bg-green-500/40 text-green-300';
  if (ms < 200) return 'bg-yellow-500/30 text-yellow-400';
  if (ms < 500) return 'bg-orange-500/30 text-orange-400';
  return 'bg-red-500/30 text-red-400';
}

function formatBucketLabel(bucket: string): string {
  try {
    const d = new Date(bucket);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return bucket;
  }
}

interface LatencyHeatmapProps {
  timeWindow?: string;
  /** Called whenever the mock-data status of this panel changes. */
  onMockStateChange?: (isMock: boolean) => void;
}

export function LatencyHeatmap({ timeWindow = '24h', onMockStateChange }: LatencyHeatmapProps) {
  const {
    data: result,
    isLoading,
    error,
  } = useQuery({
    queryKey: [...queryKeys.extraction.latency(timeWindow)],
    queryFn: () => extractionSource.latencyHeatmap(timeWindow),
    refetchInterval: 30_000,
  });

  const data = result;

  // Propagate isMock to parent after render to avoid setState-during-render.
  const isMock = false;
  useEffect(() => {
    onMockStateChange?.(isMock);
  }, [isMock, onMockStateChange]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Latency Heatmap</CardTitle>
        </div>
        <CardDescription className="text-xs">
          P50/P95/P99 latency percentiles over time
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="w-4 h-4" />
            <span>Failed to load latency data</span>
          </div>
        )}

        {!isLoading && !error && data && data.buckets.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-8">
            No latency data yet. Metrics will appear when latency events start flowing.
          </div>
        )}

        {!isLoading && !error && data && data.buckets.length > 0 && (
          <div className="w-full text-xs" data-chart="latency-heatmap">
            <div className="overflow-x-auto">
              {/* Header row: time bucket labels */}
              <div
                className="grid gap-1 mb-1"
                style={{
                  gridTemplateColumns: `4rem repeat(${data.buckets.length}, minmax(3rem, 1fr))`,
                }}
              >
                <div className="text-xs text-muted-foreground" />
                {data.buckets.map((b: LatencyBucket) => (
                  <div
                    key={b.bucket}
                    className="text-[10px] text-muted-foreground text-center truncate"
                    title={b.bucket}
                  >
                    {formatBucketLabel(b.bucket)}
                  </div>
                ))}
              </div>

              {/* Percentile rows */}
              {PERCENTILE_LABELS.map((label) => {
                const key = label.toLowerCase() as 'p50' | 'p95' | 'p99';
                return (
                  <div
                    key={label}
                    className="grid gap-1 mb-1"
                    style={{
                      gridTemplateColumns: `4rem repeat(${data.buckets.length}, minmax(3rem, 1fr))`,
                    }}
                  >
                    <div className="text-xs font-mono text-muted-foreground flex items-center">
                      {label}
                    </div>
                    {data.buckets.map((b: LatencyBucket) => {
                      const val = b[key];
                      return (
                        <div
                          key={`${label}-${b.bucket}`}
                          className={`rounded px-1 py-1 text-center text-[10px] font-mono ${latencyColor(val)}`}
                          title={val != null ? `${Math.round(val)}ms` : 'No data'}
                        >
                          {val != null ? `${Math.round(val)}` : '--'}
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {/* Legend */}
              <div className="flex items-center gap-3 mt-3 text-[10px] text-muted-foreground">
                <span>Latency (ms):</span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-green-500/20" /> &lt;50
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-green-500/40" /> 50-100
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-yellow-500/30" /> 100-200
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-orange-500/30" /> 200-500
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-red-500/30" /> &gt;500
                </span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
