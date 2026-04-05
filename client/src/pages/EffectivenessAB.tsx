/**
 * EffectivenessAB
 *
 * A/B Comparison page for injection effectiveness.
 * Shows treatment vs control cohorts side-by-side with session counts,
 * utilization, accuracy, success rate, and latency metrics plus
 * grouped bar charts for visual comparison.
 *
 * @see OMN-1891 - Build Effectiveness Dashboard (R5)
 */

import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { effectivenessSource } from '@/lib/data-sources/effectiveness-source';
import { DemoBanner } from '@/components/DemoBanner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SignificanceBadge } from '@/components/SignificanceBadge';
import { chiSquaredTest, welchTTest } from '@/lib/statistics';
import type { SignificanceResult } from '@/lib/statistics';
import { queryKeys } from '@/lib/query-keys';
import { Link } from 'wouter';
import type { ABComparison, CohortComparison } from '@shared/effectiveness-types';
import {
  GitCompare,
  ChevronLeft,
  RefreshCw,
  Users,
  TrendingUp,
  Clock,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from 'recharts';

// ============================================================================
// Constants
// ============================================================================

const TREATMENT_COLOR = '#3b82f6';
const CONTROL_COLOR = '#22c55e';

// ============================================================================
// Helpers
// ============================================================================

/** Find a cohort by name from the comparison data, returning a zeroed fallback. */
function findCohort(cohorts: CohortComparison[], name: string): CohortComparison {
  return (
    cohorts.find((c) => c.cohort === name) ?? {
      cohort: name,
      session_count: 0,
      median_utilization_pct: 0,
      avg_accuracy_pct: 0,
      success_rate_pct: 0,
      avg_latency_ms: 0,
    }
  );
}

/** Build chart data for the grouped percentage-metric bar chart. */
function buildMetricChartData(treatment: CohortComparison, control: CohortComparison) {
  return [
    {
      metric: 'Utilization',
      Treatment: treatment.median_utilization_pct,
      Control: control.median_utilization_pct,
    },
    {
      metric: 'Accuracy',
      Treatment: treatment.avg_accuracy_pct,
      Control: control.avg_accuracy_pct,
    },
    {
      metric: 'Success Rate',
      Treatment: treatment.success_rate_pct,
      Control: control.success_rate_pct,
    },
  ];
}

/** Build chart data for the latency comparison bar chart. */
function buildLatencyChartData(treatment: CohortComparison, control: CohortComparison) {
  return [
    { cohort: 'Treatment', latency: treatment.avg_latency_ms },
    { cohort: 'Control', latency: control.avg_latency_ms },
  ];
}

// ============================================================================
// Sub-Components
// ============================================================================

interface SignificanceMap {
  success_rate?: SignificanceResult;
  latency?: SignificanceResult;
}

interface CohortDeltas {
  utilization?: number;
  accuracy?: number;
  success_rate?: number;
  latency?: number;
}

interface CohortCardProps {
  cohort: CohortComparison;
  label: string;
  borderClass: string;
  badgeClass: string;
  deltas?: CohortDeltas;
  significance?: SignificanceMap;
}

/** Format a delta badge with appropriate color and sign. */
function DeltaBadge({ metric, value }: { metric: string; value: number }) {
  // For latency, lower is better (negative delta = green)
  // For utilization, accuracy, success_rate: higher is better (positive = green)
  const isLatency = metric === 'latency';
  const isGood = isLatency ? value < 0 : value > 0;
  const color = isGood ? 'text-green-400' : 'text-red-400';
  const sign = value > 0 ? '+' : '';
  const suffix = isLatency ? 'ms' : 'pp';
  const displayValue = isLatency ? value.toFixed(0) : value.toFixed(1);

  return (
    <span className={`text-[10px] font-mono ml-1.5 ${color}`}>
      {sign}
      {displayValue}
      {suffix}
    </span>
  );
}

/** Renders a single cohort's metrics in a card with colored accent border. */
function CohortCard({
  cohort,
  label,
  borderClass,
  badgeClass,
  deltas,
  significance,
}: CohortCardProps) {
  return (
    <Card className={`border-l-4 ${borderClass}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{label} Cohort</CardTitle>
          <Badge variant="outline" className={badgeClass}>
            {label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 mt-4">
          <div>
            <div className="text-xs text-muted-foreground uppercase">Sessions</div>
            <div className="text-2xl font-bold font-mono">{cohort.session_count}</div>
            <div className="text-[11px] text-muted-foreground mt-1 leading-tight">
              Total sessions in cohort
            </div>
          </div>
          <Link href="/effectiveness/utilization" className="group block">
            <div className="text-xs text-muted-foreground uppercase flex items-center gap-1">
              Utilization
              <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity" />
            </div>
            <div className="text-2xl font-bold font-mono cursor-pointer hover:text-primary transition-colors">
              {cohort.median_utilization_pct.toFixed(1)}%
              {deltas?.utilization != null && (
                <DeltaBadge metric="utilization" value={deltas.utilization} />
              )}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1 leading-tight">
              Median pattern utilization score
            </div>
          </Link>
          <div>
            <div className="text-xs text-muted-foreground uppercase">Accuracy</div>
            <div className="text-2xl font-bold font-mono">
              {cohort.avg_accuracy_pct.toFixed(1)}%
              {deltas?.accuracy != null && <DeltaBadge metric="accuracy" value={deltas.accuracy} />}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1 leading-tight">
              Mean agent-match score
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase">Success Rate</div>
            <div className="text-2xl font-bold font-mono">
              {cohort.success_rate_pct.toFixed(1)}%
              {deltas?.success_rate != null && (
                <DeltaBadge metric="success_rate" value={deltas.success_rate} />
              )}
            </div>
            {significance?.success_rate && (
              <div className="mt-1">
                <SignificanceBadge result={significance.success_rate} metric="success rate" />
              </div>
            )}
            <div className="text-[11px] text-muted-foreground mt-1 leading-tight">
              Successful task completions
            </div>
          </div>
          <Link href="/effectiveness/latency" className="col-span-2 group block">
            <div className="text-xs text-muted-foreground uppercase flex items-center gap-1">
              Avg Latency
              <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity" />
            </div>
            <div className="text-2xl font-bold font-mono cursor-pointer hover:text-primary transition-colors">
              {cohort.avg_latency_ms.toFixed(0)}ms
              {deltas?.latency != null && <DeltaBadge metric="latency" value={deltas.latency} />}
            </div>
            {significance?.latency && (
              <div className="mt-1">
                <SignificanceBadge result={significance.latency} metric="latency" />
              </div>
            )}
            <div className="text-[11px] text-muted-foreground mt-1 leading-tight">
              Mean end-to-end response time
            </div>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Component
// ============================================================================

/**
 * A/B comparison dashboard for injection effectiveness.
 *
 * Displays treatment and control cohort metrics side-by-side with
 * grouped bar charts comparing utilization, accuracy, and success rate,
 * plus a latency comparison chart highlighting the delta.
 *
 * Data refreshes via 15-second polling with WebSocket-triggered invalidation
 * for real-time responsiveness.
 */
export default function EffectivenessAB() {
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

  const { data, isLoading, isError, refetch } = useQuery<ABComparison>({
    queryKey: queryKeys.effectiveness.ab(),
    queryFn: () => effectivenessSource.abComparison(),
    refetchInterval: 15_000,
  });

  const treatment = data ? findCohort(data.cohorts, 'treatment') : null;
  const control = data ? findCohort(data.cohorts, 'control') : null;

  // Compute deltas for treatment card annotations
  const deltas =
    treatment && control
      ? {
          utilization: treatment.median_utilization_pct - control.median_utilization_pct,
          accuracy: treatment.avg_accuracy_pct - control.avg_accuracy_pct,
          success_rate: treatment.success_rate_pct - control.success_rate_pct,
          latency: treatment.avg_latency_ms - control.avg_latency_ms,
        }
      : undefined;

  // ---------------------------------------------------------------------------
  // Statistical significance (OMN-2049 F2)
  // ---------------------------------------------------------------------------

  const significance = useMemo<SignificanceMap | undefined>(() => {
    if (!treatment || !control) return undefined;

    // Chi-squared test for success rate
    const treatmentSuccesses = Math.round(
      (treatment.success_rate_pct / 100) * treatment.session_count
    );
    const treatmentFailures = treatment.session_count - treatmentSuccesses;
    const controlSuccesses = Math.round((control.success_rate_pct / 100) * control.session_count);
    const controlFailures = control.session_count - controlSuccesses;

    const successRateResult = chiSquaredTest(
      treatmentSuccesses,
      treatmentFailures,
      controlSuccesses,
      controlFailures
    );

    // Welch's t-test for latency
    const latencyResult = welchTTest(
      treatment.avg_latency_ms,
      control.avg_latency_ms,
      treatment.session_count,
      control.session_count
    );

    return {
      success_rate: successRateResult,
      latency: latencyResult,
    };
  }, [treatment, control]);

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
          <AlertTitle>Failed to load A/B comparison data</AlertTitle>
          <AlertDescription>
            A/B comparison data could not be retrieved. Please try refreshing.
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
            <GitCompare className="w-6 h-6 text-primary" />
            A/B Comparison
          </h2>
          <p className="text-sm text-muted-foreground">
            Side-by-side treatment vs control cohort metrics
          </p>
        </div>
        <div className="flex items-center gap-3">
          {false && (
            <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
              Demo Data
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Total Sessions Badge */}
      {!isLoading && data && (
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Total sessions:</span>
          <Badge variant="secondary" className="font-mono">
            {data.total_sessions}
          </Badge>
        </div>
      )}

      {/* Side-by-Side Cohort Cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Skeleton className="h-[280px] w-full rounded-lg" />
          <Skeleton className="h-[280px] w-full rounded-lg" />
        </div>
      ) : treatment && control ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <CohortCard
            cohort={treatment}
            label="Treatment"
            borderClass="border-l-blue-500"
            badgeClass="text-blue-500 border-blue-500/30"
            deltas={deltas}
            significance={significance}
          />
          <CohortCard
            cohort={control}
            label="Control"
            borderClass="border-l-green-500"
            badgeClass="text-green-500 border-green-500/30"
          />
        </div>
      ) : (
        <Card>
          <CardContent className="py-8">
            <div className="flex items-center justify-center text-muted-foreground text-sm">
              No A/B comparison data available. Data will appear once sessions with outcomes are
              recorded.
            </div>
          </CardContent>
        </Card>
      )}

      {/* Statistical Significance Summary (OMN-2049 F2) */}
      {!isLoading && significance && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Statistical Significance</CardTitle>
            <CardDescription>
              Confidence levels for key metric differences between cohorts
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {significance.success_rate && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
                  <div>
                    <div className="text-sm font-medium">Success Rate</div>
                    <div className="text-xs text-muted-foreground">
                      Chi-squared test (2x2 contingency)
                    </div>
                  </div>
                  <SignificanceBadge result={significance.success_rate} metric="success rate" />
                </div>
              )}
              {significance.latency && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
                  <div>
                    <div className="text-sm font-medium">Latency</div>
                    <div className="text-xs text-muted-foreground">
                      Welch&apos;s t-test (unequal variance)
                    </div>
                  </div>
                  <SignificanceBadge result={significance.latency} metric="latency" />
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Grouped Bar Chart: Percentage Metrics */}
      {!isLoading && treatment && control && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Metric Comparison</CardTitle>
                <CardDescription>Utilization, accuracy, and success rate by cohort</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={buildMetricChartData(treatment, control)}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="metric"
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                  cursor={{ fill: 'hsl(var(--muted))', fillOpacity: 0.15 }}
                  formatter={(value: any) => [`${value.toFixed(1)}%`, undefined]}
                />
                <Legend />
                <Bar dataKey="Treatment" fill={TREATMENT_COLOR} radius={[4, 4, 0, 0]} />
                <Bar dataKey="Control" fill={CONTROL_COLOR} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Latency Comparison Bar Chart */}
      {!isLoading && treatment && control && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Latency Comparison</CardTitle>
                <CardDescription>
                  Average latency by cohort (delta:{' '}
                  <span className="font-mono">
                    {Math.abs(treatment.avg_latency_ms - control.avg_latency_ms).toFixed(0)}ms
                  </span>
                  )
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={buildLatencyChartData(treatment, control)}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="cohort"
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                />
                <YAxis
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                  tickFormatter={(v: number) => `${v}ms`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                  cursor={{ fill: 'hsl(var(--muted))', fillOpacity: 0.15 }}
                  formatter={(value: any) => [`${value.toFixed(0)}ms`, 'Avg Latency']}
                />
                <Bar dataKey="latency" name="Avg Latency" radius={[4, 4, 0, 0]}>
                  {buildLatencyChartData(treatment, control).map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.cohort === 'Treatment' ? TREATMENT_COLOR : CONTROL_COLOR}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
