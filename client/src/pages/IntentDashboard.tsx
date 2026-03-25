/**
 * Intent Dashboard Page (OMN-1458, OMN-2096)
 *
 * Real-time Intent Classification Dashboard that combines:
 * - IntentDistribution: Bar chart showing category distribution (time-range filtered)
 * - RecentIntents: Streaming list of recent classifications (live, unfiltered)
 * - SessionTimeline: Chronological timeline visualization (live, unfiltered)
 *
 * Features:
 * - Server-side projection snapshots via useIntentProjectionStream (OMN-2096 r4)
 * - WebSocket invalidation triggers re-fetch (no polling)
 * - Animated connection status indicator
 * - Responsive grid layout
 * - Time range selector (affects IntentDistribution only)
 * - Stats summary cards derived from projection snapshot
 *
 * Time Range Behavior:
 * The time-range selector only affects IntentDistribution. This is intentional:
 * - IntentDistribution: Shows aggregated statistics that benefit from historical filtering
 * - RecentIntents: Shows a live stream of the most recent N items (real-time UX)
 * - SessionTimeline: Shows recent intents or session-specific data (real-time UX)
 *
 * The real-time components (RecentIntents, SessionTimeline) prioritize showing the
 * latest activity regardless of time range, while the distribution chart allows
 * historical analysis over configurable periods.
 */

import { useState, useMemo } from 'react';
import { IntentDistribution, RecentIntents, SessionTimeline } from '@/components/intent';
import { useIntentProjectionStream } from '@/hooks/useIntentProjectionStream';
import { useDemoMode } from '@/contexts/DemoModeContext';
import { useFeatureStaleness } from '@/hooks/useStaleness';
import { StalenessIndicator } from '@/components/StalenessIndicator';
import { DemoBanner } from '@/components/DemoBanner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DashboardPageHeader } from '@/components/DashboardPageHeader';
import { cn } from '@/lib/utils';
import {
  CONFIDENCE_THRESHOLD_HIGH,
  CONFIDENCE_THRESHOLD_MEDIUM,
  CONFIDENCE_THRESHOLD_LOW,
} from '@/lib/intent-colors';
import {
  Brain,
  Activity,
  TrendingUp,
  Clock,
  BarChart3,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import React from 'react';
import type { IntentItem } from '@/components/intent';
import type { IntentProjectionPayload, ProjectionEventItem } from '@shared/projection-types';

// ─────────────────────────────────────────────────────────────────────────────
// Demo snapshot factory
// ─────────────────────────────────────────────────────────────────────────────

function makeDemoIntentSnapshot(): IntentProjectionPayload {
  const now = Date.now();
  const recentIntents: ProjectionEventItem[] = [
    {
      id: 'di-001',
      eventTimeMs: now - 720_000,
      ingestSeq: 1,
      type: 'intent-classified',
      topic: 'intent.classified.v1',
      source: 'omniclaude',
      severity: 'info',
      payload: {
        intent_category: 'code_generation',
        confidence: 0.94,
        session_ref: 'ses-demo-7f3a',
        created_at: new Date(now - 720_000).toISOString(),
      },
    },
    {
      id: 'di-002',
      eventTimeMs: now - 600_000,
      ingestSeq: 2,
      type: 'intent-classified',
      topic: 'intent.classified.v1',
      source: 'omniclaude',
      severity: 'info',
      payload: {
        intent_category: 'debugging',
        confidence: 0.88,
        session_ref: 'ses-demo-8b2c',
        created_at: new Date(now - 600_000).toISOString(),
      },
    },
    {
      id: 'di-003',
      eventTimeMs: now - 480_000,
      ingestSeq: 3,
      type: 'intent-classified',
      topic: 'intent.classified.v1',
      source: 'omniclaude',
      severity: 'info',
      payload: {
        intent_category: 'code_generation',
        confidence: 0.91,
        session_ref: 'ses-demo-7f3a',
        created_at: new Date(now - 480_000).toISOString(),
      },
    },
    {
      id: 'di-004',
      eventTimeMs: now - 360_000,
      ingestSeq: 4,
      type: 'intent-classified',
      topic: 'intent.classified.v1',
      source: 'omniclaude',
      severity: 'info',
      payload: {
        intent_category: 'refactoring',
        confidence: 0.79,
        session_ref: 'ses-demo-9c4d',
        created_at: new Date(now - 360_000).toISOString(),
      },
    },
    {
      id: 'di-005',
      eventTimeMs: now - 240_000,
      ingestSeq: 5,
      type: 'intent-classified',
      topic: 'intent.classified.v1',
      source: 'omniclaude',
      severity: 'info',
      payload: {
        intent_category: 'code_review',
        confidence: 0.85,
        session_ref: 'ses-demo-9c4d',
        created_at: new Date(now - 240_000).toISOString(),
      },
    },
    {
      id: 'di-006',
      eventTimeMs: now - 120_000,
      ingestSeq: 6,
      type: 'intent-classified',
      topic: 'intent.classified.v1',
      source: 'omniclaude',
      severity: 'info',
      payload: {
        intent_category: 'debugging',
        confidence: 0.92,
        session_ref: 'ses-demo-8b2c',
        created_at: new Date(now - 120_000).toISOString(),
      },
    },
    {
      id: 'di-007',
      eventTimeMs: now - 60_000,
      ingestSeq: 7,
      type: 'intent-classified',
      topic: 'intent.classified.v1',
      source: 'omniclaude',
      severity: 'info',
      payload: {
        intent_category: 'code_generation',
        confidence: 0.96,
        session_ref: 'ses-demo-7f3a',
        created_at: new Date(now - 60_000).toISOString(),
      },
    },
  ];

  const distribution = [
    { category: 'code_generation', count: 3, percentage: 42.9 },
    { category: 'debugging', count: 2, percentage: 28.6 },
    { category: 'refactoring', count: 1, percentage: 14.3 },
    { category: 'code_review', count: 1, percentage: 14.3 },
  ];

  return {
    recentIntents,
    distribution,
    totalIntents: 7,
    categoryCount: 4,
    lastEventTimeMs: now - 60_000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Available time range options for filtering */
const TIME_RANGE_OPTIONS = [
  { value: '1', label: 'Last 1 hour' },
  { value: '6', label: 'Last 6 hours' },
  { value: '24', label: 'Last 24 hours' },
  { value: '168', label: 'Last 7 days' },
] as const;

type TimeRangeHours = (typeof TIME_RANGE_OPTIONS)[number]['value'];

// ─────────────────────────────────────────────────────────────────────────────
// Error Boundary Component
// ─────────────────────────────────────────────────────────────────────────────

interface IntentErrorBoundaryProps {
  children: React.ReactNode;
  fallbackTitle?: string;
}

interface IntentErrorBoundaryState {
  hasError: boolean;
}

/**
 * Error boundary for Intent Dashboard visualization components.
 * Catches errors from child components and displays a user-friendly fallback UI.
 */
class IntentErrorBoundary extends React.Component<
  IntentErrorBoundaryProps,
  IntentErrorBoundaryState
> {
  constructor(props: IntentErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): IntentErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[IntentDashboard] Component error:', error, info.componentStack);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <Card className="h-full">
          <CardContent className="flex flex-col items-center justify-center h-48 gap-3">
            <AlertCircle className="w-8 h-8 text-destructive" />
            <p className="text-sm text-muted-foreground">
              Failed to load {this.props.fallbackTitle || 'component'}
            </p>
            <Button variant="outline" size="sm" onClick={this.handleRetry}>
              Retry
            </Button>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat Card Component
// ─────────────────────────────────────────────────────────────────────────────

// Note: This component is similar to MetricCard from @/components/MetricCard.
// StatCard provides an always-visible `description` field, whereas MetricCard
// uses a `tooltip` for additional context. StatCard is preferred here for UX
// where the description text should be immediately visible without hover.

interface StatCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  trend?: 'up' | 'down' | 'neutral';
  className?: string;
}

function StatCard({ title, value, description, icon: Icon, trend, className }: StatCardProps) {
  return (
    <Card className={cn('h-full', className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2">
          <div className="text-2xl font-bold">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </div>
          {trend && (
            <TrendingUp
              className={cn(
                'h-4 w-4',
                trend === 'up' && 'text-green-500',
                trend === 'down' && 'text-red-500 rotate-180',
                trend === 'neutral' && 'text-muted-foreground'
              )}
            />
          )}
        </div>
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent Detail Sheet
// ─────────────────────────────────────────────────────────────────────────────

interface IntentDetailProps {
  intent: IntentItem | null;
  onClose: () => void;
}

/**
 * Sheet component for displaying detailed intent information.
 * Slides in from the right when an intent is selected.
 * Automatically handles:
 * - Escape key to close
 * - Click outside to close
 * - Focus management
 */
function IntentDetail({ intent, onClose }: IntentDetailProps) {
  return (
    <Sheet open={!!intent} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-96 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Intent Details</SheetTitle>
          {intent && (
            <SheetDescription>Classification details for {intent.intent_category}</SheetDescription>
          )}
        </SheetHeader>
        {intent && (
          <div className="space-y-4 mt-6 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Category:</span>
              <Badge variant="outline">{intent.intent_category}</Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Confidence:</span>
              <span className="font-mono">{(intent.confidence * 100).toFixed(1)}%</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Session:</span>
              <span className="font-mono text-xs truncate max-w-[180px]">{intent.session_ref}</span>
            </div>
            {intent.keywords && intent.keywords.length > 0 && (
              <div>
                <span className="text-muted-foreground">Keywords:</span>
                <div className="flex flex-wrap gap-1 mt-2">
                  {intent.keywords.slice(0, 5).map((kw, i) => (
                    <Badge key={i} variant="secondary" className="text-xs">
                      {kw}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {intent.user_context && (
              <div>
                <span className="text-muted-foreground block mb-2">Prompt:</span>
                <div className="rounded-md bg-muted/50 border border-border p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                  {intent.user_context}
                </div>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export default function IntentDashboard() {
  const { isDemoMode } = useDemoMode();
  const intentLastUpdated = useFeatureStaleness('intent-signals');

  // State
  const [timeRange, setTimeRange] = useState<TimeRangeHours>('24');
  const [selectedIntent, setSelectedIntent] = useState<IntentItem | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  // Server-side projection snapshot (OMN-2096 r4)
  // Fetches on mount, then re-fetches when WebSocket invalidation arrives.
  // When demo mode is active, fetchOnMount is disabled so we don't poll live data.
  const liveStream = useIntentProjectionStream<IntentProjectionPayload>('intent', {
    limit: 100,
    fetchOnMount: !isDemoMode,
  });

  // In demo mode, override the live stream with canned data.
  const demoSnapshot = useMemo(() => (isDemoMode ? makeDemoIntentSnapshot() : null), [isDemoMode]);

  const snapshot = isDemoMode ? demoSnapshot : liveStream.snapshot;
  const isConnected = isDemoMode ? false : liveStream.isConnected;
  const connectionStatus = isDemoMode ? ('disconnected' as const) : liveStream.connectionStatus;
  const refresh = isDemoMode ? () => {} : liveStream.refresh;

  // Derive stat card values from the projection snapshot
  const categoryCount = snapshot?.categoryCount ?? 0;

  // Depend on `snapshot` — the entire object is replaced on each fetch, so
  // using snapshot?.recentIntents would also trigger on every update (same
  // reference lifetime). Using `snapshot` is more explicit about the intent.
  const avgConfidence = useMemo(() => {
    if (!snapshot?.recentIntents?.length) return 0;
    const confidences = snapshot.recentIntents
      .map((e) => e.payload.confidence)
      .filter((c) => c != null)
      .map((c) => Number(c))
      .filter((c) => !isNaN(c));
    if (confidences.length === 0) return 0;
    return confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
  }, [snapshot]);

  const lastEventTimeStr = useMemo(() => {
    if (snapshot?.lastEventTimeMs == null) return 'No events yet';
    return new Date(snapshot.lastEventTimeMs).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }, [snapshot?.lastEventTimeMs]);

  // Handlers
  const handleIntentClick = (intent: IntentItem) => {
    setSelectedIntent(intent);
  };

  const timeRangeHours = parseInt(timeRange, 10);

  // ─── REGRESSION WARNING ───────────────────────────────────────────────────
  // Transform projection snapshot → IntentItem[] for RecentIntents + SessionTimeline.
  //
  // WHY THE DUAL-CASING FALLBACKS EXIST (do NOT remove them):
  //
  //   handleIntentClassified() in omniintelligence-handler.ts builds an
  //   InternalIntentClassifiedEvent that uses camelCase field names:
  //     { intentType, sessionId, createdAt, correlationId, ... }
  //
  //   That object is emitted verbatim as the 'intent-event' payload, which
  //   projection-instance.ts forwards directly to ProjectionService.ingest().
  //   The raw camelCase payload is then stored inside each ProjectionEvent.
  //
  //   When the snapshot is fetched, e.payload still contains camelCase keys.
  //   If this mapping reads only snake_case (intent_category, session_ref,
  //   created_at), every field resolves to undefined → '' → the resolver
  //   returns 'unknown' → every dot on the Session Timeline turns gray and
  //   every category badge in Recent Intents goes blank.
  //
  //   This has regressed multiple times (OMN-5318, prior incidents). The
  //   camelCase fallbacks below are the correct, intentional fix.
  //   DO NOT simplify this to a single casing without also normalising the
  //   payload at the write site in projection-instance.ts.
  // ─────────────────────────────────────────────────────────────────────────
  const projectionIntentItems = useMemo((): IntentItem[] | undefined => {
    if (!snapshot?.recentIntents?.length) return undefined;
    return snapshot.recentIntents.map((e) => ({
      intent_id: e.id,
      // camelCase fallback required: payload may carry intentType (InternalIntentClassifiedEvent)
      // or intent_category (IntentStoredEvent / future normalized events). Never read only one.
      session_ref: String(
        e.payload.session_ref ?? e.payload.sessionId ?? e.payload.session_id ?? ''
      ),
      intent_category: String(
        e.payload.intent_category ?? e.payload.intentType ?? e.payload.intent_type ?? ''
      ),
      confidence: Number(e.payload.confidence ?? 0),
      keywords: Array.isArray(e.payload.keywords) ? (e.payload.keywords as string[]) : [],
      // camelCase fallback: InternalIntentClassifiedEvent uses createdAt, not created_at
      created_at:
        (e.payload.created_at as string | undefined) ||
        (e.payload.createdAt as string | undefined) ||
        new Date(e.eventTimeMs ?? Date.now()).toISOString(),
      user_context: undefined,
    }));
  }, [snapshot]);

  // Apply category filter for cross-panel filtering
  const filteredIntentItems = useMemo(() => {
    if (!projectionIntentItems || !categoryFilter) return projectionIntentItems;
    return projectionIntentItems.filter((i) => i.intent_category === categoryFilter);
  }, [projectionIntentItems, categoryFilter]);

  // Filter distribution data: exclude "unknown" category (classifier fallback for
  // unclassifiable intents with 0% confidence — OMN-5056). These are noise from
  // before the classifier fix and don't convey actionable information.
  const filteredDistribution = useMemo(() => {
    if (!snapshot?.distribution) return undefined;
    return snapshot.distribution.filter((d) => d.category !== 'unknown');
  }, [snapshot?.distribution]);

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <DemoBanner />

        {/* Page Header */}
        <DashboardPageHeader
          title="Intent Classification Dashboard"
          description="Real-time classification of user intents across sessions"
          statusBadge={<StalenessIndicator lastUpdated={intentLastUpdated} label="Intents" />}
          isConnected={isConnected}
          connectionStatus={connectionStatus}
          lastUpdated={
            snapshot?.lastEventTimeMs != null ? new Date(snapshot.lastEventTimeMs) : null
          }
          actions={
            <div className="flex items-center gap-2">
              {/* Time Range Selector - affects IntentDistribution only (see module docstring) */}
              <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRangeHours)}>
                <SelectTrigger className="w-[140px]">
                  <Clock className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Time Range" />
                </SelectTrigger>
                <SelectContent>
                  {TIME_RANGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Refresh Button */}
              <Button variant="outline" size="sm" onClick={refresh} className="gap-2">
                <RefreshCw className="h-4 w-4" />
                <span className="hidden sm:inline">Refresh</span>
              </Button>
            </div>
          }
        />

        {/* Stats Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            title="Total Intents"
            value={snapshot?.totalIntents ?? 0}
            description="Total classified intents"
            icon={Brain}
            trend={(snapshot?.totalIntents ?? 0) > 0 ? 'up' : 'neutral'}
          />
          <StatCard
            title="Categories"
            value={categoryCount}
            description="Unique categories detected"
            icon={BarChart3}
          />
          <StatCard
            title="Avg Confidence"
            value={`${(avgConfidence * 100).toFixed(1)}%`}
            description="Mean classification score"
            icon={TrendingUp}
            trend={
              avgConfidence >= CONFIDENCE_THRESHOLD_HIGH
                ? 'up'
                : avgConfidence >= CONFIDENCE_THRESHOLD_MEDIUM
                  ? 'neutral'
                  : 'down'
            }
          />
          <StatCard
            title="Last Event"
            value={lastEventTimeStr}
            description="Most recent classification"
            icon={Activity}
          />
        </div>

        {/* Main Dashboard Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left Column: Distribution Chart (~40% width on lg) */}
          <div className="lg:col-span-2">
            <IntentErrorBoundary fallbackTitle="intent distribution">
              <IntentDistribution
                timeRangeHours={timeRangeHours}
                refreshInterval={30000}
                title={`Intent Distribution (${TIME_RANGE_OPTIONS.find((o) => o.value === timeRange)?.label})`}
                className="h-full"
                data={filteredDistribution}
                totalIntents={snapshot?.totalIntents}
                selectedCategory={categoryFilter}
                onCategoryClick={setCategoryFilter}
              />
            </IntentErrorBoundary>
          </div>

          {/* Right Column: Recent Intents (~60% width on lg) */}
          <div className="lg:col-span-3">
            <IntentErrorBoundary fallbackTitle="recent intents">
              <RecentIntents
                limit={50}
                showConfidence={true}
                maxHeight={400}
                onIntentClick={handleIntentClick}
                className="h-full"
                data={filteredIntentItems}
                connectionStatus={connectionStatus}
              />
            </IntentErrorBoundary>
          </div>
        </div>

        {/* Session Timeline (Full Width) */}
        <IntentErrorBoundary fallbackTitle="session timeline">
          <SessionTimeline
            maxHeight={350}
            showCard={true}
            refetchInterval={30000}
            defaultView="chart"
            showViewToggle={true}
            onIntentClick={handleIntentClick}
            data={filteredIntentItems}
          />
        </IntentErrorBoundary>

        {/* Legend - 4-band thresholds from shared constants (intent-colors.ts) [OMN-1560] */}
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground pt-2 border-t">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span>High confidence (&ge;{Math.round(CONFIDENCE_THRESHOLD_HIGH * 100)}%)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-blue-500" />
            <span>
              Medium-high confidence ({Math.round(CONFIDENCE_THRESHOLD_MEDIUM * 100)}&ndash;
              {Math.round(CONFIDENCE_THRESHOLD_HIGH * 100)}%)
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-amber-500" />
            <span>
              Medium-low confidence ({Math.round(CONFIDENCE_THRESHOLD_LOW * 100)}&ndash;
              {Math.round(CONFIDENCE_THRESHOLD_MEDIUM * 100)}%)
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <span>Low confidence (&lt;{Math.round(CONFIDENCE_THRESHOLD_LOW * 100)}%)</span>
          </div>
        </div>

        {/* Intent Detail Sheet */}
        <IntentDetail intent={selectedIntent} onClose={() => setSelectedIntent(null)} />
      </div>
    </TooltipProvider>
  );
}
