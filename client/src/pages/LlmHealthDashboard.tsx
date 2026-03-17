/**
 * LLM Health Dashboard (OMN-5279)
 *
 * Displays per-model LLM endpoint health so you can answer
 * "which models are up?", "what's the latency?", and "what's the error rate?"
 *
 * Data source: /api/llm-health (projected from llm-health-snapshot Kafka events)
 *
 * Status colors:
 *   green  = healthy  (error_rate < 0.05 AND latency_p99 < 2000ms)
 *   yellow = degraded (error_rate < 0.20 OR latency_p99 < 5000ms)
 *   red    = down     (error_rate >= 0.20 OR status === 'down' OR no data)
 */

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, XCircle, AlertTriangle, Cpu, Clock, Zap, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

// ============================================================================
// Types
// ============================================================================

interface LlmHealthRow {
  id: number;
  modelId: string;
  endpointUrl: string;
  latencyP50Ms: number | null;
  latencyP99Ms: number | null;
  errorRate: number | null;
  tokensPerSecond: number | null;
  status: string;
  createdAt: string;
}

interface LlmHealthPayload {
  models: LlmHealthRow[];
  history: LlmHealthRow[];
  generatedAt: string;
}

// ============================================================================
// Helpers
// ============================================================================

type ModelStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

function computeStatus(row: LlmHealthRow): ModelStatus {
  if (row.status === 'down') return 'down';
  if (row.status === 'healthy') return 'healthy';
  if (row.status === 'degraded') return 'degraded';

  // Derive from metrics when status field is generic
  const errorRate = row.errorRate ?? null;
  const latencyP99 = row.latencyP99Ms ?? null;

  if (errorRate === null && latencyP99 === null) return 'unknown';
  if (errorRate !== null && errorRate >= 0.2) return 'down';
  if (
    (errorRate !== null && errorRate >= 0.05) ||
    (latencyP99 !== null && latencyP99 >= 5000)
  ) {
    return 'degraded';
  }
  return 'healthy';
}

function StatusIcon({ status }: { status: ModelStatus }) {
  switch (status) {
    case 'healthy':
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    case 'degraded':
      return <AlertTriangle className="h-5 w-5 text-yellow-500" />;
    case 'down':
      return <XCircle className="h-5 w-5 text-red-500" />;
    default:
      return <AlertTriangle className="h-5 w-5 text-muted-foreground" />;
  }
}

function statusBadgeVariant(status: ModelStatus): string {
  switch (status) {
    case 'healthy':
      return 'bg-green-500/10 text-green-500 border-green-500/20';
    case 'degraded':
      return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20';
    case 'down':
      return 'bg-red-500/10 text-red-500 border-red-500/20';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function statusLabel(status: ModelStatus): string {
  switch (status) {
    case 'healthy':
      return 'Healthy';
    case 'degraded':
      return 'Degraded';
    case 'down':
      return 'Down';
    default:
      return 'Unknown';
  }
}

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

function formatLatency(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatErrorRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

function formatTps(tps: number | null): string {
  if (tps === null) return '—';
  return `${tps.toFixed(1)} t/s`;
}

// ============================================================================
// Model Card Component
// ============================================================================

function ModelCard({ row }: { row: LlmHealthRow }) {
  const status = computeStatus(row);
  const cardBorderClass =
    status === 'healthy'
      ? 'border-green-500/20'
      : status === 'degraded'
        ? 'border-yellow-500/20'
        : status === 'down'
          ? 'border-red-500/20'
          : 'border-border';

  return (
    <Card className={cn('transition-colors', cardBorderClass)}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <StatusIcon status={status} />
            <CardTitle className="text-base truncate">{row.modelId}</CardTitle>
          </div>
          <Badge className={cn('text-xs shrink-0', statusBadgeVariant(status))}>
            {statusLabel(status)}
          </Badge>
        </div>
        <CardDescription className="text-xs truncate mt-1" title={row.endpointUrl}>
          {row.endpointUrl}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">P50 Latency</p>
              <p className="text-sm font-medium">{formatLatency(row.latencyP50Ms)}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">P99 Latency</p>
              <p
                className={cn(
                  'text-sm font-medium',
                  row.latencyP99Ms !== null && row.latencyP99Ms >= 5000
                    ? 'text-red-500'
                    : row.latencyP99Ms !== null && row.latencyP99Ms >= 2000
                      ? 'text-yellow-500'
                      : ''
                )}
              >
                {formatLatency(row.latencyP99Ms)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Error Rate</p>
              <p
                className={cn(
                  'text-sm font-medium',
                  row.errorRate !== null && row.errorRate >= 0.2
                    ? 'text-red-500'
                    : row.errorRate !== null && row.errorRate >= 0.05
                      ? 'text-yellow-500'
                      : ''
                )}
              >
                {formatErrorRate(row.errorRate)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Tokens/s</p>
              <p className="text-sm font-medium">{formatTps(row.tokensPerSecond)}</p>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Last probe: {relativeTime(row.createdAt)}
        </p>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Summary Bar
// ============================================================================

function SummaryBar({ models }: { models: LlmHealthRow[] }) {
  const counts = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
  for (const m of models) {
    counts[computeStatus(m)]++;
  }

  return (
    <div className="flex flex-wrap gap-4 text-sm">
      <span className="flex items-center gap-1.5">
        <CheckCircle2 className="h-4 w-4 text-green-500" />
        <span className="font-medium text-green-500">{counts.healthy}</span>
        <span className="text-muted-foreground">healthy</span>
      </span>
      <span className="flex items-center gap-1.5">
        <AlertTriangle className="h-4 w-4 text-yellow-500" />
        <span className="font-medium text-yellow-500">{counts.degraded}</span>
        <span className="text-muted-foreground">degraded</span>
      </span>
      <span className="flex items-center gap-1.5">
        <XCircle className="h-4 w-4 text-red-500" />
        <span className="font-medium text-red-500">{counts.down}</span>
        <span className="text-muted-foreground">down</span>
      </span>
      {counts.unknown > 0 && (
        <span className="flex items-center gap-1.5">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-muted-foreground">{counts.unknown}</span>
          <span className="text-muted-foreground">unknown</span>
        </span>
      )}
    </div>
  );
}

// ============================================================================
// Main Page
// ============================================================================

async function fetchLlmHealth(): Promise<LlmHealthPayload> {
  const res = await fetch('/api/llm-health');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<LlmHealthPayload>;
}

export default function LlmHealthDashboard() {
  const { data, isLoading, isError } = useQuery<LlmHealthPayload>({
    queryKey: queryKeys.llmHealth.snapshot(),
    queryFn: fetchLlmHealth,
    refetchInterval: 30_000,
  });

  const models = data?.models ?? [];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">LLM Health</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Per-endpoint latency, error rate, and throughput from health snapshot events
          </p>
        </div>
        {data && (
          <p className="text-xs text-muted-foreground self-end">
            Updated {relativeTime(data.generatedAt)}
          </p>
        )}
      </div>

      {/* Summary */}
      {!isLoading && !isError && models.length > 0 && <SummaryBar models={models} />}

      {/* No data state */}
      {!isLoading && !isError && models.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <TrendingUp className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No LLM health snapshots yet. Waiting for{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                onex.evt.omnibase-infra.llm-health-snapshot.v1
              </code>{' '}
              events.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Error state */}
      {isError && (
        <Card className="border-red-500/20">
          <CardContent className="py-8 text-center">
            <XCircle className="h-6 w-6 text-red-500 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">Failed to load LLM health data.</p>
          </CardContent>
        </Card>
      )}

      {/* Loading skeletons */}
      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-3 w-56 mt-1" />
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3">
                  {Array.from({ length: 4 }).map((_, j) => (
                    <Skeleton key={j} className="h-10 w-full" />
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Model cards */}
      {!isLoading && models.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {models.map((model) => (
            <ModelCard key={model.id} row={model} />
          ))}
        </div>
      )}
    </div>
  );
}
