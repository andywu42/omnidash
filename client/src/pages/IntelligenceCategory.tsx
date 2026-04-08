/**
 * Intelligence & Behavior Tracking Category Dashboard (OMN-2181)
 *
 * Phase 2 consolidated view combining Intent Dashboard and
 * Pattern Intelligence into a single category landing page.
 *
 * Hero Metric: Pattern Utilization (top pattern usage %)
 * Content: Intent classification, detection methods, pattern ranking
 * Sources: IntentDashboard, PatternLearning
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIntentProjectionStream } from '@/hooks/useIntentProjectionStream';
import { patlearnSource } from '@/lib/data-sources';
import { queryKeys } from '@/lib/query-keys';
import { MetricCard } from '@/components/MetricCard';
import { HeroMetric } from '@/components/HeroMetric';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { IntentDistribution } from '@/components/intent';
import { TopPatternsTable } from '@/components/pattern';
import { Link } from 'wouter';
import type { IntentProjectionPayload } from '@shared/projection-types';
import {
  Brain,
  Sparkles,
  ArrowRight,
  BarChart3,
  TrendingUp,
  Database,
  Activity,
  AlertTriangle,
} from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { POLLING_INTERVAL_MEDIUM, getPollingInterval } from '@/lib/constants/query-config';

// ============================================================================
// Pattern Usage Donut Chart
// ============================================================================

const DONUT_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4'];

function PatternUsageDonut({
  summary,
  isLoading,
}: {
  summary: { byState: Record<string, number>; totalPatterns: number } | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <Skeleton className="h-[200px] w-full rounded-lg" />;
  }

  if (!summary || summary.totalPatterns === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
        No pattern data available
      </div>
    );
  }

  const data = Object.entries(summary.byState)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => ({
      name: state.charAt(0).toUpperCase() + state.slice(1),
      value: count,
    }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={3}
          dataKey="value"
          label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
        >
          {data.map((_, index) => (
            <Cell key={`cell-${index}`} fill={DONUT_COLORS[index % DONUT_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function IntelligenceCategory() {
  // ---------------------------------------------------------------------------
  // Intent Projection Data
  // ---------------------------------------------------------------------------
  const { snapshot, isConnected } = useIntentProjectionStream<IntentProjectionPayload>(
    'intent-db',
    {
      limit: 100,
    }
  );

  const categoryCount = snapshot?.categoryCount ?? 0;

  const avgConfidence = useMemo(() => {
    if (!snapshot?.recentIntents?.length) return 0;
    const confidences = snapshot.recentIntents
      .map((e) => e.payload.confidence)
      .filter((c) => c != null)
      .map((c) => Number(c))
      .filter((c) => !isNaN(c));
    if (confidences.length === 0) return 0;
    return confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
  }, [snapshot]);

  // ---------------------------------------------------------------------------
  // Pattern Learning Data
  // ---------------------------------------------------------------------------
  const {
    data: patternSummary,
    isLoading: patternSummaryLoading,
    isError: patternSummaryError,
  } = useQuery({
    queryKey: queryKeys.patlearn.summary('24h'),
    queryFn: () => patlearnSource.summary('24h'),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  const {
    data: patterns,
    isLoading: patternsLoading,
    isError: patternsError,
  } = useQuery({
    queryKey: queryKeys.patlearn.list('top-50'),
    queryFn: () =>
      patlearnSource.list({
        limit: 50,
        offset: 0,
        sort: 'score',
        order: 'desc',
      }),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  // ---------------------------------------------------------------------------
  // Derived values for hero metric
  // ---------------------------------------------------------------------------
  const validatedCount = patternSummary?.byState.validated ?? 0;
  const totalPatterns = patternSummary?.totalPatterns ?? 0;
  const utilizationPct =
    totalPatterns > 0 ? ((validatedCount / totalPatterns) * 100).toFixed(1) : '0.0';

  const heroStatus: 'healthy' | 'warning' | 'error' | undefined =
    totalPatterns > 0
      ? validatedCount / totalPatterns >= 0.5
        ? 'healthy'
        : validatedCount / totalPatterns >= 0.2
          ? 'warning'
          : 'error'
      : undefined;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Brain className="w-6 h-6 text-primary" />
            Intelligence & Behavior Tracking
          </h2>
          <p className="text-sm text-muted-foreground">
            Intent classification, detection methods, and pattern ranking
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground'}`}
          />
          <span className="text-[10px] text-muted-foreground">
            {isConnected ? 'Live' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Error Banner */}
      {patternSummaryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load intelligence data</AlertTitle>
          <AlertDescription>
            Pattern summary could not be retrieved. Pattern list and utilization metrics may also be
            affected.
          </AlertDescription>
        </Alert>
      )}

      {/* Hero Metric: Pattern Utilization */}
      <HeroMetric
        label="Pattern Utilization"
        value={`${utilizationPct}%`}
        subtitle={`${validatedCount} validated out of ${totalPatterns} total patterns`}
        status={heroStatus}
        isLoading={patternSummaryLoading}
      />

      {/* Supporting Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard
          label="Total Intents"
          value={snapshot?.totalIntents ?? 0}
          subtitle="Classified intent signals"
          icon={Brain}
          isLoading={!snapshot}
        />
        <MetricCard
          label="Categories"
          value={categoryCount}
          subtitle="Unique intent categories"
          icon={BarChart3}
          isLoading={!snapshot}
        />
        <MetricCard
          label="Avg Confidence"
          value={`${(avgConfidence * 100).toFixed(1)}%`}
          subtitle="Mean classification score"
          icon={TrendingUp}
          status={avgConfidence >= 0.8 ? 'healthy' : avgConfidence >= 0.5 ? 'warning' : undefined}
          isLoading={!snapshot}
        />
        <MetricCard
          label="Total Patterns"
          value={totalPatterns.toLocaleString()}
          subtitle="Across all lifecycle states"
          icon={Database}
          isLoading={patternSummaryLoading}
        />
      </div>

      {/* Visualizations Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Intent Distribution */}
        <Card className="h-full">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="w-4 h-4 text-muted-foreground" />
              Intent Distribution (24h)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <IntentDistribution timeRangeHours={24} refreshInterval={30000} className="h-full" />
          </CardContent>
        </Card>

        {/* Pattern Lifecycle Distribution */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-muted-foreground" />
              Pattern Lifecycle Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PatternUsageDonut
              summary={patternSummary ?? undefined}
              isLoading={patternSummaryLoading}
            />
          </CardContent>
        </Card>
      </div>

      {/* Top Patterns Table */}
      <TopPatternsTable
        patterns={patterns ?? []}
        isLoading={patternsLoading}
        isError={patternsError}
        limit={5}
      />

      {/* Drill-Down Navigation */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link href="/intents">
          <Card className="cursor-pointer hover:bg-muted/50 transition-colors group">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="w-4 h-4 text-muted-foreground" />
                Intent Signals
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Real-time intent classification, session timeline, and confidence analysis.
              </p>
              <div className="flex items-center gap-1 mt-3 text-xs text-primary group-hover:underline">
                View details
                <ArrowRight className="w-3 h-3" />
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href="/patterns">
          <Card className="cursor-pointer hover:bg-muted/50 transition-colors group">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-muted-foreground" />
                Pattern Intelligence
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Full PATLEARN dashboard with evidence-based score debugging.
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
