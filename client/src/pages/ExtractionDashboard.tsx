/**
 * Extraction Dashboard (OMN-1804)
 *
 * Pattern extraction pipeline observability: pipeline health, latency heatmap,
 * pattern volume, and error rates. All data sourced from PostgreSQL via API.
 *
 * Layout: Stats row (4 metric cards) + 2x2 grid of panels.
 *
 * WebSocket integration: listens for EXTRACTION_INVALIDATE events to trigger
 * query re-fetches. The WebSocket carries no data payloads -- it only signals
 * "something changed, re-query the API".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { extractionSource } from '@/lib/data-sources/extraction-source';
import { DemoBanner } from '@/components/DemoBanner';
import { queryKeys } from '@/lib/query-keys';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Activity, Clock, Zap, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatRelativeTime } from '@/lib/date-utils';
import { MetricCard } from '@/components/MetricCard';
import { PipelineHealthPanel } from '@/components/extraction/PipelineHealthPanel';
import { LatencyHeatmap } from '@/components/extraction/LatencyHeatmap';
import { PatternVolumeChart } from '@/components/extraction/PatternVolumeChart';
import { ErrorRatesPanel } from '@/components/extraction/ErrorRatesPanel';

// ============================================================================
// Dashboard Page
// ============================================================================

export default function ExtractionDashboard() {
  const queryClient = useQueryClient();
  const [timeWindow, setTimeWindow] = useState('24h');

  // Track mock-data status in reactive state so React re-renders when it changes.
  // We aggregate `isMock` across the summary query and all four sub-panel queries:
  // the badge shows "Demo Data" if ANY of the five data sources is using mock data.
  const [isUsingMockData, setIsUsingMockData] = useState(false);

  // Per-panel mock flags tracked in a ref so we can aggregate without triggering
  // a re-render on every intermediate update.  We use stable panel keys so that
  // each onMockStateChange callback only flips its own slot.
  //
  // Convention for adding new panels:
  //   1. Add a key here initialised to `false` (the key name is arbitrary but
  //      must be stable and unique across the dashboard).
  //   2. Pass an `onMockStateChange` prop to the new panel component that calls
  //      `updateMockFlag('<key>', v)`.
  //   3. Keys that are NOT listed here still work correctly — an unlisted key
  //      starts as `undefined` (falsy), so `updateMockFlag` will set it to the
  //      real value on the first render without producing a stale `true` flip.
  //      Listing keys explicitly is purely for documentation/discoverability.
  const mockFlags = useRef<Record<string, boolean>>({
    summary: false,
    pipelineHealth: false,
    latency: false,
    patternVolume: false,
    errors: false,
  });

  const updateMockFlag = useCallback((panel: string, isMock: boolean) => {
    mockFlags.current[panel] = isMock;
    setIsUsingMockData(Object.values(mockFlags.current).some(Boolean));
  }, []);

  const onPipelineHealthMock = useCallback(
    (v: boolean) => updateMockFlag('pipelineHealth', v),
    [updateMockFlag]
  );
  const onLatencyMock = useCallback((v: boolean) => updateMockFlag('latency', v), [updateMockFlag]);
  const onPatternVolumeMock = useCallback(
    (v: boolean) => updateMockFlag('patternVolume', v),
    [updateMockFlag]
  );
  const onErrorsMock = useCallback((v: boolean) => updateMockFlag('errors', v), [updateMockFlag]);

  // Summary stats for metric cards
  const {
    data: summaryResult,
    isLoading: summaryLoading,
    isError: summaryError,
  } = useQuery({
    queryKey: [...queryKeys.extraction.summary()],
    queryFn: () => extractionSource.summary(),
    refetchInterval: 30_000,
  });

  const summary = summaryResult;

  // WebSocket invalidation: re-fetch all extraction queries on EXTRACTION_INVALIDATE
  const handleWebSocketMessage = useCallback(
    (msg: { type: string; data?: unknown; timestamp?: string }) => {
      if (msg.type === 'EXTRACTION_INVALIDATE') {
        queryClient.invalidateQueries({ queryKey: queryKeys.extraction.all });
      }
    },
    [queryClient]
  );

  const { isConnected, subscribe, unsubscribe } = useWebSocket({
    onMessage: handleWebSocketMessage,
  });

  useEffect(() => {
    if (isConnected) {
      subscribe(['extraction']);
    }
    return () => {
      unsubscribe(['extraction']);
    };
  }, [isConnected, subscribe, unsubscribe]);

  // Format helpers
  const formatNumber = (n: number | null | undefined): string => {
    if (n == null) return '--';
    return n.toLocaleString();
  };

  const formatPercent = (n: number | null | undefined): string => {
    if (n == null) return '--';
    return `${(n * 100).toFixed(1)}%`;
  };

  const formatMs = (n: number | null | undefined): string => {
    if (n == null) return '--';
    return `${Math.round(n)}ms`;
  };

  return (
    <div className="space-y-6">
      <DemoBanner />

      {/* Error Banner */}
      {summaryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load extraction data</AlertTitle>
          <AlertDescription>
            Extraction summary could not be retrieved. Pipeline metrics may also be affected.
          </AlertDescription>
        </Alert>
      )}

      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Extraction Pipeline</h2>
          <p className="text-sm text-muted-foreground">
            Pattern extraction pipeline observability and metrics
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isUsingMockData && (
            <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
              Demo Data
            </Badge>
          )}
          <Select value={timeWindow} onValueChange={setTimeWindow}>
            <SelectTrigger className="w-28 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">Last 1h</SelectItem>
              <SelectItem value="6h">Last 6h</SelectItem>
              <SelectItem value="24h">Last 24h</SelectItem>
              <SelectItem value="7d">Last 7d</SelectItem>
              <SelectItem value="30d">Last 30d</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground'}`}
            />
            <span className="text-[10px] text-muted-foreground">
              {isConnected ? 'Live' : 'Offline'}
            </span>
          </div>
        </div>
      </div>

      {/* Metric Cards Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Total Injections"
          value={formatNumber(summary?.total_injections)}
          subtitle="Unique sessions with pattern injection"
          icon={Zap}
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Patterns Matched"
          value={formatNumber(summary?.total_patterns_matched)}
          subtitle="Distinct patterns matched across all sessions"
          icon={Activity}
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Avg Latency"
          value={formatMs(summary?.avg_latency_ms)}
          subtitle="End-to-end injection latency, all cohorts"
          icon={Clock}
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Success Rate"
          value={formatPercent(summary?.success_rate)}
          subtitle={
            summary?.last_event_at
              ? `Last event: ${formatRelativeTime(summary.last_event_at)}`
              : undefined
          }
          icon={AlertTriangle}
          isLoading={summaryLoading}
        />
      </div>

      {/* 2x2 Panel Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PipelineHealthPanel onMockStateChange={onPipelineHealthMock} />
        <LatencyHeatmap timeWindow={timeWindow} onMockStateChange={onLatencyMock} />
        <PatternVolumeChart timeWindow={timeWindow} onMockStateChange={onPatternVolumeMock} />
        <ErrorRatesPanel onMockStateChange={onErrorsMock} />
      </div>
    </div>
  );
}
