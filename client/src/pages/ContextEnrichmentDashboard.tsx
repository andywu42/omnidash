/**
 * Context Enrichment Dashboard (OMN-2280)
 *
 * Displays enrichment metrics from `onex.evt.omniclaude.context-enrichment.v1`:
 * - Hit rate per channel (GOLDEN METRIC hero card)
 * - Net tokens saved from summarization (GOLDEN METRIC: net_tokens_saved > 0)
 * - Latency distribution per model
 * - Similarity search quality over time
 * - Context inflation alert table (enrichment increasing token count)
 */

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDemoMode } from '@/contexts/DemoModeContext';
import { enrichmentSource } from '@/lib/data-sources/enrichment-source';
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
  TrendingDown,
  AlertTriangle,
  Coins,
  Gauge,
  Search,
  Zap,
  AlertCircle,
  BarChart3,
  Activity,
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
import { TOOLTIP_STYLE } from '@/lib/constants/chart-theme';
import type { EnrichmentTimeWindow, InflationAlert } from '@shared/enrichment-types';

// ============================================================================
// Constants
// ============================================================================

const TIME_WINDOWS: { value: EnrichmentTimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

/** Bar colours for channel chart (cycled by index). */
const CHANNEL_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-6))',
];

// ============================================================================
// Helpers
// ============================================================================

function fmtPct(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

function fmtTokens(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function fmtMs(ms: number): string {
  return `${ms}ms`;
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

function hitRateColor(rate: number): string {
  if (rate >= 0.7) return 'text-[hsl(var(--chart-2))]';
  if (rate >= 0.5) return 'text-[hsl(var(--chart-4))]';
  return 'text-destructive';
}

function hitRateBadge(rate: number): 'default' | 'secondary' | 'destructive' {
  if (rate >= 0.7) return 'default';
  if (rate >= 0.5) return 'secondary';
  return 'destructive';
}

function tokenSavingsColor(saved: number): string {
  if (saved > 0) return 'text-[hsl(var(--chart-2))]';
  if (saved === 0) return 'text-muted-foreground';
  return 'text-destructive';
}

// ============================================================================
// Sub-components
// ============================================================================

/** Segmented time window selector. */
function WindowSelector({
  value,
  onChange,
}: {
  value: EnrichmentTimeWindow;
  onChange: (w: EnrichmentTimeWindow) => void;
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

/** Hero card for the Hit Rate golden metric. */
function HitRateHero({
  rate,
  total,
  isLoading,
}: {
  rate: number;
  total: number;
  isLoading: boolean;
}) {
  return (
    <Card className="col-span-full md:col-span-2 border-2 border-primary/40 bg-primary/5">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Cache Hit Rate
          </CardTitle>
          <CardDescription className="text-xs mt-0.5">
            Golden Metric — enrichment operations served from cache
          </CardDescription>
        </div>
        <Badge variant={isLoading ? 'secondary' : hitRateBadge(rate)} className="text-xs">
          {isLoading ? '...' : rate >= 0.7 ? 'Healthy' : rate >= 0.5 ? 'Needs Attention' : 'Low'}
        </Badge>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="flex items-end gap-6">
            <div>
              <span className={cn('text-5xl font-bold tabular-nums', hitRateColor(rate))}>
                {fmtPct(rate, 0)}
              </span>
              <p className="text-xs text-muted-foreground mt-1">
                of {total.toLocaleString()} enrichments cached
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Hero card for the Net Tokens Saved golden metric. */
function TokenSavingsHero({
  netTokensSaved,
  isLoading,
}: {
  netTokensSaved: number;
  isLoading: boolean;
}) {
  const isPositive = netTokensSaved > 0;
  return (
    <Card
      className={cn(
        'col-span-full md:col-span-2 border-2',
        isPositive
          ? 'border-[hsl(var(--chart-2)_/_0.4)] bg-[hsl(var(--chart-2)_/_0.05)]'
          : 'border-[hsl(var(--destructive)_/_0.4)] bg-[hsl(var(--destructive)_/_0.05)]'
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Coins
              className={cn(
                'h-4 w-4',
                isPositive ? 'text-[hsl(var(--chart-2))]' : 'text-destructive'
              )}
            />
            Net Tokens Saved
          </CardTitle>
          <CardDescription className="text-xs mt-0.5">
            Golden Metric — net_tokens_saved &gt; 0 means value delivered
          </CardDescription>
        </div>
        <Badge variant={isLoading ? 'secondary' : isPositive ? 'default' : 'destructive'}>
          {isLoading ? '...' : isPositive ? 'Savings Active' : 'No Savings'}
        </Badge>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div>
            <span
              className={cn('text-5xl font-bold tabular-nums', tokenSavingsColor(netTokensSaved))}
            >
              {netTokensSaved >= 0 ? '+' : ''}
              {fmtTokens(netTokensSaved)}
            </span>
            <p className="text-xs text-muted-foreground mt-1">tokens reduced via summarization</p>
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

/** Context inflation alert table. */
function InflationAlertTable({
  alerts,
  isLoading,
  isError,
}: {
  alerts: InflationAlert[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <Card className="border-[hsl(var(--destructive)_/_0.3)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          Context Inflation Alerts
          {alerts.length > 0 && (
            <Badge variant="destructive" className="text-xs ml-1">
              {alerts.length}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Enrichment operations that INCREASED token count — investigate and tune context retrieval
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <p className="text-sm text-destructive py-4 text-center">
            Failed to load inflation alerts.
          </p>
        ) : isLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No context inflation detected in this window.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Before</TableHead>
                <TableHead className="text-right">After</TableHead>
                <TableHead className="text-right">Delta</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {alerts.map((a) => (
                <TableRow key={a.correlation_id}>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] px-1 py-0 font-mono">
                      {a.channel}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {a.model_name}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fmtTokens(a.tokens_before)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fmtTokens(a.tokens_after)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="font-mono text-sm font-medium text-destructive">
                      {fmtTokens(a.net_tokens_saved)}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.agent_name ?? '—'}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {relativeTime(a.occurred_at)}
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

export default function ContextEnrichmentDashboard() {
  const [timeWindow, setTimeWindow] = useState<EnrichmentTimeWindow>('7d');
  const { isDemoMode } = useDemoMode();

  // Clear stale mock-endpoint state whenever the time window changes so that
  // the previous window's mock/real determination does not carry over into the
  // new window's parallel fetches (fixes singleton race condition).
  useEffect(() => {}, [timeWindow]);

  // ── Queries ──────────────────────────────────────────────────────────────

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
  } = useQuery({
    queryKey: queryKeys.enrichment.summary(timeWindow),
    queryFn: () => enrichmentSource.summary(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  const {
    data: byChannel,
    isLoading: channelLoading,
    isError: channelError,
    refetch: refetchChannel,
  } = useQuery({
    queryKey: queryKeys.enrichment.byChannel(timeWindow),
    queryFn: () => enrichmentSource.byChannel(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: latencyDist,
    isLoading: latencyLoading,
    isError: latencyError,
    refetch: refetchLatency,
  } = useQuery({
    queryKey: queryKeys.enrichment.latencyDistribution(timeWindow),
    queryFn: () => enrichmentSource.latencyDistribution(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: tokenSavings,
    isLoading: tokenLoading,
    isError: tokenError,
    refetch: refetchToken,
  } = useQuery({
    queryKey: queryKeys.enrichment.tokenSavings(timeWindow),
    queryFn: () => enrichmentSource.tokenSavings(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: similarityQuality,
    isLoading: simLoading,
    isError: simError,
    refetch: refetchSim,
  } = useQuery({
    queryKey: queryKeys.enrichment.similarityQuality(timeWindow),
    queryFn: () => enrichmentSource.similarityQuality(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: inflationAlerts,
    isLoading: alertsLoading,
    isError: alertsError,
    refetch: refetchAlerts,
  } = useQuery({
    queryKey: queryKeys.enrichment.inflationAlerts(timeWindow),
    queryFn: () => enrichmentSource.inflationAlerts(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const handleRefresh = () => {
    void refetchSummary();
    void refetchChannel();
    void refetchLatency();
    void refetchToken();
    void refetchSim();
    void refetchAlerts();
  };

  // Determine whether we're in demo/mock mode.
  // Derived directly from query loading state and the source's mock-endpoint
  // tracking so no side-effect chaining is required.  The banner is suppressed
  // while any query is still in-flight (allSettled guard) so it doesn't flash
  // during the initial fetch or when the time window changes.
  const allSettled =
    !summaryLoading &&
    !channelLoading &&
    !latencyLoading &&
    !tokenLoading &&
    !simLoading &&
    !alertsLoading;
  // Current behavior (post OMN-2330): the singleton mock-state is only mutated on
  // network/HTTP errors — empty-table responses no longer set mock state. As a result
  // the banner below will only appear when a hard fetch error occurred, not when the
  // API returns an empty-but-successful payload.
  //
  // TODO(OMN-2280): Replace singleton mock-state with query data shape inspection.
  // Acceptance criteria: derive from summaryQuery.data — if summary.total_enrichments === 0
  // after a successful fetch, treat as live-but-empty (not mock). Use useState updated
  // in summaryQuery's onSettled callback to make the banner reactive.
  const [isUsingMockData, setIsUsingMockData] = useState(false);

  useEffect(() => {
    if (allSettled) {
      setIsUsingMockData(false);
    }
  }, [allSettled, timeWindow]);

  // Context inflation alert badge — show if inflation_alert_count > 0
  const showInflationWarning = (summary?.inflation_alert_count ?? 0) > 0 && !summaryLoading;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6" data-testid="page-context-enrichment">
      {/* Demo mode banner */}
      <DemoBanner />

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Context Enrichment</h1>
          <p className="text-muted-foreground">
            Hit rate per channel, token savings, latency distribution, and similarity quality
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

      {/* Demo Mode Banner */}
      {isUsingMockData && (
        <Alert
          variant="default"
          className="border-[hsl(var(--chart-4)_/_0.5)] bg-[hsl(var(--chart-4)_/_0.1)]"
        >
          <AlertCircle className="h-4 w-4 text-[hsl(var(--chart-4))]" />
          <AlertTitle className="text-[hsl(var(--chart-4))]">Demo Mode</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Database unavailable or no enrichment events yet. Showing representative demo data. The
            dashboard will show live data once{' '}
            <code className="text-xs">onex.evt.omniclaude.context-enrichment.v1</code> events are
            received.
          </AlertDescription>
        </Alert>
      )}

      {/* Feature not enabled banner — shown when API returns zero data (not mock, not demo) */}
      {allSettled &&
        !isDemoMode &&
        !isUsingMockData &&
        !summaryError &&
        (summary?.total_enrichments ?? 0) === 0 && (
          <FeatureNotEnabledBanner
            featureName="Context Enrichment"
            eventTopic="onex.evt.omniclaude.context-enrichment.v1"
            flagHint="ENABLE_CONTEXT_ENRICHMENT"
          />
        )}

      {/* Context Inflation Alert Banner */}
      {showInflationWarning && summary && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Context Inflation Detected</AlertTitle>
          <AlertDescription>
            {summary?.inflation_alert_count} enrichment operation
            {summary?.inflation_alert_count !== 1 ? 's' : ''} increased token count in this window.
            Review the inflation alerts table below and tune context retrieval parameters.
          </AlertDescription>
        </Alert>
      )}

      {/* Error Banner */}
      {summaryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load enrichment data</AlertTitle>
          <AlertDescription>
            Unable to load enrichment data. Check that the API server is running.
            <Button variant="outline" size="sm" className="mt-2 ml-2" onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4 mr-1" /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* ── Hero Cards: Hit Rate + Token Savings ─────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Golden Metric 1: Hit Rate (spans 2 cols) */}
        <HitRateHero
          rate={summary?.hit_rate ?? 0}
          total={summary?.total_enrichments ?? 0}
          isLoading={summaryLoading}
        />

        {/* Golden Metric 2: Net Tokens Saved (spans 2 cols) */}
        <TokenSavingsHero
          netTokensSaved={summary?.net_tokens_saved ?? 0}
          isLoading={summaryLoading}
        />

        {/* P50 Latency */}
        <StatCard
          title="P50 Latency"
          value={summaryLoading ? '—' : fmtMs(summary?.p50_latency_ms ?? 0)}
          description="Median enrichment latency"
          icon={Zap}
          isLoading={summaryLoading}
        />

        {/* P95 Latency */}
        <StatCard
          title="P95 Latency"
          value={summaryLoading ? '—' : fmtMs(summary?.p95_latency_ms ?? 0)}
          description="95th percentile latency"
          icon={Gauge}
          valueClass={
            (summary?.p95_latency_ms ?? 0) > 200 ? 'text-[hsl(var(--chart-4))]' : 'text-foreground'
          }
          isLoading={summaryLoading}
        />

        {/* Avg Similarity Score */}
        <StatCard
          title="Avg Similarity Score"
          value={summaryLoading ? '—' : fmtPct(summary?.avg_similarity_score ?? 0)}
          description="Average retrieval relevance (0–1)"
          icon={Search}
          valueClass={hitRateColor(summary?.avg_similarity_score ?? 0)}
          isLoading={summaryLoading}
        />

        {/* Total Enrichments */}
        <StatCard
          title="Total Enrichments"
          value={summaryLoading ? '—' : (summary?.total_enrichments ?? 0).toLocaleString()}
          description={`${(summary?.counts?.misses ?? 0).toLocaleString()} misses, ${(summary?.counts?.errors ?? 0).toLocaleString()} errors`}
          icon={BarChart3}
          isLoading={summaryLoading}
        />

        {/* Inflation Alerts */}
        <StatCard
          title="Inflation Alerts"
          value={summaryLoading ? '—' : (summary?.inflation_alert_count ?? 0).toLocaleString()}
          description="Operations that increased token count"
          icon={TrendingDown}
          valueClass={
            (summary?.inflation_alert_count ?? 0) > 0
              ? 'text-destructive'
              : 'text-[hsl(var(--chart-2))]'
          }
          isLoading={summaryLoading}
        />

        {/* Error Rate */}
        <StatCard
          title="Error Rate"
          value={summaryLoading ? '—' : fmtPct(summary?.error_rate ?? 0)}
          description="Enrichment operations that failed"
          icon={AlertTriangle}
          valueClass={
            (summary?.error_rate ?? 0) < 0.02
              ? 'text-[hsl(var(--chart-2))]'
              : (summary?.error_rate ?? 0) < 0.05
                ? 'text-[hsl(var(--chart-4))]'
                : 'text-destructive'
          }
          isLoading={summaryLoading}
        />
      </div>

      {/* ── Hit Rate by Channel + Latency Distribution ────────────────────── */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Hit Rate by Channel */}
        <Card>
          <CardHeader>
            <CardTitle>Hit Rate by Channel</CardTitle>
            <CardDescription>Cache hit rate per enrichment channel</CardDescription>
          </CardHeader>
          <CardContent>
            {channelError ? (
              <p className="text-sm text-destructive py-4 text-center">
                Failed to load channel data.
              </p>
            ) : channelLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : (byChannel?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={byChannel}
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
                    dataKey="channel"
                    tick={{ fontSize: 11 }}
                    width={110}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip
                    formatter={(v: any, name: any) => [
                      name === 'hit_rate' ? fmtPct(v) : fmtMs(Number(v)),
                      name === 'hit_rate' ? 'Hit Rate' : 'Avg Latency',
                    ]}
                    contentStyle={TOOLTIP_STYLE}
                  />
                  <Bar dataKey="hit_rate" radius={[0, 4, 4, 0]}>
                    {(byChannel ?? []).map((_, idx) => (
                      <Cell key={idx} fill={CHANNEL_COLORS[idx % CHANNEL_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Latency Distribution by Model */}
        <Card>
          <CardHeader>
            <CardTitle>Latency Distribution by Model</CardTitle>
            <CardDescription>P50 / P95 / P99 latency per enrichment model</CardDescription>
          </CardHeader>
          <CardContent>
            {latencyError ? (
              <p className="text-sm text-destructive py-4 text-center">
                Failed to load latency data.
              </p>
            ) : latencyLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : (latencyDist?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={latencyDist} margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="model"
                    tick={{ fontSize: 10 }}
                    stroke="hsl(var(--muted-foreground))"
                    interval={0}
                    angle={-20}
                    textAnchor="end"
                    height={40}
                  />
                  <YAxis
                    tickFormatter={(v: number) => `${v}ms`}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip
                    formatter={(v: any, name: any) => [
                      `${v}ms`,
                      name === 'p50_ms' ? 'P50' : name === 'p95_ms' ? 'P95' : 'P99',
                    ]}
                    contentStyle={TOOLTIP_STYLE}
                  />
                  <Legend formatter={(v) => v.replace('_ms', '').toUpperCase()} />
                  <Bar
                    dataKey="p50_ms"
                    fill="hsl(var(--chart-2))"
                    name="p50_ms"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="p95_ms"
                    fill="hsl(var(--chart-4))"
                    name="p95_ms"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="p99_ms"
                    fill="hsl(var(--chart-5))"
                    name="p99_ms"
                    radius={[2, 2, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Token Savings Trend ──────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-4 w-4" />
            Token Savings Trend
          </CardTitle>
          <CardDescription>
            Net tokens saved per period — positive values confirm enrichment is compressing context
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tokenError ? (
            <p className="text-sm text-destructive py-8 text-center">
              Failed to load token savings data.
            </p>
          ) : tokenLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (tokenSavings?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No token savings data available.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={tokenSavings} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v: string) => String(v).slice(timeWindow === '24h' ? 11 : 5)}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <YAxis
                  tickFormatter={(v: number) => fmtTokens(v)}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <Tooltip
                  formatter={(v: any, name: any) => [
                    fmtTokens(v),
                    name === 'net_tokens_saved'
                      ? 'Net Tokens Saved'
                      : name === 'avg_tokens_before'
                        ? 'Avg Before'
                        : 'Avg After',
                  ]}
                  labelFormatter={(l) => String(l).slice(0, 16)}
                  contentStyle={TOOLTIP_STYLE}
                />
                <Legend
                  formatter={(v) =>
                    v === 'net_tokens_saved'
                      ? 'Net Tokens Saved'
                      : v === 'avg_tokens_before'
                        ? 'Avg Before'
                        : 'Avg After'
                  }
                />
                <Line
                  type="monotone"
                  dataKey="net_tokens_saved"
                  stroke="hsl(var(--chart-2))"
                  strokeWidth={2.5}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="avg_tokens_before"
                  stroke="hsl(var(--muted-foreground))"
                  strokeWidth={1.5}
                  dot={false}
                  strokeDasharray="4 3"
                />
                <Line
                  type="monotone"
                  dataKey="avg_tokens_after"
                  stroke="hsl(var(--chart-1))"
                  strokeWidth={1.5}
                  dot={false}
                  strokeDasharray="4 3"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Similarity Quality Trend ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-4 w-4" />
            Similarity Search Quality
          </CardTitle>
          <CardDescription>
            Average similarity and quality scores from vector search operations
          </CardDescription>
        </CardHeader>
        <CardContent>
          {simError ? (
            <p className="text-sm text-destructive py-8 text-center">
              Failed to load similarity quality data.
            </p>
          ) : simLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (similarityQuality?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No similarity quality data available.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart
                data={similarityQuality}
                margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v: string) => String(v).slice(timeWindow === '24h' ? 11 : 5)}
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
                  formatter={(v: any, name: any) => [
                    fmtPct(v),
                    name === 'avg_similarity_score' ? 'Similarity Score' : 'Quality Score',
                  ]}
                  labelFormatter={(l) => String(l).slice(0, 16)}
                  contentStyle={TOOLTIP_STYLE}
                />
                <Legend
                  formatter={(v) =>
                    v === 'avg_similarity_score' ? 'Similarity Score' : 'Quality Score'
                  }
                />
                <Line
                  type="monotone"
                  dataKey="avg_similarity_score"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="avg_quality_score"
                  stroke="hsl(var(--chart-3))"
                  strokeWidth={2}
                  dot={false}
                  strokeDasharray="4 3"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Context Inflation Alerts ─────────────────────────────────────── */}
      <InflationAlertTable
        alerts={inflationAlerts ?? []}
        isLoading={alertsLoading}
        isError={alertsError}
      />
    </div>
  );
}
