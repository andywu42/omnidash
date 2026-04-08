/**
 * Delegation Metrics Dashboard (OMN-2284)
 *
 * Tracks task delegation metrics:
 * - Delegation rate by task type
 * - Cost savings (combines with OMN-2234 data)
 * - Quality gate pass/fail rate (GOLDEN METRIC — target >80%)
 * - Shadow validation divergence metrics
 * - Unified cost savings view
 *
 * Events consumed from:
 *   onex.evt.omniclaude.task-delegated.v1
 *   onex.evt.omniclaude.delegation-shadow-comparison.v1
 */

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { delegationSource } from '@/lib/data-sources/delegation-source';
import { MetricCard } from '@/components/MetricCard';
import { queryKeys } from '@/lib/query-keys';
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
  CheckCircle2,
  DollarSign,
  BarChart3,
  TrendingUp,
  GitBranch,
  ShieldCheck,
  Clock,
  Cpu,
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
  ComposedChart,
} from 'recharts';
import { cn } from '@/lib/utils';
import {
  POLLING_INTERVAL_MEDIUM,
  POLLING_INTERVAL_SLOW,
  getPollingInterval,
} from '@/lib/constants/query-config';
import { TOOLTIP_STYLE, TOOLTIP_STYLE_SM } from '@/lib/constants/chart-theme';
import type {
  DelegationTimeWindow,
  DelegationShadowDivergence,
  DelegationByModel,
} from '@shared/delegation-types';

// ============================================================================
// Constants
// ============================================================================

const TIME_WINDOWS: { value: DelegationTimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

/** Golden metric target for quality gate pass rate. */
const QUALITY_GATE_TARGET = 0.8;
/** Alert threshold — below this, quality gate pass rate is critical. */
const QUALITY_GATE_ALERT_THRESHOLD = 0.6;

const TASK_TYPE_COLORS = [
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
];

// ============================================================================
// Helpers
// ============================================================================

function fmtPct(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

function fmtCount(n: number): string {
  return n.toLocaleString();
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

function fmtCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.001) return `$${(usd * 1_000_000).toFixed(1)}µ`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
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

function qualityGateColor(rate: number): string {
  if (rate >= QUALITY_GATE_TARGET) return 'text-green-500';
  if (rate >= QUALITY_GATE_ALERT_THRESHOLD) return 'text-yellow-500';
  return 'text-red-500';
}

function qualityGateBadge(rate: number): 'default' | 'secondary' | 'destructive' {
  if (rate >= QUALITY_GATE_TARGET) return 'default';
  if (rate >= QUALITY_GATE_ALERT_THRESHOLD) return 'secondary';
  return 'destructive';
}

function divergenceColor(score: number): string {
  if (score <= 0.2) return 'text-green-500';
  if (score <= 0.4) return 'text-yellow-500';
  return 'text-red-500';
}

// ============================================================================
// Sub-components
// ============================================================================

/** Segmented time window selector. */
function WindowSelector({
  value,
  onChange,
}: {
  value: DelegationTimeWindow;
  onChange: (w: DelegationTimeWindow) => void;
}) {
  return (
    <div className="flex rounded-md border border-border overflow-hidden">
      {TIME_WINDOWS.map((w) => (
        <button
          key={w.value}
          type="button"
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

/** Hero card for the Quality Gate Pass Rate golden metric. */
function QualityGateHero({
  rate,
  trend,
  isLoading,
}: {
  rate: number;
  trend: Array<{ date: string; value: number }>;
  isLoading: boolean;
}) {
  const aboveTarget = rate >= QUALITY_GATE_TARGET;
  return (
    <Card className="col-span-full md:col-span-2 border-2 border-primary/40 bg-primary/5">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Quality Gate Pass Rate
          </CardTitle>
          <CardDescription className="text-xs mt-0.5">
            Golden Metric — delegations passing all quality gates (target: &gt;80%)
          </CardDescription>
        </div>
        <Badge variant={isLoading ? 'secondary' : qualityGateBadge(rate)} className="text-xs">
          {isLoading
            ? '...'
            : aboveTarget
              ? 'On Target'
              : rate >= QUALITY_GATE_ALERT_THRESHOLD
                ? 'Below Target'
                : 'Critical'}
        </Badge>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="flex items-end gap-6">
            <div>
              <span className={cn('text-5xl font-bold tabular-nums', qualityGateColor(rate))}>
                {fmtPct(rate, 0)}
              </span>
              <p className="text-xs text-muted-foreground mt-1">
                quality gates passed · target {fmtPct(QUALITY_GATE_TARGET, 0)}
              </p>
            </div>
            {trend.length > 0 && (
              <div className="flex-1 h-16">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Tooltip
                      formatter={(v: any) => [fmtPct(v), 'Pass Rate']}
                      labelFormatter={(l) => String(l).slice(0, 10)}
                      contentStyle={TOOLTIP_STYLE_SM}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Shadow divergence table. */
function ShadowDivergenceTable({
  divergences,
  isLoading,
  isError,
}: {
  divergences: DelegationShadowDivergence[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-yellow-500" />
          Top Shadow Divergence Pairs
        </CardTitle>
        <CardDescription>
          Agent pairs where shadow and primary delegation results diverge most frequently
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <p className="text-sm text-destructive py-4 text-center">
            Failed to load shadow divergence data.
          </p>
        ) : isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : divergences.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No shadow divergences in this window.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Primary Agent</TableHead>
                <TableHead>Shadow Agent</TableHead>
                <TableHead>Task Type</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead className="text-right">Avg Score</TableHead>
                <TableHead className="text-right">Primary p50</TableHead>
                <TableHead className="text-right">Shadow p50</TableHead>
                <TableHead className="text-right">Last Seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {divergences.map((d, idx) => (
                <TableRow key={`${d.primary_agent}:${d.shadow_agent}:${d.task_type}:${idx}`}>
                  <TableCell>
                    <span className="font-mono text-xs text-blue-400">{d.primary_agent}</span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs text-purple-400">{d.shadow_agent}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] px-1 py-0">
                      {d.task_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fmtCount(d.count)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn('font-mono text-xs', divergenceColor(d.avg_divergence_score))}
                    >
                      {fmtPct(d.avg_divergence_score)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-blue-400">
                    {fmtMs(d.avg_primary_latency_ms)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-purple-400">
                    {fmtMs(d.avg_shadow_latency_ms)}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {relativeTime(d.occurred_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Dashboard
// ============================================================================

export default function DelegationDashboard() {
  const [timeWindow, setTimeWindow] = useState<DelegationTimeWindow>('7d');
  const queryClient = useQueryClient();

  // Invalidate all delegation queries on WebSocket DELEGATION_INVALIDATE event
  useWebSocket({
    onMessage: useCallback(
      (msg: { type: string; timestamp: string }) => {
        if (msg.type === 'DELEGATION_INVALIDATE') {
          queryClient.invalidateQueries({ queryKey: queryKeys.delegation.all });
        }
      },
      [queryClient]
    ),
    debug: false,
  });

  // ── Queries ──────────────────────────────────────────────────────────────

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
  } = useQuery({
    queryKey: queryKeys.delegation.summary(timeWindow),
    queryFn: () => delegationSource.summary(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  const {
    data: byTaskType,
    isLoading: taskTypeLoading,
    isError: taskTypeError,
    refetch: refetchTaskType,
  } = useQuery({
    queryKey: queryKeys.delegation.byTaskType(timeWindow),
    queryFn: () => delegationSource.byTaskType(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: byModel,
    isLoading: byModelLoading,
    isError: byModelError,
    refetch: refetchByModel,
  } = useQuery({
    queryKey: queryKeys.delegation.byModel(timeWindow),
    queryFn: () => delegationSource.byModel(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: costSavings,
    isLoading: costSavingsLoading,
    isError: costSavingsError,
    refetch: refetchCostSavings,
  } = useQuery({
    queryKey: queryKeys.delegation.costSavings(timeWindow),
    queryFn: () => delegationSource.costSavings(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: qualityGates,
    isLoading: qualityGatesLoading,
    isError: qualityGatesError,
    refetch: refetchQualityGates,
  } = useQuery({
    queryKey: queryKeys.delegation.qualityGates(timeWindow),
    queryFn: () => delegationSource.qualityGates(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: shadowDivergence,
    isLoading: shadowDivergenceLoading,
    isError: shadowDivergenceError,
    refetch: refetchShadowDivergence,
  } = useQuery({
    queryKey: queryKeys.delegation.shadowDivergence(timeWindow),
    queryFn: () => delegationSource.shadowDivergence(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  const {
    data: trend,
    isLoading: trendLoading,
    isError: trendError,
    refetch: refetchTrend,
  } = useQuery({
    queryKey: queryKeys.delegation.trend(timeWindow),
    queryFn: () => delegationSource.trend(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const handleRefresh = () => {
    void refetchSummary();
    void refetchTaskType();
    void refetchByModel();
    void refetchCostSavings();
    void refetchQualityGates();
    void refetchShadowDivergence();
    void refetchTrend();
  };

  const qualityGateRate = summary?.quality_gate_pass_rate ?? 0;
  const showQualityGateAlert =
    !summaryLoading && summary != null && qualityGateRate < QUALITY_GATE_ALERT_THRESHOLD;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6" data-testid="page-delegation-dashboard">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Delegation Metrics</h1>
          <p className="text-muted-foreground">
            Task delegation rate, cost savings, quality gates, and shadow validation divergence
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

      {/* Quality Gate Alert */}
      {showQualityGateAlert && (
        <Alert variant="destructive" className="border-red-500/50 bg-red-500/10">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          <AlertTitle className="text-red-500">Low Quality Gate Pass Rate</AlertTitle>
          <AlertDescription>
            Only <strong>{fmtPct(qualityGateRate)}</strong> of delegated tasks are passing quality
            gates (target: {fmtPct(QUALITY_GATE_TARGET)}). Review failing gates and task types
            below.
          </AlertDescription>
        </Alert>
      )}

      {/* Error Banner */}
      {summaryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load delegation data</AlertTitle>
          <AlertDescription>
            Delegation data could not be retrieved.
            <Button variant="outline" size="sm" className="mt-2" onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4 mr-1" /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* ── Hero: Quality Gate Pass Rate + Stat Cards ─────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Golden metric spans 2 columns */}
        <QualityGateHero
          rate={qualityGateRate}
          trend={summary?.quality_gate_trend ?? []}
          isLoading={summaryLoading}
        />

        {/* Total Delegations */}
        <MetricCard
          label="Total Delegations"
          value={summaryLoading ? '—' : fmtCount(summary?.total_delegations ?? 0)}
          subtitle={`${fmtPct(summary?.delegation_rate ?? 0)} delegation rate`}
          icon={BarChart3}
          isLoading={summaryLoading}
        />

        {/* Total Cost Savings */}
        <MetricCard
          label="Total Cost Savings"
          value={summaryLoading ? '—' : fmtCost(summary?.total_cost_savings_usd ?? 0)}
          subtitle={`${fmtCost(summary?.avg_cost_savings_usd ?? 0)} avg per delegation`}
          icon={DollarSign}
          status="healthy"
          isLoading={summaryLoading}
        />

        {/* Shadow Divergence Rate */}
        <MetricCard
          label="Shadow Divergence Rate"
          value={summaryLoading ? '—' : fmtPct(summary?.shadow_divergence_rate ?? 0)}
          subtitle={`${fmtCount(summary?.total_shadow_comparisons ?? 0)} comparisons`}
          icon={GitBranch}
          status={(summary?.shadow_divergence_rate ?? 0) < 0.2 ? 'healthy' : 'warning'}
          isLoading={summaryLoading}
        />

        {/* Quality Gate Passed */}
        <MetricCard
          label="Quality Gates Passed"
          value={summaryLoading ? '—' : fmtCount(summary?.counts.quality_gate_passed ?? 0)}
          subtitle={`${fmtCount(summary?.counts.quality_gate_failed ?? 0)} failed`}
          icon={CheckCircle2}
          status="healthy"
          isLoading={summaryLoading}
        />

        {/* Avg Delegation Latency */}
        <MetricCard
          label="Avg Delegation Latency"
          value={summaryLoading ? '—' : fmtMs(summary?.avg_delegation_latency_ms ?? 0)}
          subtitle="handoff overhead"
          icon={Clock}
          isLoading={summaryLoading}
        />
      </div>

      {/* ── Trend Chart ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Delegation Trends
          </CardTitle>
          <CardDescription>
            Quality gate pass rate, shadow divergence, and cost savings over time
          </CardDescription>
        </CardHeader>
        <CardContent>
          {trendError ? (
            <p className="text-sm text-destructive py-8 text-center">Failed to load trend data.</p>
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
                  tickFormatter={(v: string) => String(v).slice(5)}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <YAxis
                  yAxisId="rate"
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                  domain={[0, 1]}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <YAxis
                  yAxisId="cost"
                  orientation="right"
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <Tooltip
                  formatter={(v: any, name: any) => {
                    if (name === 'cost_savings_usd') return [fmtCost(v), 'Cost Savings'];
                    return [
                      fmtPct(v),
                      name === 'quality_gate_pass_rate'
                        ? 'Quality Gate Pass Rate'
                        : 'Shadow Divergence Rate',
                    ];
                  }}
                  labelFormatter={(l) => String(l).slice(0, 10)}
                  contentStyle={TOOLTIP_STYLE}
                />
                <Legend
                  formatter={(value) =>
                    value === 'quality_gate_pass_rate'
                      ? 'Quality Gate Pass Rate'
                      : value === 'shadow_divergence_rate'
                        ? 'Shadow Divergence Rate'
                        : 'Cost Savings'
                  }
                />
                <Line
                  yAxisId="rate"
                  type="monotone"
                  dataKey="quality_gate_pass_rate"
                  stroke="#22c55e"
                  strokeWidth={2.5}
                  dot={false}
                />
                <Line
                  yAxisId="rate"
                  type="monotone"
                  dataKey="shadow_divergence_rate"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={false}
                  strokeDasharray="4 3"
                />
                <Line
                  yAxisId="cost"
                  type="monotone"
                  dataKey="cost_savings_usd"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  dot={false}
                  strokeDasharray="2 4"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Task Type Breakdown + Quality Gate Time Series ────────────────── */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Delegation by Task Type */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Delegation Rate by Task Type
            </CardTitle>
            <CardDescription>Quality gate pass rate per task type</CardDescription>
          </CardHeader>
          <CardContent>
            {taskTypeError ? (
              <p className="text-sm text-destructive py-4 text-center">
                Failed to load task type data.
              </p>
            ) : taskTypeLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : (byTaskType?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={byTaskType}
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
                    tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    type="category"
                    dataKey="task_type"
                    tick={{ fontSize: 11 }}
                    width={100}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip
                    formatter={(v: any, name: any) => {
                      if (name === 'quality_gate_pass_rate') return [fmtPct(v), 'Pass Rate'];
                      return [fmtCost(v), 'Avg Savings'];
                    }}
                    contentStyle={TOOLTIP_STYLE}
                  />
                  <Bar dataKey="quality_gate_pass_rate" radius={[0, 4, 4, 0]}>
                    {(byTaskType ?? []).map((_, idx) => (
                      <Cell key={idx} fill={TASK_TYPE_COLORS[idx % TASK_TYPE_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Cost Savings Trend */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Cost Savings Over Time
            </CardTitle>
            <CardDescription>Cumulative cost savings from delegation</CardDescription>
          </CardHeader>
          <CardContent>
            {costSavingsError ? (
              <p className="text-sm text-destructive py-4 text-center">
                Failed to load cost savings data.
              </p>
            ) : costSavingsLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : (costSavings?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={costSavings} margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(v: string) => String(v).slice(5)}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip
                    formatter={(v: any, name: any) => [
                      fmtCost(v),
                      name === 'cost_savings_usd' ? 'Cost Savings' : 'Total Cost',
                    ]}
                    labelFormatter={(l) => String(l).slice(0, 10)}
                    contentStyle={TOOLTIP_STYLE}
                  />
                  <Legend
                    formatter={(value) =>
                      value === 'cost_savings_usd' ? 'Cost Savings' : 'Total Cost'
                    }
                  />
                  <Line
                    type="monotone"
                    dataKey="cost_savings_usd"
                    stroke="#22c55e"
                    strokeWidth={2.5}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="total_cost_usd"
                    stroke="#ef4444"
                    strokeWidth={1.5}
                    dot={false}
                    strokeDasharray="4 3"
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Model Comparison ──────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="h-4 w-4" />
            Delegation by Model
          </CardTitle>
          <CardDescription>
            Per-model delegation count, latency, cost savings, and quality gate pass rate
          </CardDescription>
        </CardHeader>
        <CardContent>
          {byModelError ? (
            <p className="text-sm text-destructive py-4 text-center">Failed to load model data.</p>
          ) : byModelLoading ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (byModel?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No model data available.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Delegations</TableHead>
                  <TableHead className="text-right">Avg Latency</TableHead>
                  <TableHead className="text-right">Cost Savings</TableHead>
                  <TableHead className="text-right">Avg Savings</TableHead>
                  <TableHead className="text-right">QG Pass Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(byModel ?? []).map((m) => (
                  <TableRow key={m.model}>
                    <TableCell>
                      <span className="font-mono text-xs text-blue-400">{m.model}</span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {fmtCount(m.total)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {fmtMs(m.avg_latency_ms)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-green-400">
                      {fmtCost(m.total_cost_savings_usd)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {fmtCost(m.avg_cost_savings_usd)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant={qualityGateBadge(m.quality_gate_pass_rate)}
                        className="text-[10px] px-1.5 py-0"
                      >
                        {fmtPct(m.quality_gate_pass_rate)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Quality Gate Pass Rate Time Series ───────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Quality Gate Pass Rate Over Time
          </CardTitle>
          <CardDescription>Daily pass/fail counts and rate trend — target &gt;80%</CardDescription>
        </CardHeader>
        <CardContent>
          {qualityGatesError ? (
            <p className="text-sm text-destructive py-8 text-center">
              Failed to load quality gate data.
            </p>
          ) : qualityGatesLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (qualityGates?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No quality gate data available.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={qualityGates} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v: string) => String(v).slice(5)}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <YAxis
                  yAxisId="count"
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <YAxis
                  yAxisId="rate"
                  orientation="right"
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                  domain={[0, 1]}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <Tooltip
                  formatter={(v: any, name: any) => {
                    if (name === 'pass_rate') return [fmtPct(v), 'Pass Rate'];
                    return [fmtCount(v), name === 'passed' ? 'Passed' : 'Failed'];
                  }}
                  labelFormatter={(l) => String(l).slice(0, 10)}
                  contentStyle={TOOLTIP_STYLE}
                />
                <Legend />
                <Bar yAxisId="count" dataKey="passed" stackId="a" fill="#22c55e" name="passed" />
                <Bar
                  yAxisId="count"
                  dataKey="failed"
                  stackId="a"
                  fill="#ef4444"
                  radius={[2, 2, 0, 0]}
                  name="failed"
                />
                <Line
                  yAxisId="rate"
                  type="monotone"
                  dataKey="pass_rate"
                  stroke="#3b82f6"
                  strokeWidth={2.5}
                  dot={false}
                  name="pass_rate"
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Shadow Divergence Table ───────────────────────────────────────── */}
      <ShadowDivergenceTable
        divergences={shadowDivergence ?? []}
        isLoading={shadowDivergenceLoading}
        isError={shadowDivergenceError}
      />
    </div>
  );
}
