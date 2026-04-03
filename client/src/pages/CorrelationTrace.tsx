/**
 * CorrelationTrace (OMN-2301, OMN-5047)
 *
 * Trace complete agent execution flows using correlation IDs and trace spans.
 * Shows recent traces from the span-based API with click-to-select for full
 * hop-by-hop timeline visualization. Falls back to the legacy routing-decision
 * based trace API when no span data is available.
 *
 * Data sources (OMN-5047 — span-based, primary):
 *   GET /api/traces/recent?limit=20              - Recent traces (span-based)
 *   GET /api/traces/sessions/recent?limit=20     - Recent sessions
 *   GET /api/traces/:traceId/spans               - Full trace span timeline
 *   GET /api/traces/session/:sessionId            - Traces for a session
 *
 * Data sources (legacy, fallback):
 *   GET /api/intelligence/traces/recent?limit=20  - Recent traces (routing-decision based)
 *   GET /api/intelligence/trace/:correlationId     - Full trace detail
 */

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  Clock,
  AlertCircle,
  Code,
  Database,
  Zap,
  Activity,
  RefreshCw,
  Info,
  ChevronLeft,
  Layers,
  GitBranch,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ExportButton } from '@/components/ExportButton';
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelativeTime } from '@/lib/date-utils';
import { useDemoMode } from '@/contexts/DemoModeContext';
import { DemoBanner } from '@/components/DemoBanner';

// ============================================================================
// Types — Span-based (OMN-5047)
// ============================================================================

/** Recent trace summary from GET /api/traces/recent */
interface RecentTraceSpan {
  traceId: string;
  correlationId: string;
  sessionId: string | null;
  spanCount: number;
  rootSpanName: string | null;
  startedAt: string;
  totalDurationMs: number;
  errorCount: number;
}

/** Recent session summary from GET /api/traces/sessions/recent */
interface RecentSession {
  sessionId: string;
  traceCount: number;
  spanCount: number;
  firstSeen: string;
  lastSeen: string;
  errorCount: number;
}

/** Single span in a trace timeline */
interface TraceSpan {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  correlationId: string;
  sessionId: string | null;
  spanKind: string;
  spanName: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
}

/** Full trace detail from GET /api/traces/:traceId/spans */
interface TraceSpansResponse {
  traceId: string;
  spans: TraceSpan[];
  summary: {
    totalSpans: number;
    rootSpanName: string | null;
    correlationId: string;
    sessionId: string | null;
    errors: number;
    totalDurationMs: number;
    kindBreakdown: Record<string, number>;
  } | null;
}

/** Session traces from GET /api/traces/session/:sessionId */
interface _SessionTracesResponse {
  sessionId: string;
  traceCount: number;
  traces: {
    traceId: string;
    correlationId: string;
    spanCount: number;
    rootSpanName: string | null;
    startedAt: string;
    endedAt: string | null;
    totalDurationMs: number;
    errorCount: number;
  }[];
}

// ============================================================================
// Types — Legacy
// ============================================================================

/** Summary row returned by GET /api/intelligence/traces/recent */
interface _LegacyRecentTrace {
  correlationId: string;
  selectedAgent: string;
  confidenceScore: number;
  userRequest: string | null;
  routingTimeMs: number;
  createdAt: string | null;
  eventCount: number;
}

// ============================================================================
// Demo data (shown when demo mode is active)
// ============================================================================

const DEMO_RECENT_TRACES: RecentTraceSpan[] = [
  {
    traceId: 'trace-demo-7f3a',
    correlationId: 'cor-demo-7f3a',
    sessionId: 'session-demo-001',
    spanCount: 5,
    rootSpanName: 'session-prompt',
    startedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    totalDurationMs: 480_000,
    errorCount: 0,
  },
  {
    traceId: 'trace-demo-8b2c',
    correlationId: 'cor-demo-8b2c',
    sessionId: 'session-demo-001',
    spanCount: 3,
    rootSpanName: 'session-prompt',
    startedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    totalDurationMs: 120_000,
    errorCount: 0,
  },
];

const DEMO_TRACE_DETAIL: TraceSpansResponse = (() => {
  const base = Date.now() - 12 * 60 * 1000;
  return {
    traceId: 'trace-demo-7f3a',
    spans: [
      {
        id: 'demo-001',
        traceId: 'trace-demo-7f3a',
        spanId: 'span-root',
        parentSpanId: null,
        correlationId: 'cor-demo-7f3a',
        sessionId: 'session-demo-001',
        spanKind: 'orchestrator',
        spanName: 'session-prompt',
        status: 'ok',
        startedAt: new Date(base).toISOString(),
        endedAt: new Date(base + 480_000).toISOString(),
        durationMs: 480_000,
        metadata: { prompt_preview: 'feat(dash): implement demo mode toggle' },
      },
      {
        id: 'demo-002',
        traceId: 'trace-demo-7f3a',
        spanId: 'span-route',
        parentSpanId: 'span-root',
        correlationId: 'cor-demo-7f3a',
        sessionId: 'session-demo-001',
        spanKind: 'routing',
        spanName: 'agent-routing',
        status: 'ok',
        startedAt: new Date(base + 12_000).toISOString(),
        endedAt: new Date(base + 12_038).toISOString(),
        durationMs: 38,
        metadata: {
          selectedAgent: 'frontend-developer',
          confidence: 0.94,
        },
      },
      {
        id: 'demo-003',
        traceId: 'trace-demo-7f3a',
        spanId: 'span-manifest',
        parentSpanId: 'span-root',
        correlationId: 'cor-demo-7f3a',
        sessionId: 'session-demo-001',
        spanKind: 'effect',
        spanName: 'manifest-injection',
        status: 'ok',
        startedAt: new Date(base + 30_000).toISOString(),
        endedAt: new Date(base + 30_038).toISOString(),
        durationMs: 38,
        metadata: { patternsInjected: 8, tokenCount: 1240 },
      },
      {
        id: 'demo-004',
        traceId: 'trace-demo-7f3a',
        spanId: 'span-tool-1',
        parentSpanId: 'span-root',
        correlationId: 'cor-demo-7f3a',
        sessionId: 'session-demo-001',
        spanKind: 'tool_call',
        spanName: 'Read',
        status: 'ok',
        startedAt: new Date(base + 66_000).toISOString(),
        endedAt: new Date(base + 66_042).toISOString(),
        durationMs: 42,
        metadata: { file_path: 'client/src/contexts/DemoModeContext.tsx' },
      },
      {
        id: 'demo-005',
        traceId: 'trace-demo-7f3a',
        spanId: 'span-tool-2',
        parentSpanId: 'span-root',
        correlationId: 'cor-demo-7f3a',
        sessionId: 'session-demo-001',
        spanKind: 'tool_call',
        spanName: 'Bash',
        status: 'ok',
        startedAt: new Date(base + 228_000).toISOString(),
        endedAt: new Date(base + 232_210).toISOString(),
        durationMs: 4210,
        metadata: { command: 'npm run check' },
      },
    ],
    summary: {
      totalSpans: 5,
      rootSpanName: 'session-prompt',
      correlationId: 'cor-demo-7f3a',
      sessionId: 'session-demo-001',
      errors: 0,
      totalDurationMs: 480_000,
      kindBreakdown: { orchestrator: 1, routing: 1, effect: 1, tool_call: 2 },
    },
  };
})();

// ============================================================================
// Helpers
// ============================================================================

function truncate(text: string | null | undefined, maxLen: number): string {
  if (!text) return '--';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function getSpanIcon(spanKind: string) {
  switch (spanKind) {
    case 'routing':
      return <Zap className="w-4 h-4" />;
    case 'tool_call':
      return <Code className="w-4 h-4" />;
    case 'effect':
      return <Database className="w-4 h-4" />;
    case 'orchestrator':
      return <Layers className="w-4 h-4" />;
    case 'compute':
      return <Activity className="w-4 h-4" />;
    default:
      return <Clock className="w-4 h-4" />;
  }
}

function getSpanColor(spanKind: string, status: string) {
  if (status === 'error') return 'bg-red-500/10 text-red-500 border-red-500/20';
  switch (spanKind) {
    case 'routing':
      return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
    case 'tool_call':
      return 'bg-green-500/10 text-green-500 border-green-500/20';
    case 'effect':
      return 'bg-purple-500/10 text-purple-500 border-purple-500/20';
    case 'orchestrator':
      return 'bg-amber-500/10 text-amber-500 border-amber-500/20';
    case 'compute':
      return 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20';
    default:
      return 'bg-gray-500/10 text-gray-500 border-gray-500/20';
  }
}

function getSpanLabel(spanKind: string) {
  switch (spanKind) {
    case 'routing':
      return 'Routing';
    case 'tool_call':
      return 'Tool Call';
    case 'effect':
      return 'Effect';
    case 'orchestrator':
      return 'Orchestrator';
    case 'compute':
      return 'Compute';
    case 'reducer':
      return 'Reducer';
    default:
      return spanKind;
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// ============================================================================
// Sub-components
// ============================================================================

function RecentTracesSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-64 flex-1" />
          <Skeleton className="h-5 w-8" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

function EmptyRecentTraces() {
  return (
    <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/40 border border-border/50">
      <Info className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
      <div>
        <p className="text-sm font-medium mb-1">No recent traces found</p>
        <p className="text-sm text-muted-foreground">
          Traces appear here when OmniClaude sessions generate trace span events. Start a Claude
          Code session with the ONEX plugin enabled to generate trace data.
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function CorrelationTrace() {
  const { isDemoMode } = useDemoMode();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [activeTab, setActiveTab] = useState<'traces' | 'sessions'>('traces');

  // Clear selection when demo mode toggles
  useEffect(() => {
    if (isDemoMode) {
      setSelectedTraceId(null);
    } else {
      setSelectedTraceId(null);
      setSearchInput('');
    }
  }, [isDemoMode]);

  // -------------------------------------------------------------------------
  // Recent traces query (span-based, auto-refreshes every 30s)
  // -------------------------------------------------------------------------

  const {
    data: recentTraces,
    isLoading: recentLoading,
    error: recentError,
  } = useQuery<RecentTraceSpan[]>({
    queryKey: ['/api/traces/recent', isDemoMode],
    queryFn: async () => {
      if (isDemoMode) return DEMO_RECENT_TRACES;
      const response = await fetch('/api/traces/recent?limit=20');
      if (!response.ok) {
        throw new Error(`Failed to fetch recent traces: ${response.status}`);
      }
      return response.json();
    },
    refetchInterval: isDemoMode ? false : 30_000,
  });

  // -------------------------------------------------------------------------
  // Recent sessions query
  // -------------------------------------------------------------------------

  const {
    data: recentSessions,
    isLoading: sessionsLoading,
    error: sessionsError,
  } = useQuery<RecentSession[]>({
    queryKey: ['/api/traces/sessions/recent', isDemoMode],
    queryFn: async () => {
      if (isDemoMode) return [];
      const response = await fetch('/api/traces/sessions/recent?limit=20');
      if (!response.ok) {
        throw new Error(`Failed to fetch recent sessions: ${response.status}`);
      }
      return response.json();
    },
    refetchInterval: isDemoMode ? false : 30_000,
    enabled: activeTab === 'sessions' && !isDemoMode,
  });

  // -------------------------------------------------------------------------
  // Trace detail query (span-based)
  // -------------------------------------------------------------------------

  const {
    data: traceDetail,
    isLoading: traceLoading,
    error: traceError,
  } = useQuery<TraceSpansResponse>({
    queryKey: ['/api/traces', selectedTraceId, 'spans', isDemoMode],
    queryFn: async () => {
      if (isDemoMode) return DEMO_TRACE_DETAIL;
      const response = await fetch(`/api/traces/${selectedTraceId}/spans`);
      if (!response.ok) {
        throw new Error(`Failed to fetch trace: ${response.status}`);
      }
      return response.json();
    },
    enabled: !!selectedTraceId,
  });

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleSearch = () => {
    const trimmed = searchInput.trim();
    if (trimmed) {
      setSelectedTraceId(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleSelectTrace = (traceId: string) => {
    setSelectedTraceId(traceId);
    setSearchInput(traceId);
  };

  const handleClearSelection = () => {
    setSelectedTraceId(null);
    setSearchInput('');
  };

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const hasRecentTraces = recentTraces && recentTraces.length > 0;

  return (
    <div className="space-y-6">
      <DemoBanner />

      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Correlation Trace</h1>
        <p className="text-muted-foreground">
          Trace complete agent execution flows with span-level detail
        </p>
      </div>

      {/* Search Section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Search by Trace ID</CardTitle>
          <CardDescription>
            Enter a trace ID to view its span timeline, or select from recent traces below
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <Input
              placeholder="e.g., trace-abc123 or correlation UUID"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 font-mono text-sm"
            />
            <Button onClick={handleSearch} disabled={!searchInput.trim()}>
              <Search className="w-4 h-4 mr-2" />
              Trace
            </Button>
            {selectedTraceId && (
              <Button variant="outline" onClick={handleClearSelection}>
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Recent Traces / Sessions Panel (shown when no trace is selected) */}
      {!selectedTraceId && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Activity className="w-4 h-4" />
                  Trace Explorer
                </CardTitle>
                <CardDescription className="mt-1">
                  Recent execution traces and sessions
                </CardDescription>
              </div>
              {hasRecentTraces && (
                <Badge variant="outline" className="text-xs">
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Auto-refresh 30s
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'traces' | 'sessions')}>
              <TabsList className="mb-4">
                <TabsTrigger value="traces" className="gap-1.5">
                  <GitBranch className="w-3.5 h-3.5" />
                  Recent Traces
                </TabsTrigger>
                <TabsTrigger value="sessions" className="gap-1.5">
                  <Layers className="w-3.5 h-3.5" />
                  Sessions
                </TabsTrigger>
              </TabsList>

              <TabsContent value="traces">
                {recentLoading && <RecentTracesSkeleton />}

                {recentError && !recentLoading && (
                  <div className="flex items-start gap-3 p-4 rounded-lg bg-destructive/5 border border-destructive/20">
                    <AlertCircle className="w-5 h-5 text-destructive mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium mb-1">Failed to load recent traces</p>
                      <p className="text-sm text-muted-foreground">
                        {recentError instanceof Error
                          ? recentError.message
                          : 'Could not connect to the traces API'}
                      </p>
                    </div>
                  </div>
                )}

                {hasRecentTraces && !recentLoading && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Trace ID</TableHead>
                        <TableHead>Root Span</TableHead>
                        <TableHead>Session</TableHead>
                        <TableHead>Spans</TableHead>
                        <TableHead>Duration</TableHead>
                        <TableHead>Errors</TableHead>
                        <TableHead>Time</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentTraces.map((trace) => (
                        <TableRow
                          key={trace.traceId}
                          className="cursor-pointer hover:bg-muted/80 transition-colors"
                          onClick={() => handleSelectTrace(trace.traceId)}
                        >
                          <TableCell className="font-mono text-xs">
                            {truncate(trace.traceId, 20)}
                          </TableCell>
                          <TableCell>
                            <span className="text-sm font-medium">
                              {trace.rootSpanName || '--'}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {truncate(trace.sessionId, 16)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="text-xs">
                              {trace.spanCount}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {formatDuration(trace.totalDurationMs)}
                          </TableCell>
                          <TableCell>
                            {trace.errorCount > 0 ? (
                              <Badge variant="destructive" className="text-xs">
                                {trace.errorCount}
                              </Badge>
                            ) : (
                              <span className="text-sm text-muted-foreground">0</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                            {formatRelativeTime(trace.startedAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                {!hasRecentTraces && !recentLoading && !recentError && <EmptyRecentTraces />}
              </TabsContent>

              <TabsContent value="sessions">
                {sessionsLoading && <RecentTracesSkeleton />}

                {sessionsError && !sessionsLoading && (
                  <div className="flex items-start gap-3 p-4 rounded-lg bg-destructive/5 border border-destructive/20">
                    <AlertCircle className="w-5 h-5 text-destructive mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium mb-1">Failed to load sessions</p>
                      <p className="text-sm text-muted-foreground">
                        {sessionsError instanceof Error
                          ? sessionsError.message
                          : 'Could not connect to the sessions API'}
                      </p>
                    </div>
                  </div>
                )}

                {recentSessions && recentSessions.length > 0 && !sessionsLoading && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Session ID</TableHead>
                        <TableHead>Traces</TableHead>
                        <TableHead>Total Spans</TableHead>
                        <TableHead>Errors</TableHead>
                        <TableHead>First Seen</TableHead>
                        <TableHead>Last Seen</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentSessions.map((session) => (
                        <TableRow key={session.sessionId} className="hover:bg-muted/80">
                          <TableCell className="font-mono text-xs">
                            {truncate(session.sessionId, 24)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="text-xs">
                              {session.traceCount}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">{session.spanCount}</TableCell>
                          <TableCell>
                            {session.errorCount > 0 ? (
                              <Badge variant="destructive" className="text-xs">
                                {session.errorCount}
                              </Badge>
                            ) : (
                              <span className="text-sm text-muted-foreground">0</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                            {formatRelativeTime(session.firstSeen)}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                            {formatRelativeTime(session.lastSeen)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                {(!recentSessions || recentSessions.length === 0) &&
                  !sessionsLoading &&
                  !sessionsError && (
                    <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/40 border border-border/50">
                      <Info className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium mb-1">No sessions found</p>
                        <p className="text-sm text-muted-foreground">
                          Sessions will appear here when OmniClaude emits trace spans with session
                          IDs.
                        </p>
                      </div>
                    </div>
                  )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      {/* Trace Detail: Loading State */}
      {traceLoading && selectedTraceId && (
        <Card>
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mb-4" />
              <p className="text-muted-foreground">Loading trace data...</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Trace Detail: Error State */}
      {traceError && selectedTraceId && (
        <Card className="border-destructive/50">
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center">
              <AlertCircle className="w-12 h-12 text-destructive mb-4" />
              <h3 className="text-lg font-semibold mb-2">Error Loading Trace</h3>
              <p className="text-muted-foreground">
                {traceError instanceof Error ? traceError.message : 'Failed to load trace data'}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Trace Detail: Span Timeline */}
      {traceDetail && traceDetail.spans.length > 0 && (
        <>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearSelection}
              className="gap-1.5 shrink-0"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </Button>
            <div className="space-y-0.5">
              <h2 className="text-xl font-semibold leading-none">Trace Detail</h2>
              <p className="text-sm text-muted-foreground font-mono">{traceDetail.traceId}</p>
            </div>
            <ExportButton
              data={traceDetail as unknown as Record<string, unknown>}
              filename={`trace-${selectedTraceId}-${new Date().toISOString().split('T')[0]}`}
            />
          </div>

          {/* Summary Cards */}
          {traceDetail.summary && (
            <div className="grid gap-4 md:grid-cols-5">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Total Spans</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{traceDetail.summary.totalSpans}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Root Span</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-lg font-bold truncate">
                    {traceDetail.summary.rootSpanName || '--'}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Errors</CardTitle>
                </CardHeader>
                <CardContent>
                  <div
                    className={`text-2xl font-bold ${traceDetail.summary.errors > 0 ? 'text-red-500' : ''}`}
                  >
                    {traceDetail.summary.errors}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Total Duration</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {formatDuration(traceDetail.summary.totalDurationMs)}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Span Kinds</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(traceDetail.summary.kindBreakdown).map(([kind, count]) => (
                      <Badge key={kind} variant="outline" className="text-xs">
                        {kind}: {count}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Span Timeline */}
          <Card>
            <CardHeader>
              <CardTitle>Span Timeline</CardTitle>
              <CardDescription>Spans sorted by start time (chronological order)</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {traceDetail.spans.map((span, index) => (
                  <Collapsible key={span.spanId}>
                    <div className="flex items-start gap-4">
                      {/* Timeline Indicator */}
                      <div className="flex flex-col items-center">
                        <div
                          className={`rounded-full p-2 border ${getSpanColor(span.spanKind, span.status)}`}
                        >
                          {getSpanIcon(span.spanKind)}
                        </div>
                        {index < traceDetail.spans.length - 1 && (
                          <div className="w-0.5 h-12 bg-border mt-2" />
                        )}
                      </div>

                      {/* Span Content */}
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={getSpanColor(span.spanKind, span.status)}
                            >
                              {getSpanLabel(span.spanKind)}
                            </Badge>
                            <span className="text-sm font-medium">{span.spanName}</span>
                            {span.status === 'error' && (
                              <Badge variant="destructive" className="text-xs">
                                Error
                              </Badge>
                            )}
                            {span.parentSpanId === null && (
                              <Badge variant="secondary" className="text-xs">
                                Root
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
                            {span.durationMs !== null && (
                              <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {formatDuration(span.durationMs)}
                              </span>
                            )}
                            <span>{new Date(span.startedAt).toLocaleString()}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 mb-1 text-xs text-muted-foreground">
                          <span className="font-mono">span: {truncate(span.spanId, 16)}</span>
                          {span.parentSpanId && (
                            <span className="font-mono">
                              parent: {truncate(span.parentSpanId, 16)}
                            </span>
                          )}
                        </div>

                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8">
                            View Details
                          </Button>
                        </CollapsibleTrigger>

                        <CollapsibleContent className="mt-2">
                          <Card className="bg-muted/50">
                            <CardContent className="p-4">
                              <pre className="text-xs overflow-auto">
                                {JSON.stringify(span.metadata, null, 2)}
                              </pre>
                            </CardContent>
                          </Card>
                        </CollapsibleContent>
                      </div>
                    </div>
                  </Collapsible>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* No Spans in Selected Trace */}
      {traceDetail && traceDetail.spans.length === 0 && selectedTraceId && (
        <Card>
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center">
              <Search className="w-12 h-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Spans Found</h3>
              <p className="text-muted-foreground">
                No trace span data found for trace ID: {selectedTraceId}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
