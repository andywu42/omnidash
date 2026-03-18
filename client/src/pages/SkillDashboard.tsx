/**
 * Skill Dashboard (OMN-5278)
 *
 * Displays skill invocation analytics from: onex.evt.omniclaude.skill-invoked.v1
 * Source table: skill_invocations (populated by read-model-consumer.ts)
 *
 * Shows:
 * - Top skills table (name, invocation count, success rate, avg duration)
 * - Recent invocations list
 * - Success rate bar chart (horizontal bars using Tailwind widths, no chart library)
 */

import { useQuery } from '@tanstack/react-query';
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
import { CheckCircle2, XCircle, BarChart3, Zap, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DataSourceEmptyState } from '@/components/EmptyState';

// ============================================================================
// Types
// ============================================================================

interface SkillSummaryRow {
  skill_name: string;
  invocations: number;
  avg_ms: number | null;
  success_rate: number;
}

interface SkillInvocationRow {
  id: number;
  skill_name: string;
  session_id: string | null;
  duration_ms: number | null;
  success: boolean;
  error: string | null;
  created_at: string;
}

interface SkillTotals {
  totalInvocations: number;
  uniqueSkills: number;
  overallSuccessRate: number;
}

interface SkillsPayload {
  skills: SkillSummaryRow[];
  recent: SkillInvocationRow[];
  totals: SkillTotals;
}

// ============================================================================
// Helpers
// ============================================================================

function fmtPct(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

function SkillsBarChart({ skills, isLoading }: { skills: SkillSummaryRow[]; isLoading: boolean }) {
  const maxInvocations = skills.length > 0 ? Math.max(...skills.map((s) => s.invocations)) : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          Top Skills by Invocation Count
        </CardTitle>
        <CardDescription>
          Most-used skills (horizontal bars = relative invocation volume)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : skills.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No skill invocations yet. Waiting for{' '}
            <code className="text-xs">onex.evt.omniclaude.skill-invoked.v1</code> events.
          </p>
        ) : (
          <div className="space-y-3">
            {skills.map((row) => {
              const widthPct = Math.round((row.invocations / maxInvocations) * 100);
              const successPct = row.success_rate ?? 0;
              return (
                <div key={row.skill_name} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-mono truncate max-w-[200px]">{row.skill_name}</span>
                    <div className="flex items-center gap-4 text-muted-foreground text-xs">
                      <span>{row.invocations} calls</span>
                      <span
                        className={
                          successPct >= 0.8
                            ? 'text-green-500'
                            : successPct >= 0.6
                              ? 'text-yellow-500'
                              : 'text-red-500'
                        }
                      >
                        {fmtPct(successPct)} ok
                      </span>
                      <span>{fmtMs(row.avg_ms)} avg</span>
                    </div>
                  </div>
                  <div className="h-2 w-full bg-muted rounded">
                    <div className="h-2 rounded bg-primary" style={{ width: `${widthPct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentInvocationsTable({
  rows,
  isLoading,
}: {
  rows: SkillInvocationRow[];
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Recent Skill Invocations
        </CardTitle>
        <CardDescription>Last 50 invocations from skill_invocations table</CardDescription>
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
            No recent skill invocations.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Skill</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Session</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.skill_name}</TableCell>
                  <TableCell>
                    {row.success ? (
                      <Badge variant="default" className="text-xs">
                        <CheckCircle2 className="h-3 w-3 mr-1 text-green-500" />
                        ok
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="text-xs">
                        <XCircle className="h-3 w-3 mr-1" />
                        failed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {fmtMs(row.duration_ms)}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs max-w-[120px] truncate">
                    {row.session_id ?? '—'}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {relativeTime(row.created_at)}
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

async function fetchSkills(): Promise<SkillsPayload> {
  const res = await fetch('/api/skills');
  if (!res.ok) throw new Error('Failed to fetch skills data');
  return res.json() as Promise<SkillsPayload>;
}

export default function SkillDashboard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.skills.list(),
    queryFn: fetchSkills,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const skills = data?.skills ?? [];
  const recent = data?.recent ?? [];
  const totals = data?.totals ?? { totalInvocations: 0, uniqueSkills: 0, overallSuccessRate: 0 };

  const totalInvocations = totals.totalInvocations;
  const overallSuccessRate = totals.overallSuccessRate;
  const uniqueSkills = totals.uniqueSkills;

  return (
    <div className="space-y-6" data-testid="page-skill-dashboard">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Skill Dashboard</h1>
        <p className="text-muted-foreground">
          Skill invocation analytics from{' '}
          <code className="text-xs">onex.evt.omniclaude.skill-invoked.v1</code>
        </p>
      </div>

      {isError && <p className="text-sm text-destructive">Failed to load skill data.</p>}

      {!isLoading && !isError && totalInvocations === 0 && (
        <DataSourceEmptyState
          sourceName="Skill Invocation Events"
          producerName="omniclaude skill executor"
          instructions="Invoke omniclaude skills to produce skill-invoked events."
        />
      )}

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="Total Invocations"
          value={isLoading ? '—' : String(totalInvocations)}
          icon={BarChart3}
          isLoading={isLoading}
        />
        <StatCard
          title="Unique Skills"
          value={isLoading ? '—' : String(uniqueSkills)}
          icon={Zap}
          isLoading={isLoading}
        />
        <StatCard
          title="Overall Success Rate"
          value={isLoading ? '—' : fmtPct(overallSuccessRate)}
          icon={CheckCircle2}
          valueClass={
            overallSuccessRate >= 0.8
              ? 'text-green-500'
              : overallSuccessRate >= 0.6
                ? 'text-yellow-500'
                : 'text-red-500'
          }
          isLoading={isLoading}
        />
      </div>

      {/* Bar Chart */}
      <SkillsBarChart skills={skills} isLoading={isLoading} />

      {/* Recent Invocations Table */}
      <RecentInvocationsTable rows={recent} isLoading={isLoading} />
    </div>
  );
}
