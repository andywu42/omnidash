/**
 * Friction Log Dashboard (OMN-8698)
 *
 * Displays on-disk friction events from FRICTION_LOG_PATH.
 * Backed by: /api/friction (reads YAML/JSON/MD files directly from disk)
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
import { AlertTriangle, RefreshCw, Hash, FileWarning } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LocalDataUnavailableBanner } from '@/components/LocalDataUnavailableBanner';

// ============================================================================
// Types
// ============================================================================

interface FrictionEvent {
  id?: string;
  type?: string;
  surface?: string;
  severity?: string;
  timestamp?: string;
  date?: string;
  session?: string;
  description?: string;
  failure_mode?: string;
  root_cause?: string;
  impact?: string;
  resolution?: string;
  fix_direction?: string;
  ticket_id?: string;
  ticket_needed?: boolean;
  _filename: string;
  _effective_date: string;
}

interface FrictionResponse {
  events: FrictionEvent[];
  total: number;
  warning?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function severityVariant(
  severity: string | undefined
): 'default' | 'destructive' | 'outline' | 'secondary' {
  switch ((severity ?? '').toLowerCase()) {
    case 'critical':
    case 'high':
      return 'destructive';
    case 'minor':
    case 'low':
      return 'secondary';
    default:
      return 'outline';
  }
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return '-';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

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

export default function FrictionLogDashboard() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<FrictionResponse>({
    queryKey: ['friction-log'],
    queryFn: async () => {
      const res = await fetch('/api/friction?limit=100');
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const events = data?.events ?? [];
  const total = data?.total ?? 0;

  const criticalCount = events.filter((e) =>
    ['critical', 'high'].includes((e.severity ?? '').toLowerCase())
  ).length;

  const surfaceCounts = events.reduce<Record<string, number>>((acc, e) => {
    const key = e.type ?? e.surface ?? 'unknown';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const topSurface =
    Object.entries(surfaceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-';

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <AlertTriangle className="h-6 w-6" />
            Friction Log
          </h1>
          <p className="text-muted-foreground">
            On-disk friction events recorded by agent sessions — pipeline gaps, stalls, and
            misrouting incidents
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['friction-log'] })}
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {isError && <LocalDataUnavailableBanner />}
      {data?.warning && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-600">
          {data.warning}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="Total Events"
          value={total.toString()}
          icon={Hash}
          isLoading={isLoading}
        />
        <StatCard
          title="Critical / High"
          value={criticalCount.toString()}
          icon={FileWarning}
          valueClass={criticalCount > 0 ? 'text-red-500' : undefined}
          isLoading={isLoading}
        />
        <StatCard
          title="Top Surface"
          value={topSurface}
          icon={AlertTriangle}
          isLoading={isLoading}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Friction Events
          </CardTitle>
          <CardDescription>
            All recorded friction events from {data ? `${total} files` : '…'}, newest first
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No friction events found. Check that{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">FRICTION_LOG_PATH</code> is set
              correctly.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Failure Mode</TableHead>
                  <TableHead>Fix Direction</TableHead>
                  <TableHead>Ticket</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event, idx) => (
                  <TableRow key={event.id ?? event._filename ?? idx}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {event._effective_date ? event._effective_date.slice(0, 10) : '-'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs font-mono">
                        {event.type ?? event.surface ?? '-'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {event.severity ? (
                        <Badge variant={severityVariant(event.severity)} className="text-xs">
                          {event.severity}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs max-w-[280px]">
                      {truncate(event.description, 120)}
                    </TableCell>
                    <TableCell className="text-xs max-w-[180px] text-muted-foreground">
                      {truncate(event.failure_mode, 80)}
                    </TableCell>
                    <TableCell className="text-xs max-w-[180px] text-muted-foreground">
                      {truncate(event.fix_direction ?? event.resolution, 80)}
                    </TableCell>
                    <TableCell className="text-xs font-mono">
                      {event.ticket_id ?? (event.ticket_needed ? '(needed)' : '-')}
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
