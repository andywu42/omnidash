/**
 * Context Effectiveness Dashboard (OMN-5286)
 *
 * Displays context utilization metrics from injection_effectiveness table
 * (event_type='context_utilization', topic: onex.evt.omniclaude.context-utilization.v1):
 * - Avg utilization score + injection rate (hero cards)
 * - Utilization by detection method (bar chart)
 * - Effectiveness score trend over time (line chart)
 * - Session outcome breakdown (bar chart)
 * - Low-utilization session alert table (score < 0.3)
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { contextEffectivenessSource } from '@/lib/data-sources/context-effectiveness-source';
import { FeatureNotEnabledBanner } from '@/components/FeatureNotEnabledBanner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  RefreshCw,
  AlertTriangle,
  Activity,
  Gauge,
  Zap,
  BarChart3,
  TrendingUp,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import { cn } from '@/lib/utils';
import {
  POLLING_INTERVAL_MEDIUM,
  POLLING_INTERVAL_SLOW,
  getPollingInterval,
} from '@/lib/constants/query-config';
import type { ContextEffectivenessTimeWindow } from '@shared/context-effectiveness-types';

// ============================================================================
// Constants
// ============================================================================

const TIME_WINDOWS: { value: ContextEffectivenessTimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

const METHOD_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

// ============================================================================
// Helpers
// ============================================================================

function fmtPct(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

function fmtScore(value: number): string {
  return value.toFixed(3);
}

function relativeTime(isoTs: string): string {
  if (!isoTs) return 'never';
  const ts = new Date(isoTs).getTime();
  if (isNaN(ts)) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function scoreColor(score: number): string {
  if (score >= 0.7) return 'text-[hsl(var(--chart-2))]';
  if (score >= 0.4) return 'text-[hsl(var(--chart-4))]';
  return 'text-destructive';
}

function scoreBadge(score: number): 'default' | 'secondary' | 'destructive' {
  if (score >= 0.7) return 'default';
  if (score >= 0.4) return 'secondary';
  return 'destructive';
}

// ============================================================================
// Sub-components
// ============================================================================

function WindowSelector({
  value,
  onChange,
}: {
  value: ContextEffectivenessTimeWindow;
  onChange: (w: ContextEffectivenessTimeWindow) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Time window"
      className="flex rounded-md border border-border overflow-hidden"
    >
      {TIME_WINDOWS.map((w) => (
        <button
          key={w.value}
          type="button"
          aria-pressed={value === w.value}
          onClick={() => onChange(w.value)}
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition-colors',
            value === w.value
              ? 'bg-primary text-primary-foreground'
              : 'bg-background text-muted-foreground hover:bg-muted'
          )}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

function StatCard({
  title,
  value,
  description,
  icon: Icon,
  valueClass,
  isLoading,
}: {
  title: string;
  value: string;
  description?: string;
  icon: React.ElementType;
  valueClass?: string;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <>
            <div className={cn('text-2xl font-bold tabular-nums', valueClass)}>{value}</div>
            {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Dashboard
// ============================================================================

export default function ContextEffectivenessDashboard() {
  const [timeWindow, setTimeWindow] = useState<ContextEffectivenessTimeWindow>('7d');

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
  } = useQuery({
    queryKey: queryKeys.contextEffectiveness.summary(timeWindow),
    queryFn: () => contextEffectivenessSource.summary(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  const {
    data: byMethod,
    isLoading: methodLoading,
    isError: methodError,
    refetch: refetchMethod,
  } = useQuery({
    queryKey: queryKeys.contextEffectiveness.byMethod(timeWindow),
    queryFn: () => contextEffectivenessSource.byMethod(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: trend,
    isLoading: trendLoading,
    isError: trendError,
    refetch: refetchTrend,
  } = useQuery({
    queryKey: queryKeys.contextEffectiveness.trend(timeWindow),
    queryFn: () => contextEffectivenessSource.trend(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: outcomes,
    isLoading: outcomesLoading,
    isError: outcomesError,
    refetch: refetchOutcomes,
  } = useQuery({
    queryKey: queryKeys.contextEffectiveness.outcomes(timeWindow),
    queryFn: () => contextEffectivenessSource.outcomes(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: lowUtil,
    isLoading: lowUtilLoading,
    isError: lowUtilError,
    refetch: refetchLowUtil,
  } = useQuery({
    queryKey: queryKeys.contextEffectiveness.lowUtilization(timeWindow),
    queryFn: () => contextEffectivenessSource.lowUtilization(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  const handleRefresh = () => {
    void refetchSummary();
    void refetchMethod();
    void refetchTrend();
    void refetchOutcomes();
    void refetchLowUtil();
  };

  const allSettled =
    !summaryLoading && !methodLoading && !trendLoading && !outcomesLoading && !lowUtilLoading;

  const noData = allSettled && !summaryError && (summary?.total_injected_sessions ?? 0) === 0;

  return (
    <div className="space-y-6" data-testid="page-context-effectiveness">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Context Effectiveness</h1>
          <p className="text-muted-foreground">
            Utilization score by detection method, trend over time, and low-utilization sessions
          </p>
        </div>
        <div className="flex items-center gap-3">
          <WindowSelector value={timeWindow} onChange={setTimeWindow} />
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Feature not enabled banner */}
      {noData && (
        <FeatureNotEnabledBanner
          featureName="Context Effectiveness"
          eventTopic="onex.evt.omniclaude.context-utilization.v1"
          flagHint="ENABLE_CONTEXT_UTILIZATION"
        />
      )}

      {/* Error banner */}
      {summaryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load context effectiveness data</AlertTitle>
          <AlertDescription>
            Unable to load data. Check that the API server is running.
            <Button variant="outline" size="sm" className="mt-2 ml-2" onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4 mr-1" /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Low-utilization alert */}
      {(lowUtil?.length ?? 0) > 0 && !lowUtilLoading && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Low-Utilization Sessions Detected</AlertTitle>
          <AlertDescription>
            {lowUtil!.length} session{lowUtil!.length !== 1 ? 's' : ''} with utilization score below
            0.3 in this window. Review the table below and tune context injection parameters.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Hero Cards ────────────────────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Avg Utilization Score — Golden Metric */}
        <Card className="col-span-full md:col-span-2 border-2 border-primary/40 bg-primary/5">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                Avg Utilization Score
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Golden Metric — patterns injected that were actually used
              </CardDescription>
            </div>
            <Badge
              variant={summaryLoading ? 'secondary' : scoreBadge(summary?.avg_utilization_score ?? 0)}
              className="text-xs"
            >
              {summaryLoading
                ? '...'
                : (summary?.avg_utilization_score ?? 0) >= 0.7
                  ? 'Healthy'
                  : (summary?.avg_utilization_score ?? 0) >= 0.4
                    ? 'Needs Attention'
                    : 'Low'}
            </Badge>
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <div className="flex items-end gap-6">
                <div>
                  <span
                    className={cn(
                      'text-5xl font-bold tabular-nums',
                      scoreColor(summary?.avg_utilization_score ?? 0)
                    )}
                  >
                    {fmtScore(summary?.avg_utilization_score ?? 0)}
                  </span>
                  <p className="text-xs text-muted-foreground mt-1">
                    across {(summary?.total_injected_sessions ?? 0).toLocaleString()} sessions
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Injection Rate */}
        <StatCard
          title="Injection Rate"
          value={summaryLoading ? '—' : fmtPct(summary?.injection_rate ?? 0)}
          description="Sessions where injection occurred"
          icon={Zap}
          valueClass={
            (summary?.injection_rate ?? 0) >= 0.7
              ? 'text-[hsl(var(--chart-2))]'
              : 'text-[hsl(var(--chart-4))]'
          }
          isLoading={summaryLoading}
        />

        {/* Cache Hit Rate */}
        <StatCard
          title="Cache Hit Rate"
          value={summaryLoading ? '—' : fmtPct(summary?.cache_hit_rate ?? 0)}
          description="Injections served from cache"
          icon={Gauge}
          valueClass={
            (summary?.cache_hit_rate ?? 0) >= 0.5
              ? 'text-[hsl(var(--chart-2))]'
              : 'text-muted-foreground'
          }
          isLoading={summaryLoading}
        />

        {/* Avg Patterns Count */}
        <StatCard
          title="Avg Patterns / Session"
          value={summaryLoading ? '—' : (summary?.avg_patterns_count ?? 0).toFixed(1)}
          description="Average patterns injected per session"
          icon={BarChart3}
          isLoading={summaryLoading}
        />

        {/* Top Utilization Method */}
        <StatCard
          title="Top Method"
          value={summaryLoading ? '—' : (summary?.top_utilization_method ?? '—')}
          description="Most common utilization method"
          icon={TrendingUp}
          isLoading={summaryLoading}
        />
      </div>

      {/* ── Charts Row ────────────────────────────────────────────────────── */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Utilization by Detection Method */}
        <Card>
          <CardHeader>
            <CardTitle>Utilization by Detection Method</CardTitle>
            <CardDescription>Average utilization score per detection method</CardDescription>
          </CardHeader>
          <CardContent>
            {methodError ? (
              <p className="text-sm text-destructive py-4 text-center">Failed to load method data.</p>
            ) : methodLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : (byMethod?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={byMethod}
                  layout="vertical"
                  margin={{ top: 0, right: 16, left: 8, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    domain={[0, 1]}
                    tickFormatter={(v: number) => v.toFixed(2)}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    type="category"
                    dataKey="method"
                    tick={{ fontSize: 11 }}
                    width={120}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip
                    formatter={(v: number, name: string) => [
                      name === 'avg_score' ? fmtScore(v) : v.toLocaleString(),
                      name === 'avg_score' ? 'Avg Score' : 'Sessions',
                    ]}
                    contentStyle={{ fontSize: '12px' }}
                  />
                  <Bar dataKey="avg_score" radius={[0, 4, 4, 0]}>
                    {(byMethod ?? []).map((_, idx) => (
                      <Cell key={idx} fill={METHOD_COLORS[idx % METHOD_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Session Outcome Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>Session Outcome Breakdown</CardTitle>
            <CardDescription>Count and avg utilization score per outcome</CardDescription>
          </CardHeader>
          <CardContent>
            {outcomesError ? (
              <p className="text-sm text-destructive py-4 text-center">
                Failed to load outcomes data.
              </p>
            ) : outcomesLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : (outcomes?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={outcomes}
                  margin={{ top: 0, right: 16, left: 8, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="outcome"
                    tick={{ fontSize: 10 }}
                    stroke="hsl(var(--muted-foreground))"
                    angle={-15}
                    textAnchor="end"
                    height={36}
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    domain={[0, 1]}
                    tickFormatter={(v: number) => v.toFixed(1)}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip
                    formatter={(v: number, name: string) => [
                      name === 'count' ? v.toLocaleString() : fmtScore(v),
                      name === 'count' ? 'Sessions' : 'Avg Score',
                    ]}
                    contentStyle={{ fontSize: '12px' }}
                  />
                  <Legend />
                  <Bar
                    yAxisId="left"
                    dataKey="count"
                    fill="hsl(var(--chart-1))"
                    name="count"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    yAxisId="right"
                    dataKey="avg_utilization_score"
                    fill="hsl(var(--chart-3))"
                    name="avg_utilization_score"
                    radius={[2, 2, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Effectiveness Trend ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Effectiveness Score Trend
          </CardTitle>
          <CardDescription>
            Average utilization score and injection rate over time
          </CardDescription>
        </CardHeader>
        <CardContent>
          {trendError ? (
            <p className="text-sm text-destructive py-8 text-center">
              Failed to load trend data.
            </p>
          ) : trendLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (trend?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No trend data available.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={trend} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v: string) => String(v).slice(timeWindow === '24h' ? 11 : 5)}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <YAxis
                  domain={[0, 1]}
                  tickFormatter={(v: number) => v.toFixed(1)}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <Tooltip
                  formatter={(v: number, name: string) => [
                    name === 'avg_utilization_score' ? fmtScore(v) : fmtPct(v),
                    name === 'avg_utilization_score' ? 'Avg Score' : 'Injection Rate',
                  ]}
                  labelFormatter={(l) => String(l).slice(0, 16)}
                  contentStyle={{ fontSize: '12px' }}
                />
                <Legend
                  formatter={(v) =>
                    v === 'avg_utilization_score' ? 'Avg Utilization Score' : 'Injection Rate'
                  }
                />
                <Line
                  type="monotone"
                  dataKey="avg_utilization_score"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2.5}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="injection_rate"
                  stroke="hsl(var(--chart-3))"
                  strokeWidth={1.5}
                  dot={false}
                  strokeDasharray="4 3"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Low-Utilization Sessions ──────────────────────────────────────── */}
      <Card className="border-[hsl(var(--destructive)_/_0.3)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            Low-Utilization Sessions
            {(lowUtil?.length ?? 0) > 0 && (
              <Badge variant="destructive" className="text-xs ml-1">
                {lowUtil!.length}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Sessions with utilization_score &lt; 0.3 — injected patterns were largely unused
          </CardDescription>
        </CardHeader>
        <CardContent>
          {lowUtilError ? (
            <p className="text-sm text-destructive py-4 text-center">
              Failed to load low-utilization sessions.
            </p>
          ) : lowUtilLoading ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (lowUtil?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No low-utilization sessions in this window.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="text-right">Patterns</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lowUtil!.map((s) => (
                  <TableRow key={`${s.session_id}-${s.correlation_id}`}>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {s.agent_name ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] px-1 py-0 font-mono">
                        {s.detection_method ?? '—'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="font-mono text-sm font-medium text-destructive">
                        {fmtScore(s.utilization_score)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {s.patterns_count ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {s.session_outcome ?? '—'}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {relativeTime(s.occurred_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
