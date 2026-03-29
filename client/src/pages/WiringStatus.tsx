/**
 * Wiring Status Dashboard (OMN-6975)
 *
 * Meta-dashboard: shows which dashboard pipelines are fully connected
 * (producer -> consumer -> projection -> API -> UI) vs broken/empty.
 *
 * Data source: GET /api/wiring-status
 * Manifest: shared/wiring-status.json
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
import {
  CheckCircle2,
  AlertTriangle,
  Eye,
  XCircle,
  HelpCircle,
  Database,
  Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WiringStatus } from '@shared/wiring-status';

// ============================================================================
// Types
// ============================================================================

interface WiringRouteInfo {
  route: string;
  status: WiringStatus;
  table: string | null;
  description: string;
  rowCount: number | null;
  lastEventAt: string | null;
}

interface WiringStatusApiResponse {
  routes: WiringRouteInfo[];
  summary: Record<WiringStatus, number>;
  checkedAt: string;
}

// ============================================================================
// Data source
// ============================================================================

async function fetchWiringStatus(): Promise<WiringStatusApiResponse> {
  const res = await fetch('/api/wiring-status');
  if (!res.ok) throw new Error(`Failed to fetch wiring status: ${res.status}`);
  return res.json();
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

function formatRowCount(count: number | null): string {
  if (count === null) return '--';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

// ============================================================================
// Status UI Components
// ============================================================================

const STATUS_CONFIG: Record<
  WiringStatus,
  {
    label: string;
    icon: typeof CheckCircle2;
    className: string;
    bgClassName: string;
    description: string;
  }
> = {
  working: {
    label: 'Working',
    icon: CheckCircle2,
    className: 'text-emerald-400',
    bgClassName: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    description: 'Full pipeline proven end-to-end',
  },
  partial: {
    label: 'Partial',
    icon: AlertTriangle,
    className: 'text-amber-400',
    bgClassName: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    description: 'Pipeline connected but incomplete',
  },
  preview: {
    label: 'Preview',
    icon: Eye,
    className: 'text-blue-400',
    bgClassName: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    description: 'Code exists, pipeline not proven',
  },
  stub: {
    label: 'Stub',
    icon: XCircle,
    className: 'text-zinc-500',
    bgClassName: 'bg-zinc-500/15 text-zinc-500 border-zinc-500/30',
    description: 'Placeholder only',
  },
  missing: {
    label: 'Missing',
    icon: HelpCircle,
    className: 'text-red-400',
    bgClassName: 'bg-red-500/15 text-red-400 border-red-500/30',
    description: 'No code exists',
  },
};

function StatusBadge({ status }: { status: WiringStatus }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <Badge
      variant="outline"
      className={cn('gap-1 font-mono text-[10px] uppercase', config.bgClassName)}
      data-testid={`status-badge-${status}`}
    >
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}

function SummaryCard({
  status,
  count,
  total,
}: {
  status: WiringStatus;
  count: number;
  total: number;
}) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;

  return (
    <Card className="border-border/50">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className={cn('h-5 w-5', config.className)} />
            <span className="text-sm font-medium capitalize">{config.label}</span>
          </div>
          <span className="text-2xl font-bold tabular-nums">{count}</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{config.description}</span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        {/* Progress bar */}
        <div className="mt-2 h-1.5 w-full rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              config.className.replace('text-', 'bg-')
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Page Component
// ============================================================================

export default function WiringStatusPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['wiring-status'],
    queryFn: fetchWiringStatus,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Wiring Status</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pipeline connection status for all dashboard pages
          </p>
        </div>
        <div className="grid gap-4 grid-cols-2 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Wiring Status</h1>
        <Card className="border-destructive/50">
          <CardContent className="p-6 text-center text-muted-foreground">
            Failed to load wiring status: {error?.message ?? 'Unknown error'}
          </CardContent>
        </Card>
      </div>
    );
  }

  const total = data.routes.length;
  const statusOrder: WiringStatus[] = ['working', 'partial', 'preview', 'stub', 'missing'];

  return (
    <div className="space-y-6" data-testid="wiring-status-page">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Wiring Status</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pipeline connection status for all {total} dashboard pages
          {data.checkedAt && (
            <span className="ml-2 text-xs">(checked {relativeTime(data.checkedAt)})</span>
          )}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-5">
        {statusOrder.map((status) => (
          <SummaryCard
            key={status}
            status={status}
            count={data.summary[status] ?? 0}
            total={total}
          />
        ))}
      </div>

      {/* Route table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">All Routes</CardTitle>
          <CardDescription>
            Live pipeline status with row counts and last-event timestamps from the database
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[200px]">Route</TableHead>
                <TableHead className="w-[100px]">Status</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[160px]">
                  <div className="flex items-center gap-1">
                    <Database className="h-3 w-3" />
                    Table
                  </div>
                </TableHead>
                <TableHead className="w-[80px] text-right">Rows</TableHead>
                <TableHead className="w-[120px]">
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Last Event
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.routes.map((route) => (
                <TableRow
                  key={route.route}
                  className={cn(
                    route.status === 'stub' && 'opacity-50',
                    route.status === 'missing' && 'opacity-30'
                  )}
                  data-testid={`wiring-row-${route.route.slice(1).replace(/\//g, '-')}`}
                >
                  <TableCell className="font-mono text-xs">
                    <a href={route.route} className="hover:underline text-foreground">
                      {route.route}
                    </a>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={route.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[300px] truncate">
                    {route.description}
                  </TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {route.table ?? '--'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {route.rowCount !== null && route.rowCount > 0 ? (
                      <span className="text-emerald-400">{formatRowCount(route.rowCount)}</span>
                    ) : (
                      <span className="text-muted-foreground/50">
                        {formatRowCount(route.rowCount)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {route.lastEventAt ? relativeTime(route.lastEventAt) : '--'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
