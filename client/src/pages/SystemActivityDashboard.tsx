/**
 * System Activity Dashboard
 *
 * Shows what the autonomous system is doing: build loop phase timeline,
 * recent pipeline runs (skill invocations), agent sessions, and delegations.
 *
 * Data sources:
 * - phase_metrics_events (build loop)
 * - skill_invocations (pipeline runs)
 * - session_outcomes (agent sessions)
 * - delegation_events (delegation activity)
 */

import { useQuery } from '@tanstack/react-query';
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
import { Activity, CheckCircle2, XCircle, Clock, Zap, Users, Bot, BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DataSourceEmptyState } from '@/components/EmptyState';

// ============================================================================
// Types
// ============================================================================

interface PhaseRow {
  session_id: string;
  phase: string;
  status: string;
  duration_ms: number;
  ticket_id: string | null;
  emitted_at: string;
}

interface BuildLoopState {
  phase: string;
  status: string;
  sessionId: string;
  at: string;
}

interface BuildLoopPayload {
  phases: PhaseRow[];
  currentState: BuildLoopState | null;
}

interface PipelineRow {
  id: number;
  skill_name: string;
  session_id: string | null;
  duration_ms: number | null;
  success: boolean;
  status: string;
  error: string | null;
  created_at: string;
}

interface PipelinesPayload {
  pipelines: PipelineRow[];
  totals: { total: number; success: number; error: number };
}

interface SessionRow {
  session_id: string;
  outcome: string;
  emitted_at: string;
}

interface SessionsPayload {
  sessions: SessionRow[];
  totals: { total: number; byOutcome: Record<string, number> };
}

interface DelegationRow {
  id: string;
  task_type: string;
  delegated_to: string;
  delegated_by: string | null;
  quality_gate_passed: boolean;
  cost_usd: string | null;
  timestamp: string;
}

interface DelegationsPayload {
  delegations: DelegationRow[];
  totals: { total: number; qualityGatePassRate: number | null; totalCostUsd: number | null };
}

// ============================================================================
// Helpers
// ============================================================================

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

function fmtMs(ms: number | null): string {
  if (ms == null) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function phaseBadgeVariant(status: string): 'default' | 'destructive' | 'secondary' | 'outline' {
  switch (status) {
    case 'completed':
    case 'success':
      return 'default';
    case 'failed':
    case 'error':
      return 'destructive';
    case 'running':
    case 'in_progress':
      return 'secondary';
    default:
      return 'outline';
  }
}

// ============================================================================
// Sub-components
// ============================================================================

function StatCard({
  title,
  value,
  icon: Icon,
  subtitle,
  valueClass,
  isLoading,
}: {
  title: string;
  value: string;
  icon: React.ElementType;
  subtitle?: string;
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
            {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BuildLoopCard({
  data,
  isLoading,
}: {
  data: BuildLoopPayload | undefined;
  isLoading: boolean;
}) {
  const currentState = data?.currentState;
  const phases = data?.phases ?? [];

  // Group by session to show timeline
  const sessionPhases = new Map<string, PhaseRow[]>();
  for (const p of phases) {
    const existing = sessionPhases.get(p.session_id) ?? [];
    existing.push(p);
    sessionPhases.set(p.session_id, existing);
  }

  // Show the most recent 3 sessions
  const recentSessions = [...sessionPhases.entries()].slice(0, 3);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Build Loop Status
        </CardTitle>
        <CardDescription>Phase timeline from phase_metrics_events (last 24h)</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : phases.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No build loop phases recorded in the last 24 hours.
          </p>
        ) : (
          <div className="space-y-4">
            {/* Current state banner */}
            {currentState && (
              <div className="flex items-center gap-3 p-3 rounded-md bg-muted/50">
                <Badge variant={phaseBadgeVariant(currentState.status)}>
                  {currentState.phase.toUpperCase()}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {currentState.status} -- {relativeTime(currentState.at)}
                </span>
              </div>
            )}

            {/* Recent session timelines */}
            {recentSessions.map(([sessionId, sessionRows]) => (
              <div key={sessionId} className="space-y-1">
                <p className="text-xs text-muted-foreground font-mono truncate">
                  Session: {sessionId}
                </p>
                <div className="flex flex-wrap gap-1">
                  {sessionRows
                    .slice()
                    .reverse()
                    .map((p, i) => (
                      <Badge key={i} variant={phaseBadgeVariant(p.status)} className="text-xs">
                        {p.phase} ({fmtMs(p.duration_ms)})
                      </Badge>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PipelinesTable({
  data,
  isLoading,
}: {
  data: PipelinesPayload | undefined;
  isLoading: boolean;
}) {
  const rows = data?.pipelines ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Recent Pipeline Runs
        </CardTitle>
        <CardDescription>Skill invocations from skill_invocations table</CardDescription>
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
            No skill invocations recorded yet.
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
                        error
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
                    {row.session_id ?? '--'}
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

function SessionsCard({
  data,
  isLoading,
}: {
  data: SessionsPayload | undefined;
  isLoading: boolean;
}) {
  const sessions = data?.sessions ?? [];
  const totals = data?.totals ?? { total: 0, byOutcome: {} };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-4 w-4" />
          Active Agent Sessions
        </CardTitle>
        <CardDescription>
          Recent session outcomes (last 24h: {totals.total} sessions)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No session outcomes recorded yet.
          </p>
        ) : (
          <div className="space-y-3">
            {/* Outcome breakdown bar */}
            {Object.keys(totals.byOutcome).length > 0 && (
              <div className="flex flex-wrap gap-2 pb-2 border-b">
                {Object.entries(totals.byOutcome).map(([outcome, count]) => (
                  <Badge key={outcome} variant="outline" className="text-xs">
                    {outcome}: {count}
                  </Badge>
                ))}
              </div>
            )}

            {/* Recent sessions list */}
            <div className="space-y-1">
              {sessions.slice(0, 15).map((s) => (
                <div key={s.session_id} className="flex items-center justify-between text-xs py-1">
                  <span className="font-mono truncate max-w-[200px]">{s.session_id}</span>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={s.outcome === 'success' ? 'default' : 'secondary'}
                      className="text-xs"
                    >
                      {s.outcome}
                    </Badge>
                    <span className="text-muted-foreground">{relativeTime(s.emitted_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DelegationsTable({
  data,
  isLoading,
}: {
  data: DelegationsPayload | undefined;
  isLoading: boolean;
}) {
  const rows = data?.delegations ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4" />
          Delegation Activity
        </CardTitle>
        <CardDescription>Recent task delegations from delegation_events table</CardDescription>
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
            No delegation events recorded yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task Type</TableHead>
                <TableHead>Delegated To</TableHead>
                <TableHead>Quality Gate</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.task_type}</TableCell>
                  <TableCell className="text-xs">{row.delegated_to}</TableCell>
                  <TableCell>
                    {row.quality_gate_passed ? (
                      <Badge variant="default" className="text-xs">
                        <CheckCircle2 className="h-3 w-3 mr-1 text-green-500" />
                        passed
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="text-xs">
                        <XCircle className="h-3 w-3 mr-1" />
                        failed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">
                    {row.cost_usd != null ? `$${Number(row.cost_usd).toFixed(4)}` : '--'}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {relativeTime(row.timestamp)}
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

export default function SystemActivityDashboard() {
  const buildLoop = useQuery<BuildLoopPayload>({
    queryKey: ['system-activity', 'build-loop'],
    queryFn: async () => {
      const res = await fetch('/api/system-activity/build-loop');
      if (!res.ok) throw new Error('Failed to fetch build loop data');
      return res.json();
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const pipelines = useQuery<PipelinesPayload>({
    queryKey: ['system-activity', 'pipelines'],
    queryFn: async () => {
      const res = await fetch('/api/system-activity/pipelines?limit=30');
      if (!res.ok) throw new Error('Failed to fetch pipelines data');
      return res.json();
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const sessions = useQuery<SessionsPayload>({
    queryKey: ['system-activity', 'sessions'],
    queryFn: async () => {
      const res = await fetch('/api/system-activity/sessions?limit=20');
      if (!res.ok) throw new Error('Failed to fetch sessions data');
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const delegations = useQuery<DelegationsPayload>({
    queryKey: ['system-activity', 'delegations'],
    queryFn: async () => {
      const res = await fetch('/api/system-activity/delegations?limit=20');
      if (!res.ok) throw new Error('Failed to fetch delegations data');
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const isAllLoading =
    buildLoop.isLoading && pipelines.isLoading && sessions.isLoading && delegations.isLoading;
  const isAllEmpty =
    !isAllLoading &&
    (buildLoop.data?.phases.length ?? 0) === 0 &&
    (pipelines.data?.totals.total ?? 0) === 0 &&
    (sessions.data?.totals.total ?? 0) === 0 &&
    (delegations.data?.totals.total ?? 0) === 0;

  const pipelineTotals = pipelines.data?.totals ?? { total: 0, success: 0, error: 0 };
  const sessionTotal = sessions.data?.totals.total ?? 0;
  const delegationTotals = delegations.data?.totals ?? {
    total: 0,
    qualityGatePassRate: null,
    totalCostUsd: null,
  };

  return (
    <div className="space-y-6" data-testid="page-system-activity">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">System Activity</h1>
        <p className="text-muted-foreground">
          What the autonomous system is doing -- build loop, pipelines, sessions, delegations
        </p>
      </div>

      {isAllEmpty && (
        <DataSourceEmptyState
          sourceName="System Activity Events"
          producerName="omniclaude build loop, skill executor, session tracker, delegation hook"
          instructions="Run build loop, skills, or delegations to produce system activity events."
        />
      )}

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          title="Pipeline Runs (24h)"
          value={String(pipelineTotals.total)}
          icon={Zap}
          subtitle={
            pipelineTotals.total > 0
              ? `${pipelineTotals.success} ok / ${pipelineTotals.error} error`
              : undefined
          }
          isLoading={pipelines.isLoading}
        />
        <StatCard
          title="Agent Sessions (24h)"
          value={String(sessionTotal)}
          icon={Bot}
          isLoading={sessions.isLoading}
        />
        <StatCard
          title="Delegations (24h)"
          value={String(delegationTotals.total)}
          icon={Users}
          subtitle={
            delegationTotals.qualityGatePassRate != null
              ? `${delegationTotals.qualityGatePassRate}% gate pass`
              : undefined
          }
          isLoading={delegations.isLoading}
        />
        <StatCard
          title="Delegation Cost (24h)"
          value={
            delegationTotals.totalCostUsd != null
              ? `$${delegationTotals.totalCostUsd.toFixed(4)}`
              : '--'
          }
          icon={BarChart3}
          isLoading={delegations.isLoading}
        />
      </div>

      {/* Build Loop + Sessions side by side */}
      <div className="grid gap-6 lg:grid-cols-2">
        <BuildLoopCard data={buildLoop.data} isLoading={buildLoop.isLoading} />
        <SessionsCard data={sessions.data} isLoading={sessions.isLoading} />
      </div>

      {/* Pipelines Table */}
      <PipelinesTable data={pipelines.data} isLoading={pipelines.isLoading} />

      {/* Delegations Table */}
      <DelegationsTable data={delegations.data} isLoading={delegations.isLoading} />
    </div>
  );
}
