/**
 * Event Bus Health Dashboard (OMN-3192)
 *
 * Displays per-topic Redpanda health so you can answer
 * "which topics are silent?", "what's the consumer lag?", and
 * "which expected topics are missing from the broker?"
 *
 * Data source: /api/event-bus-health (polled from Redpanda Admin API localhost:9644)
 *
 * Shows table: Topic | Consumer Group | Lag | DLQ | Last Message | Status
 * Color-coded: missing=red, silent=yellow, high-lag=orange, healthy=green
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
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  VolumeX,
  Radio,
  BarChart3,
  WifiOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  TopicHealthSummary,
  EventBusSummary,
} from '../../../server/projections/event-bus-health-projection';

// ============================================================================
// Types
// ============================================================================

interface EventBusHealthPayload {
  topics: TopicHealthSummary[];
  summary: EventBusSummary;
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

function lagClass(lag: number): string {
  if (lag === 0) return '';
  if (lag < 10) return 'text-yellow-500';
  return 'text-orange-500 font-semibold';
}

function TopicStatusIcon({ topic }: { topic: TopicHealthSummary }) {
  if (topic.missingFromBroker) return <XCircle className="h-4 w-4 text-red-500" />;
  if (topic.silent) return <VolumeX className="h-4 w-4 text-yellow-500" />;
  if (topic.lag > 0) return <AlertTriangle className="h-4 w-4 text-orange-500" />;
  return <CheckCircle2 className="h-4 w-4 text-green-500" />;
}

function topicStatusLabel(topic: TopicHealthSummary): string {
  if (topic.missingFromBroker) return 'MISSING';
  if (topic.silent) return 'SILENT';
  if (topic.hasDlqMessages) return 'DLQ';
  if (topic.lag > 0) return 'LAG';
  return 'OK';
}

function topicStatusBadgeClass(topic: TopicHealthSummary): string {
  if (topic.missingFromBroker) return 'border-red-500 text-red-500';
  if (topic.silent) return 'border-yellow-500 text-yellow-500';
  if (topic.hasDlqMessages) return 'border-orange-500 text-orange-500';
  if (topic.lag > 0) return 'border-orange-400 text-orange-400';
  return 'border-green-500 text-green-500';
}

function rowHighlightClass(topic: TopicHealthSummary): string | undefined {
  if (topic.missingFromBroker) return 'bg-red-50 dark:bg-red-950/20';
  if (topic.silent) return 'bg-yellow-50 dark:bg-yellow-950/20';
  return undefined;
}

// Shorten topic names for display (keep last 2 segments)
function shortTopicName(topic: string): string {
  const parts = topic.split('.');
  if (parts.length <= 3) return topic;
  return '…' + parts.slice(-3).join('.');
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

function TopicTable({ topics, isLoading }: { topics: TopicHealthSummary[]; isLoading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="h-4 w-4" />
          Topic Health
        </CardTitle>
        <CardDescription>
          Polled from Redpanda Admin API at{' '}
          <code className="text-xs">localhost:9644/v1/partitions</code>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : topics.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No topic data available yet.
            <br />
            Ensure Redpanda is running and the Admin API is reachable at{' '}
            <code className="text-xs">localhost:9644</code>.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Topic</TableHead>
                <TableHead>Consumer Group</TableHead>
                <TableHead className="text-right">Lag</TableHead>
                <TableHead className="text-right">DLQ</TableHead>
                <TableHead>Last Message</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {topics.map((topic) => (
                <TableRow key={topic.topic} className={rowHighlightClass(topic)}>
                  <TableCell
                    className="font-mono text-xs max-w-[220px] truncate"
                    title={topic.topic}
                  >
                    {shortTopicName(topic.topic)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {topic.consumerGroup}
                  </TableCell>
                  <TableCell
                    className={cn('text-right text-xs tabular-nums font-mono', lagClass(topic.lag))}
                  >
                    {topic.lag.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums font-mono">
                    {topic.dlqMessageCount > 0 ? (
                      <span className="text-orange-500 font-semibold">{topic.dlqMessageCount}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {relativeTime(topic.lastMessageTimestamp)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <TopicStatusIcon topic={topic} />
                      <Badge
                        variant="outline"
                        className={cn('text-xs font-mono', topicStatusBadgeClass(topic))}
                      >
                        {topicStatusLabel(topic)}
                      </Badge>
                    </div>
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

async function fetchEventBusHealth(): Promise<EventBusHealthPayload> {
  const res = await fetch('/api/event-bus-health');
  if (!res.ok) throw new Error('Failed to fetch event bus health');
  return res.json() as Promise<EventBusHealthPayload>;
}

export default function EventBusHealthDashboard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.eventBusHealth.full(),
    queryFn: fetchEventBusHealth,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const topics = data?.topics ?? [];
  const summary = data?.summary ?? {
    totalTopics: 0,
    silentTopics: 0,
    missingTopics: 0,
    topicsWithDlqMessages: 0,
    totalLag: 0,
  };

  return (
    <div className="space-y-6" data-testid="page-event-bus-health-dashboard">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Event Bus Health</h1>
        <p className="text-muted-foreground">
          Consumer lag, DLQ traffic, and silent topics per Redpanda topic
        </p>
      </div>

      {isError && (
        <p className="text-sm text-destructive">
          Failed to load event bus health data. Ensure Redpanda Admin API is reachable at{' '}
          <code className="text-xs">localhost:9644</code>.
        </p>
      )}

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Topics Tracked"
          value={isLoading ? '—' : String(summary.totalTopics)}
          icon={BarChart3}
          isLoading={isLoading}
        />
        <StatCard
          title="Missing Topics"
          value={isLoading ? '—' : String(summary.missingTopics)}
          icon={WifiOff}
          valueClass={summary.missingTopics > 0 ? 'text-red-500' : undefined}
          isLoading={isLoading}
        />
        <StatCard
          title="Silent Consumers"
          value={isLoading ? '—' : String(summary.silentTopics)}
          icon={VolumeX}
          valueClass={summary.silentTopics > 0 ? 'text-yellow-500' : undefined}
          isLoading={isLoading}
        />
        <StatCard
          title="Topics with DLQ"
          value={isLoading ? '—' : String(summary.topicsWithDlqMessages)}
          icon={AlertTriangle}
          valueClass={summary.topicsWithDlqMessages > 0 ? 'text-orange-500' : undefined}
          isLoading={isLoading}
        />
      </div>

      {/* Total lag secondary stat */}
      {!isLoading && summary.totalLag > 0 && (
        <p className="text-sm text-muted-foreground">
          Total consumer lag:{' '}
          <span
            className={cn(
              'font-semibold tabular-nums',
              summary.totalLag > 100 ? 'text-orange-500' : 'text-yellow-500'
            )}
          >
            {summary.totalLag.toLocaleString()} messages
          </span>
        </p>
      )}

      {/* Topic Table */}
      <TopicTable topics={topics} isLoading={isLoading} />
    </div>
  );
}
