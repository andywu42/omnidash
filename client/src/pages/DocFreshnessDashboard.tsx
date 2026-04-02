/**
 * Doc Freshness Dashboard (feature-hookup Phase 2)
 *
 * Displays doc freshness sweep results from the skill_invocations table.
 * The doc_freshness_sweep skill scans documentation files across repos for
 * broken references, stale content, and CLAUDE.md accuracy.
 *
 * Backed by: /api/doc-freshness routes (filtered skill_invocations table)
 */

import { useQuery } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FileText, RefreshCw, CheckCircle2, XCircle, Clock, Hash } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LocalDataUnavailableBanner } from '@/components/LocalDataUnavailableBanner';

// ============================================================================
// Types
// ============================================================================

interface DocFreshnessRun {
  id: number;
  skill_name: string;
  session_id: string | null;
  duration_ms: number | null;
  success: boolean;
  status: string;
  error: string | null;
  created_at: string;
  emitted_at: string | null;
}

interface DocFreshnessSummary {
  total: number;
  succeeded: number;
  failed: number;
  success_rate: number;
  avg_duration_ms: number;
}

interface DocFreshnessResponse {
  runs: DocFreshnessRun[];
  summary: DocFreshnessSummary;
}

// ============================================================================
// Helpers
// ============================================================================

function relativeTime(isoTs: string | null): string {
  if (!isoTs) return 'n/a';
  const ts = new Date(isoTs).getTime();
  if (isNaN(ts)) return 'n/a';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function fmtPct(value: number): string {
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

// ============================================================================
// Main Component
// ============================================================================

export default function DocFreshnessDashboard() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<DocFreshnessResponse>({
    queryKey: ['doc-freshness'],
    queryFn: async () => {
      const res = await fetch('/api/doc-freshness');
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const summary = data?.summary;
  const runs = data?.runs ?? [];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="h-6 w-6" />
            Doc Freshness
          </h1>
          <p className="text-muted-foreground">
            Documentation freshness sweep results — checks for broken references, stale content, and
            CLAUDE.md accuracy
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['doc-freshness'] })}
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {isError && <LocalDataUnavailableBanner />}

      {/* Summary stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          title="Total Sweeps"
          value={summary?.total?.toString() ?? '0'}
          icon={Hash}
          isLoading={isLoading}
        />
        <StatCard
          title="Success Rate"
          value={summary ? fmtPct(summary.success_rate) : '0%'}
          icon={CheckCircle2}
          valueClass={
            summary && summary.success_rate >= 0.9
              ? 'text-green-500'
              : summary && summary.success_rate >= 0.7
                ? 'text-yellow-500'
                : 'text-red-500'
          }
          isLoading={isLoading}
        />
        <StatCard
          title="Failed"
          value={summary?.failed?.toString() ?? '0'}
          icon={XCircle}
          valueClass={summary && summary.failed > 0 ? 'text-red-500' : undefined}
          isLoading={isLoading}
        />
        <StatCard
          title="Avg Duration"
          value={summary ? formatDuration(summary.avg_duration_ms) : '-'}
          icon={Clock}
          isLoading={isLoading}
        />
      </div>

      {/* Recent runs table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Recent Sweeps
          </CardTitle>
          <CardDescription>
            Recent doc_freshness_sweep skill invocations from the event bus
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No doc freshness sweeps recorded yet. Run{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">/doc_freshness_sweep</code> in
              Claude Code to generate results.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Session</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <Badge variant={run.success ? 'default' : 'destructive'} className="text-xs">
                        {run.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {run.session_id ? run.session_id.slice(0, 12) + '...' : '-'}
                    </TableCell>
                    <TableCell className="tabular-nums text-xs">
                      {formatDuration(run.duration_ms)}
                    </TableCell>
                    <TableCell className="text-xs max-w-[300px] truncate text-red-500">
                      {run.error ?? '-'}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {relativeTime(run.created_at)}
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
