/**
 * Pattern Lifecycle Dashboard (OMN-5283)
 *
 * Visualizes pattern state machine transitions stored in the
 * pattern_lifecycle_transitions table.
 *
 * Shows:
 *   - Recent transitions table (pattern ID, from_state → to_state, trigger, timestamp)
 *   - State distribution bar chart (transition counts per destination state)
 *   - Daily transition volume trend (last 30 days)
 *
 * Data sources:
 *   GET /api/pattern-lifecycle/recent
 *   GET /api/pattern-lifecycle/state-summary
 *   GET /api/pattern-lifecycle/trend
 */

import { useQuery } from '@tanstack/react-query';
import { RefreshCw, AlertCircle, ArrowRight, GitBranch } from 'lucide-react';
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
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts';
import { formatRelativeTime } from '@/lib/date-utils';
import { POLLING_INTERVAL_SLOW, getPollingInterval } from '@/lib/constants/query-config';
import { useDemoMode } from '@/contexts/DemoModeContext';
import { DemoBanner } from '@/components/DemoBanner';

// ============================================================================
// Types
// ============================================================================

interface LifecycleTransition {
  id: string;
  patternId: string;
  fromStatus: string;
  toStatus: string;
  transitionTrigger: string;
  actor: string | null;
  reason: string | null;
  correlationId: string | null;
  transitionAt: string;
}

interface StateSummaryRow {
  state: string;
  count: number;
}

interface TrendRow {
  day: string;
  count: number;
}

// ============================================================================
// Helpers
// ============================================================================

const STATE_COLORS: Record<string, string> = {
  candidate: '#6366f1',
  provisional: '#f59e0b',
  validated: '#10b981',
  deprecated: '#6b7280',
};

function stateColor(state: string): string {
  return STATE_COLORS[state.toLowerCase()] ?? '#94a3b8';
}

function StateBadge({ state }: { state: string }) {
  const color = stateColor(state);
  return (
    <Badge
      style={{ backgroundColor: color, color: '#fff', border: 'none' }}
      className="font-mono text-xs"
    >
      {state}
    </Badge>
  );
}

function truncateId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

// ============================================================================
// Main Component
// ============================================================================

export default function PatternLifecycleDashboard() {
  const { isDemoMode } = useDemoMode();
  const pollingInterval = getPollingInterval(POLLING_INTERVAL_SLOW);

  const {
    data: recent,
    isLoading: recentLoading,
    isError: recentError,
    refetch: refetchRecent,
  } = useQuery<LifecycleTransition[]>({
    queryKey: ['pattern-lifecycle', 'recent'],
    queryFn: async () => {
      const res = await fetch('/api/pattern-lifecycle/recent?limit=100');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<LifecycleTransition[]>;
    },
    refetchInterval: pollingInterval,
    enabled: !isDemoMode,
    staleTime: 30_000,
  });

  const { data: stateSummary, isLoading: summaryLoading } = useQuery<StateSummaryRow[]>({
    queryKey: ['pattern-lifecycle', 'state-summary'],
    queryFn: async () => {
      const res = await fetch('/api/pattern-lifecycle/state-summary');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<StateSummaryRow[]>;
    },
    refetchInterval: pollingInterval,
    enabled: !isDemoMode,
    staleTime: 30_000,
  });

  const { data: trend, isLoading: trendLoading } = useQuery<TrendRow[]>({
    queryKey: ['pattern-lifecycle', 'trend'],
    queryFn: async () => {
      const res = await fetch('/api/pattern-lifecycle/trend');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<TrendRow[]>;
    },
    refetchInterval: pollingInterval,
    enabled: !isDemoMode,
    staleTime: 30_000,
  });

  const totalTransitions = recent?.length ?? 0;
  const uniquePatterns = recent ? new Set(recent.map((r) => r.patternId)).size : 0;

  return (
    <div className="flex flex-col gap-6 p-6">
      {isDemoMode && <DemoBanner />}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Pattern Lifecycle</h1>
          <p className="text-muted-foreground text-sm mt-1">
            State machine transitions for pattern promotion and demotion
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refetchRecent()}
          disabled={recentLoading}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${recentLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Transitions</CardDescription>
          </CardHeader>
          <CardContent>
            {recentLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-3xl font-bold">{totalTransitions}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Unique Patterns</CardDescription>
          </CardHeader>
          <CardContent>
            {recentLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-3xl font-bold">{uniquePatterns}</p>
            )}
          </CardContent>
        </Card>
        {stateSummary && stateSummary.length > 0 ? (
          stateSummary.slice(0, 2).map((s) => (
            <Card key={s.state}>
              <CardHeader className="pb-2">
                <CardDescription className="capitalize">{s.state} transitions</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold" style={{ color: stateColor(s.state) }}>
                  {s.count}
                </p>
              </CardContent>
            </Card>
          ))
        ) : summaryLoading ? (
          <>
            <Card>
              <CardContent className="pt-6">
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* State distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">State Distribution</CardTitle>
            <CardDescription>Transition counts by destination state</CardDescription>
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : !stateSummary || stateSummary.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                No data
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={stateSummary} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="state" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="count" name="Transitions" radius={[4, 4, 0, 0]}>
                    {stateSummary.map((s) => (
                      <rect key={s.state} fill={stateColor(s.state)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Daily trend */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Daily Transition Volume</CardTitle>
            <CardDescription>Last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            {trendLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : !trend || trend.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                No data
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={trend} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v: string) => v.slice(5, 10)}
                  />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip labelFormatter={(v: string) => v.slice(0, 10)} />
                  <Line
                    type="monotone"
                    dataKey="count"
                    name="Transitions"
                    stroke="#6366f1"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent transitions table */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Recent Transitions</CardTitle>
          </div>
          <CardDescription>Latest 100 pattern lifecycle state changes</CardDescription>
        </CardHeader>
        <CardContent>
          {recentError ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Failed to load transitions</AlertTitle>
              <AlertDescription>Check that the database is available.</AlertDescription>
            </Alert>
          ) : recentLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !recent || recent.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
              No transitions recorded yet. Events arrive via{' '}
              <code className="mx-1 font-mono text-xs bg-muted px-1 py-0.5 rounded">
                onex.evt.omniintelligence.pattern-lifecycle-transitioned.v1
              </code>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pattern ID</TableHead>
                  <TableHead>Transition</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs" title={row.patternId}>
                      {truncateId(row.patternId)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <StateBadge state={row.fromStatus} />
                        <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                        <StateBadge state={row.toStatus} />
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.transitionTrigger}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.actor ?? '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {formatRelativeTime(row.transitionAt)}
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
