/**
 * Circuit Breaker Dashboard (OMN-5293)
 *
 * Visualizes circuit breaker state transitions from:
 *   onex.evt.omnibase-infra.circuit-breaker.v1
 *
 * Shows:
 * - Per-service current state badges (CLOSED / OPEN / HALF_OPEN)
 * - Stat cards: total transitions, open circuits, services monitored
 * - Recent state-transition event log
 */

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, CheckCircle2, Activity, Server, Zap } from 'lucide-react';
import {
  circuitBreakerSource,
  type CircuitBreakerState,
  type CircuitBreakerWindow,
  type CircuitBreakerSummary,
  type CircuitBreakerEvents,
} from '@/lib/data-sources/circuit-breaker-source';

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

function StateBadge({ state }: { state: CircuitBreakerState }) {
  if (state === 'open') {
    return (
      <Badge variant="destructive" className="uppercase text-xs font-mono">
        OPEN
      </Badge>
    );
  }
  if (state === 'half_open') {
    return (
      <Badge className="uppercase text-xs font-mono bg-yellow-500 hover:bg-yellow-600 text-black">
        HALF_OPEN
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="uppercase text-xs font-mono">
      CLOSED
    </Badge>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function StatCard({
  title,
  value,
  icon: Icon,
  isLoading,
}: {
  title: string;
  value: string;
  icon: React.ElementType;
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
          <div className="text-2xl font-bold tabular-nums">{value}</div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main page
// ============================================================================

export default function CircuitBreakerDashboard() {
  const queryClient = useQueryClient();
  const [window, setWindow] = useState<CircuitBreakerWindow>('24h');

  const {
    data: summary,
    isLoading: summaryLoading,
  } = useQuery<CircuitBreakerSummary>({
    queryKey: ['circuit-breaker-summary', window],
    queryFn: () => circuitBreakerSource.summary(window),
    refetchInterval: 15_000,
  });

  const {
    data: eventsData,
    isLoading: eventsLoading,
  } = useQuery<CircuitBreakerEvents>({
    queryKey: ['circuit-breaker-events', window],
    queryFn: () => circuitBreakerSource.events(window),
    refetchInterval: 15_000,
  });

  const handleMessage = useCallback(
    (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'circuit-breaker-event') {
        void queryClient.invalidateQueries({ queryKey: ['circuit-breaker-summary'] });
        void queryClient.invalidateQueries({ queryKey: ['circuit-breaker-events'] });
      }
    },
    [queryClient]
  );
  useWebSocket({ onMessage: handleMessage });

  const stateCounts = summary?.stateCounts ?? { closed: 0, open: 0, half_open: 0 };
  const services = summary?.services ?? [];
  const recentEvents = eventsData?.events ?? [];

  const openCount = stateCounts.open;
  const halfOpenCount = stateCounts.half_open;
  const totalServices = services.length;
  const totalEvents = summary?.totalEvents ?? 0;

  const isLoading = summaryLoading;

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Circuit Breaker Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Infrastructure circuit breaker state transitions (
            <code className="text-xs">onex.evt.omnibase-infra.circuit-breaker.v1</code>)
          </p>
        </div>
        <Select
          value={window}
          onValueChange={(v) => setWindow(v as CircuitBreakerWindow)}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1h">Last 1h</SelectItem>
            <SelectItem value="24h">Last 24h</SelectItem>
            <SelectItem value="7d">Last 7d</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Services Monitored"
          value={String(totalServices)}
          icon={Server}
          isLoading={isLoading}
        />
        <StatCard
          title="Open Circuits"
          value={String(openCount)}
          icon={AlertTriangle}
          isLoading={isLoading}
        />
        <StatCard
          title="Half-Open"
          value={String(halfOpenCount)}
          icon={Zap}
          isLoading={isLoading}
        />
        <StatCard
          title="Total Transitions"
          value={String(totalEvents)}
          icon={Activity}
          isLoading={isLoading}
        />
      </div>

      {/* Per-service state cards */}
      <Card>
        <CardHeader>
          <CardTitle>Service Circuit States</CardTitle>
          <CardDescription>
            Current state of each circuit breaker tracked in the selected window.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : services.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
              <CheckCircle2 className="h-8 w-8" />
              <p className="text-sm">
                No circuit breaker events in the selected window. All circuits healthy.
              </p>
              <p className="text-xs">
                Ensure the omnibase_infra services are running and emitting events.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {services.map((svc) => (
                <div
                  key={svc.serviceName}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{svc.serviceName}</p>
                    <p className="text-xs text-muted-foreground">
                      {svc.failureCount}/{svc.threshold} failures
                      {' · '}
                      {relativeTime(svc.lastTransitionAt)}
                    </p>
                  </div>
                  <StateBadge state={svc.currentState} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent transitions table */}
      <Card>
        <CardHeader>
          <CardTitle>Recent State Transitions</CardTitle>
          <CardDescription>
            Last 50 state transitions in the selected window, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {eventsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : recentEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No transitions in the selected window.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead className="text-right">Failures</TableHead>
                  <TableHead className="text-right">Threshold</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentEvents.map((ev) => (
                  <TableRow key={ev.id}>
                    <TableCell className="font-mono text-xs max-w-48 truncate">
                      {ev.serviceName}
                    </TableCell>
                    <TableCell>
                      <StateBadge state={ev.previousState} />
                    </TableCell>
                    <TableCell>
                      <StateBadge state={ev.state} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{ev.failureCount}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {ev.threshold}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs">
                      {relativeTime(ev.emittedAt)}
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
