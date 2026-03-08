/**
 * Model Efficiency Dashboard (OMN-3941)
 *
 * Displays the Model Efficiency Index (MEI) for comparing model performance
 * across PR validation runs. Shows summary metrics, model comparison table,
 * VTS trend chart, completeness indicators, and PR rollup drill-down.
 *
 * HARD INVARIANT: MEI is defined only over rollup_status='final' rows.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { modelEfficiencySource } from '@/lib/data-sources/model-efficiency-source';
import { useDemoMode } from '@/contexts/DemoModeContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  BarChart3,
  Activity,
  Clock,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
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
} from 'recharts';
import { POLLING_INTERVAL_MEDIUM, getPollingInterval } from '@/lib/constants/query-config';
import type {
  ModelEfficiencySummary,
  ModelEfficiencyTrendPoint,
  PrValidationRollup,
} from '@shared/model-efficiency-types';

// ============================================================================
// Constants
// ============================================================================

const MODEL_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];

/** Minimum PR count before "Best MEI" metric is meaningful. */
const MIN_PR_THRESHOLD = 5;

// ============================================================================
// Helpers
// ============================================================================

function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms.toFixed(0)}ms`;
}

function fmtVts(v: number): string {
  return v.toFixed(1);
}

// ============================================================================
// MetricCard sub-component
// ============================================================================

function MetricCard({
  title,
  value,
  subtitle,
  icon: Icon,
  loading,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ElementType;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            {loading ? (
              <Skeleton className="h-8 w-24 mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1">{value}</p>
            )}
            {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
          </div>
          <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// RollupDrillDown sub-component
// ============================================================================

function RollupDrillDown({
  rollups,
  loading,
}: {
  rollups: PrValidationRollup[];
  loading: boolean;
}) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">PR Rollup Drill-Down</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">PR Rollup Drill-Down</CardTitle>
        <CardDescription>Recent PR validation runs (click to expand)</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Run ID</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Repo</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">VTS</TableHead>
              <TableHead className="text-right">VTS/kLoC</TableHead>
              <TableHead className="text-right">Reruns</TableHead>
              <TableHead className="text-right">Time to Green</TableHead>
              <TableHead>Completeness</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rollups.map((r) => {
              const isExpanded = expandedRunId === r.run_id;
              const hasMissing = r.missing_fields && r.missing_fields.length > 0;
              return (
                <>
                  <TableRow
                    key={r.run_id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setExpandedRunId(isExpanded ? null : r.run_id)}
                  >
                    <TableCell>
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.run_id}</TableCell>
                    <TableCell>{r.model_id}</TableCell>
                    <TableCell>{r.repo_id}</TableCell>
                    <TableCell>
                      <Badge variant={r.rollup_status === 'final' ? 'default' : 'secondary'}>
                        {r.rollup_status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{fmtVts(r.vts)}</TableCell>
                    <TableCell className="text-right">{fmtVts(r.vts_per_kloc)}</TableCell>
                    <TableCell className="text-right">{r.reruns}</TableCell>
                    <TableCell className="text-right">{fmtMs(r.time_to_green_ms)}</TableCell>
                    <TableCell>
                      {hasMissing ? (
                        <Badge variant="destructive" className="text-xs">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          {r.missing_fields.length} missing
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">
                          Complete
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                  {isExpanded && (
                    <TableRow key={`${r.run_id}-detail`}>
                      <TableCell colSpan={10} className="bg-muted/30 p-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                          <div>
                            <span className="text-muted-foreground">PR: </span>
                            {r.pr_url ? (
                              <a
                                href={r.pr_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-500 hover:underline inline-flex items-center gap-1"
                              >
                                #{r.pr_id}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : (
                              r.pr_id || 'N/A'
                            )}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Producer: </span>
                            {r.producer_kind}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Blocking Failures: </span>
                            {r.blocking_failures}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Emitted: </span>
                            {new Date(r.emitted_at).toLocaleString()}
                          </div>
                          {hasMissing && (
                            <div className="col-span-full">
                              <span className="text-muted-foreground">Missing Fields: </span>
                              <span className="text-orange-500">{r.missing_fields.join(', ')}</span>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
            {rollups.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                  No rollup data available yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Dashboard Component
// ============================================================================

export default function ModelEfficiencyDashboard() {
  const { isDemoMode } = useDemoMode();
  const fetchOptions = {
    fallbackToMock: true,
    mockOnEmpty: isDemoMode,
    demoMode: isDemoMode,
  };

  // Summary query
  const { data: summaryData, isLoading: summaryLoading } = useQuery({
    queryKey: ['model-efficiency', 'summary', isDemoMode],
    queryFn: () => modelEfficiencySource.summary(30, fetchOptions),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
  });

  // Trend query
  const { data: trendData, isLoading: trendLoading } = useQuery({
    queryKey: ['model-efficiency', 'trend', isDemoMode],
    queryFn: () => modelEfficiencySource.trend(14, undefined, fetchOptions),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
  });

  // Rollups query (drill-down)
  const { data: rollupsData, isLoading: rollupsLoading } = useQuery({
    queryKey: ['model-efficiency', 'rollups', isDemoMode],
    queryFn: () => modelEfficiencySource.rollups(undefined, 50, undefined, fetchOptions),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
  });

  const summary: ModelEfficiencySummary[] = summaryData ?? [];
  const trend: ModelEfficiencyTrendPoint[] = trendData ?? [];
  const rollups: PrValidationRollup[] = rollupsData ?? [];

  // Derived metrics
  const totalModels = summary.length;
  const totalPrs = summary.reduce((sum, m) => sum + m.pr_count, 0);

  // Best MEI: model with lowest median_vts_per_kloc, but SUPPRESSED below MIN_PR_THRESHOLD
  const qualifiedModels = summary.filter((m) => m.pr_count >= MIN_PR_THRESHOLD);
  const bestModel = qualifiedModels.length > 0 ? qualifiedModels[0] : null;
  const bestMeiValue = bestModel
    ? `${fmtVts(bestModel.median_vts_per_kloc)} (${bestModel.model_id})`
    : 'Insufficient data';

  const avgTimeToGreen =
    summary.length > 0
      ? summary.reduce((sum, m) => sum + m.avg_time_to_green_ms, 0) / summary.length
      : 0;

  // Check if any model has rollups with missing fields
  const hasIncomplete = rollups.some((r) => r.missing_fields && r.missing_fields.length > 0);

  // Build chart data: pivot trend points into date-keyed rows with one key per model
  const modelIds = [...new Set(trend.map((t) => t.model_id))];
  const trendByDate = new Map<string, Record<string, number | string>>();
  for (const point of trend) {
    if (!trendByDate.has(point.date)) {
      trendByDate.set(point.date, { date: point.date });
    }
    const row = trendByDate.get(point.date)!;
    row[point.model_id] = point.median_vts;
  }
  const chartData = [...trendByDate.values()].sort((a, b) =>
    (a.date as string).localeCompare(b.date as string)
  );

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Model Efficiency Index</h1>
          <p className="text-muted-foreground mt-1">
            Comparing model performance across PR validation runs
          </p>
        </div>
        {hasIncomplete && (
          <Badge variant="destructive" className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            Incomplete rollups detected
          </Badge>
        )}
        {modelEfficiencySource.isUsingMockData && <Badge variant="secondary">Demo Data</Badge>}
      </div>

      {/* Summary metric cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard
          title="Models Tracked"
          value={summaryLoading ? '...' : String(totalModels)}
          icon={BarChart3}
          loading={summaryLoading}
        />
        <MetricCard
          title="Best MEI (median VTS/kLoC)"
          value={summaryLoading ? '...' : bestMeiValue}
          subtitle={
            bestModel && bestModel.pr_count < MIN_PR_THRESHOLD
              ? `Suppressed: <${MIN_PR_THRESHOLD} PRs`
              : undefined
          }
          icon={Activity}
          loading={summaryLoading}
        />
        <MetricCard
          title="Total PRs Analyzed"
          value={summaryLoading ? '...' : totalPrs.toLocaleString()}
          icon={BarChart3}
          loading={summaryLoading}
        />
        <MetricCard
          title="Avg Time to Green"
          value={summaryLoading ? '...' : fmtMs(avgTimeToGreen)}
          icon={Clock}
          loading={summaryLoading}
        />
      </div>

      {/* Model comparison table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Model Comparison</CardTitle>
          <CardDescription>
            Aggregated metrics per model (final rollups only). Sorted by median VTS/kLoC ascending
            (lower is better).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {summaryLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">PRs</TableHead>
                  <TableHead className="text-right">Median VTS</TableHead>
                  <TableHead className="text-right">Median VTS/kLoC</TableHead>
                  <TableHead className="text-right">Total Reruns</TableHead>
                  <TableHead className="text-right">Total Autofixes</TableHead>
                  <TableHead className="text-right">Avg Time to Green</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.map((m) => (
                  <TableRow key={m.model_id}>
                    <TableCell className="font-medium">{m.model_id}</TableCell>
                    <TableCell className="text-right">{m.pr_count}</TableCell>
                    <TableCell className="text-right">{fmtVts(m.median_vts)}</TableCell>
                    <TableCell className="text-right">{fmtVts(m.median_vts_per_kloc)}</TableCell>
                    <TableCell className="text-right">{m.total_reruns}</TableCell>
                    <TableCell className="text-right">{m.total_autofixes}</TableCell>
                    <TableCell className="text-right">{fmtMs(m.avg_time_to_green_ms)}</TableCell>
                  </TableRow>
                ))}
                {summary.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      No model efficiency data available yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* VTS Trend Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">VTS Trend (14 days)</CardTitle>
          <CardDescription>Median VTS per model over time (lower is better)</CardDescription>
        </CardHeader>
        <CardContent>
          {trendLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  className="fill-muted-foreground"
                  label={{ value: 'Median VTS', angle: -90, position: 'insideLeft', fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                  }}
                />
                <Legend />
                {modelIds.map((id, idx) => (
                  <Line
                    key={id}
                    type="monotone"
                    dataKey={id}
                    stroke={MODEL_COLORS[idx % MODEL_COLORS.length]}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    name={id}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-64 flex items-center justify-center text-muted-foreground">
              No trend data available yet.
            </div>
          )}
        </CardContent>
      </Card>

      {/* PR Rollup Drill-Down */}
      <RollupDrillDown rollups={rollups} loading={rollupsLoading} />
    </div>
  );
}
