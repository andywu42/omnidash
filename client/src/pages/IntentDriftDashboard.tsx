/**
 * Intent Drift Dashboard (OMN-5281)
 *
 * Displays intent drift events from: onex.evt.omniintelligence.intent-drift-detected.v1
 * Source table: intent_drift_events (populated by read-model-consumer.ts)
 *
 * Shows:
 * - Recent drift events table (session, drift_score, severity badge, time)
 * - Severity distribution (count per severity with colored badges)
 * - Drift score histogram (buckets: 0-0.25, 0.25-0.5, 0.5-0.75, 0.75-1.0)
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
import { TrendingUp, AlertTriangle } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface IntentDriftEventRow {
  id: number;
  session_id: string | null;
  original_intent: string | null;
  current_intent: string | null;
  drift_score: number | null;
  severity: string | null;
  created_at: string;
}

interface SeverityCount {
  severity: string | null;
  count: number;
}

interface IntentDriftPayload {
  recent: IntentDriftEventRow[];
  summary: SeverityCount[];
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

function severityVariant(
  severity: string | null
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (severity === 'critical') return 'destructive';
  if (severity === 'high') return 'destructive';
  if (severity === 'medium') return 'secondary';
  return 'outline';
}

function severityClass(severity: string | null): string {
  if (severity === 'critical') return 'text-red-600';
  if (severity === 'high') return 'text-orange-500';
  if (severity === 'medium') return 'text-yellow-500';
  return 'text-muted-foreground';
}

function driftScoreBucket(score: number | null): string {
  if (score === null) return 'unknown';
  if (score < 0.25) return '0–0.25';
  if (score < 0.5) return '0.25–0.5';
  if (score < 0.75) return '0.5–0.75';
  return '0.75–1.0';
}

// ============================================================================
// Sub-components
// ============================================================================

function DriftHistogram({ rows, isLoading }: { rows: IntentDriftEventRow[]; isLoading: boolean }) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Drift Score Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  const buckets: Record<string, number> = {
    '0–0.25': 0,
    '0.25–0.5': 0,
    '0.5–0.75': 0,
    '0.75–1.0': 0,
  };
  for (const row of rows) {
    const b = driftScoreBucket(row.drift_score);
    if (b in buckets) buckets[b]++;
  }

  const max = Math.max(...Object.values(buckets), 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Drift Score Distribution
        </CardTitle>
        <CardDescription>Frequency by score bucket (last 100 events)</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No data yet.</p>
        ) : (
          <div className="space-y-2">
            {Object.entries(buckets).map(([bucket, count]) => (
              <div key={bucket} className="flex items-center gap-3">
                <span className="w-20 text-xs font-mono text-right shrink-0">{bucket}</span>
                <div className="flex-1 bg-muted rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-primary h-3 rounded-full transition-all"
                    style={{ width: `${(count / max) * 100}%` }}
                  />
                </div>
                <span className="w-8 text-xs tabular-nums text-right">{count}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SeveritySummary({
  summary,
  isLoading,
}: {
  summary: SeverityCount[];
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Severity Distribution
        </CardTitle>
        <CardDescription>Count by severity level</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : summary.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No severity data yet.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {summary.map((s) => (
              <div key={s.severity ?? 'null'} className="flex items-center gap-2">
                <Badge variant={severityVariant(s.severity)}>
                  <span className={severityClass(s.severity)}>{s.severity ?? 'unknown'}</span>
                </Badge>
                <span className="text-sm tabular-nums font-bold">{s.count}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentDriftTable({
  rows,
  isLoading,
}: {
  rows: IntentDriftEventRow[];
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Intent Drift Events</CardTitle>
        <CardDescription>Last 100 events from intent_drift_events table</CardDescription>
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
            No intent drift events yet. Waiting for{' '}
            <code className="text-xs">onex.evt.omniintelligence.intent-drift-detected.v1</code>{' '}
            events.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Original Intent</TableHead>
                <TableHead>Current Intent</TableHead>
                <TableHead>Drift Score</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs max-w-[100px] truncate">
                    {row.session_id ?? '—'}
                  </TableCell>
                  <TableCell className="text-xs max-w-[160px] truncate">
                    {row.original_intent ?? '—'}
                  </TableCell>
                  <TableCell className="text-xs max-w-[160px] truncate">
                    {row.current_intent ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {row.drift_score !== null ? row.drift_score.toFixed(3) : '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={severityVariant(row.severity)} className="text-xs">
                      <span className={severityClass(row.severity)}>
                        {row.severity ?? 'unknown'}
                      </span>
                    </Badge>
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

async function fetchIntentDrift(): Promise<IntentDriftPayload> {
  const res = await fetch('/api/intent-drift');
  if (!res.ok) throw new Error('Failed to fetch intent drift data');
  return res.json() as Promise<IntentDriftPayload>;
}

export default function IntentDriftDashboard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['intent-drift'],
    queryFn: fetchIntentDrift,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const recent = data?.recent ?? [];
  const summary = data?.summary ?? [];

  return (
    <div className="space-y-6" data-testid="page-intent-drift-dashboard">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Intent Drift</h1>
        <p className="text-muted-foreground">
          Agent intent drift detection from{' '}
          <code className="text-xs">
            onex.evt.omniintelligence.intent-drift-detected.v1
          </code>
        </p>
      </div>

      {isError && (
        <p className="text-sm text-destructive">Failed to load intent drift data.</p>
      )}

      {/* Severity + Histogram row */}
      <div className="grid gap-4 md:grid-cols-2">
        <SeveritySummary summary={summary} isLoading={isLoading} />
        <DriftHistogram rows={recent} isLoading={isLoading} />
      </div>

      {/* Recent Table */}
      <RecentDriftTable rows={recent} isLoading={isLoading} />
    </div>
  );
}
