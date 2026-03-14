/**
 * Baselines & ROI Dashboard (OMN-2156)
 *
 * Cost + outcome comparison surface for A/B pattern evaluation.
 * Visualizes: token delta, time delta, retry counts, test pass rates,
 * review iterations, and promotion recommendations (promote/shadow/suppress/fork).
 *
 * Follows the same layout conventions as SuccessCategory.tsx:
 * HeroMetric -> MetricCards -> Charts -> Comparison Table.
 */

import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { baselinesSource } from '@/lib/data-sources/baselines-source';
import { queryKeys } from '@/lib/query-keys';
import { MetricCard } from '@/components/MetricCard';
import { HeroMetric } from '@/components/HeroMetric';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type {
  BaselinesSummary,
  PatternComparison,
  ROITrendPoint,
  RecommendationBreakdown,
  DeltaMetric,
  PromotionAction,
} from '@shared/baselines-types';
import {
  DollarSign,
  TrendingUp,
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  Coins,
  Timer,
  GitPullRequest,
  BarChart3,
  AlertTriangle,
} from 'lucide-react';
import {
  ComposedChart,
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

// ============================================================================
// Constants
// ============================================================================

const ACTION_COLORS: Record<PromotionAction, string> = {
  promote: '#22c55e',
  shadow: '#3b82f6',
  suppress: '#ef4444',
  fork: '#f59e0b',
};

const ACTION_LABELS: Record<PromotionAction, string> = {
  promote: 'Promote',
  shadow: 'Shadow',
  suppress: 'Suppress',
  fork: 'Fork',
};

const CONFIDENCE_VARIANTS: Record<string, string> = {
  high: 'bg-green-500/20 text-green-400 border-green-500/30',
  medium: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  low: 'bg-red-500/20 text-red-400 border-red-500/30',
};

// ============================================================================
// ROI Trend Chart
// ============================================================================

function ROITrendChart({ data }: { data: ROITrendPoint[] | undefined }) {
  if (!data?.length) {
    return (
      <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
        No trend data available
      </div>
    );
  }

  const chartData = data.map((p) => ({
    date: p.date,
    'Cost Savings': +(p.avg_cost_savings * 100).toFixed(1),
    'Outcome Improvement': +(p.avg_outcome_improvement * 100).toFixed(1),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis
          dataKey="date"
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
          tickFormatter={(v: string) => v.slice(5)}
        />
        <YAxis
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
          }}
          formatter={(value: number, name: string) => [`${value.toFixed(1)}%`, name]}
        />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        <Line type="monotone" dataKey="Cost Savings" stroke="#22c55e" strokeWidth={2} dot={false} />
        <Line
          type="monotone"
          dataKey="Outcome Improvement"
          stroke="#3b82f6"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// Recommendation Breakdown Chart
// ============================================================================

function BreakdownChart({ data }: { data: RecommendationBreakdown[] | undefined }) {
  if (!data?.length) {
    return (
      <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
        No breakdown data available
      </div>
    );
  }

  const chartData = data.map((d) => ({
    action: ACTION_LABELS[d.action],
    count: d.count,
    fill: ACTION_COLORS[d.action],
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis
          dataKey="action"
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
        />
        <YAxis
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
          allowDecimals={false}
        />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted))' }}
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
          }}
        />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {chartData.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// Delta Metric Display
// ============================================================================

function DeltaDisplay({ metric }: { metric: DeltaMetric }) {
  const isPositive = metric.delta > 0;
  const isImproved = metric.direction === 'lower_is_better' ? metric.delta < 0 : metric.delta > 0;
  const absDelta = Math.abs(metric.delta);

  const formatValue = (v: number) => {
    if (metric.unit === '%') return `${(v * 100).toFixed(1)}%`;
    if (metric.unit === 'tokens') return v.toLocaleString();
    if (metric.unit === 'ms') return `${v.toLocaleString()}ms`;
    return v.toFixed(1);
  };

  const formatDelta = (v: number) => {
    if (metric.unit === '%') return `${(v * 100).toFixed(1)}pp`;
    if (metric.unit === 'tokens') return v.toLocaleString();
    if (metric.unit === 'ms') return `${v.toLocaleString()}ms`;
    return v.toFixed(1);
  };

  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{metric.label}</span>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground font-mono">
          {formatValue(metric.baseline)}
        </span>
        <span className="text-xs text-muted-foreground">vs</span>
        <span className="text-xs font-mono">{formatValue(metric.candidate)}</span>
        <span
          className={`text-xs font-mono flex items-center gap-0.5 ${metric.delta === 0 ? 'text-muted-foreground' : isImproved ? 'text-green-400' : 'text-red-400'}`}
        >
          {metric.delta === 0 ? (
            <Minus className="w-3 h-3" />
          ) : isPositive ? (
            <ArrowUpRight className="w-3 h-3" />
          ) : (
            <ArrowDownRight className="w-3 h-3" />
          )}
          {formatDelta(absDelta)}
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// Pattern Comparison Card
// ============================================================================

function ComparisonCard({ comparison }: { comparison: PatternComparison }) {
  const actionColor = ACTION_COLORS[comparison.recommendation];

  return (
    <Card className="border-l-4" style={{ borderLeftColor: actionColor }}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{comparison.pattern_name}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge className={CONFIDENCE_VARIANTS[comparison.confidence]}>
              {comparison.confidence}
            </Badge>
            <Badge
              style={{
                backgroundColor: `${actionColor}20`,
                color: actionColor,
                borderColor: `${actionColor}50`,
              }}
            >
              {ACTION_LABELS[comparison.recommendation]}
            </Badge>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {comparison.sample_size} sessions | {comparison.pattern_id}
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="divide-y divide-border">
          <DeltaDisplay metric={comparison.token_delta} />
          <DeltaDisplay metric={comparison.time_delta} />
          <DeltaDisplay metric={comparison.retry_delta} />
          <DeltaDisplay metric={comparison.test_pass_rate_delta} />
          <DeltaDisplay metric={comparison.review_iteration_delta} />
        </div>
        <p className="text-xs text-muted-foreground mt-3 italic">{comparison.rationale}</p>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function BaselinesROI() {
  const queryClient = useQueryClient();

  // ---------------------------------------------------------------------------
  // Data Fetching
  // ---------------------------------------------------------------------------

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
  } = useQuery<BaselinesSummary>({
    queryKey: queryKeys.baselines.summary(),
    queryFn: () => baselinesSource.summary(),
    refetchInterval: 15_000,
  });

  const {
    data: comparisons,
    isLoading: comparisonsLoading,
    isError: comparisonsError,
  } = useQuery<PatternComparison[]>({
    queryKey: queryKeys.baselines.comparisons(),
    queryFn: () => baselinesSource.comparisons(),
    refetchInterval: 15_000,
  });

  const {
    data: trend,
    isLoading: trendLoading,
    isError: trendError,
  } = useQuery<ROITrendPoint[]>({
    queryKey: queryKeys.baselines.trend(14),
    queryFn: () => baselinesSource.trend(14),
    refetchInterval: 15_000,
  });

  const {
    data: breakdown,
    isLoading: breakdownLoading,
    isError: breakdownError,
  } = useQuery<RecommendationBreakdown[]>({
    queryKey: queryKeys.baselines.breakdown(),
    queryFn: () => baselinesSource.breakdown(),
    refetchInterval: 15_000,
  });

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  const { subscribe, unsubscribe, isConnected } = useWebSocket({
    onMessage: (msg) => {
      if (msg.type === 'BASELINES_UPDATE') {
        queryClient.invalidateQueries({ queryKey: queryKeys.baselines.all });
      }
    },
  });

  useEffect(() => {
    if (isConnected) {
      subscribe(['baselines']);
    }
    return () => {
      unsubscribe(['baselines']);
    };
  }, [isConnected, subscribe, unsubscribe]);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const heroValue = summary ? `${(summary.avg_cost_savings * 100).toFixed(1)}%` : '--';
  const heroSubtitle = summary
    ? `${summary.promote_count} patterns ready to promote | ${summary.total_token_savings.toLocaleString()} tokens saved`
    : 'Average cost savings across promoted patterns';
  const heroStatus: 'healthy' | 'warning' | 'error' | undefined = summary
    ? summary.avg_cost_savings >= 0.15
      ? 'healthy'
      : summary.avg_cost_savings >= 0.05
        ? 'warning'
        : 'error'
    : undefined;

  // Sort comparisons: promote first, then shadow, fork, suppress
  const sortedComparisons = useMemo(() => {
    if (!comparisons) return [];
    const order: Record<PromotionAction, number> = {
      promote: 0,
      shadow: 1,
      fork: 2,
      suppress: 3,
    };
    return [...comparisons].sort((a, b) => order[a.recommendation] - order[b.recommendation]);
  }, [comparisons]);

  return (
    <div className="space-y-6" data-testid="page-baselines-roi">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-primary" />
            Baselines & ROI
          </h2>
          <p className="text-sm text-muted-foreground">
            Cost + outcome comparison for A/B pattern evaluation
          </p>
        </div>
        <div className="flex items-center gap-2">
          {baselinesSource.isUsingMockData && (
            <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
              Demo Data
            </Badge>
          )}
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground'}`}
            />
            <span className="text-[10px] text-muted-foreground">
              {isConnected ? 'Live' : 'Offline'}
            </span>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {summaryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load baselines data</AlertTitle>
          <AlertDescription>
            Baseline summary could not be retrieved. Other sections may also be affected.
          </AlertDescription>
        </Alert>
      )}

      {/* Hero Metric: Cost Savings */}
      <HeroMetric
        label="Average Cost Savings"
        value={heroValue}
        subtitle={heroSubtitle}
        status={heroStatus}
        isLoading={summaryLoading}
      />

      {/* Supporting Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard
          label="Outcome Improvement"
          value={summary ? `${(summary.avg_outcome_improvement * 100).toFixed(1)}%` : '--'}
          subtitle="Average across promoted patterns"
          icon={TrendingUp}
          status={
            summary
              ? summary.avg_outcome_improvement >= 0.1
                ? 'healthy'
                : summary.avg_outcome_improvement >= 0.05
                  ? 'warning'
                  : 'error'
              : undefined
          }
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Token Savings"
          value={summary ? summary.total_token_savings.toLocaleString() : '--'}
          subtitle="Total tokens saved vs baseline"
          icon={Coins}
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Time Savings"
          value={summary ? `${(summary.total_time_savings_ms / 1000).toFixed(1)}s` : '--'}
          subtitle="Total execution time saved"
          icon={Timer}
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Comparisons Active"
          value={summary ? summary.total_comparisons.toLocaleString() : '--'}
          subtitle={
            summary
              ? `${summary.promote_count} promote / ${summary.shadow_count} shadow / ${summary.suppress_count} suppress / ${summary.fork_count} fork`
              : undefined
          }
          icon={BarChart3}
          isLoading={summaryLoading}
        />
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-muted-foreground" />
              14-Day ROI Trend
            </CardTitle>
          </CardHeader>
          <CardContent>
            {trendError ? (
              <p className="text-sm text-destructive py-8 text-center">
                Failed to load trend data.
              </p>
            ) : trendLoading ? (
              <Skeleton className="h-[280px] w-full rounded-lg" />
            ) : (
              <ROITrendChart data={trend} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-muted-foreground" />
              Recommendation Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            {breakdownError ? (
              <p className="text-sm text-destructive py-8 text-center">
                Failed to load breakdown data.
              </p>
            ) : breakdownLoading ? (
              <Skeleton className="h-[280px] w-full rounded-lg" />
            ) : (
              <BreakdownChart data={breakdown} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Promotion Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(['promote', 'shadow', 'suppress', 'fork'] as PromotionAction[]).map((action) => {
          const item = breakdown?.find((b) => b.action === action);
          return (
            <Card
              key={action}
              className="border-l-4"
              style={{ borderLeftColor: ACTION_COLORS[action] }}
            >
              <CardContent className="py-3 px-4">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  {ACTION_LABELS[action]}
                </div>
                <div className="text-2xl font-bold font-mono mt-1">
                  {breakdownLoading ? <Skeleton className="h-8 w-12" /> : (item?.count ?? 0)}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {item ? `${(item.avg_confidence * 100).toFixed(0)}% avg confidence` : '--'}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Pattern Comparisons */}
      <div>
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <GitPullRequest className="w-5 h-5 text-muted-foreground" />
          Pattern Comparisons
          {comparisons && (
            <span className="text-sm font-normal text-muted-foreground">
              ({comparisons.length} active)
            </span>
          )}
        </h3>
        {comparisonsError ? (
          <p className="text-sm text-destructive py-4 text-center">
            Failed to load pattern comparisons.
          </p>
        ) : comparisonsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[260px] w-full rounded-lg" />
            ))}
          </div>
        ) : sortedComparisons.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No pattern comparisons available
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {sortedComparisons.map((c) => (
              <ComparisonCard key={c.pattern_id} comparison={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
