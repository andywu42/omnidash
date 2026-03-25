/**
 * Pattern Enforcement Dashboard (OMN-2275)
 *
 * Displays enforcement metrics from `onex.evt.omniclaude.pattern-enforcement.v1`:
 * - Correction rate (GOLDEN METRIC — hero card with trend sparkline)
 * - Enforcement hit rate by language and domain
 * - Top violated patterns table
 * - False positive rate
 * - Multi-metric trend chart (hit rate, correction rate, false positive rate)
 */

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDemoMode } from '@/contexts/DemoModeContext';
import { useFeatureStaleness } from '@/hooks/useStaleness';
import { StalenessIndicator } from '@/components/StalenessIndicator';
import { enforcementSource } from '@/lib/data-sources/enforcement-source';
import { DemoBanner } from '@/components/DemoBanner';
import { FeatureNotEnabledBanner } from '@/components/FeatureNotEnabledBanner';
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
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  TrendingUp,
  BarChart3,
  AlertCircle,
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
import type { EnforcementTimeWindow, ViolatedPattern } from '@shared/enforcement-types';

// ============================================================================
// Constants
// ============================================================================

const TIME_WINDOWS: { value: EnforcementTimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

/** Pastel bar colours for the language chart (cycled by index). */
const LANG_COLORS = ['#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4'];

/** Bar colours for the domain chart. */
const DOMAIN_COLORS = [
  '#6366f1',
  '#10b981',
  '#f97316',
  '#ec4899',
  '#14b8a6',
  '#a855f7',
  '#e11d48',
  '#0ea5e9',
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

/** Colour bucket for a rate value (0–1). */
function rateColor(rate: number): string {
  if (rate >= 0.75) return 'text-green-500';
  if (rate >= 0.5) return 'text-yellow-500';
  return 'text-red-500';
}

/** Badge variant for correction rate. */
function correctionBadge(rate: number): 'default' | 'secondary' | 'destructive' {
  if (rate >= 0.7) return 'default';
  if (rate >= 0.5) return 'secondary';
  return 'destructive';
}

// ============================================================================
// Sub-components
// ============================================================================

/** Segmented time window selector. */
function WindowSelector({
  value,
  onChange,
}: {
  value: EnforcementTimeWindow;
  onChange: (w: EnforcementTimeWindow) => void;
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

/**
 * Hero card for the Correction Rate golden metric.
 * Includes a small sparkline showing 7/30-day trend.
 */
function CorrectionRateHero({
  rate,
  trend,
  isLoading,
}: {
  rate: number;
  trend: Array<{ date: string; value: number }>;
  isLoading: boolean;
}) {
  return (
    <Card className="col-span-full md:col-span-2 border-2 border-primary/40 bg-primary/5">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            Correction Rate
          </CardTitle>
          <CardDescription className="text-xs mt-0.5">
            Golden Metric — violations self-corrected / total violations
          </CardDescription>
        </div>
        <Badge variant={isLoading ? 'secondary' : correctionBadge(rate)} className="text-xs">
          {isLoading
            ? '...'
            : rate >= 0.7
              ? 'Healthy'
              : rate >= 0.5
                ? 'Needs Attention'
                : 'Critical'}
        </Badge>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="flex items-end gap-6">
            <div>
              <span className={cn('text-5xl font-bold tabular-nums', rateColor(rate))}>
                {fmtPct(rate, 0)}
              </span>
              <p className="text-xs text-muted-foreground mt-1">of violations corrected</p>
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
                      formatter={(v: number) => [fmtPct(v), 'Correction Rate']}
                      labelFormatter={(l) => String(l).slice(0, 10)}
                      contentStyle={{ fontSize: '11px' }}
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

/** Simple metric stat card. */
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

/** Top Violated Patterns table. */
function ViolatedPatternsTable({
  patterns,
  isLoading,
  isError,
}: {
  patterns: ViolatedPattern[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-yellow-500" />
          Top Violated Patterns
        </CardTitle>
        <CardDescription>
          Patterns with the most enforcement violations in the window
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <p className="text-sm text-destructive py-4 text-center">
            Failed to load violated patterns.
          </p>
        ) : isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : patterns.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No violations in this window.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pattern</TableHead>
                <TableHead className="text-right">Violations</TableHead>
                <TableHead className="text-right">Corrected</TableHead>
                <TableHead className="text-right">Correction Rate</TableHead>
                <TableHead className="text-right">Last Violation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {patterns.map((p) => (
                <TableRow key={p.pattern_name}>
                  <TableCell>
                    <div className="font-medium font-mono text-xs">{p.pattern_name}</div>
                    <div className="flex gap-1 mt-0.5">
                      {p.language && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0">
                          {p.language}
                        </Badge>
                      )}
                      {p.domain && (
                        <Badge variant="secondary" className="text-[10px] px-1 py-0">
                          {p.domain}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fmtCount(p.violation_count)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-green-500">
                    {fmtCount(p.corrected_count)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn('font-mono text-sm font-medium', rateColor(p.correction_rate))}
                    >
                      {fmtPct(p.correction_rate)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {relativeTime(p.last_violation_at)}
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

export default function PatternEnforcement() {
  const [timeWindow, setTimeWindow] = useState<EnforcementTimeWindow>('7d');
  const { isDemoMode } = useDemoMode();
  const enforcementLastUpdated = useFeatureStaleness('enforcement');

  // ── Queries ──────────────────────────────────────────────────────────────

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
  } = useQuery({
    queryKey: queryKeys.enforcement.summary(timeWindow),
    queryFn: () => enforcementSource.summary(timeWindow, { demoMode: isDemoMode }),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  const {
    data: byLanguage,
    isLoading: langLoading,
    isError: langError,
    refetch: refetchLang,
  } = useQuery({
    queryKey: queryKeys.enforcement.byLanguage(timeWindow),
    queryFn: () => enforcementSource.byLanguage(timeWindow, { demoMode: isDemoMode }),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: byDomain,
    isLoading: domainLoading,
    isError: domainError,
    refetch: refetchDomain,
  } = useQuery({
    queryKey: queryKeys.enforcement.byDomain(timeWindow),
    queryFn: () => enforcementSource.byDomain(timeWindow, { demoMode: isDemoMode }),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: violated,
    isLoading: violatedLoading,
    isError: violatedError,
    refetch: refetchViolated,
  } = useQuery({
    queryKey: queryKeys.enforcement.violatedPatterns(timeWindow),
    queryFn: () => enforcementSource.violatedPatterns(timeWindow, { demoMode: isDemoMode }),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  const {
    data: trend,
    isLoading: trendLoading,
    isError: trendError,
    refetch: refetchTrend,
  } = useQuery({
    queryKey: queryKeys.enforcement.trend(timeWindow),
    queryFn: () => enforcementSource.trend(timeWindow, { demoMode: isDemoMode }),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const handleRefresh = () => {
    refetchSummary();
    refetchLang();
    refetchDomain();
    refetchViolated();
    refetchTrend();
  };

  // enforcementSource.isUsingMockData reads a mutable Set on the singleton.
  // It is always false at mount (before any query resolves), so we use an
  // effect that re-reads it once all queries have settled.
  const [isUsingMockData, setIsUsingMockData] = useState(false);
  const allSettled =
    !summaryLoading && !langLoading && !domainLoading && !violatedLoading && !trendLoading;
  useEffect(() => {
    if (allSettled) {
      setIsUsingMockData(enforcementSource.isUsingMockData);
    }
  }, [allSettled, timeWindow]);

  // Reset the mock-data banner immediately when the time window changes so it
  // does not persist while new queries are in-flight. The effect above will
  // re-evaluate isUsingMockData once all queries settle for the new window.
  useEffect(() => {
    setIsUsingMockData(false);
  }, [timeWindow]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6" data-testid="page-pattern-enforcement">
      {/* Demo mode banner */}
      <DemoBanner />

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Pattern Enforcement</h1>
          <p className="text-muted-foreground">
            Enforcement hit rate, violations, and correction rate from the feedback loop
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StalenessIndicator lastUpdated={enforcementLastUpdated} label="Enforcement" />
          <WindowSelector value={timeWindow} onChange={setTimeWindow} />
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Demo Mode Banner */}
      {isUsingMockData && (
        <Alert variant="default" className="border-yellow-500/50 bg-yellow-500/10">
          <AlertCircle className="h-4 w-4 text-yellow-500" />
          <AlertTitle className="text-yellow-500">Demo Mode</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Database unavailable or no enforcement events yet. Showing representative demo data. The
            dashboard will show live data once{' '}
            <code className="text-xs">onex.evt.omniclaude.pattern-enforcement.v1</code> events are
            received.
          </AlertDescription>
        </Alert>
      )}

      {/* Feature not enabled banner — shown when API returns zero data (not mock, not demo) */}
      {allSettled &&
        !isDemoMode &&
        !isUsingMockData &&
        !summaryError &&
        (summary?.total_evaluations ?? 0) === 0 && (
          <FeatureNotEnabledBanner
            featureName="Pattern Enforcement"
            eventTopic="onex.evt.omniclaude.pattern-enforcement.v1"
            flagHint="ENABLE_PATTERN_ENFORCEMENT"
          />
        )}

      {/* Error Banner */}
      {summaryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load enforcement data</AlertTitle>
          <AlertDescription>
            Unable to load enforcement data. Check that the API server is running.
            <Button variant="outline" size="sm" className="mt-2 ml-2" onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4 mr-1" /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* ── Hero: Correction Rate + Stat Cards ──────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Golden metric spans 2 columns */}
        <CorrectionRateHero
          rate={summary?.correction_rate ?? 0}
          trend={summary?.correction_rate_trend ?? []}
          isLoading={summaryLoading}
        />

        {/* Hit Rate */}
        <StatCard
          title="Enforcement Hit Rate"
          value={summaryLoading ? '—' : fmtPct(summary?.hit_rate ?? 0)}
          description="Patterns accepted on first evaluation"
          icon={ShieldCheck}
          valueClass={rateColor(summary?.hit_rate ?? 0)}
          isLoading={summaryLoading}
        />

        {/* False Positive Rate */}
        <StatCard
          title="False Positive Rate"
          value={summaryLoading ? '—' : fmtPct(summary?.false_positive_rate ?? 0)}
          description="Valid code incorrectly flagged"
          icon={XCircle}
          valueClass={
            (summary?.false_positive_rate ?? 0) < 0.05 ? 'text-green-500' : 'text-yellow-500'
          }
          isLoading={summaryLoading}
        />

        {/* Total Evaluations */}
        <StatCard
          title="Total Evaluations"
          value={summaryLoading ? '—' : fmtCount(summary?.total_evaluations ?? 0)}
          description={`${fmtCount(summary?.violated_pattern_count ?? 0)} distinct violated patterns`}
          icon={BarChart3}
          isLoading={summaryLoading}
        />

        {/* Violations */}
        <StatCard
          title="Violations"
          value={summaryLoading ? '—' : fmtCount(summary?.counts.violations ?? 0)}
          description={`${fmtCount(summary?.counts.corrected ?? 0)} subsequently corrected`}
          icon={AlertTriangle}
          valueClass="text-yellow-500"
          isLoading={summaryLoading}
        />

        {/* Hits */}
        <StatCard
          title="Hits"
          value={summaryLoading ? '—' : fmtCount(summary?.counts.hits ?? 0)}
          description="Pattern applied and accepted"
          icon={CheckCircle2}
          valueClass="text-green-500"
          isLoading={summaryLoading}
        />
      </div>

      {/* ── Trend Chart ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Enforcement Trends
          </CardTitle>
          <CardDescription>
            Hit rate, correction rate, and false positive rate over time
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
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                  domain={[0, 1]}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <Tooltip
                  formatter={(v: number, name: string) => [
                    fmtPct(v),
                    name === 'hit_rate'
                      ? 'Hit Rate'
                      : name === 'correction_rate'
                        ? 'Correction Rate'
                        : 'False Positive Rate',
                  ]}
                  labelFormatter={(l) => String(l).slice(0, 10)}
                  contentStyle={{ fontSize: '12px' }}
                />
                <Legend
                  formatter={(value) =>
                    value === 'hit_rate'
                      ? 'Hit Rate'
                      : value === 'correction_rate'
                        ? 'Correction Rate'
                        : 'False Positive Rate'
                  }
                />
                <Line
                  type="monotone"
                  dataKey="hit_rate"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="correction_rate"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2.5}
                  dot={false}
                  strokeDasharray="0"
                />
                <Line
                  type="monotone"
                  dataKey="false_positive_rate"
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={false}
                  strokeDasharray="4 3"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── By Language + By Domain ─────────────────────────────────────── */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* By Language */}
        <Card>
          <CardHeader>
            <CardTitle>Hit Rate by Language</CardTitle>
            <CardDescription>Enforcement acceptance rate per programming language</CardDescription>
          </CardHeader>
          <CardContent>
            {langError ? (
              <p className="text-sm text-destructive py-4 text-center">
                Failed to load language data.
              </p>
            ) : langLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : (byLanguage?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={byLanguage}
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
                    dataKey="language"
                    tick={{ fontSize: 11 }}
                    width={80}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip
                    formatter={(v: number) => [fmtPct(v), 'Hit Rate']}
                    contentStyle={{ fontSize: '12px' }}
                  />
                  <Bar dataKey="hit_rate" radius={[0, 4, 4, 0]}>
                    {(byLanguage ?? []).map((_, idx) => (
                      <Cell key={idx} fill={LANG_COLORS[idx % LANG_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* By Domain */}
        <Card>
          <CardHeader>
            <CardTitle>Hit Rate by Domain</CardTitle>
            <CardDescription>
              Enforcement acceptance rate per code domain / category
            </CardDescription>
          </CardHeader>
          <CardContent>
            {domainError ? (
              <p className="text-sm text-destructive py-4 text-center">
                Failed to load domain data.
              </p>
            ) : domainLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : (byDomain?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={byDomain}
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
                    dataKey="domain"
                    tick={{ fontSize: 11 }}
                    width={110}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip
                    formatter={(v: number) => [fmtPct(v), 'Hit Rate']}
                    contentStyle={{ fontSize: '12px' }}
                  />
                  <Bar dataKey="hit_rate" radius={[0, 4, 4, 0]}>
                    {(byDomain ?? []).map((_, idx) => (
                      <Cell key={idx} fill={DOMAIN_COLORS[idx % DOMAIN_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Top Violated Patterns ────────────────────────────────────────── */}
      <ViolatedPatternsTable
        patterns={violated ?? []}
        isLoading={violatedLoading}
        isError={violatedError}
      />
    </div>
  );
}
