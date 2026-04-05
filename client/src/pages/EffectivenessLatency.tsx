/**
 * EffectivenessLatency
 *
 * Technical details / latency page for injection effectiveness metrics.
 * Shows latency breakdown stacked bar chart, P50/P95/P99 comparison table,
 * latency delta trend line chart, and cache hit rate metric.
 *
 * @see OMN-1891 - Build Effectiveness Dashboard (R3)
 */

import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { effectivenessSource } from '@/lib/data-sources/effectiveness-source';
import { DemoBanner } from '@/components/DemoBanner';
import { MetricCard } from '@/components/MetricCard';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { DetailSheet } from '@/components/DetailSheet';
import { TrendDrillDown } from '@/components/TrendDrillDown';
import type { TrendDrillDownData } from '@/components/TrendDrillDown';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { queryKeys } from '@/lib/query-keys';
import { Link } from 'wouter';
import type { LatencyBreakdown, LatencyTrendPoint } from '@shared/effectiveness-types';
import type { LegendPayload } from 'recharts/types/component/DefaultLegendContent';
import { Clock, ChevronLeft, RefreshCw, Zap, Database, AlertTriangle } from 'lucide-react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

// ============================================================================
// Constants
// ============================================================================

const CHART_COLORS = {
  routing: '#3b82f6',
  retrieval: '#8b5cf6',
  injection: '#f59e0b',
  treatmentP95: '#3b82f6',
  controlP95: '#22c55e',
  deltaP95: '#ef4444',
} as const;

// ============================================================================
// Component
// ============================================================================

/**
 * Latency details page for injection effectiveness.
 *
 * Displays per-cohort latency breakdowns (stacked bar), percentile comparisons
 * (table), latency delta trend over time (line chart), and cache hit rate.
 *
 * Data refreshes via 15-second polling with WebSocket-triggered invalidation
 * for real-time responsiveness.
 */
export default function EffectivenessLatency() {
  // ---------------------------------------------------------------------------
  // WebSocket: subscribe to effectiveness topic for real-time invalidation
  // ---------------------------------------------------------------------------
  const queryClient = useQueryClient();

  const { subscribe, isConnected } = useWebSocket({
    onMessage: (msg) => {
      if (msg.type === 'EFFECTIVENESS_UPDATE') {
        queryClient.invalidateQueries({ queryKey: queryKeys.effectiveness.all });
      }
    },
  });

  useEffect(() => {
    if (isConnected) {
      subscribe(['effectiveness']);
    }
  }, [isConnected, subscribe]);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const {
    data: latencyResult,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: queryKeys.effectiveness.latency(),
    queryFn: async () => {
      const data = await effectivenessSource.latencyDetails();
      // SAFE: JavaScript's event loop guarantees that no other code can run
      // between this await resumption and the next synchronous line. markMock/markReal
      // were called synchronously inside latencyDetails() before it returned.
      const isMock = false;
      return { data, isMock };
    },
    refetchInterval: 15_000,
  });

  const data = latencyResult?.data;
  const isMock = latencyResult?.isMock ?? false;

  const handleRefresh = () => {
    refetch();
  };

  // ---------------------------------------------------------------------------
  // Legend toggle state for trend chart
  // ---------------------------------------------------------------------------

  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  const handleLegendClick = useCallback((entry: LegendPayload) => {
    const key = entry.dataKey != null ? String(entry.dataKey) : null;
    if (!key) return;
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Detail sheet state (percentile table drill-down)
  // ---------------------------------------------------------------------------

  const [selectedCohort, setSelectedCohort] = useState<LatencyBreakdown | null>(null);
  const [trendDrillDown, setTrendDrillDown] = useState<TrendDrillDownData | null>(null);

  // ---------------------------------------------------------------------------
  // Derived data for charts
  // ---------------------------------------------------------------------------

  const breakdownChartData =
    data?.breakdowns.map((b) => ({
      cohort: b.cohort.charAt(0).toUpperCase() + b.cohort.slice(1),
      routing_avg_ms: b.routing_avg_ms,
      retrieval_avg_ms: b.retrieval_avg_ms,
      injection_avg_ms: b.injection_avg_ms,
    })) ?? [];

  const trendData =
    data?.trend.map((t) => ({
      ...t,
      treatment_p95: Math.round(t.treatment_p95),
      control_p95: Math.round(t.control_p95),
      delta_p95: Math.round(t.delta_p95),
    })) ?? [];

  const treatmentBreakdown = data?.breakdowns.find((b) => b.cohort === 'treatment');
  const controlBreakdown = data?.breakdowns.find((b) => b.cohort === 'control');
  const p95Delta = (treatmentBreakdown?.p95_ms ?? 0) - (controlBreakdown?.p95_ms ?? 0);

  /** Handle clicking a data point on the latency trend chart (OMN-2049 F1). */
  const handleLatencyTrendClick = useCallback(
    (state: { activePayload?: Array<{ payload: any }> }) => {
      if (!state?.activePayload?.length) return;
      const payload = state.activePayload[0].payload as LatencyTrendPoint;
      setTrendDrillDown({
        date: payload.date,
        metrics: [
          {
            label: 'Treatment P95',
            value: `${Math.round(payload.treatment_p95)}ms`,
            color: CHART_COLORS.treatmentP95,
          },
          {
            label: 'Control P95',
            value: `${Math.round(payload.control_p95)}ms`,
            color: CHART_COLORS.controlP95,
          },
          {
            label: 'Delta P95',
            value: `${Math.round(payload.delta_p95)}ms`,
            color: CHART_COLORS.deltaP95,
          },
        ],
      });
    },
    []
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Demo mode banner */}
      <DemoBanner />

      {/* Error Banner */}
      {isError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load latency data</AlertTitle>
          <AlertDescription>
            Latency details could not be retrieved. Please try refreshing.
          </AlertDescription>
        </Alert>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/effectiveness"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-1"
          >
            <ChevronLeft className="w-4 h-4" />
            Effectiveness
          </Link>
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Clock className="w-6 h-6 text-primary" />
            Latency Details
          </h2>
          <p className="text-sm text-muted-foreground">
            Per-cohort latency breakdown, percentile comparison, and trend analysis
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isMock && (
            <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
              Demo Data
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="w-4 h-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Metric Cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] w-full rounded-lg" />
          ))}
        </div>
      ) : data ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <MetricCard
            label="Treatment P95"
            value={treatmentBreakdown ? `${treatmentBreakdown.p95_ms.toFixed(0)}ms` : '--'}
            icon={Clock}
            subtitle={`${treatmentBreakdown?.sample_count.toLocaleString() ?? '0'} samples in treatment cohort`}
          />
          <MetricCard
            label="Control P95"
            value={controlBreakdown ? `${controlBreakdown.p95_ms.toFixed(0)}ms` : '--'}
            icon={Clock}
            subtitle={`${controlBreakdown?.sample_count.toLocaleString() ?? '0'} samples in control cohort`}
          />
          <MetricCard
            label="P95 Delta"
            value={`${p95Delta >= 0 ? '+' : ''}${p95Delta.toFixed(0)}ms`}
            icon={Zap}
            status={Math.abs(p95Delta) <= 50 ? 'healthy' : 'warning'}
            subtitle="Injection overhead at 95th percentile"
          />
          {data.cache && (
            <MetricCard
              label="Cache Hit Rate"
              value={`${(data.cache.hit_rate * 100).toFixed(1)}%`}
              icon={Database}
              status={data.cache.hit_rate >= 0.5 ? 'healthy' : 'warning'}
              tooltip={`${data.cache.total_hits} hits / ${data.cache.total_hits + data.cache.total_misses} total lookups`}
              subtitle={`${data.cache.total_hits.toLocaleString()} / ${(data.cache.total_hits + data.cache.total_misses).toLocaleString()} lookups`}
            />
          )}
        </div>
      ) : null}

      {/* Stacked Bar Chart: Latency Breakdown by Cohort */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="w-4 h-4 text-muted-foreground" />
            Latency Breakdown by Cohort
          </CardTitle>
          <CardDescription>
            Average latency contribution from routing, retrieval, and injection per cohort
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : breakdownChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={breakdownChartData}
                margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis
                  dataKey="cohort"
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                />
                <YAxis
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                  label={{ value: 'ms', position: 'insideLeft', offset: 10, fontSize: 12 }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                    fontSize: '12px',
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                  cursor={{ fill: 'hsl(var(--muted))', fillOpacity: 0.15 }}
                  formatter={(value: any, name: any) => {
                    const labels: Record<string, string> = {
                      routing_avg_ms: 'Routing',
                      retrieval_avg_ms: 'Retrieval',
                      injection_avg_ms: 'Injection',
                    };
                    return [`${value.toFixed(1)}ms`, labels[name] ?? name];
                  }}
                />
                <Legend
                  formatter={(value: string) => {
                    const labels: Record<string, string> = {
                      routing_avg_ms: 'Routing',
                      retrieval_avg_ms: 'Retrieval',
                      injection_avg_ms: 'Injection',
                    };
                    return labels[value] ?? value;
                  }}
                />
                <Bar
                  dataKey="routing_avg_ms"
                  stackId="stack"
                  fill={CHART_COLORS.routing}
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="retrieval_avg_ms"
                  stackId="stack"
                  fill={CHART_COLORS.retrieval}
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="injection_avg_ms"
                  stackId="stack"
                  fill={CHART_COLORS.injection}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-muted-foreground text-sm">
              No breakdown data available
            </div>
          )}
        </CardContent>
      </Card>

      {/* Percentile Comparison Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Percentile Comparison</CardTitle>
          <CardDescription>P50 / P95 / P99 latency by cohort with sample counts</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : data?.breakdowns && data.breakdowns.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cohort</TableHead>
                  <TableHead className="text-right">P50</TableHead>
                  <TableHead className="text-right">P95</TableHead>
                  <TableHead className="text-right">P99</TableHead>
                  <TableHead className="text-right">Samples</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.breakdowns.map((b) => (
                  <TableRow key={b.cohort}>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`cursor-pointer hover:bg-muted/50 ${
                          b.cohort === 'treatment'
                            ? 'text-blue-400 border-blue-500/30'
                            : 'text-zinc-400 border-zinc-500/30'
                        }`}
                        onClick={() => setSelectedCohort(b)}
                      >
                        {b.cohort.charAt(0).toUpperCase() + b.cohort.slice(1)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {b.p50_ms.toFixed(0)}ms
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {b.p95_ms.toFixed(0)}ms
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {b.p99_ms.toFixed(0)}ms
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {b.sample_count.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="h-20 flex items-center justify-center text-muted-foreground text-sm">
              No percentile data available
            </div>
          )}
        </CardContent>
      </Card>

      {/* Latency Delta Trend Line Chart */}
      <Card className="relative">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            Latency Trend (P95)
          </CardTitle>
          <CardDescription>
            Treatment vs control P95 latency over time with delta{' '}
            <span className="text-primary/60">&middot; click a data point for details</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TrendDrillDown data={trendDrillDown} onClose={() => setTrendDrillDown(null)} />
          {isLoading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart
                data={trendData}
                margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
                onClick={handleLatencyTrendClick as any}
              >
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                />
                <YAxis
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                  label={{ value: 'ms', position: 'insideLeft', offset: 10, fontSize: 12 }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                    fontSize: '12px',
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                  cursor={{ fill: 'hsl(var(--muted))', fillOpacity: 0.15 }}
                  formatter={(value: any, name: any) => {
                    const labels: Record<string, string> = {
                      treatment_p95: 'Treatment P95',
                      control_p95: 'Control P95',
                      delta_p95: 'Delta P95',
                    };
                    return [`${value}ms`, labels[name] ?? name];
                  }}
                />
                <Legend
                  onClick={handleLegendClick}
                  wrapperStyle={{ cursor: 'pointer', fontSize: '12px' }}
                  formatter={(value: string) => {
                    const labels: Record<string, string> = {
                      treatment_p95: 'Treatment P95',
                      control_p95: 'Control P95',
                      delta_p95: 'Delta P95',
                    };
                    return (
                      <span style={{ opacity: hiddenSeries.has(value) ? 0.35 : 1 }}>
                        {labels[value] ?? value}
                      </span>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="treatment_p95"
                  stroke={CHART_COLORS.treatmentP95}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  hide={hiddenSeries.has('treatment_p95')}
                />
                <Line
                  type="monotone"
                  dataKey="control_p95"
                  stroke={CHART_COLORS.controlP95}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  hide={hiddenSeries.has('control_p95')}
                />
                <Line
                  type="monotone"
                  dataKey="delta_p95"
                  stroke={CHART_COLORS.deltaP95}
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={false}
                  activeDot={{ r: 4 }}
                  hide={hiddenSeries.has('delta_p95')}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-muted-foreground text-sm">
              No trend data available
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cohort Detail Sheet */}
      <DetailSheet
        open={!!selectedCohort}
        onOpenChange={(open) => !open && setSelectedCohort(null)}
        title={`${selectedCohort?.cohort === 'treatment' ? 'Treatment' : 'Control'} Cohort Details`}
      >
        {selectedCohort && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="text-xs text-muted-foreground uppercase">P50</div>
                <div className="text-lg font-mono font-bold">
                  {selectedCohort.p50_ms.toFixed(0)}ms
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase">P95</div>
                <div className="text-lg font-mono font-bold">
                  {selectedCohort.p95_ms.toFixed(0)}ms
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase">P99</div>
                <div className="text-lg font-mono font-bold">
                  {selectedCohort.p99_ms.toFixed(0)}ms
                </div>
              </div>
            </div>
            <div className="border-t pt-4 space-y-3">
              <div className="text-xs text-muted-foreground uppercase">Latency Breakdown</div>
              {[
                { label: 'Routing', value: selectedCohort.routing_avg_ms, color: 'bg-blue-500' },
                {
                  label: 'Retrieval',
                  value: selectedCohort.retrieval_avg_ms,
                  color: 'bg-purple-500',
                },
                {
                  label: 'Injection',
                  value: selectedCohort.injection_avg_ms,
                  color: 'bg-yellow-500',
                },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${color}`} />
                    <span className="text-sm">{label}</span>
                  </div>
                  <span className="font-mono text-sm">{value.toFixed(1)}ms</span>
                </div>
              ))}
            </div>
            <div className="border-t pt-4">
              <div className="text-xs text-muted-foreground uppercase">Sample Count</div>
              <div className="text-lg font-mono font-bold">
                {selectedCohort.sample_count.toLocaleString()}
              </div>
            </div>
          </div>
        )}
      </DetailSheet>
    </div>
  );
}
