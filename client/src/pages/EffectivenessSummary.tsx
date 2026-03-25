/**
 * EffectivenessSummary
 *
 * Executive summary page for injection effectiveness metrics.
 * Shows 4 metric tiles (injection rate, context utilization, agent accuracy,
 * latency delta P95), an auto-throttle warning banner, session counts,
 * and sub-navigation to the 3 detail pages.
 *
 * @see OMN-1891 - Build Effectiveness Dashboard
 */

import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useDemoMode } from '@/contexts/DemoModeContext';
import { useFeatureStaleness } from '@/hooks/useStaleness';
import { StalenessIndicator } from '@/components/StalenessIndicator';
import { effectivenessSource } from '@/lib/data-sources/effectiveness-source';
import { DemoBanner } from '@/components/DemoBanner';
import { MetricCard } from '@/components/MetricCard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { TrendDrillDown } from '@/components/TrendDrillDown';
import type { TrendDrillDownData } from '@/components/TrendDrillDown';
import { queryKeys } from '@/lib/query-keys';
import { Link } from 'wouter';
import { cn } from '@/lib/utils';
import type {
  EffectivenessSummary as SummaryType,
  ThrottleStatus,
  EffectivenessTrendPoint,
} from '@shared/effectiveness-types';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { Payload } from 'recharts/types/component/DefaultLegendContent';
import type { CategoricalChartState } from 'recharts/types/chart/types';
import {
  Activity,
  AlertTriangle,
  Gauge,
  Target,
  Clock,
  Zap,
  Users,
  RefreshCw,
  ArrowRight,
  Syringe,
} from 'lucide-react';

// ============================================================================
// Component
// ============================================================================

/**
 * Executive summary dashboard for injection effectiveness.
 *
 * Displays key metrics at a glance with status indicators against targets,
 * an auto-throttle warning banner when injection is paused, session counts
 * for treatment/control cohorts, and navigation links to detail pages.
 *
 * Data refreshes via 15-second polling with WebSocket-triggered invalidation
 * for real-time responsiveness.
 */
export default function EffectivenessSummary() {
  const { isDemoMode } = useDemoMode();
  const effectivenessLastUpdated = useFeatureStaleness('effectiveness');

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
  // UI state
  // ---------------------------------------------------------------------------
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const [trendDays, setTrendDays] = useState<number>(14);
  const [trendDrillDown, setTrendDrillDown] = useState<TrendDrillDownData | null>(null);

  // Close drill-down overlay when the trend range changes so stale metrics
  // don't remain visible after the chart data refreshes.
  useEffect(() => {
    setTrendDrillDown(null);
  }, [trendDays]);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
  } = useQuery<SummaryType>({
    queryKey: queryKeys.effectiveness.summary(),
    queryFn: () => effectivenessSource.summary({ demoMode: isDemoMode }),
    refetchInterval: 15_000,
  });

  const {
    data: throttle,
    isLoading: throttleLoading,
    isError: throttleError,
    refetch: refetchThrottle,
  } = useQuery<ThrottleStatus>({
    queryKey: queryKeys.effectiveness.throttle(),
    queryFn: () => effectivenessSource.throttleStatus({ demoMode: isDemoMode }),
    refetchInterval: 15_000,
  });

  const {
    data: trend,
    isLoading: trendLoading,
    isError: trendError,
  } = useQuery<EffectivenessTrendPoint[]>({
    queryKey: [...queryKeys.effectiveness.trend(), trendDays],
    queryFn: () => effectivenessSource.trend(trendDays, { demoMode: isDemoMode }),
    refetchInterval: 15_000,
  });

  // Cohort injection data from the pattern_injections table (OMN-2191)
  interface CohortRow {
    cohort: string;
    total_injections: string;
    outcomes_recorded: string;
    successes: string;
    failures: string;
    success_rate: string | null;
    avg_heuristic_confidence: number | null;
    avg_token_count: number | null;
  }

  const { data: cohortData, isLoading: cohortLoading } = useQuery<{
    cohorts: CohortRow[];
    timeWindow: string;
  }>({
    queryKey: [
      'intelligence',
      'injections',
      'cohort-summary',
      trendDays <= 7 ? '7d' : trendDays <= 14 ? '7d' : '30d',
    ],
    queryFn: async () => {
      const tw = trendDays <= 7 ? '7d' : trendDays <= 14 ? '7d' : '30d';
      const res = await fetch(`/api/intelligence/injections/cohort-summary?timeWindow=${tw}`);
      if (!res.ok) throw new Error('Failed to fetch cohort data');
      return res.json();
    },
    refetchInterval: 15_000,
  });

  // ---------------------------------------------------------------------------
  // Legend toggle + refresh handlers
  // ---------------------------------------------------------------------------

  const handleLegendClick = useCallback((entry: Payload) => {
    const key = entry.dataKey != null ? String(entry.dataKey) : null;
    if (!key) return;
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleRefresh = () => {
    refetchSummary();
    refetchThrottle();
  };

  /** Handle clicking a data point on the effectiveness trend chart (F1). */
  const handleTrendChartClick = useCallback(
    (state: CategoricalChartState) => {
      if (!state?.activePayload?.length || !trend) return;
      const payload = state.activePayload[0].payload as EffectivenessTrendPoint;
      setTrendDrillDown({
        date: payload.date,
        metrics: [
          {
            label: 'Injection Rate',
            value: `${(payload.injection_rate * 100).toFixed(1)}%`,
            color: '#22c55e',
          },
          {
            label: 'Utilization',
            value: `${(payload.avg_utilization * 100).toFixed(1)}%`,
            color: '#3b82f6',
          },
          {
            label: 'Accuracy',
            value: `${(payload.avg_accuracy * 100).toFixed(1)}%`,
            color: '#f59e0b',
          },
          {
            label: 'Latency Delta',
            value: `${payload.avg_latency_delta_ms.toFixed(0)}ms`,
            color: '#ef4444',
          },
        ],
      });
    },
    [trend]
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Demo mode banner */}
      <DemoBanner />

      {/* Error Banner */}
      {summaryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load effectiveness data</AlertTitle>
          <AlertDescription>
            Effectiveness summary could not be retrieved. Other sections may also be affected.
          </AlertDescription>
        </Alert>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" />
            Injection Effectiveness
          </h2>
          <p className="text-sm text-muted-foreground">
            Executive summary of context injection performance against targets
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StalenessIndicator lastUpdated={effectivenessLastUpdated} label="Effectiveness" />
          {effectivenessSource.isUsingMockData && (
            <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
              Demo Data
            </Badge>
          )}
          <div className="flex items-center rounded-md border border-input">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                onClick={() => setTrendDays(d)}
                className={cn(
                  'px-3 py-1 text-xs font-medium transition-colors',
                  trendDays === d
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {d}d
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="w-4 h-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Auto-Throttle Error */}
      {throttleError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load auto-throttle status</AlertTitle>
          <AlertDescription>
            Auto-throttle status could not be retrieved. Throttle state may be unavailable.
          </AlertDescription>
        </Alert>
      )}

      {/* Auto-Throttle Warning Banner (R2) */}
      {!throttleLoading && !throttleError && throttle?.active && (
        <Card className="border-red-500/40 bg-red-500/[0.06]">
          <CardContent className="py-3 px-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-red-400">Auto-Throttle Active</div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {throttle.reason ?? 'Injection has been paused due to threshold violations.'}
                </p>
                <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                  {throttle.latency_delta_p95_1h != null && (
                    <span>
                      Latency delta P95 (1h):{' '}
                      <span className="font-mono text-red-400">
                        +{throttle.latency_delta_p95_1h.toFixed(0)}ms
                      </span>
                    </span>
                  )}
                  {throttle.median_utilization_1h != null && (
                    <span>
                      Median utilization (1h):{' '}
                      <span className="font-mono">
                        {(throttle.median_utilization_1h * 100).toFixed(1)}%
                      </span>
                    </span>
                  )}
                  <span>
                    Injected sessions (1h):{' '}
                    <span className="font-mono">{throttle.injected_sessions_1h}</span>
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Metric Tiles */}
      {summaryLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] w-full rounded-lg" />
          ))}
        </div>
      ) : summary ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <Link href="/effectiveness/latency" className="block cursor-pointer">
            <div className="group">
              <MetricCard
                label="Injection Rate"
                value={`${(summary.injection_rate * 100).toFixed(1)}%`}
                icon={Zap}
                status={
                  summary.injection_rate >= summary.injection_rate_target ? 'healthy' : 'warning'
                }
                tooltip={`Percentage of sessions with context injection (target: ${(summary.injection_rate_target * 100).toFixed(0)}%)`}
                subtitle={`Target ${(summary.injection_rate_target * 100).toFixed(0)}% · ${summary.treatment_sessions} treatment sessions`}
                className="group-hover:ring-1 group-hover:ring-primary/30 rounded-lg transition-all"
              />
            </div>
          </Link>
          <Link href="/effectiveness/utilization" className="block cursor-pointer">
            <div className="group">
              <MetricCard
                label="Context Utilization"
                value={`${(summary.median_utilization * 100).toFixed(1)}%`}
                icon={Gauge}
                status={
                  summary.median_utilization >= summary.utilization_target ? 'healthy' : 'warning'
                }
                tooltip={`Median utilization score of injected patterns (target: ${summary.utilization_target})`}
                subtitle="Median pattern utilization across injected sessions"
                className="group-hover:ring-1 group-hover:ring-primary/30 rounded-lg transition-all"
              />
            </div>
          </Link>
          <Link href="/effectiveness/ab" className="block cursor-pointer">
            <div className="group">
              <MetricCard
                label="Agent Accuracy"
                value={`${(summary.mean_agent_accuracy * 100).toFixed(1)}%`}
                icon={Target}
                status={
                  summary.mean_agent_accuracy >= summary.accuracy_target ? 'healthy' : 'warning'
                }
                tooltip={`Mean agent-match accuracy across sessions (target: ${summary.accuracy_target})`}
                subtitle="Mean agent-match score for treatment cohort"
                className="group-hover:ring-1 group-hover:ring-primary/30 rounded-lg transition-all"
              />
            </div>
          </Link>
          <Link href="/effectiveness/latency" className="block cursor-pointer">
            <div className="group">
              <MetricCard
                label="Latency Delta P95"
                value={`${summary.latency_delta_p95_ms >= 0 ? '+' : ''}${summary.latency_delta_p95_ms.toFixed(0)}ms`}
                icon={Clock}
                status={
                  summary.latency_delta_p95_ms <= summary.latency_delta_target_ms
                    ? 'healthy'
                    : 'warning'
                }
                tooltip={`P95 latency overhead of injection vs control (target: +${summary.latency_delta_target_ms}ms)`}
                subtitle={`Budget +${summary.latency_delta_target_ms}ms · injection overhead vs control`}
                className="group-hover:ring-1 group-hover:ring-primary/30 rounded-lg transition-all"
              />
            </div>
          </Link>
        </div>
      ) : null}

      {/* Effectiveness Trend Chart */}
      <Card className="relative">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4 text-muted-foreground" />
            Effectiveness Trend
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {trendDays}-day trend of key effectiveness metrics{' '}
            <span className="text-primary/60">&middot; click a data point for details</span>
          </p>
        </CardHeader>
        <CardContent>
          <TrendDrillDown data={trendDrillDown} onClose={() => setTrendDrillDown(null)} />
          {trendLoading ? (
            <Skeleton className="h-[280px] w-full rounded-lg" />
          ) : trendError ? (
            <Alert variant="destructive" className="mx-0">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Failed to load trend data</AlertTitle>
              <AlertDescription>Effectiveness trend could not be retrieved.</AlertDescription>
            </Alert>
          ) : trend && trend.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart
                data={trend}
                margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                onClick={handleTrendChartClick}
              >
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  yAxisId="left"
                  domain={[0, 1]}
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                  tickFormatter={(v: number) => `${v.toFixed(0)}ms`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                    fontSize: '12px',
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                  formatter={(value: number, name: string) => {
                    if (name === 'avg_latency_delta_ms')
                      return [`${value.toFixed(0)}ms`, 'Latency Delta'];
                    return [
                      `${(value * 100).toFixed(1)}%`,
                      name === 'injection_rate'
                        ? 'Injection Rate'
                        : name === 'avg_utilization'
                          ? 'Utilization'
                          : 'Accuracy',
                    ];
                  }}
                />
                <Legend
                  onClick={handleLegendClick}
                  wrapperStyle={{ cursor: 'pointer', fontSize: '12px' }}
                  formatter={(value: string) => {
                    const labels: Record<string, string> = {
                      injection_rate: 'Injection Rate',
                      avg_utilization: 'Utilization',
                      avg_accuracy: 'Accuracy',
                      avg_latency_delta_ms: 'Latency Delta (ms)',
                    };
                    return (
                      <span style={{ opacity: hiddenSeries.has(value) ? 0.35 : 1 }}>
                        {labels[value] ?? value}
                      </span>
                    );
                  }}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="injection_rate"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 5, cursor: 'pointer' }}
                  hide={hiddenSeries.has('injection_rate')}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="avg_utilization"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 5, cursor: 'pointer' }}
                  hide={hiddenSeries.has('avg_utilization')}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="avg_accuracy"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 5, cursor: 'pointer' }}
                  hide={hiddenSeries.has('avg_accuracy')}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="avg_latency_delta_ms"
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 5, cursor: 'pointer' }}
                  hide={hiddenSeries.has('avg_latency_delta_ms')}
                />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
              No trend data available
            </div>
          )}
        </CardContent>
      </Card>

      {/* Session Counts */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-4 h-4 text-muted-foreground" />
            Session Counts
          </CardTitle>
        </CardHeader>
        <CardContent>
          {summaryLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : summary ? (
            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Total
                </div>
                <div className="text-2xl font-bold font-mono">{summary.total_sessions}</div>
              </div>
              <Link href="/effectiveness/ab" className="block cursor-pointer group">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Treatment
                </div>
                <div className="text-2xl font-bold font-mono text-blue-400 hover:text-primary transition-colors group-hover:underline">
                  {summary.treatment_sessions}
                </div>
              </Link>
              <Link href="/effectiveness/ab" className="block cursor-pointer group">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Control
                </div>
                <div className="text-2xl font-bold font-mono text-zinc-400 hover:text-primary transition-colors group-hover:underline">
                  {summary.control_sessions}
                </div>
              </Link>
            </div>
          ) : (
            <div className="h-10 flex items-center text-muted-foreground text-sm">
              No session data available
            </div>
          )}
        </CardContent>
      </Card>

      {/* Injection Cohort Data (OMN-2191) */}
      {cohortData && cohortData.cohorts.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Syringe className="w-4 h-4 text-muted-foreground" />
              Injection Pipeline - A/B Cohort Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {cohortData.cohorts.map((row) => (
                <div key={row.cohort} className="space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    {row.cohort}
                  </div>
                  <div className="text-xl font-bold font-mono">
                    {Number(row.total_injections).toLocaleString()}
                  </div>
                  <div className="text-xs text-muted-foreground">injections</div>
                  {row.success_rate != null && (
                    <div className="text-xs">
                      <span className="text-green-400">
                        {(Number(row.success_rate) * 100).toFixed(1)}%
                      </span>{' '}
                      success rate
                    </div>
                  )}
                  {row.avg_token_count != null && (
                    <div className="text-xs text-muted-foreground">
                      ~{Math.round(Number(row.avg_token_count))} avg tokens
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sub-Navigation */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/effectiveness/latency">
          <Card className="cursor-pointer hover:bg-muted/50 transition-colors group">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="w-4 h-4 text-muted-foreground" />
                Latency Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                P50/P95/P99 latency by cohort, trend charts, and cache hit rates.
              </p>
              <div className="flex items-center gap-1 mt-3 text-xs text-primary group-hover:underline">
                View details
                <ArrowRight className="w-3 h-3" />
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/effectiveness/utilization">
          <Card className="cursor-pointer hover:bg-muted/50 transition-colors group">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Gauge className="w-4 h-4 text-muted-foreground" />
                Utilization Analytics
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Utilization distribution, per-method scores, and low-utilization sessions.
              </p>
              <div className="flex items-center gap-1 mt-3 text-xs text-primary group-hover:underline">
                View details
                <ArrowRight className="w-3 h-3" />
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/effectiveness/ab">
          <Card className="cursor-pointer hover:bg-muted/50 transition-colors group">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Target className="w-4 h-4 text-muted-foreground" />
                A/B Comparison
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Side-by-side treatment vs control cohort metrics and success rates.
              </p>
              <div className="flex items-center gap-1 mt-3 text-xs text-primary group-hover:underline">
                View details
                <ArrowRight className="w-3 h-3" />
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
