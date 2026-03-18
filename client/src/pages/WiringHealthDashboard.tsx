/**
 * Wiring Health Dashboard (OMN-5292)
 *
 * Displays per-topic emission/consumption health from WiringHealthChecker
 * snapshots. Answers: "are topics emitting but not being consumed?",
 * "what is the mismatch ratio?", and "when did health last change?"
 *
 * Data source: /api/wiring-health (projected from Kafka topic
 * onex.evt.omnibase-infra.wiring-health-snapshot.v1)
 *
 * Shows:
 *  - Overall health status header
 *  - Per-topic table: Topic | Emit | Consume | Mismatch % | Status
 *  - Dependency summary: last snapshot age, threshold, history count
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
import { CheckCircle2, XCircle, AlertTriangle, Activity, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  WiringHealthSnapshot,
  WiringHealthSummary,
  TopicWiringRecord,
} from '@shared/wiring-health-types';

// ============================================================================
// Types
// ============================================================================

interface WiringHealthPayload {
  latest: WiringHealthSnapshot | null;
  summary: WiringHealthSummary;
}

// ============================================================================
// Helpers
// ============================================================================

function relativeTime(isoTs: string | null): string {
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

function mismatchClass(ratio: number, threshold: number): string {
  if (ratio === 0) return '';
  if (ratio < threshold) return 'text-yellow-500';
  return 'text-red-500 font-semibold';
}

function TopicStatusIcon({ topic, threshold }: { topic: TopicWiringRecord; threshold: number }) {
  if (!topic.isHealthy) return <XCircle className="h-4 w-4 text-red-500" />;
  if (topic.mismatchRatio > 0 && topic.mismatchRatio < threshold)
    return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
  return <CheckCircle2 className="h-4 w-4 text-green-500" />;
}

// ============================================================================
// Components
// ============================================================================

function SummaryCards({ summary }: { summary: WiringHealthSummary }) {
  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Overall Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            {summary.overallHealthy ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <XCircle className="h-5 w-5 text-red-500" />
            )}
            <span
              className={cn(
                'text-2xl font-bold',
                summary.overallHealthy ? 'text-green-500' : 'text-red-500'
              )}
            >
              {summary.overallHealthy ? 'Healthy' : 'Degraded'}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Unhealthy Topics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <AlertTriangle
              className={cn('h-5 w-5', summary.unhealthyCount > 0 ? 'text-red-500' : 'text-muted-foreground')}
            />
            <span
              className={cn(
                'text-2xl font-bold',
                summary.unhealthyCount > 0 ? 'text-red-500' : ''
              )}
            >
              {summary.unhealthyCount}
            </span>
            <span className="text-muted-foreground text-sm">/ {summary.totalTopics}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Mismatch Threshold</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Radio className="h-5 w-5 text-muted-foreground" />
            <span className="text-2xl font-bold">{(summary.threshold * 100).toFixed(1)}%</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Last Snapshot</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-muted-foreground" />
            <div>
              <span className="text-2xl font-bold">
                {relativeTime(summary.lastSnapshotAt)}
              </span>
              <p className="text-xs text-muted-foreground">{summary.snapshotCount} snapshots</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TopicsTable({
  topics,
  threshold,
}: {
  topics: TopicWiringRecord[];
  threshold: number;
}) {
  if (topics.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
        No topics monitored in this snapshot.
      </div>
    );
  }

  const sorted = [...topics].sort((a, b) => {
    // Unhealthy first
    if (!a.isHealthy && b.isHealthy) return -1;
    if (a.isHealthy && !b.isHealthy) return 1;
    // Then by mismatch ratio descending
    return b.mismatchRatio - a.mismatchRatio;
  });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>Topic</TableHead>
          <TableHead className="text-right">Emitted</TableHead>
          <TableHead className="text-right">Consumed</TableHead>
          <TableHead className="text-right">Mismatch %</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((topic) => (
          <TableRow key={topic.topic} className={!topic.isHealthy ? 'bg-red-500/5' : undefined}>
            <TableCell>
              <TopicStatusIcon topic={topic} threshold={threshold} />
            </TableCell>
            <TableCell className="font-mono text-xs">{topic.topic}</TableCell>
            <TableCell className="text-right">{topic.emitCount.toLocaleString()}</TableCell>
            <TableCell className="text-right">{topic.consumeCount.toLocaleString()}</TableCell>
            <TableCell
              className={cn('text-right', mismatchClass(topic.mismatchRatio, threshold))}
            >
              {(topic.mismatchRatio * 100).toFixed(2)}%
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ============================================================================
// Page
// ============================================================================

export default function WiringHealthDashboard() {
  const { data, isLoading, error } = useQuery<WiringHealthPayload>({
    queryKey: queryKeys.wiringHealth.full(),
    queryFn: async () => {
      const res = await fetch('/api/wiring-health');
      if (!res.ok) throw new Error(`Failed to fetch wiring health: ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
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
        <Card className="border-red-200 bg-red-50 dark:bg-red-950/10">
          <CardHeader>
            <CardTitle className="text-red-600">Failed to load wiring health data</CardTitle>
            <CardDescription>{String(error)}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const summary = data?.summary ?? {
    overallHealthy: true,
    unhealthyCount: 0,
    totalTopics: 0,
    threshold: 0.05,
    lastSnapshotAt: null,
    snapshotCount: 0,
  };
  const latest = data?.latest ?? null;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Wiring Health</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Emission vs consumption mismatch monitoring across feedback-loop topics
          </p>
        </div>
        <Badge
          variant={summary.overallHealthy ? 'default' : 'destructive'}
          className="text-sm px-3 py-1"
        >
          {summary.overallHealthy ? 'All Topics Healthy' : `${summary.unhealthyCount} Unhealthy`}
        </Badge>
      </div>

      {/* Summary cards */}
      <SummaryCards summary={summary} />

      {/* Topics table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monitored Topics</CardTitle>
          <CardDescription>
            {latest
              ? `Snapshot from ${relativeTime(latest.timestamp)} · correlation ${latest.correlationId.slice(0, 8)}…`
              : 'Waiting for first wiring health snapshot…'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {latest ? (
            <TopicsTable topics={latest.topics} threshold={summary.threshold} />
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
              No wiring health snapshot received yet.
              <br />
              <span className="text-xs mt-1 block">
                WiringHealthChecker emits to{' '}
                <code className="font-mono">onex.evt.omnibase-infra.wiring-health-snapshot.v1</code>
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
