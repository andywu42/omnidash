/**
 * DoD Verification Dashboard (OMN-5200)
 *
 * Displays DoD verification runs and guard events from:
 *   - dod_verify_runs table (populated by OMN-5199 consumer)
 *   - dod_guard_events table (populated by OMN-5199 consumer)
 *
 * Layout:
 *   Row 1 — 4 stat cards (Total Runs, Pass Rate 7d, Guard Blocks 7d, Tickets with Evidence)
 *   Row 2 — Verification Runs table (expandable rows for evidence details)
 *   Row 3 — Guard Activity table
 *   Row 4 — Pass rate trend chart (30-day daily buckets)
 */

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
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
import {
  CheckCircle2,
  ShieldAlert,
  BarChart3,
  Percent,
  Ticket,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { cn } from '@/lib/utils';
import { DataSourceEmptyState } from '@/components/EmptyState';
import type {
  DodPayload,
  DodVerifyRunRow,
  DodGuardEventRow,
  DodTrendPoint,
} from '../../../shared/omniclaude-state-schema';

// ============================================================================
// Helpers
// ============================================================================

function fmtPct(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
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

function statusBadgeVariant(overallPass: boolean): 'default' | 'destructive' {
  return overallPass ? 'default' : 'destructive';
}

function formatReceiptAge(seconds: number | null): string {
  if (seconds == null) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function guardOutcomeBadgeVariant(outcome: string): 'default' | 'secondary' | 'destructive' {
  if (outcome === 'allowed') return 'default';
  if (outcome === 'warned') return 'secondary';
  return 'destructive';
}

function passRateColor(rate: number): string {
  if (rate >= 0.8) return 'text-green-500';
  if (rate >= 0.5) return 'text-yellow-500';
  return 'text-red-500';
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

function VerifyRunsTable({ rows, isLoading }: { rows: DodVerifyRunRow[]; isLoading: boolean }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          Verification Runs
        </CardTitle>
        <CardDescription>Recent DoD verification results from dod_verify_runs</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No verification runs yet. Waiting for DoD verification events.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Ticket</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Checks</TableHead>
                <TableHead>Policy Mode</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const isExpanded = expandedId === row.id;
                const evidenceItems = Array.isArray(row.evidence_items) ? row.evidence_items : [];
                const hasEvidence = evidenceItems.length > 0;

                return (
                  <>
                    <TableRow
                      key={row.id}
                      className={cn(hasEvidence && 'cursor-pointer')}
                      onClick={() => hasEvidence && setExpandedId(isExpanded ? null : row.id)}
                    >
                      <TableCell className="w-8 px-2">
                        {hasEvidence ? (
                          isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.ticket_id}</TableCell>
                      <TableCell>
                        <Badge variant={statusBadgeVariant(row.overall_pass)} className="text-xs">
                          {row.overall_pass ? 'pass' : 'fail'}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.passed_checks}/{row.total_checks}
                      </TableCell>
                      <TableCell className="text-xs">{row.policy_mode}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {relativeTime(row.event_timestamp)}
                      </TableCell>
                    </TableRow>
                    {isExpanded && hasEvidence && (
                      <TableRow key={`${row.id}-evidence`}>
                        <TableCell colSpan={6} className="bg-muted/50 py-3 px-6">
                          <div className="text-xs">
                            <p className="font-medium mb-1">Evidence Items:</p>
                            <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                              {evidenceItems.map((item, idx) => (
                                <li key={idx}>{String(item)}</li>
                              ))}
                            </ul>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function GuardActivityTable({ rows, isLoading }: { rows: DodGuardEventRow[]; isLoading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" />
          Guard Activity
        </CardTitle>
        <CardDescription>Recent DoD guard decisions from dod_guard_events</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No guard events yet. Waiting for DoD guard events.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticket</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Policy Mode</TableHead>
                <TableHead>Receipt Age</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.ticket_id}</TableCell>
                  <TableCell>
                    <Badge
                      variant={guardOutcomeBadgeVariant(row.guard_outcome)}
                      className="text-xs"
                    >
                      {row.guard_outcome}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{row.policy_mode}</TableCell>
                  <TableCell className="text-xs">
                    {formatReceiptAge(row.receipt_age_seconds)}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {relativeTime(row.event_timestamp)}
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

function PassRateTrendChart({ data, isLoading }: { data: DodTrendPoint[]; isLoading: boolean }) {
  // Convert to percentage for chart display
  const chartData = data.map((d) => ({
    date: d.date,
    pass_rate: Math.round(d.pass_rate * 100),
    total: d.total,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          Pass Rate Trend (30 days)
        </CardTitle>
        <CardDescription>Daily DoD verification pass rate</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[250px] w-full" />
        ) : chartData.length === 0 || chartData.every((d) => d.total === 0) ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No trend data available yet.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11 }}
                tickFormatter={(v: string) => {
                  const d = new Date(v);
                  return `${d.getMonth() + 1}/${d.getDate()}`;
                }}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip
                formatter={(value: any) => [`${value}%`, 'Pass Rate']}
                labelFormatter={(label: any) => new Date(label).toLocaleDateString()}
              />
              <Line
                type="monotone"
                dataKey="pass_rate"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Dashboard
// ============================================================================

async function fetchDodSnapshot(): Promise<DodPayload> {
  const res = await fetch('/api/dod/snapshot');
  if (!res.ok) throw new Error('Failed to fetch DoD verification snapshot');
  return res.json() as Promise<DodPayload>;
}

export default function DodDashboard() {
  const queryClient = useQueryClient();

  useWebSocket({
    onMessage: useCallback(
      (msg: { type: string }) => {
        if (msg.type === 'DOD_INVALIDATE') {
          queryClient.invalidateQueries({ queryKey: queryKeys.dod.all });
        }
      },
      [queryClient]
    ),
    debug: false,
  });

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.dod.snapshot(),
    queryFn: fetchDodSnapshot,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const stats = data?.stats;
  const verifyRuns = data?.verify_runs ?? [];
  const guardEvents = data?.guard_events ?? [];
  const trends = data?.trends ?? [];

  return (
    <div className="space-y-6" data-testid="page-dod-dashboard">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">DoD Verification</h1>
        <p className="text-muted-foreground">
          Definition of Done verification runs and guard enforcement activity
        </p>
      </div>

      {isError && <p className="text-sm text-destructive">Failed to load DoD verification data.</p>}

      {!isLoading &&
        !isError &&
        (stats?.total_runs ?? 0) === 0 &&
        verifyRuns.length === 0 &&
        guardEvents.length === 0 && (
          <DataSourceEmptyState
            sourceName="DoD Verification Events"
            producerName="DoD verification pipeline (omniclaude)"
            instructions="Run a DoD verification check on a ticket to produce verification events."
          />
        )}

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Verification Runs"
          value={isLoading ? '--' : String(stats?.total_runs ?? 0)}
          icon={BarChart3}
          isLoading={isLoading}
        />
        <StatCard
          title="Pass Rate (7d)"
          value={isLoading ? '--' : fmtPct(stats?.pass_rate_7d ?? 0)}
          icon={Percent}
          valueClass={passRateColor(stats?.pass_rate_7d ?? 0)}
          isLoading={isLoading}
        />
        <StatCard
          title="Guard Blocks (7d)"
          value={isLoading ? '--' : String(stats?.guard_blocks_7d ?? 0)}
          icon={ShieldAlert}
          valueClass={(stats?.guard_blocks_7d ?? 0) > 0 ? 'text-red-500' : undefined}
          isLoading={isLoading}
        />
        <StatCard
          title="Tickets with Evidence"
          value={isLoading ? '--' : String(stats?.tickets_with_evidence ?? 0)}
          icon={Ticket}
          isLoading={isLoading}
        />
      </div>

      {/* Verification Runs Table */}
      <VerifyRunsTable rows={verifyRuns} isLoading={isLoading} />

      {/* Guard Activity Table */}
      <GuardActivityTable rows={guardEvents} isLoading={isLoading} />

      {/* Trend Chart */}
      <PassRateTrendChart data={trends} isLoading={isLoading} />
    </div>
  );
}
