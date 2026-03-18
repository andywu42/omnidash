/**
 * DLQ Monitor Dashboard (OMN-5287)
 *
 * Focused view of individual failed messages in the dead-letter queue.
 * Data source: /api/dlq (read-model projection from onex.evt.platform.dlq-message.v1)
 *
 * Shows:
 * - Failed messages table (topic, error type, retry count, consumer group, time)
 * - Error category breakdown
 * - Timeline chart of DLQ message rate over 24h
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
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

// ============================================================================
// Types
// ============================================================================

interface DlqMessage {
  id: string;
  original_topic: string;
  error_message: string;
  error_type: string;
  retry_count: number;
  consumer_group: string;
  message_key: string | null;
  created_at: string;
}

interface ErrorBreakdownItem {
  error_type: string;
  count: number;
}

interface DlqResponse {
  messages: DlqMessage[];
  errorBreakdown: ErrorBreakdownItem[];
  total: number;
  since: string | null;
}

interface TimelineBucket {
  bucket: string;
  count: number;
}

interface TimelineResponse {
  buckets: TimelineBucket[];
}

// ============================================================================
// Helpers
// ============================================================================

function relativeTime(isoTs: string): string {
  const ts = new Date(isoTs).getTime();
  if (isNaN(ts)) return 'unknown';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function errorTypeBadgeClass(errorType: string): string {
  const t = errorType.toLowerCase();
  if (t.includes('deserializ') || t.includes('parse') || t.includes('schema'))
    return 'border-yellow-500 text-yellow-600 dark:text-yellow-400';
  if (t.includes('timeout') || t.includes('network') || t.includes('connect'))
    return 'border-orange-500 text-orange-600 dark:text-orange-400';
  if (t.includes('auth') || t.includes('permission') || t.includes('forbidden'))
    return 'border-red-500 text-red-600 dark:text-red-400';
  return 'border-slate-400 text-slate-600 dark:text-slate-400';
}

function retryBadgeClass(count: number): string {
  if (count === 0) return 'border-slate-400 text-slate-500';
  if (count < 3) return 'border-yellow-500 text-yellow-600 dark:text-yellow-400';
  return 'border-red-500 text-red-600 dark:text-red-400';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ============================================================================
// Sub-components
// ============================================================================

function ErrorBreakdownCard({ breakdown }: { breakdown: ErrorBreakdownItem[] }) {
  if (breakdown.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Error Categories (7d)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No DLQ events in the last 7 days.</p>
        </CardContent>
      </Card>
    );
  }

  const total = breakdown.reduce((s, r) => s + r.count, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Error Categories (7d)</CardTitle>
        <CardDescription>{total} total failures</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {breakdown.map((item) => {
            const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
            return (
              <div key={item.error_type} className="flex items-center gap-3">
                <div className="w-36 shrink-0">
                  <Badge
                    variant="outline"
                    className={cn('text-xs font-mono', errorTypeBadgeClass(item.error_type))}
                  >
                    {truncate(item.error_type, 20)}
                  </Badge>
                </div>
                <div className="flex-1 h-2 bg-muted rounded overflow-hidden">
                  <div className="h-full bg-orange-500 rounded" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs text-muted-foreground w-12 text-right">
                  {item.count} ({pct}%)
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function TimelineCard() {
  const { data, isLoading, isError } = useQuery<TimelineResponse>({
    queryKey: queryKeys.dlq.timeline(),
    queryFn: async () => {
      const res = await fetch('/api/dlq/timeline');
      if (!res.ok) throw new Error('Failed to fetch DLQ timeline');
      return res.json() as Promise<TimelineResponse>;
    },
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">DLQ Rate (24h)</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">DLQ Rate (24h)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-500">Failed to load DLQ timeline.</p>
        </CardContent>
      </Card>
    );
  }

  const buckets = data?.buckets ?? [];

  if (buckets.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">DLQ Rate (24h)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No DLQ events in the last 24 hours.</p>
        </CardContent>
      </Card>
    );
  }

  const maxCount = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">DLQ Rate (24h)</CardTitle>
        <CardDescription>Failures per hour</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-1 h-16">
          {buckets.map((b) => {
            const heightPct = (b.count / maxCount) * 100;
            const hour = new Date(b.bucket).getHours().toString().padStart(2, '0') + ':00';
            return (
              <div
                key={b.bucket}
                className="flex-1 flex flex-col items-center gap-1"
                title={`${hour}: ${b.count} failure(s)`}
              >
                <div
                  className="w-full bg-orange-500 rounded-t"
                  style={{ height: `${heightPct}%` }}
                />
              </div>
            );
          })}
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-xs text-muted-foreground">24h ago</span>
          <span className="text-xs text-muted-foreground">now</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main page
// ============================================================================

export default function DlqMonitorDashboard() {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery<DlqResponse>({
    queryKey: queryKeys.dlq.messages(100),
    queryFn: async () => {
      const res = await fetch('/api/dlq?limit=100');
      if (!res.ok) throw new Error('Failed to fetch DLQ messages');
      return res.json() as Promise<DlqResponse>;
    },
    refetchInterval: 30_000,
  });

  const messages = data?.messages ?? [];
  const breakdown = data?.errorBreakdown ?? [];
  const updatedAt = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : null;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-orange-500" />
          <div>
            <h1 className="text-xl font-semibold">DLQ Monitor</h1>
            <p className="text-sm text-muted-foreground">
              Dead-letter queue failures from consumer processing errors
            </p>
          </div>
        </div>
        {updatedAt && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3" />
            Updated {updatedAt}
          </div>
        )}
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Failures</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <span className="text-2xl font-bold">{data?.total ?? 0}</span>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Unique Error Types</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <span className="text-2xl font-bold">{breakdown.length}</span>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Unique Topics Affected</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <span className="text-2xl font-bold">
                {new Set(messages.map((m) => m.original_topic)).size}
              </span>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Timeline + breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TimelineCard />
        <ErrorBreakdownCard breakdown={breakdown} />
      </div>

      {/* Failed messages table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Failed Messages</CardTitle>
          <CardDescription>Most recent 100 DLQ entries</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="flex items-center gap-2 text-red-500">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-sm">Failed to load DLQ data</span>
            </div>
          ) : messages.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No DLQ failures recorded — queue is clear.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Topic</TableHead>
                  <TableHead>Error Type</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead>Retries</TableHead>
                  <TableHead>Consumer Group</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {messages.map((msg) => (
                  <TableRow key={msg.id}>
                    <TableCell
                      className="font-mono text-xs max-w-[200px] truncate"
                      title={msg.original_topic}
                    >
                      {truncate(msg.original_topic, 40)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn('text-xs', errorTypeBadgeClass(msg.error_type))}
                      >
                        {msg.error_type}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="text-xs text-muted-foreground max-w-[240px] truncate"
                      title={msg.error_message}
                    >
                      {truncate(msg.error_message, 60)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn('text-xs tabular-nums', retryBadgeClass(msg.retry_count))}
                      >
                        {msg.retry_count}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {truncate(msg.consumer_group, 30)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {relativeTime(msg.created_at)}
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
