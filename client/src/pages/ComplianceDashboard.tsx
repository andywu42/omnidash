/**
 * Compliance Dashboard (OMN-5285)
 *
 * Tracks compliance evaluations from onex.evt.omniintelligence.compliance-evaluated.v1:
 * - Pass/fail stats and overall pass rate
 * - Score trend over time
 * - Violations breakdown table
 * - Breakdown by repo and rule set
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { MetricCard } from '@/components/MetricCard';
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
  XCircle,
  ShieldCheck,
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
import { POLLING_INTERVAL_SLOW, getPollingInterval } from '@/lib/constants/query-config';

// ============================================================================
// Types
// ============================================================================

type TimeWindow = '24h' | '7d' | '30d' | 'all';

interface ComplianceSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgScore: number;
}

interface ComplianceEvaluation {
  id: string;
  evaluationId: string;
  repo: string;
  ruleSet: string;
  score: number;
  violations: unknown[];
  pass: boolean;
  eventTimestamp: string | null;
}

interface ComplianceEvaluationsResponse {
  summary: ComplianceSummary;
  evaluations: ComplianceEvaluation[];
}

interface RepoBreakdown {
  repo: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgScore: number;
}

interface RuleSetBreakdown {
  ruleSet: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgScore: number;
}

interface ComplianceSummaryResponse {
  byRepo: RepoBreakdown[];
  byRuleSet: RuleSetBreakdown[];
}

interface TrendPoint {
  period: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgScore: number;
}

interface ComplianceTrendResponse {
  trend: TrendPoint[];
}

// ============================================================================
// Constants
// ============================================================================

const TIME_WINDOWS: { value: TimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

const PASS_RATE_TARGET = 90;

// ============================================================================
// Fetchers
// ============================================================================

async function fetchEvaluations(window: TimeWindow): Promise<ComplianceEvaluationsResponse> {
  const res = await fetch(`/api/compliance?window=${window}&limit=50`);
  if (!res.ok) throw new Error('Failed to fetch compliance evaluations');
  return res.json() as Promise<ComplianceEvaluationsResponse>;
}

async function fetchSummary(window: TimeWindow): Promise<ComplianceSummaryResponse> {
  const res = await fetch(`/api/compliance/summary?window=${window}`);
  if (!res.ok) throw new Error('Failed to fetch compliance summary');
  return res.json() as Promise<ComplianceSummaryResponse>;
}

async function fetchTrend(window: TimeWindow): Promise<ComplianceTrendResponse> {
  const res = await fetch(`/api/compliance/trend?window=${window}`);
  if (!res.ok) throw new Error('Failed to fetch compliance trend');
  return res.json() as Promise<ComplianceTrendResponse>;
}

// ============================================================================
// Helpers
// ============================================================================

function formatTimestamp(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPeriod(period: string, window: TimeWindow): string {
  const d = new Date(period);
  if (window === '24h') {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function passRateColor(rate: number): string {
  if (rate >= PASS_RATE_TARGET) return '#22c55e';
  if (rate >= 70) return '#f59e0b';
  return '#ef4444';
}

// ============================================================================
// ComplianceDashboard
// ============================================================================

export default function ComplianceDashboard() {
  const [window, setWindow] = useState<TimeWindow>('7d');
  const queryClient = useQueryClient();

  const pollingInterval = getPollingInterval(POLLING_INTERVAL_SLOW);

  const evaluationsQuery = useQuery<ComplianceEvaluationsResponse>({
    queryKey: queryKeys.compliance.evaluations(window),
    queryFn: () => fetchEvaluations(window),
    refetchInterval: pollingInterval,
    staleTime: 30_000,
  });

  const summaryQuery = useQuery<ComplianceSummaryResponse>({
    queryKey: queryKeys.compliance.summary(window),
    queryFn: () => fetchSummary(window),
    refetchInterval: pollingInterval,
    staleTime: 30_000,
  });

  const trendQuery = useQuery<ComplianceTrendResponse>({
    queryKey: queryKeys.compliance.trend(window),
    queryFn: () => fetchTrend(window),
    refetchInterval: pollingInterval,
    staleTime: 30_000,
  });

  function handleRefresh() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.compliance.all });
  }

  const isLoading = evaluationsQuery.isLoading || summaryQuery.isLoading || trendQuery.isLoading;
  const isError = evaluationsQuery.isError || summaryQuery.isError || trendQuery.isError;

  const summary = evaluationsQuery.data?.summary ?? {
    total: 0,
    passed: 0,
    failed: 0,
    passRate: 0,
    avgScore: 0,
  };
  const evaluations = evaluationsQuery.data?.evaluations ?? [];
  const trendData = (trendQuery.data?.trend ?? []).map((t) => ({
    ...t,
    period: formatPeriod(t.period, window),
  }));
  const byRepo = summaryQuery.data?.byRepo ?? [];
  const byRuleSet = summaryQuery.data?.byRuleSet ?? [];

  const passRateStatus =
    summary.passRate >= PASS_RATE_TARGET
      ? ('healthy' as const)
      : summary.passRate >= 70
        ? ('warning' as const)
        : ('error' as const);

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="h-6 w-6" />
            Compliance Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Compliance evaluations from{' '}
            <code className="text-xs">onex.evt.omniintelligence.compliance-evaluated.v1</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border overflow-hidden">
            {TIME_WINDOWS.map((tw) => (
              <button
                key={tw.value}
                onClick={() => setWindow(tw.value)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium transition-colors',
                  window === tw.value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background hover:bg-muted'
                )}
              >
                {tw.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isLoading}>
            <RefreshCw className={cn('h-4 w-4 mr-1', isLoading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {isError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error loading compliance data</AlertTitle>
          <AlertDescription>Check server logs for details.</AlertDescription>
        </Alert>
      )}

      {/* Summary metric cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
        ) : (
          <>
            <MetricCard
              label="Pass Rate"
              value={`${summary.passRate}%`}
              subtitle={`Target: ${PASS_RATE_TARGET}%`}
              icon={ShieldCheck}
              status={passRateStatus}
            />
            <MetricCard
              label="Total Evaluations"
              value={summary.total}
              subtitle={`${window} window`}
              icon={BarChart3}
            />
            <MetricCard
              label="Passed"
              value={summary.passed}
              subtitle="evaluations passed"
              icon={CheckCircle2}
              status="healthy"
            />
            <MetricCard
              label="Failed"
              value={summary.failed}
              subtitle="evaluations failed"
              icon={XCircle}
              status={summary.failed === 0 ? 'healthy' : 'error'}
            />
          </>
        )}
      </div>

      {/* Score trend chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Score Trend
          </CardTitle>
          <CardDescription>Pass rate and avg score over time</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-56 w-full" />
          ) : trendData.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
              No trend data in the selected window.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trendData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="rate" domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} />
                <YAxis
                  yAxisId="score"
                  orientation="right"
                  domain={[0, 1]}
                  tick={{ fontSize: 11 }}
                />
                <Tooltip />
                <Legend />
                <Line
                  yAxisId="rate"
                  type="monotone"
                  dataKey="passRate"
                  name="Pass Rate %"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  yAxisId="score"
                  type="monotone"
                  dataKey="avgScore"
                  name="Avg Score"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Breakdown by repo and rule set */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* By repo */}
        <Card>
          <CardHeader>
            <CardTitle>By Repository</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : byRepo.length === 0 ? (
              <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
                No data available.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(160, byRepo.length * 36)}>
                <BarChart
                  layout="vertical"
                  data={byRepo}
                  margin={{ left: 10, right: 20, top: 5, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="repo" tick={{ fontSize: 11 }} width={100} />
                  <Tooltip formatter={(v: any) => `${v}%`} />
                  <Bar dataKey="passRate" name="Pass Rate %" radius={[0, 4, 4, 0]}>
                    {byRepo.map((entry) => (
                      <Cell key={entry.repo} fill={passRateColor(entry.passRate)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* By rule set */}
        <Card>
          <CardHeader>
            <CardTitle>By Rule Set</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : byRuleSet.length === 0 ? (
              <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
                No data available.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(160, byRuleSet.length * 36)}>
                <BarChart
                  layout="vertical"
                  data={byRuleSet}
                  margin={{ left: 10, right: 20, top: 5, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="ruleSet" tick={{ fontSize: 11 }} width={110} />
                  <Tooltip formatter={(v: any) => `${v}%`} />
                  <Bar dataKey="passRate" name="Pass Rate %" radius={[0, 4, 4, 0]}>
                    {byRuleSet.map((entry) => (
                      <Cell key={entry.ruleSet} fill={passRateColor(entry.passRate)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent evaluations table */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Evaluations</CardTitle>
          <CardDescription>Latest compliance-evaluated.v1 events ({window} window)</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : evaluations.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              No evaluations in the selected window.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead>Rule Set</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="text-right">Violations</TableHead>
                  <TableHead className="text-center">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {evaluations.map((ev) => (
                  <TableRow key={ev.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatTimestamp(ev.eventTimestamp)}
                    </TableCell>
                    <TableCell className="font-mono text-xs max-w-[120px] truncate">
                      {ev.repo}
                    </TableCell>
                    <TableCell className="text-xs">{ev.ruleSet}</TableCell>
                    <TableCell className="text-right text-xs font-mono">
                      {typeof ev.score === 'number' ? ev.score.toFixed(3) : '—'}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {Array.isArray(ev.violations) ? ev.violations.length : 0}
                    </TableCell>
                    <TableCell className="text-center">
                      {ev.pass ? (
                        <Badge
                          variant="outline"
                          className="border-green-500 text-green-600 text-xs"
                        >
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          pass
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-red-500 text-red-600 text-xs">
                          <XCircle className="h-3 w-3 mr-1" />
                          fail
                        </Badge>
                      )}
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
