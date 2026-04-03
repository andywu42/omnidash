/**
 * Review Calibration Dashboard (OMN-6177)
 *
 * Displays review calibration loop metrics: convergence charts, noise ratio
 * trends, recent calibration runs, model scores, and few-shot injection log.
 *
 * API endpoints (from OMN-6176):
 *   GET /api/review-calibration/history?model=&limit=50
 *   GET /api/review-calibration/scores
 *   GET /api/review-calibration/fewshot-log
 */

import { useState, useMemo, useCallback } from 'react';
import { useDataSource } from '@/hooks/useDataSource';
import { queryKeys } from '@/lib/query-keys';
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
import { LocalDataUnavailableBanner } from '@/components/LocalDataUnavailableBanner';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { TrendingDown, Target, BarChart3, FileText, Award, Beaker } from 'lucide-react';
import { cn } from '@/lib/utils';

// ============================================================================
// Types
// ============================================================================

interface CalibrationRun {
  id: string;
  created_at: string;
  ground_truth_model: string;
  challenger_model: string;
  precision: number;
  recall: number;
  f1_score: number;
  noise_ratio: number;
  findings_count: number;
}

interface ModelScore {
  model: string;
  score_correctness: number;
  last_updated: string;
}

interface FewShotLog {
  prompt_version: string;
  injected_examples_count: number;
  last_updated: string;
}

type SortField =
  | 'created_at'
  | 'ground_truth_model'
  | 'challenger_model'
  | 'precision'
  | 'recall'
  | 'f1_score'
  | 'noise_ratio'
  | 'findings_count';
type SortDirection = 'asc' | 'desc';

// ============================================================================
// API Fetchers
// ============================================================================

async function fetchCalibrationHistory(): Promise<CalibrationRun[]> {
  const res = await fetch('/api/review-calibration/history?limit=50');
  if (!res.ok) throw new Error('Failed to fetch calibration history');
  const body = await res.json();
  return (Array.isArray(body) ? body : (body.data ?? [])) as CalibrationRun[];
}

async function fetchModelScores(): Promise<ModelScore[]> {
  const res = await fetch('/api/review-calibration/scores');
  if (!res.ok) throw new Error('Failed to fetch model scores');
  const body = await res.json();
  return (Array.isArray(body) ? body : (body.data ?? [])) as ModelScore[];
}

async function fetchFewShotLog(): Promise<FewShotLog | null> {
  const res = await fetch('/api/review-calibration/fewshot-log');
  if (!res.ok) throw new Error('Failed to fetch few-shot log');
  const body = await res.json();
  return body?.data ?? body ?? null;
}

// ============================================================================
// Helpers
// ============================================================================

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

// ============================================================================
// Sub-components
// ============================================================================

function StatCard({
  title,
  value,
  icon: Icon,
  valueClass,
  isLoading,
}: {
  title: string;
  value: string;
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
          <div className={cn('text-2xl font-bold tabular-nums', valueClass)}>{value}</div>
        )}
      </CardContent>
    </Card>
  );
}

const METRIC_COLORS = {
  precision: '#3b82f6',
  recall: '#10b981',
  f1_score: '#f59e0b',
};

const MODEL_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

function ConvergenceChart({ runs, isLoading }: { runs: CalibrationRun[]; isLoading: boolean }) {
  const chartData = useMemo(() => {
    return [...runs]
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map((r) => ({
        date: formatDate(r.created_at),
        precision: r.precision,
        recall: r.recall,
        f1_score: r.f1_score,
        model: `${r.ground_truth_model} vs ${r.challenger_model}`,
      }));
  }, [runs]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-4 w-4" />
          Convergence Chart
        </CardTitle>
        <CardDescription>Precision, Recall, F1 per calibration run over time</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[300px] w-full" />
        ) : chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No calibration runs yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} className="text-muted-foreground" />
              <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} className="text-muted-foreground" />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                }}
                labelStyle={{ color: 'hsl(var(--foreground))' }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="precision"
                stroke={METRIC_COLORS.precision}
                strokeWidth={2}
                dot={{ r: 3 }}
                name="Precision"
              />
              <Line
                type="monotone"
                dataKey="recall"
                stroke={METRIC_COLORS.recall}
                strokeWidth={2}
                dot={{ r: 3 }}
                name="Recall"
              />
              <Line
                type="monotone"
                dataKey="f1_score"
                stroke={METRIC_COLORS.f1_score}
                strokeWidth={2}
                dot={{ r: 3 }}
                name="F1 Score"
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function NoiseRatioTrend({ runs, isLoading }: { runs: CalibrationRun[]; isLoading: boolean }) {
  const chartData = useMemo(() => {
    const _models = [...new Set(runs.map((r) => r.challenger_model))];
    const sorted = [...runs].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    return sorted.map((r) => {
      const point: Record<string, string | number> = { date: formatDate(r.created_at) };
      // Each model's noise ratio on its own series
      point[r.challenger_model] = r.noise_ratio;
      return point;
    });
  }, [runs]);

  const models = useMemo(() => [...new Set(runs.map((r) => r.challenger_model))], [runs]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingDown className="h-4 w-4" />
          Noise Ratio Trend
        </CardTitle>
        <CardDescription>Noise ratio per model over time (declining = improvement)</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[300px] w-full" />
        ) : chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No calibration data available.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} className="text-muted-foreground" />
              <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} className="text-muted-foreground" />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                }}
                labelStyle={{ color: 'hsl(var(--foreground))' }}
              />
              <Legend />
              {models.map((model, i) => (
                <Area
                  key={model}
                  type="monotone"
                  dataKey={model}
                  stroke={MODEL_COLORS[i % MODEL_COLORS.length]}
                  fill={MODEL_COLORS[i % MODEL_COLORS.length]}
                  fillOpacity={0.15}
                  strokeWidth={2}
                  name={model}
                  connectNulls
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function CategoryHeatmap({ isLoading }: { isLoading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          Category Heatmap
        </CardTitle>
        <CardDescription>Aggregate metrics (category drill-down coming soon)</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[120px] w-full" />
        ) : (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Category-level drill-down will be available in a future release.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RecentRunsTable({
  runs,
  isLoading,
  sortField,
  sortDirection,
  onSort,
}: {
  runs: CalibrationRun[];
  isLoading: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
}) {
  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return '';
    return sortDirection === 'asc' ? ' \u2191' : ' \u2193';
  };

  const SortableHead = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <TableHead
      className="cursor-pointer select-none hover:text-foreground transition-colors"
      onClick={() => onSort(field)}
    >
      {children}
      {sortIndicator(field)}
    </TableHead>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Recent Calibration Runs
        </CardTitle>
        <CardDescription>Click column headers to sort</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No calibration runs recorded yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead field="created_at">Date</SortableHead>
                <SortableHead field="ground_truth_model">Ground Truth</SortableHead>
                <SortableHead field="challenger_model">Challenger</SortableHead>
                <SortableHead field="precision">Precision</SortableHead>
                <SortableHead field="recall">Recall</SortableHead>
                <SortableHead field="f1_score">F1</SortableHead>
                <SortableHead field="noise_ratio">Noise</SortableHead>
                <SortableHead field="findings_count">Findings</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="text-xs">{formatDate(run.created_at)}</TableCell>
                  <TableCell className="font-mono text-xs max-w-[140px] truncate">
                    {run.ground_truth_model}
                  </TableCell>
                  <TableCell className="font-mono text-xs max-w-[140px] truncate">
                    {run.challenger_model}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">{formatPct(run.precision)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatPct(run.recall)}</TableCell>
                  <TableCell className="text-xs tabular-nums font-medium">
                    {formatPct(run.f1_score)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-xs tabular-nums',
                      run.noise_ratio > 0.3 ? 'text-red-500' : 'text-green-500'
                    )}
                  >
                    {formatPct(run.noise_ratio)}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">{run.findings_count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ModelScoresCard({ scores, isLoading }: { scores: ModelScore[]; isLoading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Award className="h-4 w-4" />
          Model Scores
        </CardTitle>
        <CardDescription>Current score_correctness per model</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : scores.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No model scores available.
          </p>
        ) : (
          <div className="space-y-3">
            {scores.map((s) => (
              <div key={s.model} className="flex items-center justify-between">
                <span className="font-mono text-sm truncate max-w-[180px]">{s.model}</span>
                <Badge
                  variant={
                    s.score_correctness >= 0.8
                      ? 'default'
                      : s.score_correctness >= 0.5
                        ? 'secondary'
                        : 'destructive'
                  }
                  className="font-mono"
                >
                  {formatPct(s.score_correctness)}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FewShotLogCard({ log, isLoading }: { log: FewShotLog | null; isLoading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Beaker className="h-4 w-4" />
          Few-Shot Injection Log
        </CardTitle>
        <CardDescription>Current prompt version and injected example count</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : !log ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No few-shot injection data available.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Prompt Version</span>
              <Badge variant="outline" className="font-mono">
                {log.prompt_version}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Injected Examples</span>
              <span className="text-lg font-bold tabular-nums">{log.injected_examples_count}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Last Updated</span>
              <span className="text-xs text-muted-foreground">{formatDate(log.last_updated)}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Dashboard
// ============================================================================

export default function ReviewCalibrationDashboard() {
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const {
    data: history,
    source: historySource,
    isLoading: historyLoading,
  } = useDataSource({
    queryKey: queryKeys.reviewCalibration.history(),
    queryFn: fetchCalibrationHistory,
    fallbackData: [] as CalibrationRun[],
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const { data: scores, isLoading: scoresLoading } = useDataSource({
    queryKey: queryKeys.reviewCalibration.scores(),
    queryFn: fetchModelScores,
    fallbackData: [] as ModelScore[],
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const { data: fewShotLog, isLoading: fewShotLoading } = useDataSource({
    queryKey: queryKeys.reviewCalibration.fewshotLog(),
    queryFn: fetchFewShotLog,
    fallbackData: null as FewShotLog | null,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const handleSort = useCallback((field: SortField) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDirection('desc');
      return field;
    });
  }, []);

  const sortedRuns = useMemo(() => {
    return [...history].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      const aNum = Number(aVal);
      const bNum = Number(bVal);
      return sortDirection === 'asc' ? aNum - bNum : bNum - aNum;
    });
  }, [history, sortField, sortDirection]);

  const latestRun =
    history.length > 0
      ? [...history].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )[0]
      : null;

  const isLoading = historyLoading || scoresLoading || fewShotLoading;

  return (
    <div className="space-y-6" data-testid="page-review-calibration-dashboard">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Review Calibration</h1>
        <p className="text-muted-foreground">
          Calibration loop metrics: convergence, noise trends, model scores, and few-shot injection
          status
        </p>
      </div>

      {historySource === 'unavailable' && <LocalDataUnavailableBanner />}

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Runs"
          value={isLoading ? '\u2014' : String(history.length)}
          icon={BarChart3}
          isLoading={historyLoading}
        />
        <StatCard
          title="Latest F1 Score"
          value={isLoading || !latestRun ? '\u2014' : formatPct(latestRun.f1_score)}
          icon={Target}
          valueClass={
            latestRun && latestRun.f1_score >= 0.8
              ? 'text-green-500'
              : latestRun && latestRun.f1_score < 0.5
                ? 'text-red-500'
                : undefined
          }
          isLoading={historyLoading}
        />
        <StatCard
          title="Latest Noise Ratio"
          value={isLoading || !latestRun ? '\u2014' : formatPct(latestRun.noise_ratio)}
          icon={TrendingDown}
          valueClass={
            latestRun && latestRun.noise_ratio <= 0.2
              ? 'text-green-500'
              : latestRun && latestRun.noise_ratio > 0.3
                ? 'text-red-500'
                : undefined
          }
          isLoading={historyLoading}
        />
        <StatCard
          title="Models Scored"
          value={isLoading ? '\u2014' : String(scores.length)}
          icon={Award}
          isLoading={scoresLoading}
        />
      </div>

      {/* Charts Row */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ConvergenceChart runs={history} isLoading={historyLoading} />
        <NoiseRatioTrend runs={history} isLoading={historyLoading} />
      </div>

      {/* Category Heatmap (placeholder) */}
      <CategoryHeatmap isLoading={historyLoading} />

      {/* Runs Table */}
      <RecentRunsTable
        runs={sortedRuns}
        isLoading={historyLoading}
        sortField={sortField}
        sortDirection={sortDirection}
        onSort={handleSort}
      />

      {/* Bottom Cards */}
      <div className="grid gap-6 md:grid-cols-2">
        <ModelScoresCard scores={scores} isLoading={scoresLoading} />
        <FewShotLogCard log={fewShotLog} isLoading={fewShotLoading} />
      </div>
    </div>
  );
}
