/**
 * DataSourceHealthPanel (OMN-2307)
 *
 * Renders the live/mock/error status of every dashboard data source by
 * querying GET /api/health/data-sources.  Designed to be embedded in the
 * System Health category page as a pre-demo readiness section.
 */

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Activity, AlertTriangle, CheckCircle, MinusCircle, WifiOff, XCircle } from 'lucide-react';

// ============================================================================
// Types (mirrors server/health-data-sources-routes.ts)
// ============================================================================

export type DataSourceStatus = 'live' | 'mock' | 'error' | 'offline' | 'expected_idle_local';

export interface DataSourceInfo {
  status: DataSourceStatus;
  reason?: string;
  lastEvent?: string;
}

export interface DataSourcesHealthResponse {
  dataSources: Record<string, DataSourceInfo>;
  summary: {
    live: number;
    mock: number;
    error: number;
    offline: number;
    expected_idle_local: number;
  };
  checkedAt: string;
}

// ============================================================================
// Human-readable labels for each data source key
// ============================================================================

const DATA_SOURCE_LABELS: Record<string, string> = {
  eventBus: 'Event Bus Monitor',
  effectiveness: 'Injection Effectiveness',
  extraction: 'Pattern Extraction',
  baselines: 'Baselines & ROI',
  costTrends: 'Cost Trends',
  intents: 'Intent Signals',
  nodeRegistry: 'Node Registry',
  correlationTrace: 'Correlation Trace',
  validation: 'Validation Dashboard',
  insights: 'Learned Insights',
  patterns: 'Pattern Learning',
  executionGraph: 'Execution Graph',
  enforcement: 'Pattern Enforcement',
  envSync: 'Env → Infisical Sync',
  topicParity: 'Topic Parity',
};

// Human-readable reason descriptions
const REASON_LABELS: Record<string, string> = {
  empty_tables: 'Empty tables',
  empty_projection: 'Projection not populated',
  no_projection_registered: 'Projection not registered',
  no_events_ingested: 'No Kafka events received',
  no_intents_classified: 'No intents classified',
  no_nodes_registered: 'No nodes registered',
  no_execution_data: 'No execution data',
  api_unavailable: 'API unavailable',
  probe_threw: 'Probe error',
  mockOnEmpty: 'Empty — mock fallback active',
  USE_MOCK_DATA_flag: 'Mock flag enabled',
  demo_flag: 'Demo flag active',
  no_api_connection: 'No API connection',
  no_db_connection: 'No database connection',
  not_implemented: 'Not yet implemented',
  upstream_service_offline: 'Upstream service not running',
  upstream_never_emitted: 'Upstream producer has never emitted',
  probe_disabled: 'Probe disabled (set ENABLE_ENV_SYNC_PROBE=true)',
  infisical_disabled: 'Infisical opt-out (INFISICAL_ADDR not set)',
  sync_script_missing: 'sync-omnibase-env.py not on this host (OMN-3216)',
  sync_never_run: 'Sync script has never run',
  sync_stale: 'Last sync >1 h ago — no recent session start',
};

function formatReason(reason: string | undefined): string {
  if (!reason) return '';
  return REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

// ============================================================================
// Status indicator helpers
// ============================================================================

function StatusIcon({ status }: { status: DataSourceStatus }) {
  switch (status) {
    case 'live':
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    case 'mock':
      return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    case 'error':
      return <XCircle className="w-4 h-4 text-red-500" />;
    case 'offline':
      return <WifiOff className="w-4 h-4 text-slate-400" />;
    case 'expected_idle_local':
      return <MinusCircle className="w-4 h-4 text-blue-400" />;
    default:
      return <Activity className="w-4 h-4 text-gray-400" />;
  }
}

function StatusBadge({ status }: { status: DataSourceStatus }) {
  switch (status) {
    case 'live':
      return (
        <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-[10px]">
          Live
        </Badge>
      );
    case 'mock':
      return (
        <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-[10px]">
          Mock
        </Badge>
      );
    case 'error':
      return (
        <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-[10px]">Error</Badge>
      );
    case 'offline':
      return (
        <Badge className="bg-slate-500/20 text-slate-400 border-slate-500/30 text-[10px]">
          Offline
        </Badge>
      );
    case 'expected_idle_local':
      return (
        <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[10px]">
          Idle (local)
        </Badge>
      );
    default:
      return (
        <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30 text-[10px]">
          {status}
        </Badge>
      );
  }
}

// ============================================================================
// Individual data source row
// ============================================================================

function DataSourceRow({ sourceKey, info }: { sourceKey: string; info: DataSourceInfo }) {
  const label = DATA_SOURCE_LABELS[sourceKey] ?? sourceKey;
  const reason = info.status !== 'live' ? formatReason(info.reason) : null;
  const lastEventDate = info.lastEvent ? new Date(info.lastEvent) : null;
  const lastEvent =
    lastEventDate != null && !isNaN(lastEventDate.getTime())
      ? lastEventDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null;

  return (
    <div className="flex items-center justify-between py-2 border-b border-border/40 last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <StatusIcon status={info.status} />
        <span className="text-sm font-medium truncate">{label}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-2">
        {reason && (
          <span className="text-[11px] text-muted-foreground hidden sm:block">{reason}</span>
        )}
        {lastEvent && info.status === 'live' && (
          <span className="text-[11px] text-muted-foreground hidden sm:block">{lastEvent}</span>
        )}
        <StatusBadge status={info.status} />
      </div>
    </div>
  );
}

// ============================================================================
// Summary counts bar
// ============================================================================

function SummaryBar({
  summary,
}: {
  summary: {
    live: number;
    mock: number;
    error: number;
    offline: number;
    expected_idle_local: number;
  };
}) {
  // total from summary object — should equal Object.keys(dataSources).length;
  // if they diverge, a probe is returning a status not included in the summary count.
  const total = Object.values(summary).reduce((sum, n) => sum + n, 0);
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      <span className="flex items-center gap-1.5 text-green-400">
        <CheckCircle className="w-3.5 h-3.5" />
        {summary.live} live
      </span>
      {summary.mock > 0 && (
        <span className="flex items-center gap-1.5 text-yellow-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {summary.mock} mock
        </span>
      )}
      {summary.offline > 0 && (
        <span className="flex items-center gap-1.5 text-slate-400">
          <WifiOff className="w-3.5 h-3.5" />
          {summary.offline} offline
        </span>
      )}
      {summary.error > 0 && (
        <span className="flex items-center gap-1.5 text-red-400">
          <XCircle className="w-3.5 h-3.5" />
          {summary.error} error
        </span>
      )}
      {summary.expected_idle_local > 0 && (
        <span className="flex items-center gap-1.5 text-blue-400">
          <MinusCircle className="w-3.5 h-3.5" />
          {summary.expected_idle_local} idle
        </span>
      )}
      <span className="text-muted-foreground text-xs ml-auto">{total} total sources</span>
    </div>
  );
}

// ============================================================================
// Main exported component
// ============================================================================

export function DataSourceHealthPanel() {
  // Error handling: the queryFn throws on non-ok HTTP responses and on
  // unexpected response shapes, so any fetch or parse failure is captured by
  // TanStack Query and surfaced via the `error` state below.  The render
  // branch at {error && !isLoading} displays an error card, so no additional
  // try/catch is needed here.
  const { data, isLoading, error } = useQuery<DataSourcesHealthResponse>({
    queryKey: ['health', 'data-sources'],
    queryFn: async () => {
      const response = await fetch('/api/health/data-sources');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (!json || typeof json.dataSources !== 'object' || !json.summary) {
        throw new Error('Invalid response shape from /api/health/data-sources');
      }
      return json as DataSourcesHealthResponse;
    },
    // Refresh every 60 seconds — data source status changes infrequently
    refetchInterval: 60_000,
    staleTime: 30_000,
    // One retry for transient failures; errors on a readiness panel should
    // surface quickly rather than being hidden behind TanStack Query's default
    // 3-retry / ~30 s delay.
    retry: 1,
  });

  const checkedAtDate = data ? new Date(data.checkedAt) : null;
  const checkedAtStr =
    checkedAtDate == null || isNaN(checkedAtDate.getTime())
      ? 'Unknown'
      : checkedAtDate.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="w-4 h-4 text-muted-foreground" />
          Data Source Health
          {data && !isLoading && (
            <span className="text-xs text-muted-foreground font-normal ml-auto">
              checked {checkedAtStr}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded" />
            ))}
          </div>
        )}

        {error && !isLoading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <XCircle className="w-4 h-4 text-red-500" />
            Failed to load data source health
          </div>
        )}

        {data && !isLoading && (
          <div className="space-y-3">
            <SummaryBar summary={data.summary} />
            <div>
              {Object.entries(data.dataSources).map(([key, info]) => (
                <DataSourceRow key={key} sourceKey={key} info={info} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
