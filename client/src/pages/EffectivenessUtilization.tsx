/**
 * EffectivenessUtilization
 *
 * Utilization analytics page (R4) for injection effectiveness.
 * Shows a utilization distribution histogram, per-method median scores,
 * top pattern utilization rates, and a low-utilization session drill-down.
 *
 * @see OMN-1891 - Build Effectiveness Dashboard
 */

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { effectivenessSource } from '@/lib/data-sources/effectiveness-source';
import { DemoBanner } from '@/components/DemoBanner';
import { formatRelativeTime } from '@/lib/date-utils';
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
import { DetailSheet } from '@/components/DetailSheet';
import { SessionDetailSheet, ClickableSessionId } from '@/components/SessionDetailSheet';
import { queryKeys } from '@/lib/query-keys';
import { Link } from 'wouter';
import type {
  UtilizationDetails,
  UtilizationByMethod,
  PatternUtilization,
} from '@shared/effectiveness-types';
import {
  BarChart3,
  ChevronLeft,
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  TrendingDown,
  Copy,
  Check,
  Activity,
  Layers,
  TrendingUp,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

// ============================================================================
// Helpers
// ============================================================================

/** Format a bucket range into a label like "0.0-0.1". */
function bucketLabel(start: number, end: number): string {
  return `${start.toFixed(1)}-${end.toFixed(1)}`;
}

/** Sort direction state for a table column. */
interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

/** Generic comparator for sortable table data. */
function compareRows<T>(a: T, b: T, key: string, dir: 'asc' | 'desc'): number {
  const av = (a as Record<string, unknown>)[key];
  const bv = (b as Record<string, unknown>)[key];
  let cmp = 0;
  if (typeof av === 'number' && typeof bv === 'number') {
    cmp = av - bv;
  } else {
    cmp = String(av).localeCompare(String(bv));
  }
  return dir === 'asc' ? cmp : -cmp;
}

/** Inline sortable column header. */
function SortableHeader({
  label,
  sortKey,
  current,
  onSort,
  className,
}: {
  label: string;
  sortKey: string;
  current: SortState;
  onSort: (key: string) => void;
  className?: string;
}) {
  const active = current.key === sortKey;
  const arrow = active ? (current.dir === 'asc' ? ' \u25B2' : ' \u25BC') : '';
  return (
    <TableHead
      className={`cursor-pointer select-none ${className ?? ''}`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {arrow}
    </TableHead>
  );
}

// ============================================================================
// Component
// ============================================================================

/**
 * Utilization analytics detail page for injection effectiveness.
 *
 * Displays:
 * 1. A histogram of utilization score distribution (10 buckets, 0.0 to 1.0)
 * 2. A table of utilization medians by detection method
 * 3. A table of top-20 pattern utilization rates with inline progress bars
 * 4. A drill-down table of sessions with low utilization (< 0.2)
 *
 * Data refreshes via 15-second polling with WebSocket-triggered invalidation
 * for real-time responsiveness.
 */
export default function EffectivenessUtilization() {
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

  const { data, isLoading, isError, refetch } = useQuery<UtilizationDetails>({
    queryKey: queryKeys.effectiveness.utilization(),
    queryFn: () => effectivenessSource.utilizationDetails(),
    refetchInterval: 15_000,
  });

  // ---------------------------------------------------------------------------
  // Detail sheet state
  // ---------------------------------------------------------------------------

  const [selectedMethod, setSelectedMethod] = useState<UtilizationByMethod | null>(null);
  const [selectedPattern, setSelectedPattern] = useState<PatternUtilization | null>(null);
  const [copiedPatternId, setCopiedPatternId] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Sort state
  // ---------------------------------------------------------------------------

  const [methodSort, setMethodSort] = useState<SortState>({ key: 'median_score', dir: 'desc' });
  const [patternSort, setPatternSort] = useState<SortState>({
    key: 'avg_utilization',
    dir: 'desc',
  });

  const toggleSort = useCallback(
    (setter: React.Dispatch<React.SetStateAction<SortState>>) => (key: string) => {
      setter((prev) =>
        prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }
      );
    },
    []
  );

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const histogramData = (data?.histogram ?? []).map((bucket) => ({
    label: bucketLabel(bucket.range_start, bucket.range_end),
    count: bucket.count,
    range_start: bucket.range_start,
  }));

  const methodRows = useMemo(() => {
    const rows = [...(data?.by_method ?? [])];
    rows.sort((a, b) => compareRows(a, b, methodSort.key, methodSort.dir));
    return rows;
  }, [data?.by_method, methodSort]);

  const patternRows = useMemo(() => {
    const rows = [...(data?.pattern_rates ?? [])].slice(0, 20);
    rows.sort((a, b) => compareRows(a, b, patternSort.key, patternSort.dir));
    return rows;
  }, [data?.pattern_rates, patternSort]);

  const lowSessions = data?.low_utilization_sessions ?? [];

  const totalSessions = (data?.histogram ?? []).reduce((sum, b) => sum + b.count, 0);
  const methodCount = (data?.by_method ?? []).length;
  const peakPatternUtil = (data?.pattern_rates ?? []).reduce(
    (best, p) => (p.avg_utilization > best ? p.avg_utilization : best),
    0
  );

  /** Copy pattern ID to clipboard and flash check icon. */
  const copyPatternId = useCallback((id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedPatternId(true);
    setTimeout(() => setCopiedPatternId(false), 1500);
  }, []);

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
          <AlertTitle>Failed to load utilization data</AlertTitle>
          <AlertDescription>
            Utilization details could not be retrieved. Please try refreshing.
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
            <BarChart3 className="w-6 h-6 text-primary" />
            Utilization Analytics
          </h2>
          <p className="text-sm text-muted-foreground">
            Distribution, method breakdown, pattern rates, and low-utilization sessions
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

      {/* KPI Metric Cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] w-full rounded-lg" />
          ))}
        </div>
      ) : data ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <MetricCard
            label="Sessions Analyzed"
            value={totalSessions.toLocaleString()}
            icon={Activity}
            subtitle="Sessions with utilization scoring data"
          />
          <MetricCard
            label="Detection Methods"
            value={methodCount}
            icon={Layers}
            subtitle="Unique methods observed across sessions"
          />
          <MetricCard
            label="Low Utilization"
            value={lowSessions.length}
            icon={AlertCircle}
            status={lowSessions.length > 0 ? 'warning' : 'healthy'}
            subtitle="Sessions with utilization below 0.2"
          />
          <MetricCard
            label="Peak Pattern Rate"
            value={`${(peakPatternUtil * 100).toFixed(0)}%`}
            icon={TrendingUp}
            subtitle="Highest avg utilization across patterns"
          />
        </div>
      ) : null}

      {/* Utilization Distribution Histogram */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Utilization Distribution</CardTitle>
          <CardDescription>Session count by utilization score bucket (0.0 to 1.0)</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-[280px] w-full" />
          ) : histogramData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={histogramData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fillOpacity: 0.85 }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                  cursor={{ fill: 'hsl(var(--muted))', fillOpacity: 0.15 }}
                  formatter={(value: any) => [value, 'Sessions']}
                />
                <ReferenceLine
                  x="0.6-0.7"
                  stroke="hsl(var(--muted-foreground))"
                  strokeDasharray="5 5"
                  label={{
                    value: 'Target (0.6)',
                    fill: 'hsl(var(--muted-foreground))',
                    fontSize: 11,
                    position: 'top',
                  }}
                />
                <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
              No utilization data available
            </div>
          )}
        </CardContent>
      </Card>

      {/* Two-column grid: Method table + Pattern table */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Utilization by Method */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Utilization by Method</CardTitle>
            <CardDescription>Median utilization score per detection method</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : methodRows.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader
                      label="Method"
                      sortKey="method"
                      current={methodSort}
                      onSort={toggleSort(setMethodSort)}
                    />
                    <SortableHeader
                      label="Median Score"
                      sortKey="median_score"
                      current={methodSort}
                      onSort={toggleSort(setMethodSort)}
                      className="text-right"
                    />
                    <SortableHeader
                      label="Sessions"
                      sortKey="session_count"
                      current={methodSort}
                      onSort={toggleSort(setMethodSort)}
                      className="text-right"
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {methodRows.map((row) => (
                    <TableRow key={row.method}>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => setSelectedMethod(row)}
                        >
                          {row.method}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {row.median_score.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {row.session_count}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
                No method data available
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Pattern Utilization */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top Pattern Utilization</CardTitle>
            <CardDescription>Top 20 patterns by average utilization rate</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : patternRows.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader
                      label="Pattern ID"
                      sortKey="pattern_id"
                      current={patternSort}
                      onSort={toggleSort(setPatternSort)}
                    />
                    <SortableHeader
                      label="Avg Utilization"
                      sortKey="avg_utilization"
                      current={patternSort}
                      onSort={toggleSort(setPatternSort)}
                    />
                    <SortableHeader
                      label="Sessions"
                      sortKey="session_count"
                      current={patternSort}
                      onSort={toggleSort(setPatternSort)}
                      className="text-right"
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {patternRows.map((row) => {
                    const pct = Math.round(row.avg_utilization * 100);
                    return (
                      <TableRow key={row.pattern_id}>
                        <TableCell className="font-mono text-xs">
                          <span
                            className="cursor-pointer hover:text-primary transition-colors"
                            onClick={() => setSelectedPattern(row)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') setSelectedPattern(row);
                            }}
                          >
                            {row.pattern_id.slice(0, 8)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full bg-purple-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="font-mono text-xs text-muted-foreground w-10 text-right">
                              {pct}%
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {row.session_count}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
                No pattern data available
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Low Utilization Sessions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400" />
            Low Utilization Sessions (&lt; 0.2)
          </CardTitle>
          <CardDescription>
            Sessions where injected context was rarely or never referenced
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : lowSessions.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Utilization</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lowSessions.map((session) => (
                  <TableRow key={session.session_id}>
                    <TableCell>
                      <ClickableSessionId
                        sessionId={session.session_id}
                        onClick={setSelectedSessionId}
                      />
                    </TableCell>
                    <TableCell>
                      <span
                        className={`font-mono text-sm ${
                          session.utilization_score < 0.1
                            ? 'text-red-500 font-semibold'
                            : 'text-muted-foreground'
                        }`}
                      >
                        {session.utilization_score.toFixed(2)}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {session.agent_name ?? <span className="text-muted-foreground">--</span>}
                    </TableCell>
                    <TableCell>
                      {session.detection_method ? (
                        <Badge variant="outline" className="text-xs">
                          {session.detection_method}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">--</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {formatRelativeTime(session.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
              <TrendingDown className="w-4 h-4 mr-2" />
              No low-utilization sessions found
            </div>
          )}
        </CardContent>
      </Card>

      {/* Method Detail Sheet */}
      <DetailSheet
        open={selectedMethod !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedMethod(null);
        }}
        title={selectedMethod?.method ?? ''}
        subtitle="Detection method details"
      >
        {selectedMethod && (
          <div className="space-y-6">
            <div>
              <p className="text-sm text-muted-foreground mb-1">Median Score</p>
              <p className="text-3xl font-mono font-semibold">
                {selectedMethod.median_score.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">Session Count</p>
              <p className="text-lg font-mono">{selectedMethod.session_count}</p>
            </div>
            <p className="text-sm text-muted-foreground italic">
              Per-method distribution coming soon
            </p>
          </div>
        )}
      </DetailSheet>

      {/* Pattern Detail Sheet */}
      <DetailSheet
        open={selectedPattern !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedPattern(null);
        }}
        title="Pattern Details"
      >
        {selectedPattern && (
          <div className="space-y-6">
            <div>
              <p className="text-sm text-muted-foreground mb-1">Pattern ID</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-muted px-3 py-2 rounded break-all">
                  {selectedPattern.pattern_id}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => copyPatternId(selectedPattern.pattern_id)}
                >
                  {copiedPatternId ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  <span className="ml-1">{copiedPatternId ? 'Copied' : 'Copy ID'}</span>
                </Button>
              </div>
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">Avg Utilization</p>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-purple-500"
                    style={{ width: `${Math.round(selectedPattern.avg_utilization * 100)}%` }}
                  />
                </div>
                <span className="font-mono text-sm">
                  {Math.round(selectedPattern.avg_utilization * 100)}%
                </span>
              </div>
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">Session Count</p>
              <p className="text-lg font-mono">{selectedPattern.session_count}</p>
            </div>
          </div>
        )}
      </DetailSheet>

      {/* Session Detail Sheet (OMN-2049 F3) */}
      <SessionDetailSheet
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
