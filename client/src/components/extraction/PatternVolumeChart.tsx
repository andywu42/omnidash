/**
 * Pattern Volume Chart Panel (OMN-1804)
 *
 * Area chart showing pattern matches and injections over time.
 * Uses Recharts for visualization with Carbon Design color tokens.
 * Legend items are click-to-toggle via the shared ToggleableLegend primitive.
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { extractionSource } from '@/lib/data-sources/extraction-source';
import { queryKeys } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, TrendingUp } from 'lucide-react';
import { useToggleableLegend } from '@/hooks/useToggleableLegend';
import { ToggleableLegend } from '@/components/ToggleableLegend';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

const chartConfig = {
  injections: {
    label: 'Injections',
    color: 'hsl(var(--primary))',
  },
  patterns_matched: {
    label: 'Patterns Matched',
    color: 'hsl(142 76% 36%)',
  },
} satisfies ChartConfig;

function formatBucketLabel(bucket: string): string {
  try {
    const d = new Date(bucket);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return bucket;
  }
}

const SERIES_LABELS: Record<string, string> = {
  injections: 'Injections',
  patterns_matched: 'Patterns Matched',
};

interface PatternVolumeChartProps {
  timeWindow?: string;
  /** Called whenever the mock-data status of this panel changes. */
  onMockStateChange?: (isMock: boolean) => void;
}

export function PatternVolumeChart({
  timeWindow = '24h',
  onMockStateChange,
}: PatternVolumeChartProps) {
  const legend = useToggleableLegend();

  const {
    data: result,
    isLoading,
    error,
  } = useQuery({
    queryKey: [...queryKeys.extraction.volume(timeWindow)],
    queryFn: () => extractionSource.patternVolume(timeWindow),
    refetchInterval: 30_000,
  });

  const data = result;

  // Propagate isMock to parent after render to avoid setState-during-render.
  const isMock = false;
  useEffect(() => {
    onMockStateChange?.(isMock);
  }, [isMock, onMockStateChange]);

  const chartData = data?.points.map((p) => ({
    ...p,
    label: formatBucketLabel(p.bucket),
  }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Pattern Volume</CardTitle>
        </div>
        <CardDescription className="text-xs">
          Pattern matches and injections over time
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-48 w-full" />}

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="w-4 h-4" />
            <span>Failed to load pattern volume</span>
          </div>
        )}

        {!isLoading && !error && data && data.points.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-8">
            No pattern volume data yet. Charts will populate when extraction events arrive.
          </div>
        )}

        {!isLoading && !error && chartData && chartData.length > 0 && (
          <ChartContainer config={chartConfig} className="h-[200px] w-full">
            <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} className="text-muted-foreground" />
              <YAxis
                tick={{ fontSize: 10 }}
                className="text-muted-foreground"
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
                labelStyle={{ color: 'hsl(var(--foreground))' }}
              />
              <Legend content={<ToggleableLegend legend={legend} labels={SERIES_LABELS} />} />
              <Area
                type="monotone"
                dataKey="injections"
                name="Injections"
                stroke="var(--color-injections)"
                fill="var(--color-injections)"
                fillOpacity={0.15}
                strokeWidth={1.5}
                hide={!legend.isActive('injections')}
              />
              <Area
                type="monotone"
                dataKey="patterns_matched"
                name="Patterns Matched"
                stroke="var(--color-patterns_matched)"
                fill="var(--color-patterns_matched)"
                fillOpacity={0.15}
                strokeWidth={1.5}
                hide={!legend.isActive('patterns_matched')}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
