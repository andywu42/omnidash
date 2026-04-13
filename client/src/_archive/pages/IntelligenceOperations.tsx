import { MetricCard } from '@/components/MetricCard';
import { RealtimeChart } from '@/components/RealtimeChart';
import { DataTable } from '@/components/DataTable';
import { TransformationFlow } from '@/components/TransformationFlow';
import { AlertPill } from '@/components/AlertPill';
import { ExportButton } from '@/components/ExportButton';
import { SectionHeader } from '@/components/SectionHeader';
import { Card } from '@/components/ui/card';
import { TimeRangeSelector } from '@/components/TimeRangeSelector';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Zap,
  CheckCircle,
  AlertTriangle,
  TrendingUp,
  Activity,
  Database,
  Clock,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { agentOperationsSource } from '@/lib/data-sources';
import {
  POLLING_INTERVAL_SLOW,
  POLLING_INTERVAL_MEDIUM,
  getPollingInterval,
} from '@/lib/constants/query-config';

interface ManifestInjectionHealth {
  successRate: number;
  avgLatencyMs: number;
  failedInjections: Array<{
    errorType: string;
    count: number;
    lastOccurrence: string;
  }>;
  manifestSizeStats: {
    avgSizeKb: number;
    minSizeKb: number;
    maxSizeKb: number;
  };
  latencyTrend: Array<{
    period: string;
    avgLatencyMs: number;
    count: number;
  }>;
  serviceHealth: {
    postgresql: { status: 'up' | 'down'; latencyMs?: number };
    omniintelligence: { status: 'up' | 'down'; latencyMs?: number };
    qdrant: { status: 'up' | 'down'; latencyMs?: number };
  };
}

interface QualityImpact {
  period: string;
  avgQualityImprovement: number;
  manifestsImproved: number;
}

interface AgentAction {
  id: string;
  correlationId: string;
  agentName: string;
  actionType: string;
  actionName: string;
  actionDetails?: any;
  debugMode?: boolean;
  durationMs: number;
  createdAt: string;
}

interface TopAccessedDocument {
  id: string;
  repository: string;
  filePath: string;
  accessCount: number;
  lastAccessedAt: string | null;
  trend: 'up' | 'down' | 'stable';
  trendPercentage: number;
}

type EventType = 'success' | 'info' | 'warning' | 'error';

interface LiveEvent {
  id: string;
  type: EventType;
  message: string;
  timestamp: string;
  source: string;
}

export default function IntelligenceOperations() {
  const [timeRange, setTimeRange] = useState(() => {
    return localStorage.getItem('dashboard-timerange') || '24h';
  });
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);

  const handleTimeRangeChange = (value: string) => {
    setTimeRange(value);
    localStorage.setItem('dashboard-timerange', value);
  };

  const queryClient = useQueryClient();

  // Helper function to convert AgentAction to LiveEvent
  const transformActionToEvent = (action: AgentAction): LiveEvent => {
    // Determine event type based on action type and details
    let type: EventType = 'info';
    let message = '';

    switch (action.actionType) {
      case 'tool_call':
        type = 'info';
        message = `${action.actionName} executed by ${action.agentName}`;
        break;
      case 'decision':
        type = 'info';
        message = `Decision made: ${action.actionName} by ${action.agentName}`;
        break;
      case 'success':
        type = 'success';
        message = `${action.actionName} completed successfully by ${action.agentName}`;
        break;
      case 'error':
        type = 'error';
        message = `Error in ${action.actionName}: ${action.agentName}`;
        break;
      default:
        type = 'info';
        message = `${action.actionName} by ${action.agentName}`;
    }

    // Format timestamp
    const timestamp = new Date(action.createdAt).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    return {
      id: action.id,
      type,
      message,
      timestamp,
      source: action.agentName,
    };
  };

  // WebSocket for real-time updates
  useWebSocket({
    onMessage: (message) => {
      // Process different message types
      switch (message.type) {
        case 'AGENT_ACTION':
          // Add new action to live events (prepend to show newest first)
          const newEvent = transformActionToEvent(message.data);
          setLiveEvents((prev) => [newEvent, ...prev].slice(0, 50)); // Keep last 50 events
          break;

        case 'INITIAL_STATE':
          // Populate live events from initial state
          if (message.data?.recentActions) {
            const initialEvents = message.data.recentActions
              .map(transformActionToEvent)
              .slice(0, 50);
            setLiveEvents(initialEvents);
          }
          // Refresh all data on initial state
          queryClient.invalidateQueries();
          break;

        case 'AGENT_METRIC_UPDATE':
        case 'ROUTING_DECISION':
          // Invalidate all intelligence queries when events occur
          queryClient.invalidateQueries({
            queryKey: ['/api/intelligence/health/manifest-injection', timeRange],
          });
          queryClient.invalidateQueries({
            queryKey: ['agent-operations-full', timeRange],
          });
          queryClient.invalidateQueries({
            queryKey: ['/api/intelligence/documents/top-accessed', timeRange],
          });
          break;
      }
    },
    debug: false,
  });

  // Fetch manifest injection health data (updated via WebSocket)
  const { data: healthData, isLoading: healthLoading } = useQuery<ManifestInjectionHealth>({
    queryKey: ['/api/intelligence/health/manifest-injection', timeRange],
    queryFn: async () => {
      const response = await fetch(
        `/api/intelligence/health/manifest-injection?timeWindow=${timeRange}`
      );
      if (!response.ok) throw new Error('Failed to fetch manifest injection health');
      return response.json();
    },
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
  });

  // Use data source for all operations data (includes transformations)
  const { data: operationsSourceData, isLoading: operationsSourceLoading } = useQuery({
    queryKey: ['agent-operations-full', timeRange],
    queryFn: () => agentOperationsSource.fetchAll(timeRange),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
  });

  // Deprecated stubs — replaced by operationsSourceData
  const operationsData = null;
  const qualityImpactData: QualityImpact[] = [];
  const operationsLoading = operationsSourceLoading;

  // Fetch recent actions as fallback if WebSocket hasn't provided data yet
  const { data: recentActionsData } = useQuery<AgentAction[]>({
    queryKey: [`/api/intelligence/actions/recent?limit=50`],
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    enabled: liveEvents.length === 0, // Only fetch if no live events
  });

  // Fetch top accessed documents
  const { data: topDocumentsData } = useQuery<TopAccessedDocument[]>({
    queryKey: ['/api/intelligence/documents/top-accessed', timeRange],
    queryFn: async () => {
      const response = await fetch(
        `/api/intelligence/documents/top-accessed?timeWindow=${timeRange}&limit=10`
      );
      if (!response.ok) throw new Error('Failed to fetch top documents');
      return response.json();
    },
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
  });

  // Populate live events from API fallback
  useEffect(() => {
    if (recentActionsData && liveEvents.length === 0) {
      const events = recentActionsData.map(transformActionToEvent);
      setLiveEvents(events);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentActionsData]);

  // Extract transformed data from source — use real data only, no mock fallback
  const chartData = operationsSourceData?.chartData || [];
  const qualityData = operationsSourceData?.qualityChartData || [];

  const operations = operationsSourceData?.operations || [];
  const totalOperations = operationsSourceData?.totalOperations || 0;
  const runningOperations = operationsSourceData?.runningOperations || 0;
  const totalOpsPerMinute = operationsSourceData?.totalOpsPerMinute || 0;
  const avgQualityImprovement = operationsSourceData?.avgQualityImprovement || 0;

  // Loading state
  const isLoading = operationsSourceLoading;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Intelligence Operations"
        description={
          isLoading
            ? 'Loading AI operations data...'
            : `${totalOperations} AI operations for code analysis and optimization`
        }
        details="Intelligence Operations tracks all AI-powered analysis and optimization tasks across the platform. Monitor active operations, quality improvements, manifest injections, and document access patterns. This dashboard provides visibility into how AI agents are improving code quality and developer productivity in real-time."
        level="h1"
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <TimeRangeSelector value={timeRange} onChange={handleTimeRangeChange} />
          <ExportButton
            data={{
              operations,
              operationsData,
              qualityImpactData,
              healthData,
              chartData,
              qualityData,
              liveEvents,
            }}
            filename={`intelligence-operations-${new Date().toISOString().split('T')[0]}`}
            disabled={!operationsData && !qualityImpactData && !healthData}
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-6">
        <MetricCard
          label="Active Operations"
          value={isLoading ? '...' : totalOperations.toString()}
          icon={Zap}
          status="healthy"
        />
        <MetricCard
          label="Running Now"
          value={isLoading ? '...' : runningOperations.toString()}
          icon={Zap}
          status="healthy"
        />
        <MetricCard
          label="Operations/Min"
          value={isLoading ? '...' : totalOpsPerMinute.toFixed(1)}
          icon={Activity}
          status="healthy"
        />
        <MetricCard
          label="Avg Quality Impact"
          value={isLoading ? '...' : `${(avgQualityImprovement * 100).toFixed(1)}%`}
          icon={TrendingUp}
          status={avgQualityImprovement > 0 ? 'healthy' : 'warning'}
        />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div>
          <RealtimeChart
            title="Operations per Minute"
            data={chartData}
            color="hsl(var(--chart-4))"
            showArea
          />
        </div>
        <div className="space-y-4">
          {qualityData.length === 0 && !isLoading && (
            <Alert className="border-status-warning/50 bg-status-warning/10">
              <AlertTriangle className="h-4 w-4 text-status-warning" />
              <AlertDescription className="text-status-warning">
                No quality impact data available yet. Quality improvement tracking may not be
                configured.
              </AlertDescription>
            </Alert>
          )}
          <RealtimeChart
            title="Quality Improvement Impact"
            data={qualityData}
            color="hsl(var(--chart-3))"
          />
        </div>
      </div>

      <div className="space-y-6">
        <Card className="p-6">
          <h3 className="text-base font-semibold mb-4">Operation Status</h3>
          {operationsLoading ? (
            <div className="flex items-center justify-center h-48">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : operations.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-muted-foreground">
              No operations data available for selected time range
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {operations.map((op) => (
                <div
                  key={op.id}
                  className="flex items-center gap-3 p-4 rounded-lg border border-card-border hover-elevate"
                >
                  <div
                    className={`h-3 w-3 rounded-full ${op.status === 'running' ? 'bg-status-healthy animate-pulse' : 'bg-status-idle'}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{op.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {op.count} operations • {op.avgTime} avg
                    </div>
                  </div>
                  <Badge variant={op.status === 'running' ? 'default' : 'secondary'}>
                    {op.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>

        <DataTable<LiveEvent>
          title="Live Event Stream"
          data={liveEvents}
          columns={[
            {
              key: 'timestamp',
              header: 'Time',
              sortable: true,
              className: 'font-mono text-xs w-[120px]',
            },
            {
              key: 'type',
              header: 'Type',
              sortable: true,
              className: 'w-[100px]',
              render: (event) => (
                <Badge
                  variant={
                    event.type === 'success'
                      ? 'default'
                      : event.type === 'error'
                        ? 'destructive'
                        : event.type === 'warning'
                          ? 'outline'
                          : 'secondary'
                  }
                  className={cn(
                    event.type === 'success' &&
                      'bg-status-healthy/10 text-status-healthy border-status-healthy/20',
                    event.type === 'error' &&
                      'bg-status-error/10 text-status-error border-status-error/20',
                    event.type === 'warning' &&
                      'bg-status-warning/10 text-status-warning border-status-warning/20',
                    event.type === 'info' && 'bg-primary/10 text-primary border-primary/20'
                  )}
                >
                  {event.type}
                </Badge>
              ),
            },
            {
              key: 'source',
              header: 'Agent',
              sortable: true,
              className: 'w-[200px]',
              render: (event) => (
                <Badge variant="outline" className="font-mono text-xs">
                  {event.source}
                </Badge>
              ),
            },
            {
              key: 'message',
              header: 'Message',
              sortable: true,
              className: 'text-sm',
            },
          ]}
          columnFilters={[
            {
              key: 'type',
              label: 'Event Type',
              options: [
                { value: 'success', label: 'Success' },
                { value: 'info', label: 'Info' },
                { value: 'warning', label: 'Warning' },
                { value: 'error', label: 'Error' },
              ],
            },
            {
              key: 'source',
              label: 'Agent',
              options: [...Array.from(new Set(liveEvents.map((e) => e.source)))]
                .sort()
                .map((source) => ({ value: source, label: source })),
            },
          ]}
          searchKeys={['message', 'source']}
          searchPlaceholder="Search events or agents..."
          defaultPageSize={50}
          maxHeight="500px"
        />
      </div>

      {/* Intelligence Health Monitoring */}
      <div className="space-y-6">
        <SectionHeader
          title="Manifest Injection Health"
          description="Monitor intelligence system performance and detect degradation before it impacts users."
          details="This section tracks the health of the manifest injection system, which powers AI agent intelligence by providing contextual information. Monitor success rates, latency trends, service health, and failed injections. Use these metrics to identify performance bottlenecks and ensure reliable AI operations."
          level="h2"
        />

        {healthLoading ? (
          <Card className="p-6">
            <div className="flex items-center justify-center h-48">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          </Card>
        ) : healthData ? (
          <>
            {/* Health Metrics Overview */}
            <div className="grid grid-cols-4 gap-6">
              <MetricCard
                label="Success Rate (24h)"
                value={`${(healthData.successRate * 100).toFixed(1)}%`}
                icon={CheckCircle}
                status={
                  healthData.successRate >= 0.95
                    ? 'healthy'
                    : healthData.successRate >= 0.9
                      ? 'warning'
                      : 'error'
                }
              />
              <MetricCard
                label="Avg Latency"
                value={`${healthData.avgLatencyMs.toFixed(0)}ms`}
                icon={Clock}
                status={
                  healthData.avgLatencyMs <= 500
                    ? 'healthy'
                    : healthData.avgLatencyMs <= 1000
                      ? 'warning'
                      : 'error'
                }
              />
              <MetricCard
                label="Manifest Size (Avg)"
                value={`${healthData.manifestSizeStats.avgSizeKb.toFixed(1)} KB`}
                icon={Database}
                status="healthy"
              />
              <MetricCard
                label="Failed Injections"
                value={healthData.failedInjections.reduce((sum, f) => sum + f.count, 0).toString()}
                icon={AlertTriangle}
                status={
                  healthData.failedInjections.reduce((sum, f) => sum + f.count, 0) === 0
                    ? 'healthy'
                    : 'warning'
                }
              />
            </div>

            {/* Latency Trend Chart */}
            <div className="grid grid-cols-2 gap-6">
              <RealtimeChart
                title="Injection Latency Trend (24h)"
                data={[
                  ...healthData.latencyTrend.map((t) => ({
                    time: new Date(t.period).toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                    value: t.avgLatencyMs,
                  })),
                ].reverse()}
                color="hsl(var(--chart-2))"
                showArea
              />

              {/* Service Health Status */}
              <Card className="p-6">
                <h3 className="text-base font-semibold mb-4">Service Health Status</h3>
                <div className="space-y-4">
                  {Object.entries(healthData.serviceHealth).map(([service, health]) => (
                    <div
                      key={service}
                      className="flex items-center justify-between p-3 rounded-lg border border-card-border"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`h-3 w-3 rounded-full ${health.status === 'up' ? 'bg-status-healthy' : 'bg-status-critical'} ${health.status === 'up' ? 'animate-pulse' : ''}`}
                        />
                        <div>
                          <div className="text-sm font-medium capitalize">{service}</div>
                          {health.latencyMs !== undefined && health.status === 'up' && (
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {health.latencyMs}ms response time
                            </div>
                          )}
                        </div>
                      </div>
                      <Badge variant={health.status === 'up' ? 'default' : 'destructive'}>
                        {health.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            {/* Failed Injections Table */}
            {healthData.failedInjections.length > 0 && (
              <Card className="p-6">
                <h3 className="text-base font-semibold mb-4">Failed Injections (Last 24h)</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Error Type</TableHead>
                      <TableHead className="text-right">Count</TableHead>
                      <TableHead className="text-right">Last Occurrence</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {healthData.failedInjections.map((failure) => (
                      <TableRow key={failure.errorType}>
                        <TableCell className="font-medium">
                          {failure.errorType.replace(/_/g, ' ').toUpperCase()}
                        </TableCell>
                        <TableCell className="text-right">{failure.count}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {new Date(failure.lastOccurrence).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            )}

            {/* Alert Warnings */}
            {(healthData.successRate < 0.95 || healthData.avgLatencyMs > 500) && (
              <div className="flex items-center gap-2 flex-wrap">
                {healthData.successRate < 0.95 && (
                  <AlertPill
                    level="warning"
                    message={`Success rate below 95% threshold (${(healthData.successRate * 100).toFixed(1)}%)`}
                  />
                )}
                {healthData.avgLatencyMs > 500 && (
                  <AlertPill
                    level="warning"
                    message={`Average latency exceeds 500ms (${healthData.avgLatencyMs.toFixed(0)}ms)`}
                  />
                )}
              </div>
            )}
          </>
        ) : null}
      </div>

      {/* Document Access Ranking */}
      <div className="space-y-6">
        <SectionHeader
          title="Document Access Ranking"
          description="Most accessed documents in knowledge base with trend analysis."
          details="Track which documentation and code files are accessed most frequently by AI agents. This helps identify critical knowledge sources, outdated documentation, and gaps in your knowledge base. Use access trends to prioritize documentation updates and improve agent performance."
          level="h2"
        />

        <DataTable<TopAccessedDocument>
          title="Top Accessed Documents"
          data={
            topDocumentsData && topDocumentsData.length > 0
              ? topDocumentsData
              : [
                  {
                    id: 'm1',
                    repository: 'omniintelligence',
                    filePath: 'https://repo/docs/INTRO.md',
                    accessCount: 128,
                    lastAccessedAt: new Date().toISOString(),
                    trend: 'up',
                    trendPercentage: 18,
                  },
                  {
                    id: 'm2',
                    repository: 'omniintelligence',
                    filePath: 'https://repo/docs/API.md',
                    accessCount: 64,
                    lastAccessedAt: new Date(Date.now() - 86400000).toISOString(),
                    trend: 'stable',
                    trendPercentage: 0,
                  },
                  {
                    id: 'm3',
                    repository: 'omniintelligence',
                    filePath: 'https://repo/docs/SETUP.md',
                    accessCount: 29,
                    lastAccessedAt: null,
                    trend: 'down',
                    trendPercentage: 7,
                  },
                ]
          }
          columns={[
            {
              key: 'filePath',
              header: 'Document',
              sortable: true,
              className: 'max-w-[400px]',
              render: (doc) => (
                <div className="flex flex-col gap-1">
                  <a
                    href={doc.filePath}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-primary hover:underline truncate"
                  >
                    {doc.filePath.replace(/^https?:\/\//, '')}
                  </a>
                  <Badge variant="outline" className="w-fit text-xs">
                    {doc.repository}
                  </Badge>
                </div>
              ),
            },
            {
              key: 'accessCount',
              header: 'Accesses',
              sortable: true,
              className: 'text-right w-[100px]',
              render: (doc) => (
                <span className="font-mono font-semibold">{doc.accessCount.toLocaleString()}</span>
              ),
            },
            {
              key: 'trend',
              header: 'Trend',
              sortable: true,
              className: 'w-[150px]',
              render: (doc) => (
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      doc.trend === 'up'
                        ? 'default'
                        : doc.trend === 'down'
                          ? 'destructive'
                          : 'secondary'
                    }
                    className={cn(
                      doc.trend === 'up' &&
                        'bg-status-healthy/10 text-status-healthy border-status-healthy/20',
                      doc.trend === 'down' &&
                        'bg-status-error/10 text-status-error border-status-error/20',
                      doc.trend === 'stable' && 'bg-muted/10 text-muted-foreground border-muted/20'
                    )}
                  >
                    {doc.trend === 'up' ? '↑' : doc.trend === 'down' ? '↓' : '→'}{' '}
                    {Math.abs(doc.trendPercentage)}%
                  </Badge>
                </div>
              ),
            },
            {
              key: 'lastAccessedAt',
              header: 'Last Accessed',
              sortable: true,
              className: 'w-[180px]',
              render: (doc) => (
                <span className="text-xs text-muted-foreground">
                  {doc.lastAccessedAt
                    ? new Date(doc.lastAccessedAt).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'Never'}
                </span>
              ),
            },
          ]}
          columnFilters={[
            {
              key: 'repository',
              label: 'Repository',
              options: [...Array.from(new Set((topDocumentsData || []).map((d) => d.repository)))]
                .sort()
                .map((repo) => ({ value: repo, label: repo })),
            },
            {
              key: 'trend',
              label: 'Trend',
              options: [
                { value: 'up', label: 'Trending Up' },
                { value: 'stable', label: 'Stable' },
                { value: 'down', label: 'Trending Down' },
              ],
            },
          ]}
          searchKeys={['filePath', 'repository']}
          searchPlaceholder="Search documents..."
          defaultPageSize={10}
          maxHeight="500px"
        />
      </div>

      {/* Polymorphic Transformation Viewer */}
      <div>
        <TransformationFlow timeWindow="30d" />
      </div>
    </div>
  );
}
