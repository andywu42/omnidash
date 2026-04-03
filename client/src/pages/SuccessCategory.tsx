/**
 * Real-World Success & Testing Category Dashboard (OMN-2181)
 *
 * Phase 2 consolidated view combining Effectiveness sub-pages and
 * A/B dashboard into a single category landing page.
 *
 * Hero Metric: Success Rate (Treatment vs Control)
 * Content: A/B comparison, injection hit rates, effectiveness trends
 * Sources: EffectivenessSummary, EffectivenessAB, EffectivenessUtilization
 */

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { effectivenessSource } from '@/lib/data-sources/effectiveness-source';
import {
  sessionOutcomeSource,
  type SessionOutcomeSummary,
  type SessionOutcomeTrend,
} from '@/lib/data-sources/session-outcome-source';
import { queryKeys } from '@/lib/query-keys';
import { MetricCard } from '@/components/MetricCard';
import { HeroMetric } from '@/components/HeroMetric';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Link } from 'wouter';
import type {
  EffectivenessSummary as SummaryType,
  ABComparison,
  EffectivenessTrendPoint,
} from '@shared/effectiveness-types';
import {
  Target,
  Zap,
  Gauge,
  Users,
  ArrowRight,
  Activity,
  FlaskConical,
  AlertTriangle,
  Info,
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
} from 'recharts';

// ============================================================================
// A/B Cohort Comparison Mini-Chart
// ============================================================================

function CohortComparisonChart({ data }: { data: ABComparison | undefined }) {
  if (!data?.cohorts?.length) {
    return (
      <div className="h-[240px] flex items-center justify-center text-muted-foreground text-sm">
        No A/B comparison data available
      </div>
    );
  }

  const chartData = data.cohorts.map((c) => ({
    cohort: c.cohort === 'treatment' ? 'Treatment' : 'Control',
    'Success Rate': +c.success_rate_pct.toFixed(1),
    'Avg Accuracy': +c.avg_accuracy_pct.toFixed(1),
    Sessions: c.session_count,
  }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis
          dataKey="cohort"
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
        />
        <YAxis
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
          tickFormatter={(v: number) => `${v}%`}
          domain={[0, 100]}
        />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted))' }}
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
          }}
          formatter={(value: any, name: any) => {
            if (name === 'Sessions') return [value.toLocaleString(), name];
            return [`${value.toFixed(1)}%`, name];
          }}
        />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        <Bar dataKey="Success Rate" fill="#22c55e" radius={[2, 2, 0, 0]} />
        <Bar dataKey="Avg Accuracy" fill="#3b82f6" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// Effectiveness Trend Mini-Chart
// ============================================================================

function EffectivenessTrendChart({ data }: { data: EffectivenessTrendPoint[] | undefined }) {
  if (!data?.length) {
    return (
      <div className="h-[240px] flex items-center justify-center text-muted-foreground text-sm">
        No trend data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis
          dataKey="date"
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
          tickFormatter={(v: string) => v.slice(5)}
        />
        <YAxis
          domain={[0, 1]}
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
          tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
          }}
          formatter={(value: any, name: any) => {
            const labels: Record<string, string> = {
              injection_rate: 'Injection Rate',
              avg_utilization: 'Utilization',
              avg_accuracy: 'Accuracy',
            };
            return [`${(value * 100).toFixed(1)}%`, labels[name] ?? name];
          }}
        />
        <Legend
          wrapperStyle={{ fontSize: '12px' }}
          formatter={(value: string) => {
            const labels: Record<string, string> = {
              injection_rate: 'Injection Rate',
              avg_utilization: 'Utilization',
              avg_accuracy: 'Accuracy',
            };
            return labels[value] ?? value;
          }}
        />
        <Line
          type="monotone"
          dataKey="injection_rate"
          stroke="#22c55e"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="avg_utilization"
          stroke="#3b82f6"
          strokeWidth={2}
          dot={false}
        />
        <Line type="monotone" dataKey="avg_accuracy" stroke="#f59e0b" strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function SuccessCategory() {
  const queryClient = useQueryClient();

  // ---------------------------------------------------------------------------
  // Data Fetching
  // ---------------------------------------------------------------------------

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
  } = useQuery<SummaryType>({
    queryKey: queryKeys.effectiveness.summary(),
    queryFn: () => effectivenessSource.summary(),
    refetchInterval: 15_000,
  });

  const {
    data: abData,
    isLoading: abLoading,
    isError: abError,
  } = useQuery<ABComparison>({
    queryKey: queryKeys.effectiveness.ab(),
    queryFn: () => effectivenessSource.abComparison(),
    refetchInterval: 15_000,
  });

  const {
    data: trend,
    isLoading: trendLoading,
    isError: trendError,
  } = useQuery<EffectivenessTrendPoint[]>({
    queryKey: [...queryKeys.effectiveness.trend(), 14],
    queryFn: () => effectivenessSource.trend(14),
    refetchInterval: 15_000,
  });

  // OMN-5184: Session outcome data from real session-outcome.v1 events
  const { data: sessionOutcomeSummary, isLoading: sessionOutcomeLoading } =
    useQuery<SessionOutcomeSummary>({
      queryKey: queryKeys.sessionOutcomes.summary('7d'),
      queryFn: () => sessionOutcomeSource.summary('7d'),
      refetchInterval: 15_000,
    });

  const { data: sessionOutcomeTrend, isLoading: _sessionOutcomeTrendLoading } =
    useQuery<SessionOutcomeTrend>({
      queryKey: queryKeys.sessionOutcomes.trend('7d'),
      queryFn: () => sessionOutcomeSource.trend('7d'),
      refetchInterval: 15_000,
    });

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  const { subscribe, unsubscribe, isConnected } = useWebSocket({
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
    return () => {
      unsubscribe(['effectiveness']);
    };
  }, [isConnected, subscribe, unsubscribe]);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  // Find treatment cohort success rate for hero metric
  // Note: success_rate_pct is in 0-100 range (already percentage)
  const treatmentCohort = abData?.cohorts?.find((c) => c.cohort === 'treatment');
  const controlCohort = abData?.cohorts?.find((c) => c.cohort === 'control');

  const treatmentSuccessRate = treatmentCohort?.success_rate_pct;
  const controlSuccessRate = controlCohort?.success_rate_pct;

  const heroValue =
    treatmentSuccessRate != null
      ? `${treatmentSuccessRate.toFixed(1)}%`
      : summary
        ? `${(summary.mean_agent_accuracy * 100).toFixed(1)}%`
        : '--';

  const heroSubtitle =
    treatmentSuccessRate != null && controlSuccessRate != null
      ? `Treatment: ${treatmentSuccessRate.toFixed(1)}% vs Control: ${controlSuccessRate.toFixed(1)}%`
      : 'Treatment cohort success rate against baseline control';

  const heroStatus: 'healthy' | 'warning' | 'error' | undefined =
    treatmentSuccessRate != null
      ? treatmentSuccessRate >= 80
        ? 'healthy'
        : treatmentSuccessRate >= 60
          ? 'warning'
          : 'error'
      : undefined;

  return (
    <div className="space-y-6">
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

      {/* Zero-injection info — sessions are running but context injection never succeeded */}
      {!summaryLoading &&
        !summaryError &&
        summary != null &&
        summary.total_sessions > 0 &&
        summary.injection_rate === 0 && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>Context injection not yet active</AlertTitle>
            <AlertDescription>
              {summary.total_sessions.toLocaleString()} sessions recorded, but no context was
              injected (Injection Rate: 0%). The omniclaude plugin may not be returning patterns
              from the intelligence service. Utilization and accuracy metrics will populate once
              injection succeeds.
            </AlertDescription>
          </Alert>
        )}

      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <FlaskConical className="w-6 h-6 text-primary" />
            Real-World Success & Testing
          </h2>
          <p className="text-sm text-muted-foreground">
            A/B comparison, injection hit rates, and effectiveness trends
          </p>
        </div>
        <div className="flex items-center gap-2">
          {effectivenessSource.isUsingMockData && (
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

      {/* Hero Metric: Success Rate */}
      <HeroMetric
        label="Success Rate (Treatment vs Control)"
        value={heroValue}
        subtitle={heroSubtitle}
        status={heroStatus}
        isLoading={summaryLoading && abLoading}
      />

      {/* Supporting Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard
          label="Injection Rate"
          value={summary ? `${(summary.injection_rate * 100).toFixed(1)}%` : '--'}
          subtitle={`Target: ${summary ? (summary.injection_rate_target * 100).toFixed(0) : '--'}%`}
          icon={Zap}
          status={
            summary
              ? summary.injection_rate >= summary.injection_rate_target
                ? 'healthy'
                : 'warning'
              : undefined
          }
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Context Utilization"
          value={summary ? `${(summary.median_utilization * 100).toFixed(1)}%` : '--'}
          subtitle="Median pattern utilization"
          icon={Gauge}
          status={
            summary
              ? summary.median_utilization >= summary.utilization_target
                ? 'healthy'
                : 'warning'
              : undefined
          }
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Agent Accuracy"
          value={summary ? `${(summary.mean_agent_accuracy * 100).toFixed(1)}%` : '--'}
          subtitle="Mean agent-match score"
          icon={Target}
          status={
            summary
              ? summary.mean_agent_accuracy >= summary.accuracy_target
                ? 'healthy'
                : 'warning'
              : undefined
          }
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Total Sessions"
          value={summary ? summary.total_sessions.toLocaleString() : '--'}
          subtitle={
            summary
              ? `${summary.treatment_sessions} treatment / ${summary.control_sessions} control`
              : undefined
          }
          icon={Users}
          isLoading={summaryLoading}
        />
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Target className="w-4 h-4 text-muted-foreground" />
              A/B Cohort Comparison
            </CardTitle>
          </CardHeader>
          <CardContent>
            {abLoading ? (
              <Skeleton className="h-[240px] w-full rounded-lg" />
            ) : abError ? (
              <p className="text-sm text-destructive py-8 text-center">
                Failed to load A/B comparison data.
              </p>
            ) : (
              <CohortComparisonChart data={abData} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="w-4 h-4 text-muted-foreground" />
              14-Day Effectiveness Trend
            </CardTitle>
          </CardHeader>
          <CardContent>
            {trendLoading ? (
              <Skeleton className="h-[240px] w-full rounded-lg" />
            ) : trendError ? (
              <p className="text-sm text-destructive py-8 text-center">
                Failed to load effectiveness trend data.
              </p>
            ) : (
              <EffectivenessTrendChart data={trend} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* OMN-5184: Session Outcomes (real data from session-outcome.v1 events) */}
      {sessionOutcomeSummary && sessionOutcomeSummary.totalSessions > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Target className="w-4 h-4 text-muted-foreground" />
              Session Outcomes (7d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <MetricCard
                label="Session Success Rate"
                value={`${(sessionOutcomeSummary.successRate * 100).toFixed(1)}%`}
                subtitle={`${sessionOutcomeSummary.byOutcome.success} of ${sessionOutcomeSummary.byOutcome.success + sessionOutcomeSummary.byOutcome.failed} completed sessions`}
                icon={Target}
                status={
                  sessionOutcomeSummary.successRate >= 0.8
                    ? 'healthy'
                    : sessionOutcomeSummary.successRate >= 0.6
                      ? 'warning'
                      : 'error'
                }
                isLoading={sessionOutcomeLoading}
              />
              <MetricCard
                label="Successful"
                value={sessionOutcomeSummary.byOutcome.success.toLocaleString()}
                subtitle="Sessions completed successfully"
                icon={Zap}
                isLoading={sessionOutcomeLoading}
              />
              <MetricCard
                label="Failed"
                value={sessionOutcomeSummary.byOutcome.failed.toLocaleString()}
                subtitle="Sessions that failed"
                icon={AlertTriangle}
                isLoading={sessionOutcomeLoading}
              />
              <MetricCard
                label="Total Sessions"
                value={sessionOutcomeSummary.totalSessions.toLocaleString()}
                subtitle={`${sessionOutcomeSummary.byOutcome.abandoned} abandoned, ${sessionOutcomeSummary.byOutcome.unknown} unknown`}
                icon={Users}
                isLoading={sessionOutcomeLoading}
              />
            </div>

            {sessionOutcomeTrend && sessionOutcomeTrend.points.length > 0 && (
              <div className="mt-4">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart
                    data={sessionOutcomeTrend.points.map((p) => ({
                      bucket: p.bucket.slice(5, 10),
                      Success: p.success,
                      Failed: p.failed,
                      Abandoned: p.abandoned,
                    }))}
                    margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                    <XAxis
                      dataKey="bucket"
                      tick={{ fill: 'hsl(var(--foreground))', fontSize: 11, fillOpacity: 0.85 }}
                    />
                    <YAxis
                      tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
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
                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                    <Bar
                      dataKey="Success"
                      fill="#22c55e"
                      stackId="outcomes"
                      radius={[0, 0, 0, 0]}
                    />
                    <Bar dataKey="Failed" fill="#ef4444" stackId="outcomes" radius={[0, 0, 0, 0]} />
                    <Bar
                      dataKey="Abandoned"
                      fill="#f59e0b"
                      stackId="outcomes"
                      radius={[2, 2, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Drill-Down Navigation */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/effectiveness">
          <Card className="cursor-pointer hover:bg-muted/50 transition-colors group">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="w-4 h-4 text-muted-foreground" />
                Effectiveness Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Executive summary with key metrics, trend charts, and session counts.
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
      </div>
    </div>
  );
}
