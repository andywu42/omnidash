/**
 * Hostile Reviewer Dashboard (OMN-6610)
 *
 * Displays hostile reviewer run history and convergence metrics.
 * Data served from GET /api/hostile-reviewer/snapshot via
 * HostileReviewerProjection (DB-backed, TTL-cached).
 */

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Shield, AlertTriangle, CheckCircle, BarChart3 } from 'lucide-react';
import type {
  HostileReviewerPayload,
  HostileReviewerRunRow,
} from '@shared/omniclaude-state-schema';

function StatCard({
  title,
  value,
  icon: Icon,
}: {
  title: string;
  value: string | number;
  icon: React.ElementType;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const variant = verdict === 'pass' ? 'default' : verdict === 'fail' ? 'destructive' : 'secondary';

  return <Badge variant={variant}>{verdict}</Badge>;
}

function RunsTable({ runs }: { runs: HostileReviewerRunRow[] }) {
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No hostile reviewer runs recorded yet.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Target</TableHead>
          <TableHead>Mode</TableHead>
          <TableHead>Verdict</TableHead>
          <TableHead className="text-right">Findings</TableHead>
          <TableHead className="text-right">Critical</TableHead>
          <TableHead className="text-right">Major</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.event_id}>
            <TableCell className="font-mono text-sm max-w-[200px] truncate">{run.target}</TableCell>
            <TableCell>
              <Badge variant="outline">{run.mode}</Badge>
            </TableCell>
            <TableCell>
              <VerdictBadge verdict={run.verdict} />
            </TableCell>
            <TableCell className="text-right">{run.total_findings}</TableCell>
            <TableCell className="text-right font-medium text-red-600">
              {run.critical_count}
            </TableCell>
            <TableCell className="text-right font-medium text-orange-600">
              {run.major_count}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {new Date(run.created_at).toLocaleString()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function HostileReviewerDashboard() {
  const { data, isLoading, error } = useQuery<HostileReviewerPayload>({
    queryKey: ['hostile-reviewer-snapshot'],
    queryFn: async () => {
      const res = await fetch('/api/hostile-reviewer/snapshot');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold">Hostile Reviewer</h1>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Hostile Reviewer</h1>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>Failed to load hostile reviewer data: {String(error)}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const { recent, summary } = data;
  const passCount = summary.verdict_counts['pass'] ?? 0;
  const failCount = summary.verdict_counts['fail'] ?? 0;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Hostile Reviewer</h1>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Total Runs" value={summary.total_runs} icon={BarChart3} />
        <StatCard title="Passed" value={passCount} icon={CheckCircle} />
        <StatCard title="Failed" value={failCount} icon={AlertTriangle} />
        <StatCard
          title="Verdicts"
          value={Object.keys(summary.verdict_counts).length}
          icon={Shield}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Runs</CardTitle>
        </CardHeader>
        <CardContent>
          <RunsTable runs={recent} />
        </CardContent>
      </Card>
    </div>
  );
}
